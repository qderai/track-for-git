// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The read side: what the dashboard asks for. Every query is bounded (a range, a limit, a page) and every value is
 * bound; the filter's SQL is built from fixed fragments only.
 */
import { AGENT_SLOTS, agentName } from "./agents.js";
import { marks } from "./db.js";
import { DAY, HOUR, binSize, bucketStart, dayLabel, dayNumber, segments, validTz } from "./time.js";

const RANGES = { "1d": DAY, "7d": 7 * DAY, "30d": 30 * DAY, "90d": 90 * DAY };
const SHA = /^[0-9a-f]{40}$/;
const id = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null; };
const words = (v, max = 50) => String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, max);
const likeEsc = (s) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Pure. The filter of a request (URL search params): range, zone, repositories, team, people, agents, branch, path,
 * text, label. Anything malformed is dropped, never passed on.
 */
export function parseFilter(params, now = Date.now(), defaultTz = "") {
  const g = (k) => params.get(k);
  const range = RANGES[g("range")] ? g("range") : "7d";
  let to = Number(g("to")) || now + 60_000;
  let from = Number(g("from")) || to - RANGES[range];
  if (!(from < to)) from = to - RANGES[range];
  from = Math.max(from, to - 400 * DAY);
  return {
    range, from, to,
    tz: validTz(g("tz")) ? g("tz") : validTz(defaultTz) ? defaultTz : "UTC",
    repos: words(g("repos"), 200).map(id).filter(Boolean),
    team: (g("team") ?? "").slice(0, 80) || null,
    authors: words(g("author"), 30).map((s) => s.toLowerCase().slice(0, 80)),
    agents: words(g("agent"), 30).map((s) => s.toLowerCase().slice(0, 44)).filter((s) => /^[a-z0-9~._-]+$/.test(s)),
    branch: (g("branch") ?? "").slice(0, 200) || null,
    path: (g("path") ?? "").replace(/^\/+/, "").slice(0, 300) || null,
    q: (g("q") ?? "").trim().slice(0, 120) || null,
    label: (g("label") ?? "").slice(0, 50) || null,
  };
}

/** The "who" condition: "human" (a person alone), "bot", "agent" (any agent), or agent ids. */
function whoWhere(a, agents, binds) {
  if (!agents.length) return null;
  const ors = [];
  const ids = agents.filter((x) => !["human", "bot", "agent"].includes(x));
  if (agents.includes("human")) ors.push(`(${a}.agent IS NULL AND ${a}.bot = 0)`);
  if (agents.includes("bot")) ors.push(`(${a}.agent IS NULL AND ${a}.bot = 1)`);
  if (agents.includes("agent")) ors.push(`${a}.agent IS NOT NULL`);
  if (ids.length) { ors.push(`${a}.agent IN (${marks(ids)})`); binds.push(...ids); }
  return `(${ors.join(" OR ")})`;
}

/** The commit filter as SQL over alias `c`. */
export function commitWhere(f, { range = true } = {}) {
  const w = [], b = [];
  if (range) { w.push("c.at >= ?", "c.at < ?"); b.push(f.from, f.to); }
  if (f.repos.length) { w.push(`c.repo_id IN (${marks(f.repos)})`); b.push(...f.repos); }
  else w.push("c.repo_id NOT IN (SELECT id FROM repos WHERE removed = 1)");
  if (f.team) { w.push("c.author_login IN (SELECT login FROM team_members WHERE team = ?)"); b.push(f.team); }
  if (f.authors.length) { w.push(`c.author_login IN (${marks(f.authors)})`); b.push(...f.authors); }
  const who = whoWhere("c", f.agents, b);
  if (who) w.push(who);
  if (f.branch) { w.push("c.branch = ?"); b.push(f.branch); }
  if (f.path) { w.push("EXISTS (SELECT 1 FROM commit_files cf WHERE cf.repo_id = c.repo_id AND cf.sha = c.sha AND cf.path >= ? AND cf.path < ?)"); b.push(f.path, `${f.path}￿`); }
  if (f.q) {
    const q = likeEsc(f.q.toLowerCase());
    w.push("(lower(c.message) LIKE ? ESCAPE '\\' OR c.sha LIKE ? ESCAPE '\\' OR c.author_login LIKE ? ESCAPE '\\' OR lower(c.author_name) LIKE ? ESCAPE '\\')");
    b.push(`%${q}%`, `${q}%`, `%${q}%`, `%${q}%`);
  }
  return { where: w.join(" AND ") || "1", binds: b };
}

/** The pull request filter as SQL over alias `p` (no range: each state picks its own time column). */
export function prWhere(f) {
  const w = [], b = [];
  if (f.repos.length) { w.push(`p.repo_id IN (${marks(f.repos)})`); b.push(...f.repos); }
  else w.push("p.repo_id NOT IN (SELECT id FROM repos WHERE removed = 1)");
  if (f.team) { w.push("p.author_login IN (SELECT login FROM team_members WHERE team = ?)"); b.push(f.team); }
  if (f.authors.length) { w.push(`p.author_login IN (${marks(f.authors)})`); b.push(...f.authors); }
  const who = whoWhere("p", f.agents, b);
  if (who) w.push(who);
  if (f.branch) { w.push("(p.head_ref = ? OR p.base_ref = ?)"); b.push(f.branch, f.branch); }
  if (f.label) { w.push("EXISTS (SELECT 1 FROM json_each(p.labels) j WHERE j.value = ?)"); b.push(f.label); }
  if (f.q) {
    const num = /^#?(\d{1,7})$/.exec(f.q);
    if (num) { w.push("p.number = ?"); b.push(Number(num[1])); }
    else { w.push("(lower(p.title) LIKE ? ESCAPE '\\' OR p.author_login LIKE ? ESCAPE '\\')"); const q = `%${likeEsc(f.q.toLowerCase())}%`; b.push(q, q); }
  }
  return { where: w.join(" AND ") || "1", binds: b };
}

const subject = (m) => String(m ?? "").split("\n")[0].slice(0, 300);
const kindOf = (r) => r.agent ?? (r.bot ? "~bot" : "~human");

/** A commit row for the list. */
const commitOut = (c) => ({
  repo: Number(c.repo_id), repoName: c.full_name, sha: c.sha, at: Number(c.at), branch: c.branch, onDefault: !!c.on_default, author: c.author_login, authorName: c.author_name,
  agent: c.agent, bot: !!c.bot, subject: subject(c.message), additions: c.additions, deletions: c.deletions, files: c.files_n, pr: c.pr_number,
});

// ---------------------------------------------------------------------------------------------------- overview

/**
 * The overview: tiles (with the previous period for the main two), who wrote the code (people and each agent), the
 * timeline (lanes by repository, person or team, bins stacked by who), deploys and releases, and what needs attention.
 */
export async function overview(store, f, opts) {
  const { now = Date.now(), staleDays = 7, group = "repo", custom = [], extraMarkers = [] } = opts ?? {};
  const cw = commitWhere(f);
  const span = f.to - f.from;
  const prev = commitWhere({ ...f, from: f.from - span, to: f.from });
  const pw = prWhere(f);
  const stale = now - staleDays * DAY;

  const [tiles, prevTiles, who, prTiles, markerTiles, pushTiles] = await Promise.all([
    store.first(`SELECT COUNT(*) AS commits, COUNT(DISTINCT CASE WHEN c.bot = 0 AND c.author_login NOT LIKE '%[bot]' THEN c.author_login END) AS people, COUNT(DISTINCT c.repo_id) AS repos,
                   SUM(CASE WHEN c.agent IS NOT NULL THEN 1 ELSE 0 END) AS agent, COALESCE(SUM(c.additions), 0) AS additions, COALESCE(SUM(c.deletions), 0) AS deletions
                   FROM commits c WHERE ${cw.where}`, ...cw.binds),
    store.first(`SELECT COUNT(*) AS commits FROM commits c WHERE ${prev.where}`, ...prev.binds),
    store.all(`SELECT c.agent, c.bot, COUNT(*) AS n, COUNT(DISTINCT c.author_login) AS people FROM commits c WHERE ${cw.where} GROUP BY c.agent, c.bot ORDER BY n DESC`, ...cw.binds),
    store.first(`SELECT SUM(CASE WHEN p.created_at >= ? AND p.created_at < ? THEN 1 ELSE 0 END) AS opened,
                   SUM(CASE WHEN p.merged = 1 AND p.merged_at >= ? AND p.merged_at < ? THEN 1 ELSE 0 END) AS merged,
                   SUM(CASE WHEN p.merged = 1 AND p.merged_at >= ? AND p.merged_at < ? THEN 1 ELSE 0 END) AS mergedPrev,
                   SUM(CASE WHEN p.state = 'open' THEN 1 ELSE 0 END) AS open,
                   SUM(CASE WHEN p.state = 'open' AND p.draft = 0 AND p.updated_at < ? THEN 1 ELSE 0 END) AS stuck
                   FROM prs p WHERE ${pw.where}`, f.from, f.to, f.from, f.to, f.from - span, f.from, stale, ...pw.binds),
    store.first(`SELECT SUM(CASE WHEN kind = 'deploy' THEN 1 ELSE 0 END) AS deploys, SUM(CASE WHEN kind = 'release' THEN 1 ELSE 0 END) AS releases
                   FROM markers m WHERE m.at >= ? AND m.at < ?${f.repos.length ? ` AND m.repo_id IN (${marks(f.repos)})` : ""}`, f.from, f.to, ...f.repos),
    store.first(`SELECT COUNT(*) AS n FROM pushes s WHERE s.at >= ? AND s.at < ?${f.repos.length ? ` AND s.repo_id IN (${marks(f.repos)})` : ""}`, f.from, f.to, ...f.repos),
  ]);

  const total = Number(tiles?.commits ?? 0);
  const whoRows = who.map((r) => ({ id: kindOf(r), name: r.agent ? agentName(r.agent, custom) : null, commits: Number(r.n), people: Number(r.people) }));
  const extra = inRange(extraMarkers, f);
  return {
    range: { from: f.from, to: f.to, tz: f.tz },
    tiles: {
      commits: total, commitsPrev: Number(prevTiles?.commits ?? 0), people: Number(tiles?.people ?? 0), repos: Number(tiles?.repos ?? 0),
      pushes: Number(pushTiles?.n ?? 0), additions: Number(tiles?.additions ?? 0), deletions: Number(tiles?.deletions ?? 0),
      agentCommits: Number(tiles?.agent ?? 0), prsOpened: Number(prTiles?.opened ?? 0), prsMerged: Number(prTiles?.merged ?? 0),
      prsMergedPrev: Number(prTiles?.mergedPrev ?? 0), openPrs: Number(prTiles?.open ?? 0), stuckPrs: Number(prTiles?.stuck ?? 0),
      deploys: Number(markerTiles?.deploys ?? 0) + extra.filter((m) => m.kind === "deploy").length,
      releases: Number(markerTiles?.releases ?? 0) + extra.filter((m) => m.kind === "release").length,
    },
    who: whoRows,
    timeline: await timeline(store, f, group),
    markers: await markers(store, f, extra),
    attention: await attention(store, f, stale),
  };
}

const LANE = {
  repo: { key: "c.repo_id", join: "" },
  person: { key: "COALESCE(c.author_login, c.author_name, '?')", join: "" },
  team: { key: "COALESCE(tm.team, '~none')", join: "LEFT JOIN team_members tm ON tm.login = c.author_login" },
};

/**
 * The timeline: the ten busiest lanes (and "the rest" as one), each cut into bins in the viewer's zone, each bin
 * split by who made the commits (a person alone, each agent, bots).
 */
export async function timeline(store, f, group = "repo") {
  const lane = LANE[group] ?? LANE.repo;
  const cw = commitWhere(f);
  const top = await store.all(`SELECT ${lane.key} AS k, COUNT(*) AS n FROM commits c ${lane.join} WHERE ${cw.where} GROUP BY k ORDER BY n DESC LIMIT 11`, ...cw.binds);
  const keys = top.slice(0, 10).map((r) => r.k);
  const rest = top.length > 10;
  const size = binSize(f.from, f.to);
  const bins = new Map();
  for (const seg of segments(f.tz, f.from, f.to)) {
    const sw = commitWhere({ ...f, from: seg.from, to: seg.to });
    const rows = await store.all(
      `SELECT CASE WHEN ${lane.key} IN (${keys.length ? marks(keys) : "NULL"}) THEN ${lane.key} ELSE '~rest' END AS k,
              CAST((c.at + ?) / ? AS INTEGER) AS b, COALESCE(c.agent, CASE WHEN c.bot = 1 THEN '~bot' ELSE '~human' END) AS who,
              COUNT(*) AS n, MAX(c.at) AS last
         FROM commits c ${lane.join} WHERE ${sw.where} GROUP BY k, b, who`, ...keys, seg.offset, size, ...sw.binds);
    for (const r of rows) {
      const t = bucketStart(Number(r.b), size, seg.offset);
      const key = `${r.k}|${t}`;
      const bin = bins.get(key) ?? { lane: String(r.k), t, n: 0, who: {}, last: 0 };
      bin.n += Number(r.n);
      bin.who[r.who] = (bin.who[r.who] ?? 0) + Number(r.n);
      bin.last = Math.max(bin.last, Number(r.last));
      bins.set(key, bin);
    }
  }
  let names = {};
  if (group === "repo" && keys.length) {
    names = Object.fromEntries((await store.all(`SELECT id, full_name FROM repos WHERE id IN (${marks(keys)})`, ...keys)).map((r) => [String(r.id), r.full_name]));
  }
  const lanes = top.slice(0, 10).map((r) => ({ key: String(r.k), label: names[String(r.k)] ?? String(r.k), total: Number(r.n) }));
  if (rest) {
    const all = await store.first(`SELECT COUNT(*) AS n FROM commits c ${lane.join} WHERE ${cw.where}`, ...cw.binds);
    lanes.push({ key: "~rest", label: null, total: Number(all?.n ?? 0) - lanes.reduce((a, l) => a + l.total, 0) });
  }
  return { group, binMs: size, lanes, bins: [...bins.values()].sort((a, b) => a.t - b.t) };
}

/** Pure. The embedder's own markers (src/app.js hookMarkers, already shaped like markers()'s) inside the filter. */
const inRange = (list, f) => list.filter((m) => m.at >= f.from && m.at < f.to && (!f.repos.length || f.repos.includes(m.repo)));

/**
 * Deploys, releases and tags of the range (the newest 400), and among them the embedder's own deploys from outside
 * GitHub (`extra`, from hooks.markers), which are never stored.
 */
async function markers(store, f, extra = []) {
  const rows = await store.all(
    `SELECT m.id, m.repo_id, r.full_name, m.kind, m.name, m.environment, m.state, m.sha, m.at, m.finished_at, m.actor, m.url, m.prerelease
       FROM markers m JOIN repos r ON r.id = m.repo_id
      WHERE COALESCE(m.finished_at, m.at) >= ? AND COALESCE(m.finished_at, m.at) < ?${f.repos.length ? ` AND m.repo_id IN (${marks(f.repos)})` : ""}
      ORDER BY COALESCE(m.finished_at, m.at) DESC LIMIT 400`, f.from, f.to, ...f.repos);
  const own = rows.map((m) => ({ id: m.id, repo: Number(m.repo_id), repoName: m.full_name, kind: m.kind, name: m.name, environment: m.environment, state: m.state,
    sha: m.sha, at: Number(m.finished_at ?? m.at), actor: m.actor, url: m.url, prerelease: !!m.prerelease }));
  return extra.length ? [...own, ...inRange(extra, f)].sort((a, b) => b.at - a.at).slice(0, 400) : own;
}

/** Deploy states that mean "this is what runs now". */
const LIVE_STATES = ["success", "active"];

/**
 * What runs now, when the embedder does not say (hooks.live): the newest successful deploy, stored or the
 * embedder's own, preferring a production environment. Null when nothing was ever deployed.
 */
export async function liveNow(store, extra = []) {
  // The newest production deploy and the newest of any kind, each on its own: previews (one per pull request push)
  // can outnumber production many times over, so a short list of the newest would lose it.
  const sel = `SELECT m.repo_id, r.full_name, m.name, m.environment, m.sha, COALESCE(m.finished_at, m.at) AS at, m.url FROM markers m JOIN repos r ON r.id = m.repo_id
      WHERE m.kind = 'deploy' AND m.state IN (${marks(LIVE_STATES)}) AND m.sha IS NOT NULL`;
  const [prod, any] = await Promise.all([
    store.all(`${sel} AND LOWER(COALESCE(m.environment, '')) LIKE 'prod%' ORDER BY COALESCE(m.finished_at, m.at) DESC LIMIT 1`, ...LIVE_STATES),
    store.all(`${sel} ORDER BY COALESCE(m.finished_at, m.at) DESC LIMIT 1`, ...LIVE_STATES),
  ]);
  const all = [
    ...[...prod, ...any].map((m) => ({ repo: Number(m.repo_id), repoName: m.full_name, name: m.name, environment: m.environment, sha: m.sha, at: Number(m.at), url: m.url })),
    ...extra.filter((m) => m.kind === "deploy" && LIVE_STATES.includes(m.state) && m.sha),
  ].sort((a, b) => b.at - a.at);
  const pick = all.find((m) => /^prod/i.test(m.environment ?? "")) ?? all[0];
  return pick ? { repo: pick.repo, repoName: pick.repoName, sha: pick.sha, environment: pick.environment ?? null, name: pick.name ?? null, at: pick.at, url: pick.url ?? null } : null;
}

/** What a manager should look at: stuck pull requests, failing CI, changes requested (five of each). */
async function attention(store, f, stale) {
  const pw = prWhere(f);
  const sel = `SELECT p.*, r.full_name, pe.name AS author_name, ci.state AS ci FROM prs p JOIN repos r ON r.id = p.repo_id LEFT JOIN people pe ON pe.login = p.author_login LEFT JOIN ci ON ci.repo_id = p.repo_id AND ci.sha = p.head_sha WHERE ${pw.where} AND p.state = 'open' AND p.draft = 0`;
  const [stuck, failing, changes] = await Promise.all([
    store.all(`${sel} AND p.updated_at < ? ORDER BY p.updated_at ASC LIMIT 5`, ...pw.binds, stale),
    store.all(`${sel} AND ci.state = 'failure' ORDER BY p.updated_at DESC LIMIT 5`, ...pw.binds),
    store.all(`${sel} AND p.review = 'changes_requested' ORDER BY p.updated_at ASC LIMIT 5`, ...pw.binds),
  ]);
  return { stuck: stuck.map(prOut), failing: failing.map(prOut), changes: changes.map(prOut) };
}

// ---------------------------------------------------------------------------------------------------- heatmap

/** Commits per row (repository, person or team) per day in the viewer's zone (per hour for a range of two days or less). */
export async function heatmap(store, f, by = "repo") {
  const lane = LANE[by] ?? LANE.repo;
  const cw = commitWhere(f);
  const top = await store.all(`SELECT ${lane.key} AS k, COUNT(*) AS n FROM commits c ${lane.join} WHERE ${cw.where} GROUP BY k ORDER BY n DESC LIMIT 15`, ...cw.binds);
  const keys = top.map((r) => r.k);
  const hourly = f.to - f.from <= 2.01 * DAY;
  // Columns, oldest first: every local day of the range, or every hour (hours are UTC instants; the page labels them
  // in the viewer's zone).
  const cols = [];
  const colIndex = new Map();
  if (hourly) for (let h = Math.floor(f.from / HOUR); h * HOUR < f.to; h++) { colIndex.set(h, cols.length); cols.push(h * HOUR); }
  else for (let d = dayNumber(f.tz, f.from); d <= dayNumber(f.tz, f.to - 1); d++) { colIndex.set(d, cols.length); cols.push(dayLabel(d)); }
  const rowIndex = new Map(keys.map((k, i) => [String(k), i]));
  const cells = new Map();
  if (keys.length) {
    const pieces = hourly ? [{ from: f.from, to: f.to, offset: 0 }] : segments(f.tz, f.from, f.to);
    for (const seg of pieces) {
      const sw = commitWhere({ ...f, from: seg.from, to: seg.to });
      const rows = await store.all(`SELECT ${lane.key} AS k, CAST((c.at + ?) / ? AS INTEGER) AS b, COUNT(*) AS n FROM commits c ${lane.join}
                                     WHERE ${sw.where} AND ${lane.key} IN (${marks(keys)}) GROUP BY k, b`, seg.offset, hourly ? HOUR : DAY, ...sw.binds, ...keys);
      for (const r of rows) {
        const ri = rowIndex.get(String(r.k)), ci = colIndex.get(Number(r.b));
        if (ri === undefined || ci === undefined) continue;
        cells.set(`${ri}|${ci}`, (cells.get(`${ri}|${ci}`) ?? 0) + Number(r.n));
      }
    }
  }
  let names = {};
  if (by === "repo" && keys.length) names = Object.fromEntries((await store.all(`SELECT id, full_name FROM repos WHERE id IN (${marks(keys)})`, ...keys)).map((r) => [String(r.id), r.full_name]));
  return {
    by, unit: hourly ? "hour" : "day", cols,
    rows: top.map((r) => ({ key: String(r.k), label: names[String(r.k)] ?? String(r.k), total: Number(r.n) })),
    cells: [...cells].map(([k, n]) => [...k.split("|").map(Number), n]),
  };
}

// ---------------------------------------------------------------------------------------------------- lists

/** A page of commits, newest first; `cursor` is the last row of the page above ("at:repo:sha"). */
export async function commitPage(store, f, cursor, limit = 100) {
  const cw = commitWhere(f);
  const where = [cw.where], binds = [...cw.binds];
  const [cAt, cRepo, cSha] = String(cursor ?? "").split(":");
  const before = cursor && Number.isFinite(Number(cAt)) && id(cRepo) && SHA.test(cSha ?? "");
  if (before) {
    where.push("(c.at < ? OR (c.at = ? AND (c.repo_id < ? OR (c.repo_id = ? AND c.sha < ?))))");
    binds.push(Number(cAt), Number(cAt), Number(cRepo), Number(cRepo), cSha);
  }
  const rows = await store.all(`SELECT c.*, r.full_name FROM commits c JOIN repos r ON r.id = c.repo_id WHERE ${where.join(" AND ")}
                                ORDER BY c.at DESC, c.repo_id DESC, c.sha DESC LIMIT ?`, ...binds, Math.min(Math.max(limit, 1), 200) + 1);
  const more = rows.length > limit;
  const items = rows.slice(0, limit).map(commitOut);
  const last = items.at(-1);
  const total = before ? null : Number((await store.first(`SELECT COUNT(*) AS n FROM commits c WHERE ${cw.where}`, ...cw.binds))?.n ?? 0);
  return { items, total, next: more && last ? `${last.at}:${last.repo}:${last.sha}` : null };
}

/** A page of pushes, newest first. */
export async function pushPage(store, f, cursor, limit = 100) {
  const w = ["s.at >= ?", "s.at < ?"], b = [f.from, f.to];
  if (f.repos.length) { w.push(`s.repo_id IN (${marks(f.repos)})`); b.push(...f.repos); }
  if (f.branch) { w.push("s.branch = ?"); b.push(f.branch); }
  if (f.authors.length) { w.push(`s.actor IN (${marks(f.authors)})`); b.push(...f.authors); }
  if (f.team) { w.push("s.actor IN (SELECT login FROM team_members WHERE team = ?)"); b.push(f.team); }
  const [cAt, cId] = [String(cursor ?? "").split("|")[0], String(cursor ?? "").split("|").slice(1).join("|")];
  if (cursor && Number.isFinite(Number(cAt)) && cId) { w.push("(s.at < ? OR (s.at = ? AND s.id < ?))"); b.push(Number(cAt), Number(cAt), cId); }
  const rows = await store.all(`SELECT s.*, r.full_name FROM pushes s JOIN repos r ON r.id = s.repo_id WHERE ${w.join(" AND ")} ORDER BY s.at DESC, s.id DESC LIMIT ?`, ...b, limit + 1);
  const items = rows.slice(0, limit).map((s) => ({ id: s.id, repo: Number(s.repo_id), repoName: s.full_name, branch: s.branch, at: Number(s.at), actor: s.actor,
    head: s.head, commits: Number(s.commits_n), forced: !!s.forced, created: !!s.created, agent: s.agent }));
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? `${last.at}|${last.id}` : null };
}

const prOut = (p) => ({
  repo: Number(p.repo_id), repoName: p.full_name, number: Number(p.number), title: p.title, state: p.merged ? "merged" : p.state, draft: !!p.draft,
  author: p.author_login, authorName: p.author_name ?? null, agent: p.agent, bot: !!p.bot, head: p.head_ref, base: p.base_ref, headSha: p.head_sha,
  createdAt: p.created_at, updatedAt: p.updated_at, mergedAt: p.merged_at, closedAt: p.closed_at, review: p.review, ci: p.ci ?? null,
  additions: p.additions, deletions: p.deletions, files: p.files_n, labels: safeJson(p.labels), url: p.url,
});
const safeJson = (s) => { try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } };

const PR_STATES = {
  open: { where: "p.state = 'open'", order: "p.updated_at DESC" },
  stuck: { where: "p.state = 'open' AND p.draft = 0 AND p.updated_at < ?", order: "p.updated_at ASC", stale: true },
  merged: { where: "p.merged = 1 AND p.merged_at >= ? AND p.merged_at < ?", order: "p.merged_at DESC", range: true },
  closed: { where: "p.state = 'closed' AND p.merged = 0 AND p.closed_at >= ? AND p.closed_at < ?", order: "p.closed_at DESC", range: true },
  all: { where: "(p.state = 'open' OR (p.updated_at >= ? AND p.updated_at < ?))", order: "p.updated_at DESC", range: true },
};
const PR_SORTS = { updated: "p.updated_at DESC", oldest: "p.created_at ASC", largest: "(COALESCE(p.additions, 0) + COALESCE(p.deletions, 0)) DESC" };

/** A page of pull requests in one state, with the count of every state for the switcher. */
export async function prPage(store, f, { state = "open", sort = "", offset = 0, limit = 100, now = Date.now(), staleDays = 7 } = {}) {
  const st = PR_STATES[state] ?? PR_STATES.open;
  const pw = prWhere(f);
  const stale = now - staleDays * DAY;
  const stBinds = st.stale ? [stale] : st.range ? [f.from, f.to] : [];
  const order = PR_SORTS[sort] ?? st.order;
  const off = Math.min(Math.max(Number(offset) || 0, 0), 100_000);
  const rows = await store.all(
    `SELECT p.*, r.full_name, pe.name AS author_name, ci.state AS ci FROM prs p JOIN repos r ON r.id = p.repo_id LEFT JOIN people pe ON pe.login = p.author_login LEFT JOIN ci ON ci.repo_id = p.repo_id AND ci.sha = p.head_sha
      WHERE ${pw.where} AND ${st.where} ORDER BY ${order}, p.repo_id DESC, p.number DESC LIMIT ? OFFSET ?`, ...pw.binds, ...stBinds, limit + 1, off);
  const counts = await store.first(
    `SELECT SUM(CASE WHEN p.state = 'open' THEN 1 ELSE 0 END) AS open,
            SUM(CASE WHEN p.state = 'open' AND p.draft = 0 AND p.updated_at < ? THEN 1 ELSE 0 END) AS stuck,
            SUM(CASE WHEN p.merged = 1 AND p.merged_at >= ? AND p.merged_at < ? THEN 1 ELSE 0 END) AS merged,
            SUM(CASE WHEN p.state = 'closed' AND p.merged = 0 AND p.closed_at >= ? AND p.closed_at < ? THEN 1 ELSE 0 END) AS closed
       FROM prs p WHERE ${pw.where}`, stale, f.from, f.to, f.from, f.to, ...pw.binds);
  return {
    items: rows.slice(0, limit).map(prOut),
    next: rows.length > limit ? String(off + limit) : null,
    counts: { open: Number(counts?.open ?? 0), stuck: Number(counts?.stuck ?? 0), merged: Number(counts?.merged ?? 0), closed: Number(counts?.closed ?? 0) },
  };
}

/** One commit's row. */
export async function commitRow(store, repoId, sha) {
  const c = await store.first("SELECT c.*, r.full_name FROM commits c JOIN repos r ON r.id = c.repo_id WHERE c.repo_id = ? AND c.sha = ?", repoId, sha);
  return c ? { ...commitOut(c), message: String(c.message ?? "") } : null;
}

/** One pull request's row, and the commits of it the dashboard has seen. */
export async function prRowOut(store, repoId, number) {
  const p = await store.first(`SELECT p.*, r.full_name, pe.name AS author_name, ci.state AS ci FROM prs p JOIN repos r ON r.id = p.repo_id LEFT JOIN people pe ON pe.login = p.author_login LEFT JOIN ci ON ci.repo_id = p.repo_id AND ci.sha = p.head_sha
                               WHERE p.repo_id = ? AND p.number = ?`, repoId, number);
  if (!p) return null;
  const commits = await store.all(`SELECT c.*, r.full_name FROM commits c JOIN repos r ON r.id = c.repo_id WHERE c.repo_id = ? AND (c.pr_number = ? OR (c.branch = ? AND c.on_default = 0))
                                   ORDER BY c.at DESC LIMIT 100`, repoId, number, p.head_ref ?? "\u0000");
  return { ...prOut(p), commits: commits.map(commitOut) };
}

// ---------------------------------------------------------------------------------------------------- story

/**
 * The calm version for people who do not read diffs: one card per day of the range (31 at most), newest first: how
 * much happened, who, the busiest repositories, the pull requests merged, what was deployed and released.
 */
export async function story(store, f, custom = [], extraMarkers = []) {
  const from = Math.max(f.from, f.to - 31 * DAY);
  const g = { ...f, from };
  const days = new Map();
  const day = (d) => { let v = days.get(d); if (!v) { v = { day: dayLabel(d), commits: 0, people: 0, repoCount: 0, agentCommits: 0, agents: {}, repos: [], merged: [], deploys: [], releases: [] }; days.set(d, v); } return v; };
  for (const seg of segments(f.tz, from, f.to)) {
    const sw = commitWhere({ ...g, from: seg.from, to: seg.to });
    const totals = await store.all(`SELECT CAST((c.at + ?) / ? AS INTEGER) AS d, COUNT(*) AS n, COUNT(DISTINCT c.author_login) AS people, COUNT(DISTINCT c.repo_id) AS repos,
                                      SUM(CASE WHEN c.agent IS NOT NULL THEN 1 ELSE 0 END) AS agent FROM commits c WHERE ${sw.where} GROUP BY d`, seg.offset, DAY, ...sw.binds);
    for (const r of totals) { const v = day(Number(r.d)); v.commits += Number(r.n); v.people += Number(r.people); v.repoCount += Number(r.repos); v.agentCommits += Number(r.agent); }
    const agents = await store.all(`SELECT CAST((c.at + ?) / ? AS INTEGER) AS d, c.agent, COUNT(*) AS n FROM commits c WHERE ${sw.where} AND c.agent IS NOT NULL GROUP BY d, c.agent`,
      seg.offset, DAY, ...sw.binds);
    for (const r of agents) { const v = day(Number(r.d)); v.agents[r.agent] = (v.agents[r.agent] ?? 0) + Number(r.n); }
    const repos = await store.all(`SELECT x.d, x.repo_id, r.full_name, x.n FROM (
                                     SELECT d, repo_id, n, ROW_NUMBER() OVER (PARTITION BY d ORDER BY n DESC) AS rk FROM (
                                       SELECT CAST((c.at + ?) / ? AS INTEGER) AS d, c.repo_id, COUNT(*) AS n FROM commits c WHERE ${sw.where} GROUP BY d, c.repo_id)) x
                                   JOIN repos r ON r.id = x.repo_id WHERE x.rk <= 3 ORDER BY x.d, x.n DESC`, seg.offset, DAY, ...sw.binds);
    for (const r of repos) day(Number(r.d)).repos.push({ repo: Number(r.repo_id), name: r.full_name, commits: Number(r.n) });
  }
  const pw = prWhere(g);
  const merged = await store.all(`SELECT p.*, r.full_name, pe.name AS author_name, NULL AS ci FROM prs p JOIN repos r ON r.id = p.repo_id LEFT JOIN people pe ON pe.login = p.author_login WHERE ${pw.where} AND p.merged = 1 AND p.merged_at >= ? AND p.merged_at < ?
                                  ORDER BY p.merged_at DESC LIMIT 600`, ...pw.binds, from, f.to);
  for (const p of merged) day(dayNumber(f.tz, Number(p.merged_at))).merged.push(prOut(p));
  const ms = await markers(store, g, extraMarkers);
  for (const m of ms) if (m.kind !== "tag") day(dayNumber(f.tz, m.at))[m.kind === "deploy" ? "deploys" : "releases"].push(m);
  const out = [...days.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => ({
    ...v,
    agents: Object.entries(v.agents).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ id: k, name: agentName(k, custom), commits: n })),
    mergedCount: v.merged.length,
    merged: v.merged.sort((a, b) => (b.additions ?? 0) + (b.deletions ?? 0) - (a.additions ?? 0) - (a.deletions ?? 0)).slice(0, 6),
    deploysCount: v.deploys.length,
    deploys: v.deploys.slice(0, 6),
  }));
  return { days: out };
}

// ---------------------------------------------------------------------------------------------------- facets

/** What the filters offer: repositories, teams, people, agents, branches, labels. */
export async function facets(store, now = Date.now(), custom = []) {
  const [repos, teams, people, agents, branches, labels] = await Promise.all([
    store.all("SELECT id, full_name, archived, private FROM repos WHERE removed = 0 ORDER BY full_name COLLATE NOCASE LIMIT 5000"),
    store.all("SELECT t.slug, t.name, COUNT(m.login) AS members FROM teams t LEFT JOIN team_members m ON m.team = t.slug GROUP BY t.slug ORDER BY t.name COLLATE NOCASE"),
    store.all("SELECT login, name FROM people ORDER BY last_at DESC LIMIT 3000"),
    store.all("SELECT agent, COUNT(*) AS n FROM commits WHERE at >= ? AND agent IS NOT NULL GROUP BY agent ORDER BY n DESC LIMIT 60", now - 90 * DAY),
    store.all("SELECT branch, MAX(at) AS last FROM pushes WHERE at >= ? AND branch IS NOT NULL GROUP BY branch ORDER BY last DESC LIMIT 300", now - 30 * DAY),
    store.all("SELECT j.value AS label, COUNT(*) AS n FROM prs p, json_each(p.labels) j WHERE p.updated_at >= ? GROUP BY j.value ORDER BY n DESC LIMIT 200", now - 90 * DAY),
  ]);
  const defaults = await store.all("SELECT DISTINCT default_branch AS branch FROM repos WHERE removed = 0 AND default_branch IS NOT NULL LIMIT 20");
  const branchSet = [...new Set([...defaults.map((r) => r.branch), ...branches.map((r) => r.branch)])];
  return {
    repos: repos.map((r) => ({ id: Number(r.id), name: r.full_name, archived: !!r.archived, private: !!r.private })),
    teams: teams.map((t) => ({ slug: t.slug, name: t.name, members: Number(t.members) })),
    people: people.map((p) => ({ login: p.login, name: p.name })),
    agents: agents.map((a) => ({ id: a.agent, name: agentName(a.agent, custom), commits: Number(a.n), slot: AGENT_SLOTS[a.agent] ?? null })),
    branches: branchSet,
    labels: labels.map((l) => l.label),
  };
}
