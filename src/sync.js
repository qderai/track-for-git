// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Polling: the fallback to webhooks, and the backfill of what happened before the dashboard existed. It runs from
 * the cron trigger (every minute on Workers, on a timer in Node), one run at a time, inside a time budget and a
 * request budget, and carries on next run where it stopped.
 *
 * Each run:
 *   1. lists the organisation's repositories (in full every 30 minutes, the most recently pushed page every run);
 *   2. picks the repositories that need it: pushed since their last sync, flagged by a webhook, a walk back through
 *      history in progress, open pull requests not refreshed for 10 minutes, or anything not synced for 6 hours;
 *   3. asks GraphQL about them five at a time (commits with line counts, pull requests with review and CI, deploys,
 *      releases, tags), then REST for the pushes on other branches of the ones that were pushed;
 *   4. fills in line counts and paths of the newest commits while the rate limit has room;
 *   5. refreshes teams every 6 hours and deletes rows past the retention once a day.
 * With hundreds of repositories this touches only the few that changed, so it stays far inside GitHub's limits.
 */
import { chunks, getJson, getState, marks, setState, stateStmt } from "./db.js";
import { OutOfBudget, RateLimited, nextPage } from "./github/client.js";
import {
  SHA, branchOf, ciSql, commitFromGraph, commitFromRest, commitStmts, deployMarker, markerSql, prRow, prSql, pushId, pushSql,
  releaseMarker, repoSql, tagMarker,
} from "./github/normalize.js";
import { commitStatsQuery, prPageQuery, reposQuery, snapshotQuery } from "./github/queries.js";

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
const ZERO = /^0{40}$/;

/**
 * Pure. REPOS patterns into a test of a full name. Entries: "name" or "owner/name", with * wildcards; "!pattern"
 * excludes. No includes means every repository of the organisation.
 */
export function repoMatcher(patterns, org) {
  const toRe = (p) => new RegExp(`^${p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  const norm = (p) => (p.includes("/") ? p : `${org || "*"}/${p}`);
  const inc = patterns.filter((p) => !p.startsWith("!")).map(norm).map(toRe);
  const exc = patterns.filter((p) => p.startsWith("!")).map((p) => norm(p.slice(1))).map(toRe);
  return (full) => {
    const f = String(full ?? "").toLowerCase();
    if (!/^[\w.-]+\/[\w.-]+$/.test(f)) return false;
    if (exc.some((re) => re.test(f))) return false;
    if (inc.length) return inc.some((re) => re.test(f));
    return !!org && f.startsWith(`${org}/`);
  };
}

/** Claim a lock row until `until`; only one caller succeeds. */
async function claim(store, key, now, holdMs) {
  await store.run("INSERT OR IGNORE INTO state (key, value, updated_at) VALUES (?, '0', ?)", key, now);
  const r = await store.run("UPDATE state SET value = ?, updated_at = ? WHERE key = ? AND CAST(value AS INTEGER) < ?", String(now + holdMs), now, key, now);
  return r.changes === 1;
}

/**
 * One sync run. Never throws: the dashboard must keep drawing without GitHub. What went wrong is kept in state
 * `sync_last` for /api/status.
 * @param {{ store: any, cfg: import("./config.js").Config, gh: ReturnType<typeof import("./github/client.js").createGitHub> }} ctx
 */
export async function runSync(ctx, now = Date.now()) {
  const { store, cfg, gh } = ctx;
  if (cfg.demo || cfg.mode === "none") return { skipped: cfg.demo ? "demo" : "not connected" };
  if (!(await claim(store, "sync_lock", now, cfg.budgetMs + 30_000))) return { skipped: "another run is in progress" };
  const started = Date.now();
  const late = () => Date.now() - started > cfg.budgetMs;
  const out = { at: now, repos: 0, commits: 0, prs: 0, pushes: 0, errors: [], waiting: null };
  const fail = (where, e) => {
    if (e instanceof RateLimited) { out.waiting = { until: e.until, resource: e.resource }; return true; }
    if (e instanceof OutOfBudget) return true;
    out.errors.push(`${where}: ${String(e?.message ?? e)}`.slice(0, 200));
    return false;
  };
  try {
    const matches = repoMatcher(cfg.repos, cfg.org);
    try { await discover(ctx, matches, now); } catch (e) { if (fail("repositories", e)) return out; }
    if (!late()) { try { await syncTeams(ctx, now); } catch (e) { fail("teams", e); } }

    const picks = await pickRepos(store, now);
    for (const batch of chunks(picks, 5)) {
      if (late() || !gh.can("graphql")) break;
      try { await snapshot(ctx, batch, now, out); } catch (e) { if (fail("snapshot", e)) break; }
    }
    for (const r of picks.filter((x) => x.snapshotDone && x.changed)) {
      if (late() || !gh.can("core")) break;
      try { await pushes(ctx, r, now, out); r.pushesDone = true; } catch (e) { if (fail(r.full_name, e)) break; }
    }
    // A repository counts as synced once both steps that applied to it are done.
    const done = picks.filter((r) => r.snapshotDone && (!r.changed || r.pushesDone));
    if (done.length) {
      await store.batch(done.map((r) => ({ sql: "UPDATE repos SET synced_at = ?, synced_pushed_at = ?, dirty = 0 WHERE id = ?", binds: [now, r.pushed_at, r.id] })));
    }
    out.repos = done.length;
    if (!late() && gh.can("graphql")) { try { await fillStats(ctx, now); } catch (e) { fail("line counts", e); } }
    if (!late() && gh.can("core")) { try { await fillPaths(ctx, now); } catch (e) { fail("paths", e); } }
    try { await prune(store, cfg, now); } catch (e) { fail("retention", e); }
  } catch (e) {
    fail("sync", e);
  } finally {
    out.ms = Date.now() - started;
    out.requests = gh.used;
    await store.batch([
      stateStmt("rate", JSON.stringify(gh.rate()), now),
      stateStmt("sync_last", JSON.stringify(out), now),
      stateStmt("sync_lock", "0", now),
    ]).catch(() => undefined);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- repositories

async function discover(ctx, matches, now) {
  const { store, cfg, gh } = ctx;
  const fullDue = now - Number((await getState(store, "discover_at")) ?? 0) > 30 * MIN;
  const seen = [];
  const keep = (r) => {
    const row = { id: Number(r.id ?? r.databaseId), full_name: String(r.full_name ?? r.nameWithOwner ?? ""), default_branch: r.default_branch ?? r.defaultBranchRef?.name ?? null,
      private: (r.private ?? r.isPrivate) ? 1 : 0, archived: (r.archived ?? r.isArchived) ? 1 : 0, pushed_at: Date.parse(r.pushed_at ?? r.pushedAt) || null };
    if (!Number.isInteger(row.id) || !matches(row.full_name)) return;
    if (row.archived && !cfg.includeArchived) return;
    seen.push(row);
  };

  if (cfg.mode === "app" || cfg.org) {
    // The App's own list, or the organisation's, newest push first. A quick run reads the first page only (an ETag
    // makes an unchanged page free); a full run reads them all and retires what is gone.
    const base = cfg.mode === "app" ? "/installation/repositories?per_page=100" : `/orgs/${encodeURIComponent(cfg.org)}/repos?type=all&sort=pushed&direction=desc&per_page=100`;
    let path = base, pages = 0;
    const etag = fullDue ? null : await getState(store, "discover_etag");
    while (path && pages < 40) {
      const res = await gh.rest(path, { etag: pages === 0 ? etag : null });
      if (res.status === 304) break;
      if (pages === 0) await setState(store, "discover_etag", res.etag ?? "", now);
      for (const r of Array.isArray(res.data) ? res.data : res.data?.repositories ?? []) keep(r);
      pages++;
      path = fullDue ? nextPage(res.link, cfg.apiUrl) : null;
    }
  }
  // Repositories named in full outside the organisation (or with no organisation set).
  const named = cfg.repos.filter((p) => !p.startsWith("!") && p.includes("/") && !p.includes("*") && (!cfg.org || !p.toLowerCase().startsWith(`${cfg.org}/`)));
  if (named.length && fullDue) {
    for (const part of chunks(named.slice(0, 200), 20)) {
      const q = reposQuery(part);
      const { data } = await gh.graphql(q.query, q.variables);
      for (const r of Object.values(data ?? {})) if (r) keep(r);
    }
  }
  if (seen.length) await store.batch(seen.map(repoSql));
  if (fullDue) {
    // Retire what the full listing no longer has (uninstalled, deleted, filtered out, archived).
    const ids = new Set(seen.map((r) => r.id));
    const current = await store.all("SELECT id FROM repos WHERE removed = 0");
    const gone = current.filter((r) => !ids.has(Number(r.id))).map((r) => r.id);
    for (const part of chunks(gone, 90)) await store.run(`UPDATE repos SET removed = 1 WHERE id IN (${marks(part)})`, ...part);
    await setState(store, "discover_at", String(now), now);
  }
}

/** The repositories this run looks at, most urgent first. */
async function pickRepos(store, now) {
  const rows = await store.all(
    `SELECT id, full_name, default_branch, pushed_at, synced_pushed_at, synced_at, dirty, history_at, history_cursor, history_since, history_started, prs_at, events_etag, open_prs
       FROM repos WHERE removed = 0
      ORDER BY (COALESCE(pushed_at, 0) > COALESCE(synced_pushed_at, 0) OR dirty = 1 OR history_cursor IS NOT NULL OR synced_at IS NULL) DESC,
               (open_prs > 0 AND COALESCE(synced_at, 0) < ?) DESC, COALESCE(synced_at, 0) ASC
      LIMIT 40`, now - 10 * MIN);
  return rows.map((r) => ({
    ...r,
    changed: !r.synced_at || Number(r.pushed_at ?? 0) > Number(r.synced_pushed_at ?? 0),
  })).filter((r) => r.changed || r.dirty || r.history_cursor || (r.open_prs > 0 && now - Number(r.synced_at ?? 0) > 10 * MIN) || now - Number(r.synced_at ?? 0) > 6 * HOUR)
    .slice(0, 25);
}

// ---------------------------------------------------------------------------------------------------- GraphQL snapshot

async function snapshot(ctx, batch, now, out) {
  const { store, cfg, gh } = ctx;
  const plan = batch.map((r) => {
    const [owner, name] = r.full_name.split("/");
    const walking = !!r.history_cursor;
    const since = walking ? Number(r.history_since) : Math.max((r.history_at ?? now - cfg.backfillDays * DAY) - HOUR, now - cfg.backfillDays * DAY);
    return { r, owner, name, since: new Date(since).toISOString(), sinceMs: since, historyAfter: walking ? r.history_cursor : null, full: true };
  });
  // A token without the Deployments permission (a fine-grained one made read-only for code) gets every repository back
  // as null when deploys are asked for: GitHub cannot leave that field empty, so the whole repository goes. Then the
  // snapshot asks without deploys, says so on the status, and tries with them again every 6 hours.
  const note = await store.first("SELECT value, updated_at FROM state WHERE key = 'deployments_note'");
  const noDeploys = !!note?.value && now - Number(note.updated_at) < 6 * HOUR;
  const q = snapshotQuery(plan, { deployments: !noDeploys });
  const { data, errors } = await gh.graphql(q.query, q.variables);
  // Only when the refused field took the whole repository with it: an error deeper inside deploys leaves the rest.
  if (!noDeploys && (errors ?? []).some((e) => Array.isArray(e?.path) && e.path.length === 2 && e.path[1] === "deployments" && e?.type !== "NOT_FOUND" && data?.[e.path[0]] == null)) {
    await setState(store, "deployments_note", "Deploys from GitHub need the Deployments: read permission", now);
    return snapshot(ctx, batch, now, out);
  }
  if (!noDeploys && note?.value) await setState(store, "deployments_note", "", now);
  for (let i = 0; i < plan.length; i++) {
    const { r, sinceMs } = plan[i];
    const node = data?.[`r${i}`];
    if (!node) {
      // Only "not found" (deleted, moved away, no longer shared with the token) retires a repository. Any other reason
      // GitHub gives is reported and the repository kept, not counted as synced, so the next run asks again.
      const why = (errors ?? []).find((e) => Array.isArray(e?.path) && e.path[0] === `r${i}` && e?.type !== "NOT_FOUND");
      if (why) { out.errors.push(`${r.full_name}: ${String(why.message ?? why.type ?? "no answer").slice(0, 160)}`); continue; }
      r.snapshotDone = true;
      await store.run("UPDATE repos SET removed = 1 WHERE id = ?", r.id);
      continue;
    }
    const stmts = [];
    const def = node.defaultBranchRef?.name ?? r.default_branch;
    stmts.push({ sql: "UPDATE repos SET default_branch = ?, archived = ?, private = ?, pushed_at = MAX(COALESCE(pushed_at, 0), ?) WHERE id = ?",
      binds: [def, node.isArchived ? 1 : 0, node.isPrivate ? 1 : 0, Date.parse(node.pushedAt) || 0, r.id] });

    // The default branch, newest first, a page of 100 per run while a walk back is in progress.
    const hist = node.defaultBranchRef?.target?.history;
    const commits = (hist?.nodes ?? []).map((n) => commitFromGraph(r.id, n, def, cfg.agents)).filter(Boolean);
    stmts.push(...commitStmts(commits));
    out.commits += commits.length;
    if (hist?.pageInfo?.hasNextPage && hist.pageInfo.endCursor) {
      stmts.push({ sql: "UPDATE repos SET history_cursor = ?, history_since = ?, history_started = COALESCE(history_started, ?) WHERE id = ?", binds: [hist.pageInfo.endCursor, sinceMs, now, r.id] });
    } else if (hist) {
      stmts.push({ sql: "UPDATE repos SET history_cursor = NULL, history_since = NULL, history_at = COALESCE(history_started, ?), history_started = NULL WHERE id = ?", binds: [now, r.id] });
    }

    // Pull requests: the 30 most recently updated and the 30 open ones, with review decision and CI.
    const prNodes = [...(node.recent?.nodes ?? []), ...(node.open?.nodes ?? [])];
    const seen = new Set();
    for (const p of prNodes) {
      const row = prRow(r.id, p, cfg.agents, cfg.webUrl);
      if (!row || seen.has(row.number)) continue;
      seen.add(row.number);
      stmts.push(prSql(row));
      if (row.head_sha && row.ci) stmts.push(ciSql(r.id, row.head_sha, row.ci, now));
      out.prs++;
    }
    stmts.push({ sql: "UPDATE repos SET open_prs = ? WHERE id = ?", binds: [Number(node.open?.totalCount ?? 0), r.id] });

    for (const d of node.deployments?.nodes ?? []) { const m = deployMarker(r.id, d); if (m) stmts.push(markerSql(m)); }
    for (const rel of node.releases?.nodes ?? []) { const m = releaseMarker(r.id, rel, cfg.webUrl); if (m) stmts.push(markerSql(m)); }
    for (const t of node.refs?.nodes ?? []) { const m = tagMarker(r.id, t); if (m && m.at >= now - cfg.retentionDays * DAY) stmts.push(markerSql(m)); }
    await store.batch(stmts);

    // Older pull requests, until the backfill window (first sync) or the last sync is covered.
    const recent = node.recent?.nodes ?? [];
    const target = r.prs_at ? Number(r.prs_at) - HOUR : now - cfg.backfillDays * DAY;
    const oldest = Date.parse(recent.at(-1)?.updatedAt ?? "");
    if (recent.length === 30 && oldest > target) await morePrs(ctx, r, target);
    await store.run("UPDATE repos SET prs_at = ? WHERE id = ?", now, r.id);
    r.snapshotDone = true;
  }
}

/** Pages of older pull requests (at most 4 per run; a cursor carries on next run). */
async function morePrs(ctx, r, target) {
  const { store, cfg, gh } = ctx;
  const [o, n] = r.full_name.split("/");
  const key = `prs_cursor:${r.id}`;
  let after = await getState(store, key);
  for (let page = 0; page < 4; page++) {
    const q = prPageQuery();
    const { data } = await gh.graphql(q.query, { o, n, a: after || null });
    const conn = data?.repository?.pullRequests;
    const rows = (conn?.nodes ?? []).map((p) => prRow(r.id, p, cfg.agents, cfg.webUrl)).filter(Boolean);
    await store.batch(rows.map(prSql));
    const oldest = rows.at(-1)?.updated_at ?? 0;
    if (!conn?.pageInfo?.hasNextPage || oldest < target) { await setState(store, key, ""); return; }
    after = conn.pageInfo.endCursor;
    await setState(store, key, after);
  }
}

// ---------------------------------------------------------------------------------------------------- REST pushes

/**
 * The pushes of a repository since the last sync, from its events (one request; an ETag makes "nothing new" free),
 * and each new push's commits from the compare API (GitHub's events no longer list them). A new branch is compared
 * with the default branch: its own commits only, never the default branch's history.
 */
async function pushes(ctx, r, now, out) {
  const { store, cfg, gh } = ctx;
  const res = await gh.rest(`/repos/${r.full_name}/events?per_page=100`, { etag: r.events_etag });
  if (res.status === 304) return;
  const events = Array.isArray(res.data) ? res.data : [];
  const found = events.filter((e) => e?.type === "PushEvent" && /^refs\/heads\//.test(String(e?.payload?.ref ?? "")) && SHA.test(String(e?.payload?.head ?? "")) && !ZERO.test(String(e.payload.head)))
    .map((e) => ({ e, branch: branchOf(e.payload.ref), head: String(e.payload.head) }))
    .map((x) => ({ ...x, id: pushId(r.id, x.branch, x.head) }));
  const known = new Set();
  for (const part of chunks(found.map((x) => x.id), 90)) {
    for (const row of await store.all(`SELECT id FROM pushes WHERE id IN (${marks(part)})`, ...part)) known.add(row.id);
  }
  // Oldest new pushes first, ten per run; the ETag is saved only when every new push was stored.
  const todo = found.filter((x) => !known.has(x.id)).reverse();
  for (const x of todo.slice(0, 10)) {
    const before = String(x.e.payload.before ?? "");
    const base = SHA.test(before) && !ZERO.test(before) ? before : r.default_branch || "HEAD";
    const onDefault = x.branch === r.default_branch;
    const row = { id: x.id, repo_id: r.id, branch: x.branch, at: Date.parse(x.e.created_at) || now, actor: String(x.e.actor?.login ?? "").toLowerCase() || null,
      head: x.head, before: SHA.test(before) ? before : null, commits_n: 0, forced: 0, created: SHA.test(before) && !ZERO.test(before) ? 0 : 1, agent: null };
    try {
      const commits = [];
      let total = 0;
      for (let page = 1; page <= 3; page++) {
        const cmp = await gh.rest(`/repos/${r.full_name}/compare/${encodeURIComponent(base)}...${x.head}?per_page=100&page=${page}`);
        const list = Array.isArray(cmp.data?.commits) ? cmp.data.commits : [];
        total = Number(cmp.data?.total_commits) || total || list.length;
        commits.push(...list);
        if (list.length < 100 || commits.length >= total) break;
      }
      const rows = commits.map((c) => commitFromRest(r.id, c, x.branch, onDefault, cfg.agents)).filter(Boolean);
      row.commits_n = Math.max(total, rows.length);
      row.agent = rows.find((c) => c.agent)?.agent ?? null;
      // The commits first, the push last: a push row is the claim that its commits are stored.
      await store.batch([...commitStmts(rows), pushSql(row)]);
      out.commits += rows.length;
    } catch (e) {
      // GitHub cannot compare it (an unrelated branch, a before it no longer has): stored as known, without commits.
      if (e?.status === 404 || e?.status === 422) await store.batch([pushSql(row)]);
      else throw e;
    }
    out.pushes++;
  }
  if (todo.length <= 10) await store.run("UPDATE repos SET events_etag = ? WHERE id = ?", res.etag ?? null, r.id);
}

// ---------------------------------------------------------------------------------------------------- enrichment

/** Line counts for recent commits that came without them (REST compare), 25 per GraphQL request. */
async function fillStats(ctx, now) {
  const { store, gh } = ctx;
  const rows = await store.all(
    `SELECT c.repo_id, c.sha, r.full_name FROM commits c JOIN repos r ON r.id = c.repo_id
      WHERE c.at >= ? AND c.additions IS NULL AND r.removed = 0 ORDER BY c.at DESC LIMIT 50`, now - 3 * DAY);
  for (const part of chunks(rows, 25)) {
    if (!gh.can("graphql")) return;
    const q = commitStatsQuery(part.map((c) => ({ owner: c.full_name.split("/")[0], name: c.full_name.split("/")[1], sha: c.sha })));
    const { data } = await gh.graphql(q.query, q.variables);
    const stmts = part.map((c, i) => {
      const o = data?.[`c${i}`]?.object;
      if (!o) return { sql: "UPDATE commits SET additions = 0, deletions = 0 WHERE repo_id = ? AND sha = ? AND additions IS NULL", binds: [c.repo_id, c.sha] };
      const pr = o.associatedPullRequests?.nodes?.[0]?.number;
      return { sql: "UPDATE commits SET additions = ?, deletions = ?, files_n = COALESCE(?, files_n), pr_number = COALESCE(pr_number, ?) WHERE repo_id = ? AND sha = ?",
        binds: [o.additions ?? 0, o.deletions ?? 0, o.changedFilesIfAvailable ?? null, Number.isInteger(pr) ? pr : null, c.repo_id, c.sha] };
    });
    await store.batch(stmts);
  }
}

/**
 * The paths of the newest commits whose paths no webhook delivered, one REST request each, only while more than
 * half of the hour's allowance is left (people opening diffs come first).
 */
async function fillPaths(ctx, now) {
  const { store, gh } = ctx;
  const core = gh.rate().core;
  if (core && core.remaining < core.limit / 2) return;
  const rows = await store.all(
    `SELECT c.repo_id, c.sha, r.full_name FROM commits c JOIN repos r ON r.id = c.repo_id
      WHERE c.at >= ? AND c.paths_known = 0 AND r.removed = 0 ORDER BY c.at DESC LIMIT 8`, now - 2 * DAY);
  for (const c of rows) {
    if (!gh.can("core")) return;
    try {
      const res = await gh.rest(`/repos/${c.full_name}/commits/${c.sha}`);
      const files = Array.isArray(res.data?.files) ? res.data.files : [];
      await store.batch([
        ...files.slice(0, 300).map((f) => ({ sql: "INSERT OR IGNORE INTO commit_files (repo_id, sha, path) VALUES (?,?,?)", binds: [c.repo_id, c.sha, String(f.filename ?? "").slice(0, 500)] })),
        { sql: "UPDATE commits SET paths_known = 1, files_n = ?, additions = COALESCE(additions, ?), deletions = COALESCE(deletions, ?) WHERE repo_id = ? AND sha = ?",
          binds: [files.length, res.data?.stats?.additions ?? null, res.data?.stats?.deletions ?? null, c.repo_id, c.sha] },
      ]);
    } catch (e) {
      if (e?.status === 404 || e?.status === 422) await store.run("UPDATE commits SET paths_known = 1 WHERE repo_id = ? AND sha = ?", c.repo_id, c.sha);
      else throw e;
    }
  }
}

// ---------------------------------------------------------------------------------------------------- teams

/**
 * Teams from the TEAMS setting ({"platform": ["alice", "bob"]}) or from GitHub every 6 hours (needs the
 * organisation's Members: read). Without either, the team filter is simply empty.
 */
async function syncTeams(ctx, now) {
  const { store, cfg, gh } = ctx;
  if (now - Number((await getState(store, "teams_at")) ?? 0) < 6 * HOUR) return;
  if (cfg.teams) {
    const stmts = [{ sql: "DELETE FROM team_members", binds: [] }, { sql: "DELETE FROM teams", binds: [] }];
    for (const [name, members] of Object.entries(cfg.teams).slice(0, 500)) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
      if (!slug || !Array.isArray(members)) continue;
      stmts.push({ sql: "INSERT OR REPLACE INTO teams (slug, name) VALUES (?, ?)", binds: [slug, String(name).slice(0, 80)] });
      for (const m of members.slice(0, 2000)) if (typeof m === "string") stmts.push({ sql: "INSERT OR IGNORE INTO team_members (team, login) VALUES (?, ?)", binds: [slug, m.toLowerCase()] });
    }
    await store.batch(stmts);
    await setState(store, "teams_at", String(now), now);
    return;
  }
  if (!cfg.org) return;
  const progress = (await getJson(store, "teams_progress")) ?? { teams: null, i: 0 };
  if (!progress.teams) {
    const teams = [];
    let path = `/orgs/${encodeURIComponent(cfg.org)}/teams?per_page=100`;
    for (let p = 0; path && p < 10; p++) {
      const res = await gh.rest(path, { allow: [403, 404] });
      if (res.status !== 200) {
        // No Members permission: try again tomorrow, and say so on the status page.
        await setState(store, "teams_at", String(now + 18 * HOUR), now);
        await setState(store, "teams_note", "Teams need the organisation's Members: read permission", now);
        return;
      }
      for (const t of res.data ?? []) if (t?.slug) teams.push({ slug: String(t.slug).slice(0, 80), name: String(t.name ?? t.slug).slice(0, 80) });
      path = nextPage(res.link, cfg.apiUrl);
    }
    progress.teams = teams;
    progress.i = 0;
    progress.members = {};
  }
  // Members a team at a time; the list is replaced only when every team was read.
  while (progress.i < progress.teams.length) {
    if (!gh.can("core")) { await setState(store, "teams_progress", JSON.stringify(progress), now); return; }
    const t = progress.teams[progress.i];
    const logins = [];
    let path = `/orgs/${encodeURIComponent(cfg.org)}/teams/${encodeURIComponent(t.slug)}/members?per_page=100`;
    for (let p = 0; path && p < 20; p++) {
      const res = await gh.rest(path, { allow: [403, 404] });
      if (res.status !== 200) break;
      for (const m of res.data ?? []) if (m?.login) logins.push(String(m.login).toLowerCase());
      path = nextPage(res.link, cfg.apiUrl);
    }
    progress.members[t.slug] = logins;
    progress.i++;
    await setState(store, "teams_progress", JSON.stringify(progress), now);
  }
  const stmts = [{ sql: "DELETE FROM team_members", binds: [] }, { sql: "DELETE FROM teams", binds: [] }];
  for (const t of progress.teams) {
    stmts.push({ sql: "INSERT OR REPLACE INTO teams (slug, name) VALUES (?, ?)", binds: [t.slug, t.name] });
    for (const l of progress.members[t.slug] ?? []) stmts.push({ sql: "INSERT OR IGNORE INTO team_members (team, login) VALUES (?, ?)", binds: [t.slug, l] });
  }
  await store.batch(stmts);
  await setState(store, "teams_progress", "", now);
  await setState(store, "teams_note", "", now);
  await setState(store, "teams_at", String(now), now);
}

// ---------------------------------------------------------------------------------------------------- retention

/** Once a day: rows past RETENTION_DAYS go, and webhook delivery ids older than two days. */
export async function prune(store, cfg, now = Date.now()) {
  if (now - Number((await getState(store, "prune_at")) ?? 0) < DAY) return;
  const cut = now - cfg.retentionDays * DAY;
  await store.batch([
    { sql: "DELETE FROM commit_files WHERE (repo_id, sha) IN (SELECT repo_id, sha FROM commits WHERE at < ?)", binds: [cut] },
    { sql: "DELETE FROM commits WHERE at < ?", binds: [cut] },
    { sql: "DELETE FROM pushes WHERE at < ?", binds: [cut] },
    { sql: "DELETE FROM markers WHERE at < ?", binds: [cut] },
    { sql: "DELETE FROM ci WHERE at < ?", binds: [cut] },
    { sql: "DELETE FROM prs WHERE state = 'closed' AND updated_at < ?", binds: [cut] },
    { sql: "DELETE FROM people WHERE last_at < ?", binds: [cut] },
    { sql: "DELETE FROM deliveries WHERE at < ?", binds: [now - 2 * DAY] },
    stateStmt("prune_at", String(now), now),
  ]);
}
