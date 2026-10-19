// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Track for Git inside another app: the page and its API under a path of that app (`base`, for example
 * "/tools/code/"), on a database and a cron the app already has. The page's files come from src/embed-assets.js
 * (strings, generated from public/ by `npm run build:embed`), so the app needs no build step and no static files.
 *
 *   import { mount, d1Store } from "track-for-git/embed";
 *   const code = mount({ base: "/tools/code/", env: settings, store: d1Store(env.CODE_DB), frameAncestors: "'self'" });
 *   const res = await code.fetch(request);   // a Response for a path under base, null for anything else
 *   await code.webhook(request);              // GitHub's deliveries, at whatever address the app receives them
 *   await code.scheduled(Date.now());         // the sync, from the app's own cron (once a minute)
 *
 * `env` takes the same settings as a deployment of its own (README, docs/setup.md). Who may open it is still
 * Track for Git's AUTH: `access` checks Cloudflare Access's token itself; `none` only when the app's own sign-in
 * already stands in front of every path under base.
 * `hooks.markers({ from, to })` adds deploys that are not GitHub Deployments (from the app's own pipeline) and
 * `hooks.live()` says what runs now (the "Live now" tile); src/embed.d.ts has their shapes.
 */
import { createApp, normalBase } from "./app.js";
import assets from "./embed-assets.js";
import { SHA, commitStmts, pushId, pushSql } from "./github/normalize.js";
import { SECURITY_HEADERS } from "./http.js";

export { d1Store, sqliteStore, migrateSqlite } from "./db.js";
export { normalBase };

const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : null);
const str = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
const AGENT = /^[a-z0-9~._-]{1,44}$/;

/**
 * History from another tool (an earlier dashboard of the app's own) into Track for Git's tables, never over what
 * GitHub said: a commit fills only the fields still empty (the sync later adds its login, paths and line counts), a
 * push or a pull request is added only when it is missing. `repo_id` is GitHub's repository id (the `repos` table, so
 * after the first sync). Rows that do not make sense are skipped and counted.
 * @param {any} store
 * @param {{ commits?: any[], pushes?: any[], prs?: any[] }} rows
 */
export async function importHistory(store, { commits = [], pushes = [], prs = [] } = {}) {
  const known = new Set((await store.all("SELECT id FROM repos")).map((r) => Number(r.id)));
  const ok = (r) => known.has(int(r?.repo_id)) && Number.isFinite(Number(r?.at ?? r?.created_at ?? r?.updated_at));
  const cs = commits.filter((c) => ok(c) && SHA.test(String(c.sha))).map((c) => ({
    repo_id: int(c.repo_id), sha: c.sha, at: Number(c.at), branch: str(c.branch, 200), on_default: c.on_default ? 1 : 0,
    author_login: str(c.author_login, 80)?.toLowerCase() ?? null, author_name: str(c.author_name, 120), agent: AGENT.test(String(c.agent)) ? c.agent : null,
    bot: c.bot ? 1 : 0, message: String(c.message ?? "").slice(0, 4000), additions: int(c.additions), deletions: int(c.deletions), files_n: int(c.files_n),
    pr_number: int(c.pr_number), paths: [],
  }));
  // The sync's own upsert lets a newer count win; an import is older than GitHub, so its counts only fill the gaps.
  const counts = cs.map((c) => ({
    sql: "UPDATE commits SET additions = COALESCE(additions, ?), deletions = COALESCE(deletions, ?), files_n = COALESCE(files_n, ?), pr_number = COALESCE(pr_number, ?) WHERE repo_id = ? AND sha = ?",
    binds: [c.additions, c.deletions, c.files_n, c.pr_number, c.repo_id, c.sha],
  }));
  const bare = cs.map((c) => ({ ...c, additions: null, deletions: null, files_n: null, pr_number: null }));
  const ps = pushes.filter((p) => ok(p) && SHA.test(String(p.head))).map((p) => {
    const branch = str(p.branch, 200);
    return { id: pushId(int(p.repo_id), branch, p.head), repo_id: int(p.repo_id), branch, at: Number(p.at), actor: str(p.actor, 80)?.toLowerCase() ?? null, head: p.head,
      before: SHA.test(String(p.before)) ? p.before : null, commits_n: int(p.commits_n) ?? 0, forced: p.forced ? 1 : 0, created: p.created ? 1 : 0,
      agent: AGENT.test(String(p.agent)) ? p.agent : null };
  });
  const rs = prs.filter((p) => ok(p) && int(p.number) > 0).map((p) => ({
    sql: `INSERT OR IGNORE INTO prs (repo_id, number, title, state, merged, draft, author_login, agent, bot, head_ref, base_ref, created_at, updated_at, merged_at, closed_at, url)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    binds: [int(p.repo_id), int(p.number), String(p.title ?? "").slice(0, 300), p.state === "open" ? "open" : "closed", p.merged ? 1 : 0, p.draft ? 1 : 0,
      str(p.author_login, 80)?.toLowerCase() ?? null, AGENT.test(String(p.agent)) ? p.agent : null, p.bot ? 1 : 0, str(p.head_ref, 200), str(p.base_ref, 200),
      int(p.created_at), int(p.updated_at), int(p.merged_at), int(p.closed_at), typeof p.url === "string" && /^https:\/\//.test(p.url) ? p.url.slice(0, 500) : null],
  }));
  await store.batch([...commitStmts(bare), ...counts, ...ps.map(pushSql), ...rs]);
  return { commits: cs.length, pushes: ps.length, prs: rs.length, skipped: commits.length + pushes.length + prs.length - cs.length - ps.length - rs.length };
}

const TYPES = {
  html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml",
  json: "application/json", txt: "text/plain; charset=utf-8", webmanifest: "application/manifest+json",
};

/**
 * Pure. Who may show the page in a frame: "'none'" (the default), "'self'", or https origins separated by spaces.
 * Anything else is "'none'".
 */
export function frameAncestorsOf(v) {
  const parts = String(v ?? "'none'").trim().split(/\s+/).filter(Boolean);
  const ok = parts.length > 0 && parts.every((p) => p === "'self'" || /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(p));
  if (parts.length === 1 && parts[0] === "'none'") return "'none'";
  return ok ? parts.join(" ") : "'none'";
}

/** Pure. The page's security headers, with the frame rule the app asked for. */
export function pageHeaders(frameAncestors) {
  const fa = frameAncestorsOf(frameAncestors);
  const h = { ...SECURITY_HEADERS, "content-security-policy": SECURITY_HEADERS["content-security-policy"].replace("frame-ancestors 'none'", `frame-ancestors ${fa}`) };
  if (fa === "'none'") h["x-frame-options"] = "DENY";
  else if (fa === "'self'") h["x-frame-options"] = "SAMEORIGIN";
  else delete h["x-frame-options"];             // several origins: the Content Security Policy alone decides
  return h;
}

/** Pure. index.html with its root-relative links ("/styles.css") under base ("/tools/code/styles.css"). */
export const rebase = (html, base) => (base === "/" ? html : html.replace(/\b(href|src|action)="\/(?!\/)/g, `$1="${base}`));

/** Pure. A short, stable tag for a file's content (FNV-1a), for If-None-Match. */
function etagOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `"${(h >>> 0).toString(36)}-${s.length.toString(36)}"`;
}

/**
 * @param {{ base?: string, env: Record<string, any>, store: any, hooks?: any, edgeCache?: any, fetchImpl?: typeof fetch,
 *   waitUntil?: (p: Promise<any>) => void, frameAncestors?: string }} opts
 */
export function mount(opts) {
  const base = normalBase(opts.base);
  const app = createApp({ env: opts.env, store: opts.store, hooks: opts.hooks, edgeCache: opts.edgeCache, fetchImpl: opts.fetchImpl, waitUntil: opts.waitUntil, base });
  const headers = pageHeaders(opts.frameAncestors);
  const files = new Map();
  for (const [name, body] of Object.entries(assets)) {
    const text = name === "index.html" ? rebase(body, base) : body;
    files.set(name, { text, type: TYPES[name.split(".").pop()] ?? "application/octet-stream", etag: etagOf(text) });
  }

  /** The same request, at the path Track for Git answers it on (base taken off). */
  const inner = (request, path) => {
    const url = new URL(request.url);
    url.pathname = path;
    return new Request(url, request);
  };

  function file(request, rel) {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("GET only", { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
    let name = rel.replace(/^\/+/, "");
    if (!name) name = "index.html";
    let f = files.get(name);
    // A path with no file under base is the page (its state is in the query), like the deployment of its own.
    if (!f && !/\.[a-z0-9]{1,12}$/i.test(name)) f = files.get("index.html");
    if (!f) return new Response("Not found", { status: 404, headers: { ...headers, "content-type": TYPES.txt } });
    const h = { ...headers, "content-type": f.type, etag: f.etag, "cache-control": f.type === TYPES.html ? "no-cache" : "private, max-age=300" };
    if (request.headers.get("if-none-match") === f.etag) return new Response(null, { status: 304, headers: h });
    return new Response(request.method === "HEAD" ? null : f.text, { status: 200, headers: h });
  }

  return {
    app,
    cfg: app.cfg,
    base,
    /** A Response for a path under base, null for every other path (the app answers those). */
    async fetch(request) {
      const url = new URL(request.url);
      if (base !== "/" && url.pathname === base.slice(0, -1)) {
        return new Response(null, { status: 308, headers: { location: `${base}${url.search}`, "cache-control": "no-store" } });
      }
      if (!url.pathname.startsWith(base)) return null;
      const rel = `/${url.pathname.slice(base.length)}`;
      if (rel.startsWith("/api/") || rel.startsWith("/auth/") || rel === "/healthz") return app.fetch(inner(request, rel));
      return file(request, rel);
    },
    /** GitHub's webhook, wherever the app receives it (a public address, outside any sign-in). */
    webhook: (request) => app.fetch(inner(request, "/api/github/webhook")),
    /** One sync run: call it from the app's cron, once a minute. */
    scheduled: (now = Date.now()) => app.scheduled(now),
  };
}
