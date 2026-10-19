// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Who may open the dashboard. Two ways, both behind the company's own sign-in:
 *
 *   AUTH=access  Cloudflare Access stands in front of the whole hostname (any IdP: Okta, Entra ID, Google…). Every
 *                request carries Access's signed JWT; it is verified here too (signature against the team's keys,
 *                audience, expiry), so a request that bypasses Access by another route is still refused.
 *   AUTH=github  "Sign in with GitHub", for members of the organisation only (optionally of some teams). Membership
 *                is checked with the dashboard's own read-only credentials, so the sign-in asks the person for no
 *                scope at all; their GitHub token is used once to learn who they are and then dropped. The session
 *                is a signed, HTTP-only cookie for 12 hours.
 *
 * AUTH=none lets anyone in, for a private network or the demo. With no AUTH at all the dashboard refuses to answer.
 */

const enc = new TextEncoder();
const SESSION = "tfg_session";
const STATE = "tfg_oauth_state";
const SESSION_MS = 12 * 3_600_000;

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Pure. The cookies of a request. */
export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A signed value: base64url(JSON).base64url(HMAC). */
export async function seal(secret, value) {
  const body = b64url(enc.encode(JSON.stringify(value)));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(mac)}`;
}

/** The value of a sealed string, or null when the signature does not match. */
export async function unseal(secret, sealed) {
  const [body, mac] = String(sealed ?? "").split(".");
  if (!body || !mac) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(mac), enc.encode(body));
    return ok ? JSON.parse(new TextDecoder().decode(fromB64url(body))) : null;
  } catch { return null; }
}

/** A cookie for this dashboard only: its own path (`base`: "/" unless it is mounted inside another app). */
const cookie = (name, value, maxAge, path = "/") => `${name}=${value}; Path=${path}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
const baseOf = (cfg) => cfg?.base ?? "/";

// ---------------------------------------------------------------------------------------------------- Cloudflare Access

const jwks = new Map();

async function accessKeys(team, kid, fetchImpl, now) {
  const c = jwks.get(team);
  if (c && c.until > now) {
    // A kid outside the set: Access may have rotated its keys. Ask again, at most once a minute per team.
    if (c.keys.some((k) => k.kid === kid) || now - c.at < 60_000) return c.keys;
    c.at = now;
  }
  const r = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`Access keys: ${r.status}`);
  const keys = (await r.json())?.keys ?? [];
  jwks.set(team, { keys, at: now, until: now + 3_600_000 });
  return keys;
}

/**
 * The person Cloudflare Access let in, from its JWT (header Cf-Access-Jwt-Assertion, or the CF_Authorization
 * cookie), or null.
 */
export async function accessUser(req, cfg, fetchImpl = fetch, now = Date.now()) {
  const token = req.headers.get("cf-access-jwt-assertion") || cookies(req).CF_Authorization;
  if (!token) return null;
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return null;
  let head, body;
  try { head = JSON.parse(new TextDecoder().decode(fromB64url(h))); body = JSON.parse(new TextDecoder().decode(fromB64url(p))); } catch { return null; }
  if (head.alg !== "RS256") return null;
  const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
  if (!aud.some((a) => cfg.accessAud.includes(a))) return null;
  if (body.iss !== `https://${cfg.accessTeam}`) return null;
  if (!(body.exp * 1000 > now) || (body.nbf && body.nbf * 1000 > now + 60_000)) return null;
  const jwk = (await accessKeys(cfg.accessTeam, head.kid, fetchImpl, now)).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(s), enc.encode(`${h}.${p}`));
  return ok ? { id: String(body.email ?? body.sub ?? "someone"), via: "access" } : null;
}

// ---------------------------------------------------------------------------------------------------- GitHub sign-in

/** The person in the session cookie, or null. */
export async function sessionUser(req, cfg, now = Date.now()) {
  const v = await unseal(cfg.sessionSecret, cookies(req)[SESSION]);
  return v && typeof v.login === "string" && v.exp > now ? { id: v.login, via: "github" } : null;
}

/** Start: a random state in a short signed cookie, then GitHub's sign-in page. */
export async function oauthStart(req, cfg) {
  const url = new URL(req.url);
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const base = baseOf(cfg);
  const back = safeBack(url.searchParams.get("back"), base);
  const sealed = await seal(cfg.sessionSecret, { state, back, exp: Date.now() + 10 * 60_000 });
  const to = new URL(`${cfg.webUrl}/login/oauth/authorize`);
  to.searchParams.set("client_id", cfg.oauthClientId);
  to.searchParams.set("redirect_uri", `${url.origin}${base}auth/callback`);
  to.searchParams.set("state", state);
  to.searchParams.set("allow_signup", "false");
  // Membership is checked with the dashboard's own credentials; without them (webhooks only) the person's own token
  // must be able to read their memberships.
  if (cfg.mode === "none") to.searchParams.set("scope", "read:org");
  return new Response(null, { status: 302, headers: { location: to.toString(), "set-cookie": cookie(STATE, sealed, 600, base), "cache-control": "no-store" } });
}

/** Only a path on this site, never another site (else the dashboard's own start, `base`). */
export const safeBack = (v, base = "/") => (typeof v === "string" && /^\/(?!\/)[\w\-./?=&%#]*$/.test(v) ? v.slice(0, 300) : base);

/**
 * Back from GitHub: check the state, learn who it is, check they are a member, set the session.
 * @param {(path: string) => Promise<{ status: number }>} memberCheck GET with the dashboard's own credentials
 */
export async function oauthCallback(req, cfg, memberCheck, fetchImpl = fetch) {
  const url = new URL(req.url);
  const base = baseOf(cfg);
  const saved = await unseal(cfg.sessionSecret, cookies(req)[STATE]);
  const fail = (msg, status = 403) => new Response(page(msg, base), { status, headers: { "content-type": "text/html; charset=utf-8", "set-cookie": cookie(STATE, "", 0, base), "cache-control": "no-store" } });
  if (!saved || saved.exp < Date.now() || saved.state !== url.searchParams.get("state")) return fail("The sign-in expired or did not start here. Try again.", 400);
  const code = url.searchParams.get("code");
  if (!code) return fail("GitHub did not sign you in.", 400);
  const tr = await fetchImpl(`${cfg.webUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": "track-for-git" },
    body: JSON.stringify({ client_id: cfg.oauthClientId, client_secret: cfg.oauthClientSecret, code, redirect_uri: `${url.origin}${base}auth/callback` }),
  });
  const tok = (await tr.json().catch(() => null))?.access_token;
  if (!tok) return fail("GitHub did not sign you in.", 400);
  const uh = { authorization: `Bearer ${tok}`, accept: "application/vnd.github+json", "user-agent": "track-for-git" };
  const user = await (await fetchImpl(`${cfg.apiUrl}/user`, { headers: uh })).json().catch(() => null);
  const login = String(user?.login ?? "").toLowerCase();
  if (!/^[a-z0-9-]{1,39}$/.test(login)) return fail("GitHub did not say who you are.", 400);

  let member = false;
  if (cfg.mode === "none") {
    const m = await fetchImpl(`${cfg.apiUrl}/user/memberships/orgs/${encodeURIComponent(cfg.org)}`, { headers: uh });
    member = m.ok && (await m.json().catch(() => null))?.state === "active";
  } else {
    member = (await memberCheck(`/orgs/${encodeURIComponent(cfg.org)}/members/${encodeURIComponent(login)}`)).status === 204;
  }
  if (member && cfg.allowedTeams.length) {
    member = false;
    for (const team of cfg.allowedTeams) {
      const r = await memberCheck(`/orgs/${encodeURIComponent(cfg.org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`);
      if (r.status === 200 && r.data?.state === "active") { member = true; break; }
    }
  }
  if (!member) return fail(`@${login} is not a member of ${cfg.org}${cfg.allowedTeams.length ? ` (teams: ${cfg.allowedTeams.join(", ")})` : ""}.`);
  const session = await seal(cfg.sessionSecret, { login, exp: Date.now() + SESSION_MS });
  const headers = new Headers({ location: safeBack(saved.back, base), "cache-control": "no-store" });
  headers.append("set-cookie", cookie(SESSION, session, SESSION_MS / 1000, base));
  headers.append("set-cookie", cookie(STATE, "", 0, base));
  return new Response(null, { status: 302, headers });
}

export const signOut = (cfg) => new Response(null, { status: 303, headers: { location: baseOf(cfg), "set-cookie": cookie(SESSION, "", 0, baseOf(cfg)), "cache-control": "no-store" } });

/** A plain page for sign-in problems. Text only, escaped. */
function page(msg, base = "/") {
  const esc = String(msg).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Track for Git</title>
<link rel="stylesheet" href="${base}styles.css"><main class="signin"><h1>Track for Git</h1><p>${esc}</p><p><a class="btn" href="${base}auth/login">Sign in with GitHub</a></p></main>`;
}
