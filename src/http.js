// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Response helpers and the security headers every page and answer carries. The page loads nothing from another
 * origin (no CDN, no fonts, no avatars), so its Content Security Policy can be strict. public/_headers repeats these
 * for the static files Cloudflare serves without the Worker; test/http.test.js keeps the two the same.
 */

export const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
};

/** A JSON answer that is never cached by a browser or a proxy (it is the company's code activity). */
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra } });
}

export const text = (body, status = 200, extra = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra } });

/** The same headers onto a response from elsewhere (static files in Node). */
export function secure(res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!h.has(k)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

/**
 * A two-level cache for answers and diffs: this process's memory (a few hundred entries) and, on Workers, the edge
 * cache of the data centre. Values are JSON.
 */
export function makeCache(edge = null, max = 400) {
  const mem = new Map();
  const base = "https://track-for-git.internal/";
  return {
    async get(key) {
      const m = mem.get(key);
      if (m && m.until > Date.now()) return m.value;
      if (m) mem.delete(key);
      if (!edge) return null;
      const hit = await edge.match(base + encodeURIComponent(key)).catch(() => null);
      return hit ? hit.json().catch(() => null) : null;
    },
    async put(key, value, ttlSeconds) {
      if (mem.size >= max) mem.delete(mem.keys().next().value);
      mem.set(key, { value, until: Date.now() + ttlSeconds * 1000 });
      if (edge) await edge.put(base + encodeURIComponent(key), new Response(JSON.stringify(value), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` } })).catch(() => undefined);
    },
  };
}
