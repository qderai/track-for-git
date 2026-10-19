// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Signing in as a GitHub App, with WebCrypto only (the same code runs on Workers and in Node):
 *   1. a JSON Web Token signed with the App's private key (RS256, ten minutes at most), then
 *   2. an installation token for the organisation (an hour), kept in memory until five minutes before it ends.
 * The installation token is never written to the database or a log.
 *
 * GitHub hands out the private key as PKCS#1 ("BEGIN RSA PRIVATE KEY"); WebCrypto reads only PKCS#8, so the key is
 * wrapped in the PKCS#8 envelope here rather than asking anyone to run openssl.
 */

const b64url = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const enc = new TextEncoder();

/** DER length bytes. */
function derLen(n) {
  if (n < 0x80) return [n];
  const out = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/** Pure. A PEM private key (PKCS#1 or PKCS#8, with real or "\n" newlines) into PKCS#8 DER bytes. */
export function pemToPkcs8(pem) {
  const text = String(pem ?? "").replace(/\\n/g, "\n").trim();
  const m = /-----BEGIN (RSA )?PRIVATE KEY-----([\s\S]+?)-----END (RSA )?PRIVATE KEY-----/.exec(text);
  if (!m) throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  const raw = Uint8Array.from(atob(m[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (!m[1]) return raw;
  // PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier { rsaEncryption, NULL }, OCTET STRING pkcs1 }
  const algo = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octet = [0x04, ...derLen(raw.length)];
  const body = [0x02, 0x01, 0x00, ...algo, ...octet];
  const out = new Uint8Array(1 + derLen(body.length + raw.length).length + body.length + raw.length);
  out.set([0x30, ...derLen(body.length + raw.length), ...body]);
  out.set(raw, out.length - raw.length);
  return out;
}

/** The App's JWT: valid from a minute ago (clock drift) for nine minutes. */
export async function appJwt(appId, pem, now = Date.now()) {
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(enc.encode(JSON.stringify({ iat, exp: iat + 600 - 60, iss: String(appId) })));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

/** Installation tokens by App id, in this process only. */
const tokens = new Map();

/**
 * A current installation token for the App.
 * @param {{ appId: string, appKey: string, installationId?: string, org?: string, apiUrl: string }} cfg
 * @param {typeof fetch} fetchImpl
 */
export async function installationToken(cfg, fetchImpl = fetch, now = Date.now()) {
  const cached = tokens.get(cfg.appId);
  if (cached && cached.expires - 5 * 60_000 > now) return cached.token;
  const jwt = await appJwt(cfg.appId, cfg.appKey, now);
  const headers = { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "track-for-git" };
  let id = cfg.installationId || cached?.installationId;
  if (!id) {
    // The installation on the organisation, or the App's only installation.
    const url = cfg.org ? `${cfg.apiUrl}/orgs/${encodeURIComponent(cfg.org)}/installation` : `${cfg.apiUrl}/app/installations?per_page=2`;
    const r = await fetchImpl(url, { headers });
    if (!r.ok) throw new Error(`GitHub App: no installation found (${r.status}); install the App on the organisation`);
    const j = await r.json();
    const one = Array.isArray(j) ? (j.length === 1 ? j[0] : null) : j;
    if (!one?.id) throw new Error("GitHub App: installed more than once; set GITHUB_APP_INSTALLATION_ID");
    id = String(one.id);
  }
  const r = await fetchImpl(`${cfg.apiUrl}/app/installations/${encodeURIComponent(id)}/access_tokens`, { method: "POST", headers });
  if (!r.ok) throw new Error(`GitHub App: could not get an installation token (${r.status})`);
  const j = await r.json();
  const expires = Date.parse(j.expires_at) || now + 55 * 60_000;
  tokens.set(cfg.appId, { token: j.token, expires, installationId: id });
  return j.token;
}

/** For tests: forget the cached tokens. */
export const forgetTokens = () => tokens.clear();
