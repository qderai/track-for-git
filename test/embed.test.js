// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { render, target } from "../scripts/build-embed.mjs";
import { createApp, normalBase } from "../src/app.js";
import { frameAncestorsOf, mount, pageHeaders, rebase } from "../src/embed.js";
import { parseFilter } from "../src/queries.js";
import { sign } from "../src/webhook.js";
import { dayAfter, dayStart, setTimeZone } from "../public/js/i18n.js";
import { memStore, sha } from "./helpers.js";

const req = (path, init) => new Request(`https://app.example${path}`, init);
const DAY = 86_400_000;

test("src/embed-assets.js is the page as it is now (npm run build:embed after changing public/)", () => {
  assert.equal(readFileSync(target, "utf8").replace(/\r\n/g, "\n"), render());
});

test("a base is '/' or a path in slashes; anything odd is '/'", () => {
  assert.equal(normalBase(), "/");
  assert.equal(normalBase("/tools/code"), "/tools/code/");
  assert.equal(normalBase("/tools/code/"), "/tools/code/");
  for (const bad of ["tools", "//evil.example/", "/a/../b/", "/a b/", "https://x/"]) assert.equal(normalBase(bad), "/", bad);
});

test("mounted under a path: the page with its links under it, its API, and nothing else", async () => {
  const code = mount({ base: "/tools/code", env: { DEMO: "1" }, store: memStore() });
  assert.equal(code.base, "/tools/code/");
  const bare = await code.fetch(req("/tools/code?tab=prs"));
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "/tools/code/?tab=prs");
  assert.equal(await code.fetch(req("/elsewhere")), null, "the app's own paths stay the app's");
  assert.equal(await code.fetch(req("/tools/codex/")), null);

  const page = await code.fetch(req("/tools/code/"));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  const html = await page.text();
  assert.match(html, /<link rel="stylesheet" href="\/tools\/code\/styles\.css">/);
  assert.match(html, /<script type="module" src="\/tools\/code\/js\/app\.js">/);
  assert.match(html, /action="\/tools\/code\/auth\/logout"/);
  assert.match(html, /src="\/tools\/code\/brand\/qder-lockup-ltr-cobalt\.svg"/, "Built by Qder.ai stays");
  assert.ok(!/(href|src|action)="\/(?!tools\/code\/|\/)/.test(html), "no link left at the host's root");
  // A path under base with no file is the page (its state lives in the query); a missing file is a 404.
  assert.match(await (await code.fetch(req("/tools/code/commits"))).text(), /<!doctype html>/);
  assert.equal((await code.fetch(req("/tools/code/js/nothing.js"))).status, 404);
  assert.equal((await code.fetch(req("/tools/code/js/app.js", { method: "POST" }))).status, 405);

  const js = await code.fetch(req("/tools/code/js/app.js"));
  assert.match(js.headers.get("content-type"), /^text\/javascript/);
  assert.match(await js.text(), /import\.meta\.url/, "the page builds its addresses from where it is served");
  const again = await code.fetch(req("/tools/code/js/app.js", { headers: { "if-none-match": js.headers.get("etag") } }));
  assert.equal(again.status, 304);

  const me = await (await code.fetch(req("/tools/code/api/me"))).json();
  assert.equal(me.demo, true);
  assert.equal((await code.fetch(req("/tools/code/api/overview?range=7d"))).status, 200);
  assert.equal((await code.fetch(req("/tools/code/healthz"))).status, 200);
});

test("frames: none by default; the app's own origin or named https origins only when asked", async () => {
  assert.equal(frameAncestorsOf(), "'none'");
  assert.equal(frameAncestorsOf("'self'"), "'self'");
  assert.equal(frameAncestorsOf("https://a.example https://b.example:8443"), "https://a.example https://b.example:8443");
  for (const bad of ["*", "javascript:alert(1)", "http://plain.example", "'self'; script-src *", ""]) assert.equal(frameAncestorsOf(bad), "'none'", bad);
  assert.equal(pageHeaders()["x-frame-options"], "DENY");
  assert.equal(pageHeaders("'self'")["x-frame-options"], "SAMEORIGIN");
  assert.equal(pageHeaders("https://a.example")["x-frame-options"], undefined);
  assert.match(pageHeaders("'self'")["content-security-policy"], /frame-ancestors 'self';/);

  const def = await mount({ base: "/c/", env: { DEMO: "1" }, store: memStore() }).fetch(req("/c/"));
  assert.equal(def.headers.get("x-frame-options"), "DENY");
  assert.match(def.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  const framed = await mount({ base: "/c/", env: { DEMO: "1" }, store: memStore(), frameAncestors: "'self'" }).fetch(req("/c/"));
  assert.equal(framed.headers.get("x-frame-options"), "SAMEORIGIN");
  assert.match(framed.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  assert.equal(rebase('<a href="/x">', "/"), '<a href="/x">');
  assert.equal(rebase('<a href="//cdn.example/x">', "/b/"), '<a href="//cdn.example/x">');
});

test("the webhook at the app's own address: still signed, still refused unsigned", async () => {
  const code = mount({ base: "/c/", env: { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none", GITHUB_WEBHOOK_SECRET: "hook-secret" }, store: memStore() });
  const body = JSON.stringify({ zen: "Keep it logically awesome.", hook_id: 1 });
  const unsigned = await code.webhook(new Request("https://public.example/hooks/github", { method: "POST", body, headers: { "x-github-event": "ping" } }));
  assert.equal(unsigned.status, 401);
  const signed = await code.webhook(new Request("https://public.example/hooks/github", { method: "POST", body,
    headers: { "x-github-event": "ping", "x-github-delivery": "d-1", "x-hub-signature-256": await sign("hook-secret", body) } }));
  assert.equal(signed.status, 200);
});

test("GitHub sign-in under a path: its callback, cookies and sign-out stay under it", async () => {
  const env = { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "github", GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "cs", SESSION_SECRET: "s".repeat(40) };
  const code = mount({ base: "/c/", env, store: memStore() });
  const start = await code.fetch(req("/c/auth/login?back=/c/?tab=prs"));
  assert.equal(start.status, 302);
  assert.equal(new URL(start.headers.get("location")).searchParams.get("redirect_uri"), "https://app.example/c/auth/callback");
  assert.match(start.headers.get("set-cookie"), /Path=\/c\/;/);
  const out = await code.fetch(req("/c/auth/logout", { method: "POST" }));
  assert.equal(out.headers.get("location"), "/c/");
  assert.match(out.headers.get("set-cookie"), /Path=\/c\/;/);
  assert.equal((await (await code.fetch(req("/c/api/me"))).json()).signIn, "/c/auth/login");
  // On its own host nothing moved.
  const own = createApp({ env, store: memStore() });
  assert.equal(new URL((await own.fetch(req("/auth/login"))).headers.get("location")).searchParams.get("redirect_uri"), "https://app.example/auth/callback");
});

/** Two watched repositories, a commit, and one stored deploy. */
function seeded(now) {
  const store = memStore();
  store.db.exec("INSERT INTO repos (id, full_name, default_branch) VALUES (11, 'acme/web', 'main'), (12, 'acme/api', 'main')");
  store.db.prepare("INSERT INTO commits (repo_id, sha, at, branch, on_default, author_login, author_name, message) VALUES (11, ?, ?, 'main', 1, 'dana', 'Dana', 'Ship it')").run(sha(1), now - 3_600_000);
  store.db.prepare("INSERT INTO markers (id, repo_id, kind, name, environment, state, sha, at, finished_at) VALUES ('deploy:12:1', 12, 'deploy', 'staging', 'staging', 'success', ?, ?, ?)")
    .run(sha(9), now - 7_200_000, now - 7_100_000);
  return store;
}

test("hooks.markers: the app's own deploys on the timeline, in the tiles and in the Story; nonsense and failures add nothing", async () => {
  const now = Date.now();
  let asked = null;
  const hooks = {
    markers: (range) => {
      asked = range;
      return [
        { id: "run-1", repo: "acme/web", kind: "deploy", state: "success", environment: "production", name: "v7", sha: sha(1), at: now - 1_900_000, finishedAt: now - 1_800_000 },
        { id: "run-2", repo: "ACME/Web", state: "failure", environment: "production", at: now - 900_000 },
        { id: "run-3", repo: "someone/else", state: "success", at: now - 900_000 },          // not watched
        { id: "run-4", repo: "acme/web", state: "success", at: "soon" },                    // no time
        { repo: "acme/web", state: "success", at: now },                                    // no id
        { id: "run-5", repo: "acme/web", state: "success", at: now - 40 * DAY },            // outside the range
        { id: "run-6", repo: "acme/web", state: "success", at: now - 600_000, url: "javascript:alert(1)" },
      ];
    },
  };
  const app = createApp({ env: { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none" }, store: seeded(now), hooks });
  const o = await (await app.fetch(req("/api/overview?range=7d&tz=UTC"))).json();
  assert.ok(asked && asked.to > asked.from, "asked for the range shown");
  const own = o.markers.filter((m) => m.id.startsWith("hook:"));
  assert.deepEqual(own.map((m) => m.id).sort(), ["hook:run-1", "hook:run-2", "hook:run-6"]);
  assert.equal(o.tiles.deploys, 4, "three of the app's own plus the stored one");
  const run1 = own.find((m) => m.id === "hook:run-1");
  assert.equal(run1.at, now - 1_800_000, "drawn when it finished");
  assert.equal(run1.repoName, "acme/web");
  assert.equal(own.find((m) => m.id === "hook:run-2").state, "failure");
  assert.equal(own.find((m) => m.id === "hook:run-6").url, null, "only https links");
  const one = await (await app.fetch(req("/api/overview?range=7d&tz=UTC&repos=12"))).json();
  assert.ok(!one.markers.some((m) => m.id.startsWith("hook:")), "the repository filter applies to them too");
  const s = await (await app.fetch(req("/api/story?range=7d&tz=UTC"))).json();
  assert.ok(s.days.some((d) => d.deploys.some((m) => m.id === "hook:run-1")));

  const broken = createApp({ env: { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none" }, store: seeded(now), hooks: { markers: () => { throw new Error("pipeline down"); } } });
  const r = await broken.fetch(req("/api/overview?range=7d&tz=UTC"));
  assert.equal(r.status, 200, "a failing hook never breaks the dashboard");
  assert.equal((await r.json()).tiles.deploys, 1);
});

test("Live now: the app's own answer, else the newest successful deploy (production first)", async () => {
  const now = Date.now();
  const env = { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none" };
  // Only a staging deploy stored: that is what is live.
  let o = await (await createApp({ env, store: seeded(now) }).fetch(req("/api/overview?range=7d&tz=UTC"))).json();
  assert.deepEqual([o.live.repoName, o.live.sha, o.live.environment, o.live.known], ["acme/api", sha(9), "staging", false]);
  // A production deploy from the app's pipeline wins over a newer staging one.
  const hooks = { markers: () => [{ id: "p", repo: "acme/web", environment: "production", state: "success", sha: sha(1), at: now - 8_000_000 }] };
  o = await (await createApp({ env, store: seeded(now), hooks }).fetch(req("/api/overview?range=7d&tz=UTC"))).json();
  assert.deepEqual([o.live.repoName, o.live.environment, o.live.known], ["acme/web", "production", true]);
  // The app knows best (a rollback by hand): hooks.live.
  const told = { live: () => ({ repo: "acme/web", sha: sha(1), environment: "production", name: "worker 1a2b", at: now - 60_000 }) };
  o = await (await createApp({ env, store: seeded(now), hooks: told }).fetch(req("/api/overview?range=7d&tz=UTC"))).json();
  assert.deepEqual([o.live.sha, o.live.name, o.live.known], [sha(1), "worker 1a2b", true]);
  for (const bad of [() => null, () => ({ repo: "acme/web", sha: "not-a-sha" }), () => ({ repo: "nobody/else", sha: sha(1) }), () => { throw new Error("x"); }]) {
    o = await (await createApp({ env, store: seeded(now), hooks: { live: bad } }).fetch(req("/api/overview?range=7d&tz=UTC"))).json();
    assert.equal(o.live, null);
  }
  // Nothing deployed: no tile.
  o = await (await createApp({ env, store: memStore() }).fetch(req("/api/overview?range=7d&tz=UTC"))).json();
  assert.equal(o.live, null);
});

test("TIME_ZONE: the team's zone for days and hours, said in /api/me; an unknown zone is ignored", async () => {
  const me = await (await createApp({ env: { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none", TIME_ZONE: "Asia/Jerusalem" }, store: memStore() }).fetch(req("/api/me"))).json();
  assert.equal(me.timeZone, "Asia/Jerusalem");
  const none = await (await createApp({ env: { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none", TIME_ZONE: "Mars/Olympus" }, store: memStore() }).fetch(req("/api/me"))).json();
  assert.equal(none.timeZone, null);
  assert.equal(parseFilter(new URLSearchParams("range=7d"), Date.now(), "Asia/Jerusalem").tz, "Asia/Jerusalem");
  assert.equal(parseFilter(new URLSearchParams("range=7d&tz=Europe/London"), Date.now(), "Asia/Jerusalem").tz, "Europe/London", "the page's own ask wins");
  assert.equal(parseFilter(new URLSearchParams("range=7d"), Date.now(), "Mars/Olympus").tz, "UTC");
});

test("the page's days in the zone shown, across a daylight-saving change", () => {
  setTimeZone("Asia/Jerusalem");
  assert.equal(dayStart("2026-10-19"), Date.UTC(2026, 9, 18, 21), "summer time: UTC+3");
  // Israel leaves summer time on Sunday 25 October 2026: that day is 25 hours long.
  assert.equal(dayStart("2026-10-25"), Date.UTC(2026, 9, 24, 21));
  assert.equal(dayStart(dayAfter("2026-10-25")), Date.UTC(2026, 9, 25, 22));
  assert.equal(dayAfter("2026-12-31"), "2027-01-01");
  assert.equal(setTimeZone("Mars/Olympus"), "Asia/Jerusalem", "an unknown zone changes nothing");
  setTimeZone("UTC");
  assert.equal(dayStart("2026-10-19"), Date.UTC(2026, 9, 19));
});

test("importHistory: an earlier tool's rows in, never over what GitHub said, twice is once", async () => {
  const { importHistory } = await import("../src/embed.js");
  const now = Date.now();
  const store = seeded(now);
  // GitHub's own row for commit 1 already says who and how much; the import may only fill what is empty.
  store.db.prepare("UPDATE commits SET additions = 7, agent = 'claude' WHERE sha = ?").run(sha(1));
  const rows = {
    commits: [
      { repo_id: 11, sha: sha(1), at: now - 3_600_000, branch: "main", on_default: 1, author_name: "Dana", agent: "codex", message: "Ship it", additions: 999 },
      { repo_id: 11, sha: sha(2), at: now - 7_200_000, branch: "feature/x", author_name: "Dana", agent: "claude", message: "Branch work", additions: 3, deletions: 1 },
      { repo_id: 99, sha: sha(3), at: now, message: "an unknown repository" },
      { repo_id: 11, sha: "not-a-sha", at: now },
    ],
    pushes: [{ repo_id: 11, branch: "main", head: sha(1), at: now - 3_500_000, actor: "Dana", commits_n: 1 }, { repo_id: 11, branch: "main", head: "x", at: now }],
    prs: [{ repo_id: 12, number: 5, title: "Old title", state: "closed", merged: 1, author_login: "dana", created_at: now - DAY, updated_at: now - 1000, merged_at: now - 1000, url: "javascript:x" }],
  };
  const first = await importHistory(store, rows);
  assert.deepEqual(first, { commits: 2, pushes: 1, prs: 1, skipped: 3 });
  const c1 = store.db.prepare("SELECT agent, additions FROM commits WHERE sha = ?").get(sha(1));
  assert.deepEqual({ ...c1 }, { agent: "claude", additions: 7 }, "what GitHub's sync recorded stays");
  assert.equal(store.db.prepare("SELECT deletions FROM commits WHERE sha = ?").get(sha(1)).deletions, null);
  assert.deepEqual({ ...store.db.prepare("SELECT agent, additions, deletions FROM commits WHERE sha = ?").get(sha(2)) }, { agent: "claude", additions: 3, deletions: 1 }, "a new commit keeps its counts");
  const push = store.db.prepare("SELECT id, actor FROM pushes").get();
  assert.deepEqual({ ...push }, { id: `push:11:main:${sha(1)}`, actor: "dana" }, "the same id the sync and the webhook give that push");
  assert.equal(store.db.prepare("SELECT url FROM prs WHERE number = 5").get().url, null);
  // GitHub then says more about the pull request: a second import changes nothing.
  store.db.prepare("UPDATE prs SET title = 'New title', labels = '[\"x\"]' WHERE number = 5").run();
  await importHistory(store, rows);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM commits").get().n, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM pushes").get().n, 1);
  assert.deepEqual({ ...store.db.prepare("SELECT title, labels FROM prs WHERE number = 5").get() }, { title: "New title", labels: '["x"]' });
});

test("review fixes: Live now ignores the range shown, prefers production over many previews, and a silent hook is waited on 3 s at most", async () => {
  const now = Date.now();
  const env = { GITHUB_ORG: "acme", GITHUB_TOKEN: "t", AUTH: "none" };
  // The app's own production deploy two days ago: still live on a one-day view.
  const hooks = { markers: () => [{ id: "p", repo: "acme/web", environment: "production", state: "success", sha: sha(1), at: now - 2 * DAY }] };
  const o = await (await createApp({ env, store: seeded(now), hooks }).fetch(req("/api/overview?range=1d&tz=UTC"))).json();
  assert.equal(o.live?.environment, "production");
  // Thirty preview deploys after the last production one.
  const store = seeded(now);
  store.db.prepare("INSERT INTO markers (id, repo_id, kind, environment, state, sha, at) VALUES ('deploy:11:prod', 11, 'deploy', 'Production', 'success', ?, ?)").run(sha(1), now - 50 * 3_600_000);
  for (let i = 0; i < 30; i++) store.db.prepare("INSERT INTO markers (id, repo_id, kind, environment, state, sha, at) VALUES (?, 11, 'deploy', ?, 'success', ?, ?)").run(`deploy:11:pr${i}`, `preview-${i}`, sha(5), now - i * 60_000);
  const p = await (await createApp({ env, store }).fetch(req("/api/overview?range=7d&tz=UTC"))).json();
  assert.deepEqual([p.live.environment, p.live.sha], ["Production", sha(1)]);
  // A hook that never answers.
  const never = () => new Promise(() => {});
  const started = Date.now();
  const slow = await createApp({ env, store: seeded(now), hooks: { markers: never, live: never }, hookMs: 50 }).fetch(req("/api/overview?range=7d&tz=UTC"));
  assert.equal(slow.status, 200);
  assert.ok(Date.now() - started < 2_000, "went on without it");
  assert.equal((await slow.json()).live, null);
});

test("review fixes: two dashboards sharing one edge cache never see each other's answers", async () => {
  const { makeCache } = await import("../src/http.js");
  const kept = new Map();
  const edge = { match: async (k) => (kept.has(k) ? new Response(kept.get(k)) : undefined), put: async (k, r) => { kept.set(k, await r.text()); } };
  const a = makeCache(edge, 400, "/a/|acme"), b = makeCache(edge, 400, "/b/|globex");
  await a.put("answer:/api/facets", { org: "acme" }, 60);
  assert.equal(await b.get("answer:/api/facets"), null);
  assert.deepEqual(await makeCache(edge, 400, "/a/|acme").get("answer:/api/facets"), { org: "acme" }, "the same dashboard in another isolate does");
});

test("review fixes: a day that starts at 01:00 (summer time from midnight) starts then", () => {
  const label = (at, zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  for (const [zone, day] of [["America/Santiago", "2026-09-06"], ["Atlantic/Azores", "2026-03-29"], ["Asia/Jerusalem", "2026-03-27"], ["Europe/London", "2026-10-25"]]) {
    setTimeZone(zone);
    const at = dayStart(day);
    assert.equal(label(at, zone), day, `${zone} ${day} is that day`);
    assert.notEqual(label(at - 60_000, zone), day, `${zone} ${day} starts there`);
  }
  setTimeZone("UTC");
});
