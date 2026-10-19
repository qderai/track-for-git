// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * GitHub's REST and GraphQL APIs, used the way GitHub asks integrators to:
 *   - one request at a time (no parallel bursts, which trip the secondary rate limits);
 *   - conditional requests with ETags where a list is polled (a 304 does not count against the rate limit);
 *   - the rate limit read from every answer, a reserve kept for people (10% of the hour, at least 100), and no
 *     request at all until the reset once it is spent or GitHub answers 403/429 with Retry-After;
 *   - a ceiling on requests per run, so a Worker stays inside its subrequest limit.
 * Read-only: the only POST is GraphQL (queries, never mutations) and the App's token exchange.
 */
import { installationToken } from "./app-auth.js";

export class RateLimited extends Error {
  constructor(until, resource) { super(`GitHub rate limit (${resource}): waiting until ${new Date(until).toISOString()}`); this.until = until; this.resource = resource; }
}
export class OutOfBudget extends Error {
  constructor() { super("request budget for this run used up"); }
}
export class GitHubError extends Error {
  constructor(status, path, message) { super(`GitHub ${path} answered ${status}${message ? `: ${message}` : ""}`); this.status = status; }
}

/** Pure. The rate-limit headers of an answer, or null. */
export function rateOf(headers, now = Date.now()) {
  const limit = Number(headers.get("x-ratelimit-limit"));
  const remaining = Number(headers.get("x-ratelimit-remaining"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining) || headers.get("x-ratelimit-limit") === null) return null;
  return { resource: headers.get("x-ratelimit-resource") || "core", limit, remaining, reset: Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + 3_600_000 };
}

/** Pure. Keep a reserve: 10% of the hour's allowance, at least 100 (or 10 of a small allowance). */
export const reserveOf = (limit) => Math.min(Math.max(100, Math.ceil(limit * 0.1)), Math.ceil(limit / 2));

/**
 * @param {import("../config.js").Config} cfg
 * @param {{ fetchImpl?: typeof fetch, rate?: Record<string, any>, maxRequests?: number, now?: () => number }} [opts]
 */
export function createGitHub(cfg, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  const now = opts.now ?? Date.now;
  /** @type {Record<string, { limit: number, remaining: number, reset: number, blockedUntil?: number }>} */
  const rate = { ...(opts.rate ?? {}) };
  let used = 0;
  const max = opts.maxRequests ?? Infinity;

  async function auth() {
    if (cfg.mode === "app") return `Bearer ${await installationToken(cfg, fetchImpl, now())}`;
    if (cfg.token) return `Bearer ${cfg.token}`;
    throw new Error("GitHub is not connected: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY, or GITHUB_TOKEN");
  }

  function guard(resource) {
    const t = now();
    const r = rate[resource];
    if (r?.blockedUntil && r.blockedUntil > t) throw new RateLimited(r.blockedUntil, resource);
    if (r && r.reset > t && r.remaining <= reserveOf(r.limit)) throw new RateLimited(r.reset, resource);
    if (used >= max) throw new OutOfBudget();
  }

  function note(res, resource) {
    const r = rateOf(res.headers, now());
    if (r) rate[r.resource] = { limit: r.limit, remaining: r.remaining, reset: r.reset };
    if (res.status === 429 || (res.status === 403 && (res.headers.get("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"))) {
      const after = Number(res.headers.get("retry-after"));
      const until = Number.isFinite(after) && after > 0 ? now() + after * 1000 : (r?.reset ?? now() + 60_000);
      rate[r?.resource ?? resource] = { ...(rate[r?.resource ?? resource] ?? { limit: 5000, remaining: 0, reset: until }), blockedUntil: until };
      throw new RateLimited(until, r?.resource ?? resource);
    }
  }

  /**
   * GET a REST path. With `etag`, a 304 comes back as { status: 304 } and costs nothing.
   * @returns {Promise<{ status: number, data: any, etag: string|null, link: string|null }>}
   */
  async function rest(path, { etag = null, allow = [] } = {}) {
    guard("core");
    used++;
    const headers = { authorization: await auth(), accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "track-for-git" };
    if (etag) headers["if-none-match"] = etag;
    const res = await fetchImpl(cfg.apiUrl + path, { headers });
    note(res, "core");
    if (res.status === 304) return { status: 304, data: null, etag, link: null };
    if (!res.ok && !allow.includes(res.status)) {
      let msg = "";
      try { msg = String((await res.json())?.message ?? "").slice(0, 160); } catch { /* not JSON */ }
      throw new GitHubError(res.status, path.split("?")[0], msg);
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data, etag: res.headers.get("etag"), link: res.headers.get("link") };
  }

  /**
   * A GraphQL query. Partial answers are kept: GitHub returns data alongside errors when, for example, the token
   * cannot read one repository's checks. Only a query with no data at all throws.
   */
  async function graphql(query, variables = {}) {
    guard("graphql");
    used++;
    const res = await fetchImpl(cfg.graphqlUrl, {
      method: "POST",
      headers: { authorization: await auth(), "content-type": "application/json", accept: "application/json", "user-agent": "track-for-git" },
      body: JSON.stringify({ query, variables }),
    });
    note(res, "graphql");
    if (!res.ok) throw new GitHubError(res.status, "/graphql", await res.text().then((t) => t.slice(0, 160)).catch(() => ""));
    const j = await res.json();
    if (!j?.data && j?.errors?.length) {
      const limited = j.errors.find((e) => e?.type === "RATE_LIMITED");
      if (limited) { const until = rate.graphql?.reset ?? now() + 60_000; rate.graphql = { ...(rate.graphql ?? { limit: 5000, remaining: 0 }), reset: until, blockedUntil: until }; throw new RateLimited(until, "graphql"); }
      throw new GitHubError(200, "/graphql", String(j.errors[0]?.message ?? "error").slice(0, 160));
    }
    return { data: j.data ?? {}, errors: j.errors ?? [] };
  }

  return {
    rest,
    graphql,
    get used() { return used; },
    /** The rate state to keep between runs. */
    rate: () => rate,
    /** True while a resource can still be asked (the reserve not reached, not blocked). */
    can(resource = "core") { try { guard(resource); return true; } catch { return false; } },
  };
}

/** Pure. The next page's URL path from a Link header, or null. */
export function nextPage(link, apiUrl) {
  const m = /<([^>]+)>;\s*rel="next"/.exec(link ?? "");
  if (!m) return null;
  return m[1].startsWith(apiUrl) ? m[1].slice(apiUrl.length) : null;
}
