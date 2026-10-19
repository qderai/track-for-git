// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The application, independent of where it runs: a function from a Request to a Response, and a scheduled sync.
 * src/worker.js runs it on Cloudflare Workers with D1; server/node.js runs it in Node with SQLite.
 *
 *   POST /api/github/webhook        GitHub's deliveries, signed (the only route open without sign-in)
 *   GET  /healthz                   "ok"
 *   GET  /auth/login | /auth/callback, POST /auth/logout     GitHub sign-in (AUTH=github)
 *   GET  /api/me                    who is signed in, and what the page should show first
 *   GET  /api/overview | /api/heatmap | /api/story | /api/facets | /api/status
 *   GET  /api/commits[/:repo/:sha] | /api/pushes | /api/prs[/:repo/:number]
 */
import { accessUser, oauthCallback, oauthStart, sessionUser, signOut } from "./auth.js";
import { authProblem, readConfig, setupState } from "./config.js";
import { getJson, getState } from "./db.js";
import { demoFiles, demoTick, ensureDemo } from "./demo.js";
import { commitFiles, prFiles, shapeFiles } from "./diff.js";
import { GitHubError, RateLimited, createGitHub } from "./github/client.js";
import { json, makeCache, text } from "./http.js";
import { commitPage, commitRow, facets, heatmap, liveNow, overview, parseFilter, prPage, prRowOut, pushPage, story } from "./queries.js";
import { runSync } from "./sync.js";
import { ingest, readBody, verifySignature } from "./webhook.js";

const SHA = /^[0-9a-f]{40}$/;
const DAY = 86_400_000;
/** How long the dashboard waits for an embedder's hook before going on without it. */
export const HOOK_MS = 3_000;
const cap = (v, n) => (v == null || v === "" ? null : String(v).slice(0, n));
/** A hook's answer, or an error after HOOK_MS: a hook that never answers must not hold the page. */
function inTime(p, what, ms = HOOK_MS) {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`${what} did not answer in ${ms} ms`)), ms); });
  return Promise.race([Promise.resolve(p), late]).finally(() => clearTimeout(timer));
}
const httpsUrl = (v) => (typeof v === "string" && /^https:\/\/[^\s"<>]+$/.test(v) ? v.slice(0, 500) : null);

/** Pure. "/", or a path that starts and ends with "/" ("/tools/code/"). Anything else is "/". */
export function normalBase(base) {
  const b = String(base ?? "/").trim();
  if (!/^\/[\w\-./]*$/.test(b) || b.includes("//") || b.includes("/../") || b.endsWith("/..")) return "/";
  return b.endsWith("/") ? b : `${b}/`;
}

/**
 * @param {{ env: Record<string, any>, store: any, edgeCache?: any, fetchImpl?: typeof fetch, waitUntil?: (p: Promise<any>) => void,
 *   base?: string, hooks?: { markers?: (range: { from: number, to: number }) => any, live?: () => any } }} platform
 *   `base` and `hooks` are for an app that mounts Track for Git inside itself (src/embed.js): hooks.markers adds
 *   deploys that are not GitHub Deployments (from its own pipeline), hooks.live says what runs now.
 */
export function createApp(platform) {
  const cfg = { ...readConfig(platform.env), base: normalBase(platform.base) };
  const store = platform.store;
  const hooks = platform.hooks ?? {};
  const hookMs = Number(platform.hookMs) > 0 ? Number(platform.hookMs) : HOOK_MS;
  const fetchImpl = platform.fetchImpl ?? ((...a) => fetch(...a));
  const waitUntil = platform.waitUntil ?? ((p) => { p.catch(() => undefined); });
  // Its own corner of a shared cache: two dashboards in one Worker (two bases, two organisations) never see each other's.
  const cache = platform.cache ?? makeCache(platform.edgeCache ?? null, 400, `${cfg.base}|${cfg.demo ? "~demo" : cfg.org}`);
  const demoScale = Number(platform.env.DEMO_SCALE) > 0 ? Math.min(Number(platform.env.DEMO_SCALE), 3) : 1;

  const github = async (maxRequests = 12) => createGitHub(cfg, { fetchImpl, rate: (await getJson(store, "rate")) ?? {}, maxRequests });

  async function whoIs(req) {
    const problem = authProblem(cfg);
    if (problem) return { problem };
    if (cfg.auth === "none" || (cfg.demo && !cfg.auth)) return { user: { id: null, via: "none" } };
    const user = cfg.auth === "access" ? await accessUser(req, cfg, fetchImpl).catch(() => null) : await sessionUser(req, cfg);
    return user ? { user } : { signIn: true };
  }

  /** An answer computed at most once per `ttl` seconds for everyone (the data is the organisation's, not a person's). */
  async function memo(key, ttl, fn) {
    const hit = await cache.get(`answer:${key}`);
    if (hit) return hit;
    const v = await fn();
    await cache.put(`answer:${key}`, v, ttl);
    return v;
  }

  /**
   * The embedder's own deploys for a range (hooks.markers), shaped like the stored markers, on the repositories the
   * dashboard knows. A hook that fails or answers nonsense adds nothing: the dashboard never breaks for it.
   */
  async function hookMarkers(range) {
    if (typeof hooks.markers !== "function") return [];
    let list;
    try { list = await inTime(hooks.markers({ from: range.from, to: range.to }), "hooks.markers", hookMs); } catch (e) { console.warn("[track-for-git] hooks.markers:", String(e?.message ?? e).slice(0, 200)); return []; }
    if (!Array.isArray(list) || !list.length) return [];
    const ids = await repoIds();
    const out = [];
    for (const m of list.slice(0, 2000)) {
      const repo = ids.get(String(m?.repo ?? "").toLowerCase());
      const kind = m?.kind === "release" ? "release" : m?.kind === "deploy" || m?.kind == null ? "deploy" : null;
      const at = Number(m?.finishedAt ?? m?.at);
      if (!repo || !kind || !Number.isFinite(at) || !m?.id) continue;
      out.push({ id: `hook:${cap(m.id, 120)}`, repo: repo.id, repoName: repo.full_name, kind, name: cap(m.name, 120), environment: cap(m.environment, 80),
        state: cap(String(m.state ?? "success").toLowerCase(), 20), sha: SHA.test(String(m.sha)) ? m.sha : null, at, actor: cap(m.actor, 80),
        url: httpsUrl(m.url), prerelease: false });
    }
    return out;
  }
  async function repoIds() {
    const rows = await store.all("SELECT id, full_name FROM repos WHERE removed = 0");
    return new Map(rows.map((r) => [String(r.full_name).toLowerCase(), { id: Number(r.id), full_name: r.full_name }]));
  }

  /**
   * What runs now, whatever range is on screen: the embedder's answer (hooks.live), else the newest successful deploy
   * of the last 90 days (stored, or the embedder's own), production first. Computed once every few seconds for all.
   */
  const live = (now) => memo("live", 10, async () => {
    let v = null;
    if (typeof hooks.live === "function") {
      try {
        const x = await inTime(hooks.live(), "hooks.live", hookMs);
        const repo = x ? (await repoIds()).get(String(x.repo ?? "").toLowerCase()) : null;
        if (repo && SHA.test(String(x.sha))) {
          v = { repo: repo.id, repoName: repo.full_name, sha: x.sha, environment: cap(x.environment, 80), name: cap(x.name, 120), at: Number.isFinite(Number(x.at)) ? Number(x.at) : null, url: httpsUrl(x.url) };
        }
      } catch (e) { console.warn("[track-for-git] hooks.live:", String(e?.message ?? e).slice(0, 200)); }
    } else {
      v = await liveNow(store, await hookMarkers({ from: now - 90 * DAY, to: now + 60_000 }));
    }
    if (!v) return { live: null };
    // Stored, it opens in the dashboard; not (yet), it links to GitHub.
    const known = !!(await store.first("SELECT 1 AS k FROM commits WHERE repo_id = ? AND sha = ?", v.repo, v.sha));
    return { live: { ...v, known } };
  }).then((x) => x.live);

  async function api(req, url, now) {
    const p = url.pathname;
    const f = parseFilter(url.searchParams, now, cfg.timeZone);
    const key = `${p}?${[...url.searchParams].sort().map(([k, v]) => `${k}=${v}`).join("&")}`;
    const opts = { now, staleDays: cfg.staleDays, custom: cfg.agents };

    if (p === "/api/overview") {
      return json(await memo(key, 10, async () => {
        const extraMarkers = await hookMarkers(f);
        const [o, l] = await Promise.all([overview(store, f, { ...opts, group: url.searchParams.get("group") ?? "repo", extraMarkers }), live(now)]);
        return { ...o, live: l };
      }));
    }
    if (p === "/api/heatmap") return json(await memo(key, 20, () => heatmap(store, f, url.searchParams.get("by") ?? "repo")));
    if (p === "/api/story") return json(await memo(key, 30, async () => story(store, f, cfg.agents, await hookMarkers(f))));
    if (p === "/api/facets") return json(await memo("facets", cfg.demo ? 30 : 300, () => facets(store, now, cfg.agents)));
    if (p === "/api/commits") return json(await commitPage(store, f, url.searchParams.get("cursor"), 100));
    if (p === "/api/pushes") return json(await pushPage(store, f, url.searchParams.get("cursor"), 100));
    if (p === "/api/prs") {
      return json(await prPage(store, f, { state: url.searchParams.get("state") ?? "open", sort: url.searchParams.get("sort") ?? "", offset: url.searchParams.get("cursor"), now, staleDays: cfg.staleDays }));
    }
    if (p === "/api/status") return json(await status(now));

    let m = /^\/api\/commits\/(\d{1,15})\/([0-9a-f]{40})$/.exec(p);
    if (m) {
      const row = await commitRow(store, Number(m[1]), m[2]);
      const repo = await store.first("SELECT id, full_name FROM repos WHERE id = ?", Number(m[1]));
      if (!row || !repo) return json({ error: "not_found" }, 404);
      return withFiles(row, async () => {
        if (cfg.demo) {
          const paths = (await store.all("SELECT path FROM commit_files WHERE repo_id = ? AND sha = ? LIMIT 60", repo.id, row.sha)).map((r) => r.path);
          return { ...shapeFiles(demoFiles(paths, row.sha, { additions: row.additions ?? 20, deletions: row.deletions ?? 5 })), message: row.message };
        }
        return commitFiles({ store, cache, gh: await github() }, repo, row.sha);
      });
    }
    m = /^\/api\/prs\/(\d{1,15})\/(\d{1,9})$/.exec(p);
    if (m) {
      const row = await prRowOut(store, Number(m[1]), Number(m[2]));
      const repo = await store.first("SELECT id, full_name FROM repos WHERE id = ?", Number(m[1]));
      if (!row || !repo) return json({ error: "not_found" }, 404);
      return withFiles(row, async () => {
        if (cfg.demo) {
          const shas = row.commits.map((c) => c.sha);
          const paths = shas.length ? (await store.all(`SELECT DISTINCT path FROM commit_files WHERE repo_id = ? AND sha IN (${shas.map(() => "?").join(",")}) LIMIT 60`, repo.id, ...shas)).map((r) => r.path) : [];
          return shapeFiles(demoFiles(paths, row.headSha ?? "1", { additions: row.additions ?? 20, deletions: row.deletions ?? 5 }));
        }
        return prFiles({ store, cache, gh: await github() }, repo, row.number, row.headSha);
      });
    }
    return json({ error: "not_found" }, 404);
  }

  /** A row with its files from GitHub; when GitHub cannot answer, the row alone and why. */
  async function withFiles(row, load) {
    try {
      return json({ ...row, ...(await load()) });
    } catch (e) {
      const why = e instanceof RateLimited ? { filesError: "rate_limited", retryAt: e.until }
        : e instanceof GitHubError && (e.status === 404 || e.status === 422) ? { filesError: "gone" }
        : { filesError: "github", detail: String(e?.message ?? e).slice(0, 200) };
      return json({ ...row, files: null, ...why });
    }
  }

  async function status(now) {
    const [webhookAt, sync, rate, teamsNote, counts] = await Promise.all([
      getState(store, "webhook_at"), getJson(store, "sync_last"), getJson(store, "rate"), getState(store, "teams_note"),
      store.first("SELECT (SELECT COUNT(*) FROM repos WHERE removed = 0) AS repos, (SELECT MAX(at) FROM commits) AS lastCommit, (SELECT COUNT(*) FROM commits WHERE at >= ?) AS day", now - 86_400_000),
    ]);
    const limits = Object.fromEntries(Object.entries(rate ?? {}).filter(([k]) => ["core", "graphql"].includes(k))
      .map(([k, v]) => [k, { limit: v.limit, remaining: v.remaining, reset: v.reset, blockedUntil: v.blockedUntil ?? null }]));
    return {
      setup: setupState(cfg), now, webhookAt: webhookAt ? Number(webhookAt) : null, sync, rate: limits, teamsNote: teamsNote || null,
      repos: Number(counts?.repos ?? 0), lastCommitAt: counts?.lastCommit ? Number(counts.lastCommit) : null, commits24h: Number(counts?.day ?? 0),
    };
  }

  async function webhook(req, now) {
    if (!cfg.webhookSecrets.length) return json({ error: "Webhooks are not set up: set GITHUB_WEBHOOK_SECRET" }, 503);
    const raw = await readBody(req);
    if (raw === null) return json({ error: "too large" }, 413);
    if (!(await verifySignature(cfg.webhookSecrets, raw, req.headers.get("x-hub-signature-256")))) return json({ error: "bad signature" }, 401);
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: "Set the webhook's content type to application/json" }, 400); }
    const did = await ingest({ store, cfg }, String(req.headers.get("x-github-event") ?? ""), req.headers.get("x-github-delivery"), payload, now);
    return json({ ok: true, did });
  }

  return {
    cfg,
    async fetch(req) {
      const url = new URL(req.url);
      const now = Date.now();
      const p = url.pathname;
      try {
        if (p === "/healthz") return text("ok");
        if (p === "/api/github/webhook") return req.method === "POST" ? await webhook(req, now) : json({ error: "POST only" }, 405);
        if (cfg.auth === "github" && !authProblem(cfg)) {
          if (p === "/auth/login") return oauthStart(req, cfg);
          if (p === "/auth/callback") {
            const gh = cfg.mode === "none" ? null : await github(4);
            return oauthCallback(req, cfg, (path) => gh.rest(path, { allow: [302, 403, 404] }), fetchImpl);
          }
        }
        if (p === "/auth/logout") return req.method === "POST" ? signOut(cfg) : json({ error: "POST only" }, 405);
        if (!p.startsWith("/api/")) return json({ error: "not_found" }, 404);
        if (req.method !== "GET") return json({ error: "GET only" }, 405);

        const who = await whoIs(req);
        if (p === "/api/me") {
          if (who.problem) return json({ title: cfg.title, setup: setupState(cfg) });
          if (who.signIn) return json({ title: cfg.title, auth: cfg.auth, signIn: cfg.auth === "github" ? `${cfg.base}auth/login` : null });
          if (cfg.demo) await ensureDemo(store, now, { scale: demoScale });
          return json({ title: cfg.title, org: cfg.demo ? "acme" : cfg.org || null, demo: cfg.demo, auth: cfg.auth || "none", user: who.user.id,
            staleDays: cfg.staleDays, mode: cfg.mode, webUrl: cfg.demo ? null : cfg.webUrl, timeZone: cfg.timeZone || null,
            agents: cfg.agents.map((a) => ({ id: a.id, name: a.name })) });
        }
        if (who.problem) return json({ error: "setup", problem: who.problem }, 503);
        if (who.signIn) return json({ error: "signin", signIn: cfg.auth === "github" ? `${cfg.base}auth/login` : null }, 401);
        if (cfg.demo) {
          await ensureDemo(store, now, { scale: demoScale });
          waitUntil(demoTick(store, now));
        }
        return await api(req, url, now);
      } catch (e) {
        console.error("[track-for-git]", String(e?.stack ?? e).slice(0, 2000));
        return json({ error: "server", detail: "Something went wrong; the server log has the details." }, 500);
      }
    },
    /** The cron trigger: one sync run (nothing in demo mode). */
    async scheduled(now = Date.now()) {
      if (cfg.demo || cfg.mode === "none") return { skipped: true };
      const gh = createGitHub(cfg, { fetchImpl, rate: (await getJson(store, "rate")) ?? {}, maxRequests: cfg.maxRequests });
      return runSync({ store, cfg, gh }, now);
    },
  };
}
