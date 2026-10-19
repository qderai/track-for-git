// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Pure. GitHub's objects (webhook payloads, REST answers, GraphQL nodes) into the rows of migrations/0001_init.sql,
 * and the SQL that stores them. Every text from GitHub is capped; every URL kept is checked to be GitHub's own.
 */
import { detectAgent } from "../agents.js";

export const SHA = /^[0-9a-f]{40}$/;
const ZERO = /^0{40}$/;
const ms = (iso) => { const t = Date.parse(String(iso ?? "")); return Number.isFinite(t) ? t : null; };
const cap = (s, n) => { const v = String(s ?? "").slice(0, n); return v || null; };
const lc = (s) => (s ? String(s).toLowerCase().slice(0, 80) : null);
export const branchOf = (ref) => cap(String(ref ?? "").replace(/^refs\/heads\//, ""), 200);
const insiders = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The same id from the webhook and from polling: one head pushed to one branch. */
export const pushId = (repoId, branch, head) => `push:${repoId}:${branch ?? ""}:${head}`;

/**
 * @typedef {{ repo_id: number, sha: string, at: number, branch: string|null, on_default: number, author_login: string|null,
 *   author_name: string|null, agent: string|null, bot: number, message: string, additions: number|null, deletions: number|null,
 *   files_n: number|null, pr_number: number|null, paths?: string[] }} CommitRow
 */

/** A webhook's repository into a repos row. */
export function repoFromPayload(r) {
  const id = Number(r?.id);
  if (!Number.isInteger(id) || id <= 0 || !r?.full_name) return null;
  const pushed = typeof r.pushed_at === "number" ? r.pushed_at * 1000 : ms(r.pushed_at);
  return { id, full_name: String(r.full_name).slice(0, 200), default_branch: cap(r.default_branch, 200), private: r.private ? 1 : 0, archived: r.archived ? 1 : 0, pushed_at: pushed };
}

/** A push webhook into its push row and commit rows (with the paths each commit touched). */
export function pushFromWebhook(p, agents = [], now = Date.now()) {
  const repo = repoFromPayload(p?.repository);
  const head = String(p?.after ?? "");
  if (!repo || !SHA.test(head) || ZERO.test(head)) return null;          // a deleted branch has no head
  const ref = String(p?.ref ?? "");
  if (!ref.startsWith("refs/heads/")) return null;                       // tags are handled as markers
  const branch = branchOf(ref);
  const onDefault = branch && branch === repo.default_branch ? 1 : 0;
  const at = repo.pushed_at ?? now;
  const commits = (Array.isArray(p?.commits) ? p.commits : []).map((c) => {
    const sha = String(c?.id ?? "");
    if (!SHA.test(sha)) return null;
    const who = detectAgent({ login: c?.author?.username, name: c?.author?.name, email: c?.author?.email,
      committerLogin: c?.committer?.username, committerName: c?.committer?.name, committerEmail: c?.committer?.email, message: c?.message }, agents);
    const paths = [...(c?.added ?? []), ...(c?.modified ?? []), ...(c?.removed ?? [])].filter((x) => typeof x === "string").slice(0, 300);
    return {
      repo_id: repo.id, sha, at: ms(c?.timestamp) ?? at, branch, on_default: onDefault, author_login: lc(c?.author?.username), author_name: cap(c?.author?.name, 120),
      agent: who.agent, bot: who.bot ? 1 : 0, message: String(c?.message ?? "").slice(0, 4000), additions: null, deletions: null,
      files_n: paths.length || null, pr_number: null, paths,
    };
  }).filter(Boolean);
  const pusher = lc(p?.sender?.login) ?? lc(p?.pusher?.name);
  const agentOf = commits.find((c) => c.agent)?.agent ?? null;
  return {
    repo,
    push: { id: pushId(repo.id, branch, head), repo_id: repo.id, branch, at, actor: pusher, head, before: SHA.test(String(p?.before)) ? p.before : null,
      commits_n: commits.length, forced: p?.forced ? 1 : 0, created: p?.created ? 1 : 0, agent: agentOf },
    commits,
  };
}

/** A REST commit (list, compare, single) into a row. */
export function commitFromRest(repoId, c, branch, onDefault, agents = []) {
  const sha = String(c?.sha ?? "");
  if (!SHA.test(sha)) return null;
  const message = String(c?.commit?.message ?? "");
  const who = detectAgent({ login: c?.author?.login, name: c?.commit?.author?.name, email: c?.commit?.author?.email,
    committerLogin: c?.committer?.login, committerName: c?.commit?.committer?.name, committerEmail: c?.commit?.committer?.email, message }, agents);
  return {
    repo_id: repoId, sha, at: ms(c?.commit?.author?.date) ?? ms(c?.commit?.committer?.date) ?? Date.now(), branch, on_default: onDefault ? 1 : 0,
    author_login: lc(c?.author?.login), author_name: cap(c?.commit?.author?.name, 120), agent: who.agent, bot: who.bot ? 1 : 0,
    message: message.slice(0, 4000), additions: Number.isFinite(c?.stats?.additions) ? c.stats.additions : null,
    deletions: Number.isFinite(c?.stats?.deletions) ? c.stats.deletions : null, files_n: Array.isArray(c?.files) ? c.files.length : null, pr_number: null,
  };
}

/** A GraphQL Commit node (default-branch history) into a row: it carries its line counts. */
export function commitFromGraph(repoId, n, branch, agents = []) {
  const sha = String(n?.oid ?? "");
  if (!SHA.test(sha)) return null;
  const message = String(n?.message ?? "");
  const who = detectAgent({ login: n?.author?.user?.login, name: n?.author?.name, email: n?.author?.email,
    committerLogin: n?.committer?.user?.login, committerName: n?.committer?.name, committerEmail: n?.committer?.email, message }, agents);
  const pr = n?.associatedPullRequests?.nodes?.[0]?.number;
  return {
    repo_id: repoId, sha, at: ms(n?.authoredDate) ?? ms(n?.committedDate) ?? Date.now(), branch, on_default: 1,
    author_login: lc(n?.author?.user?.login), author_name: cap(n?.author?.name, 120), agent: who.agent, bot: who.bot ? 1 : 0,
    message: message.slice(0, 4000), additions: Number.isFinite(n?.additions) ? n.additions : null, deletions: Number.isFinite(n?.deletions) ? n.deletions : null,
    files_n: Number.isFinite(n?.changedFilesIfAvailable) ? n.changedFilesIfAvailable : null, pr_number: Number.isInteger(pr) ? pr : null,
  };
}

const ghUrl = (u, web) => (typeof u === "string" && (u.startsWith("https://github.com/") || (web && u.startsWith(`${web}/`))) ? u.slice(0, 400) : null);
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

/**
 * A pull request from a webhook or REST (snake_case) or GraphQL (camelCase) into a row. Its branch counts as evidence
 * of an agent only when its author is inside the organisation and it does not come from a fork: anyone can name a
 * branch claude/ on a public repository.
 */
export function prRow(repoId, pr, agents = [], web = "https://github.com") {
  const number = Number(pr?.number);
  if (!Number.isInteger(number) || number <= 0) return null;
  const graph = "headRefName" in (pr ?? {}) || "isDraft" in (pr ?? {});
  const login = graph ? pr?.author?.login : pr?.user?.login;
  const assoc = String((graph ? pr?.authorAssociation : pr?.author_association) ?? "").toUpperCase();
  const fork = graph ? !!pr?.isCrossRepository : !!(pr?.head?.repo?.full_name && pr?.base?.repo?.full_name && pr.head.repo.full_name !== pr.base.repo.full_name);
  const head = cap(graph ? pr?.headRefName : pr?.head?.ref, 200);
  const who = detectAgent({ login, name: login, message: pr?.body ? String(pr.body).slice(-2000) : "", branch: head, insider: insiders.has(assoc) && !fork }, agents);
  const labels = (graph ? pr?.labels?.nodes : pr?.labels) ?? [];
  const merged = graph ? !!pr?.merged : !!(pr?.merged || pr?.merged_at);
  const state = String(pr?.state ?? "").toLowerCase();
  const reviewRaw = graph ? pr?.reviewDecision : null;
  return {
    repo_id: repoId, number, title: String(pr?.title ?? "").slice(0, 300), state: state === "open" ? "open" : "closed", merged: merged ? 1 : 0,
    draft: (graph ? pr?.isDraft : pr?.draft) ? 1 : 0, author_login: lc(login), agent: who.agent, bot: who.bot ? 1 : 0,
    head_ref: head, base_ref: cap(graph ? pr?.baseRefName : pr?.base?.ref, 200),
    head_sha: SHA.test(String(graph ? pr?.headRefOid : pr?.head?.sha)) ? (graph ? pr.headRefOid : pr.head.sha) : null,
    created_at: ms(graph ? pr?.createdAt : pr?.created_at), updated_at: ms(graph ? pr?.updatedAt : pr?.updated_at),
    merged_at: ms(graph ? pr?.mergedAt : pr?.merged_at), closed_at: ms(graph ? pr?.closedAt : pr?.closed_at),
    review: reviewRaw ? REVIEW[reviewRaw] ?? null : undefined,
    additions: Number.isFinite(pr?.additions) ? pr.additions : null, deletions: Number.isFinite(pr?.deletions) ? pr.deletions : null,
    files_n: Number.isFinite(graph ? pr?.changedFiles : pr?.changed_files) ? (graph ? pr.changedFiles : pr.changed_files) : null,
    labels: JSON.stringify(labels.map((l) => String(l?.name ?? "")).filter(Boolean).slice(0, 20).map((s) => s.slice(0, 50))),
    url: ghUrl(graph ? pr?.url : pr?.html_url, web),
    ci: graph ? ciOf(pr?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state) : undefined,
  };
}

/** Pure. GitHub's states (rollup, check conclusion, commit status) into success | failure | pending. */
export function ciOf(state) {
  const s = String(state ?? "").toLowerCase();
  if (!s) return null;
  if (["success", "neutral", "skipped"].includes(s)) return "success";
  if (["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure", "stale"].includes(s)) return "failure";
  return "pending";
}

/** Pure. A GraphQL Deployment node into a marker row. */
export function deployMarker(repoId, d) {
  const id = Number(d?.databaseId ?? d?.id);
  if (!Number.isFinite(id)) return null;
  const st = String(d?.latestStatus?.state ?? d?.state ?? "pending").toLowerCase();
  return {
    id: `deploy:${repoId}:${id}`, repo_id: repoId, kind: "deploy", name: cap(d?.environment, 80), environment: cap(d?.environment, 80), state: st,
    sha: SHA.test(String(d?.commitOid ?? d?.sha)) ? (d.commitOid ?? d.sha) : null, ref: cap(d?.ref?.name ?? d?.ref, 200),
    at: ms(d?.createdAt ?? d?.created_at) ?? Date.now(), finished_at: ["success", "failure", "error", "inactive"].includes(st) ? ms(d?.latestStatus?.createdAt ?? d?.updated_at) : null,
    actor: lc(d?.creator?.login), url: null, prerelease: 0,
  };
}

/** Pure. A release (GraphQL or webhook) into a marker row; drafts are not shown. */
export function releaseMarker(repoId, r, web = "https://github.com") {
  const id = Number(r?.databaseId ?? r?.id);
  if (!Number.isFinite(id) || r?.isDraft || r?.draft) return null;
  return {
    id: `release:${repoId}:${id}`, repo_id: repoId, kind: "release", name: cap(r?.name || r?.tagName || r?.tag_name, 120), environment: null, state: "published",
    sha: SHA.test(String(r?.tagCommit?.oid)) ? r.tagCommit.oid : null, ref: cap(r?.tagName ?? r?.tag_name, 200),
    at: ms(r?.publishedAt ?? r?.published_at ?? r?.createdAt ?? r?.created_at) ?? Date.now(), finished_at: null,
    actor: lc(r?.author?.login), url: ghUrl(r?.url ?? r?.html_url, web), prerelease: r?.isPrerelease || r?.prerelease ? 1 : 0,
  };
}

/** Pure. A tag ref (GraphQL) into a marker row, dated by the commit it points at. */
export function tagMarker(repoId, t) {
  const name = cap(t?.name, 200);
  if (!name) return null;
  const target = t?.target?.target ?? t?.target;
  const at = ms(target?.committedDate ?? t?.target?.tagger?.date);
  if (!at) return null;
  return { id: `tag:${repoId}:${name}`, repo_id: repoId, kind: "tag", name, environment: null, state: null, sha: SHA.test(String(target?.oid)) ? target.oid : null,
    ref: name, at, finished_at: null, actor: null, url: null, prerelease: 0 };
}

// ---------------------------------------------------------------------------------------------------- the SQL

export const repoSql = (r) => ({
  sql: `INSERT INTO repos (id, full_name, default_branch, private, archived, removed, pushed_at) VALUES (?,?,?,?,?,0,?)
        ON CONFLICT(id) DO UPDATE SET full_name = excluded.full_name, default_branch = COALESCE(excluded.default_branch, repos.default_branch),
          private = excluded.private, archived = excluded.archived, removed = 0, pushed_at = MAX(COALESCE(repos.pushed_at, 0), COALESCE(excluded.pushed_at, 0))`,
  binds: [r.id, r.full_name, r.default_branch, r.private, r.archived, r.pushed_at ?? null],
});

/**
 * A commit first seen on a branch keeps that branch; once seen on the default branch it counts there. Totals and the
 * pull request number fill in when a later source knows them.
 */
export const commitSql = (c) => ({
  sql: `INSERT INTO commits (repo_id, sha, at, branch, on_default, author_login, author_name, agent, bot, message, additions, deletions, files_n, pr_number, paths_known)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(repo_id, sha) DO UPDATE SET branch = COALESCE(commits.branch, excluded.branch), on_default = MAX(commits.on_default, excluded.on_default),
          author_login = COALESCE(commits.author_login, excluded.author_login), agent = COALESCE(commits.agent, excluded.agent),
          additions = COALESCE(excluded.additions, commits.additions), deletions = COALESCE(excluded.deletions, commits.deletions),
          files_n = COALESCE(excluded.files_n, commits.files_n), pr_number = COALESCE(excluded.pr_number, commits.pr_number),
          paths_known = MAX(commits.paths_known, excluded.paths_known)`,
  binds: [c.repo_id, c.sha, c.at, c.branch, c.on_default, c.author_login, c.author_name, c.agent, c.bot, c.message, c.additions, c.deletions, c.files_n, c.pr_number, c.paths?.length ? 1 : 0],
});

export const pathSqls = (c) => (c.paths ?? []).map((path) => ({ sql: "INSERT OR IGNORE INTO commit_files (repo_id, sha, path) VALUES (?,?,?)", binds: [c.repo_id, c.sha, String(path).slice(0, 500)] }));

export const personSql = (c) => c.author_login && !c.bot ? ({
  sql: `INSERT INTO people (login, name, last_at) VALUES (?,?,?) ON CONFLICT(login) DO UPDATE SET name = COALESCE(excluded.name, people.name), last_at = MAX(people.last_at, excluded.last_at)`,
  binds: [c.author_login, c.author_name, c.at],
}) : null;

export const pushSql = (p) => ({
  sql: "INSERT OR IGNORE INTO pushes (id, repo_id, branch, at, actor, head, before, commits_n, forced, created, agent) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  binds: [p.id, p.repo_id, p.branch, p.at, p.actor, p.head, p.before, p.commits_n, p.forced, p.created, p.agent],
});

/**
 * Never older over newer: a late or redelivered event cannot put a merged pull request back to open. The review is
 * written only when the source knows it (GraphQL's reviewDecision, or a review webhook), otherwise kept.
 */
export const prSql = (p) => ({
  sql: `INSERT INTO prs (repo_id, number, title, state, merged, draft, author_login, agent, bot, head_ref, base_ref, head_sha, created_at, updated_at, merged_at, closed_at, review, additions, deletions, files_n, labels, url)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(repo_id, number) DO UPDATE SET title = excluded.title, state = excluded.state, merged = excluded.merged, draft = excluded.draft,
          agent = COALESCE(excluded.agent, prs.agent), head_ref = excluded.head_ref, base_ref = excluded.base_ref, head_sha = COALESCE(excluded.head_sha, prs.head_sha),
          updated_at = excluded.updated_at, merged_at = excluded.merged_at, closed_at = excluded.closed_at,
          review = CASE WHEN ? THEN excluded.review ELSE prs.review END,
          additions = COALESCE(excluded.additions, prs.additions), deletions = COALESCE(excluded.deletions, prs.deletions), files_n = COALESCE(excluded.files_n, prs.files_n),
          labels = excluded.labels, url = COALESCE(excluded.url, prs.url)
        WHERE excluded.updated_at IS NOT NULL AND (prs.updated_at IS NULL OR excluded.updated_at >= prs.updated_at)`,
  binds: [p.repo_id, p.number, p.title, p.state, p.merged, p.draft, p.author_login, p.agent, p.bot, p.head_ref, p.base_ref, p.head_sha, p.created_at, p.updated_at,
    p.merged_at, p.closed_at, p.review ?? null, p.additions, p.deletions, p.files_n, p.labels, p.url, p.review !== undefined ? 1 : 0],
});

export const ciSql = (repoId, sha, state, at) => ({
  sql: "INSERT INTO ci (repo_id, sha, state, at) VALUES (?,?,?,?) ON CONFLICT(repo_id, sha) DO UPDATE SET state = excluded.state, at = excluded.at WHERE excluded.at >= ci.at",
  binds: [repoId, sha, state, at],
});

export const markerSql = (m) => ({
  sql: `INSERT INTO markers (id, repo_id, kind, name, environment, state, sha, ref, at, finished_at, actor, url, prerelease) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, state = COALESCE(excluded.state, markers.state), sha = COALESCE(excluded.sha, markers.sha),
          finished_at = COALESCE(excluded.finished_at, markers.finished_at), url = COALESCE(excluded.url, markers.url), prerelease = excluded.prerelease`,
  binds: [m.id, m.repo_id, m.kind, m.name, m.environment, m.state, m.sha, m.ref, m.at, m.finished_at, m.actor, m.url, m.prerelease],
});

/** All the statements for a list of commits: the commit, its paths, its author. */
export function commitStmts(rows) {
  const out = [];
  for (const c of rows) { out.push(commitSql(c), ...pathSqls(c)); const p = personSql(c); if (p) out.push(p); }
  return out;
}
