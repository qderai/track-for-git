// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createApp } from "../src/app.js";
import { accessUser, safeBack, seal, unseal } from "../src/auth.js";
import { readConfig } from "../src/config.js";
import { SECURITY_HEADERS } from "../src/http.js";
import { sign } from "../src/webhook.js";
import { fakeFetch, memStore, sha } from "./helpers.js";

const get = (app, path, headers = {}) => app.fetch(new Request(`https://dash.example${path}`, { headers }));

test("with no sign-in configured the dashboard refuses to show data (fail closed)", async () => {
  const app = createApp({ env: { GITHUB_ORG: "acme", GITHUB_TOKEN: "not-a-real-token-value" }, store: memStore() });
  const r = await get(app, "/api/overview");
  assert.equal(r.status, 503);
  const me = await (await get(app, "/api/me")).json();
  assert.equal(me.setup.github, "token");
  assert.match(me.setup.authProblem, /AUTH=/);
  assert.ok(!JSON.stringify(me).includes("not-a-real-token-value"), "never a secret");
  const status = await get(app, "/api/status");
  assert.equal(status.status, 503);
});

test("AUTH=none opens it; every answer carries the security headers and no-store", async () => {
  const app = createApp({ env: { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none" }, store: memStore() });
  const r = await get(app, "/api/overview?range=7d");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v);
  const s = await (await get(app, "/api/status")).json();
  assert.ok(!JSON.stringify(s).includes('"t"'));
  assert.equal((await get(app, "/api/nothing")).status, 404);
  assert.equal((await app.fetch(new Request("https://dash.example/api/overview", { method: "POST" }))).status, 405);
});

test("AUTH=github: a signed session lets a member in, a forged one does not", async () => {
  const secret = "s".repeat(40);
  const env = { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "github", GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: secret };
  const app = createApp({ env, store: memStore() });
  assert.equal((await get(app, "/api/overview")).status, 401);
  const good = await seal(secret, { login: "dana", exp: Date.now() + 60_000 });
  assert.equal((await get(app, "/api/overview", { cookie: `tfg_session=${good}` })).status, 200);
  const forged = await seal("x".repeat(40), { login: "dana", exp: Date.now() + 60_000 });
  assert.equal((await get(app, "/api/overview", { cookie: `tfg_session=${forged}` })).status, 401);
  const expired = await seal(secret, { login: "dana", exp: Date.now() - 1 });
  assert.equal((await get(app, "/api/overview", { cookie: `tfg_session=${expired}` })).status, 401);
  assert.equal(await unseal(secret, `${good.split(".")[0]}.AAAA`), null);
  // The sign-in starts with a state cookie and GitHub's page, asking for no scope.
  const start = await get(app, "/auth/login?back=/?tab=prs");
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(to.searchParams.get("scope"), null);
  assert.match(start.headers.get("set-cookie"), /tfg_oauth_state=.*HttpOnly; Secure; SameSite=Lax/);
  assert.equal(safeBack("//evil.example"), "/");
  assert.equal(safeBack("https://evil.example"), "/");
  assert.equal(safeBack("/?tab=prs"), "/?tab=prs");
});

test("AUTH=github: the callback signs in members only", async () => {
  const secret = "s".repeat(40);
  const env = { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "github", GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: secret };
  const run = async (memberStatus) => {
    const fetchImpl = fakeFetch([
      ["/login/oauth/access_token", { body: { access_token: "user-token" } }],
      ["api.github.com/user", { body: { login: "Dana" } }],
      ["/orgs/acme/members/dana", { status: memberStatus }],
    ]);
    const app = createApp({ env, store: memStore(), fetchImpl });
    const start = await get(app, "/auth/login");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const cookie = start.headers.get("set-cookie").split(";")[0];
    return get(app, `/auth/callback?code=abc&state=${state}`, { cookie });
  };
  const ok = await run(204);
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("set-cookie"), /tfg_session=/);
  assert.equal((await run(404)).status, 403);
});

test("AUTH=access: Cloudflare Access's JWT is verified, not trusted", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" };
  const team = "acme.cloudflareaccess.com";
  const cfg = readConfig({ AUTH: "access", ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: "aud-123" });
  const fetchImpl = fakeFetch([[`https://${team}/cdn-cgi/access/certs`, { body: { keys: [jwk] } }]]);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = (claims, key = privateKey) => {
    const head = b64({ alg: "RS256", kid: "k1" }), body = b64(claims);
    const s = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key).toString("base64url");
    return `${head}.${body}.${s}`;
  };
  const exp = Math.floor(Date.now() / 1000) + 600;
  const req = (token) => new Request("https://dash.example/", { headers: { "cf-access-jwt-assertion": token } });
  assert.deepEqual(await accessUser(req(jwt({ aud: ["aud-123"], iss: `https://${team}`, exp, email: "dana@acme.example" })), cfg, fetchImpl), { id: "dana@acme.example", via: "access" });
  assert.equal(await accessUser(req(jwt({ aud: ["other"], iss: `https://${team}`, exp })), cfg, fetchImpl), null);
  assert.equal(await accessUser(req(jwt({ aud: ["aud-123"], iss: "https://evil.cloudflareaccess.com", exp })), cfg, fetchImpl), null);
  assert.equal(await accessUser(req(jwt({ aud: ["aud-123"], iss: `https://${team}`, exp: 1 })), cfg, fetchImpl), null);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  assert.equal(await accessUser(req(jwt({ aud: ["aud-123"], iss: `https://${team}`, exp }, other)), cfg, fetchImpl), null);
});

test("the webhook route: signed deliveries in, everything else out", async () => {
  const store = memStore();
  const app = createApp({ env: { GITHUB_ORG: "acme", GITHUB_WEBHOOK_SECRET: "hook-secret", AUTH: "none" }, store });
  const body = JSON.stringify({ ref: "refs/heads/main", after: sha(9), before: sha(1), repository: { id: 7, full_name: "acme/api", default_branch: "main" },
    commits: [{ id: sha(2), message: "Hi", timestamp: "2026-10-18T10:00:00Z", author: { name: "Dana", username: "dana" }, added: ["a"] }] });
  const post = async (headers, b = body) => app.fetch(new Request("https://dash.example/api/github/webhook", { method: "POST", body: b, headers: { "content-type": "application/json", ...headers } }));
  assert.equal((await post({ "x-github-event": "push", "x-hub-signature-256": await sign("wrong", body) })).status, 401);
  assert.equal((await post({ "x-github-event": "push" })).status, 401);
  const ok = await post({ "x-github-event": "push", "x-github-delivery": "d1", "x-hub-signature-256": await sign("hook-secret", body) });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).did, "push 1");
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM commits")).n, 1);
  const form = "payload=x";
  assert.equal((await post({ "x-github-event": "push", "x-hub-signature-256": await sign("hook-secret", form) }, form)).status, 400);
  const off = createApp({ env: { AUTH: "none" }, store: memStore() });
  assert.equal((await off.fetch(new Request("https://dash.example/api/github/webhook", { method: "POST", body }))).status, 503);
});

test("demo mode works with no token and no sign-in", async () => {
  const app = createApp({ env: { DEMO: "1", DEMO_SCALE: "0.2" }, store: memStore() });
  const me = await (await get(app, "/api/me")).json();
  assert.equal(me.demo, true);
  const ov = await (await get(app, "/api/overview?range=7d")).json();
  assert.ok(ov.tiles.commits > 50);
  const list = await (await get(app, "/api/commits?range=7d")).json();
  const c = list.items[0];
  const d = await (await get(app, `/api/commits/${c.repo}/${c.sha}`)).json();
  assert.ok(Array.isArray(d.files) && d.files.length > 0 && d.files[0].patch.includes("@@"));
});

test("public/_headers carries the same security headers as the Worker", () => {
  const text = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.ok(text.includes(`  ${k}: ${v}\n`), k);
});
