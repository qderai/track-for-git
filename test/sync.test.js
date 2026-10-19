// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";
import { createGitHub, rateOf, reserveOf } from "../src/github/client.js";
import { prune, repoMatcher, runSync } from "../src/sync.js";
import { fakeFetch, memStore, sha } from "./helpers.js";

test("REPOS patterns: names, owners, wildcards, exclusions", () => {
  const all = repoMatcher([], "acme");
  assert.equal(all("acme/api"), true);
  assert.equal(all("ACME/Web"), true);
  assert.equal(all("other/api"), false);
  const some = repoMatcher(["api-*", "web", "!api-legacy", "partner/sdk"], "acme");
  assert.equal(some("acme/api-gateway"), true);
  assert.equal(some("acme/web"), true);
  assert.equal(some("acme/web-old"), false);
  assert.equal(some("acme/api-legacy"), false);
  assert.equal(some("partner/sdk"), true);
  assert.equal(some("acme/../x"), false);
  assert.equal(repoMatcher([], "")("acme/api"), false);   // no organisation and no list: nothing
});

test("the rate limit is read from every answer and a reserve is kept", () => {
  const h = new Headers({ "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "120", "x-ratelimit-reset": "1800000000", "x-ratelimit-resource": "graphql" });
  assert.deepEqual(rateOf(h), { resource: "graphql", limit: 5000, remaining: 120, reset: 1_800_000_000_000 });
  assert.equal(reserveOf(5000), 500);
  assert.equal(reserveOf(60), 30);
});

test("a run stops asking once GitHub says the allowance is spent", async () => {
  const cfg = readConfig({ GITHUB_ORG: "acme", GITHUB_TOKEN: "t" });
  const fetch = fakeFetch([["/orgs/acme/repos", { status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } }]]);
  const store = memStore();
  const gh = createGitHub(cfg, { fetchImpl: fetch, maxRequests: 10 });
  const r = await runSync({ store, cfg, gh }, Date.now());
  assert.ok(r.waiting, "it says it is waiting");
  assert.equal(fetch.calls.length, 1);
  // The next run does not ask before the reset.
  const gh2 = createGitHub(cfg, { fetchImpl: fetch, maxRequests: 10, rate: gh.rate() });
  assert.equal(gh2.can("core"), false);
});

test("a full sync: repositories, a GraphQL snapshot, the pushes of other branches", async () => {
  const now = Date.parse("2026-10-19T10:00:00Z");
  const cfg = readConfig({ GITHUB_ORG: "acme", GITHUB_TOKEN: "t", BACKFILL_DAYS: "7" });
  const repoRest = { id: 7, full_name: "acme/api", default_branch: "main", private: true, archived: false, pushed_at: "2026-10-19T09:00:00Z" };
  const node = {
    databaseId: 7, nameWithOwner: "acme/api", isArchived: false, isPrivate: true, pushedAt: "2026-10-19T09:00:00Z",
    defaultBranchRef: { name: "main", target: { history: { pageInfo: { hasNextPage: false }, nodes: [
      { oid: sha(11), message: "Add search\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>", authoredDate: "2026-10-19T08:00:00Z", additions: 40, deletions: 3, changedFilesIfAvailable: 2,
        author: { name: "Dana Levi", user: { login: "Dana" } }, associatedPullRequests: { nodes: [{ number: 41 }] } },
    ] } } },
    recent: { nodes: [{ number: 41, title: "Search", state: "MERGED", isDraft: false, merged: true, mergedAt: "2026-10-19T08:30:00Z", closedAt: "2026-10-19T08:30:00Z",
      createdAt: "2026-10-18T08:00:00Z", updatedAt: "2026-10-19T08:30:00Z", url: "https://github.com/acme/api/pull/41", additions: 40, deletions: 3, changedFiles: 2,
      headRefName: "cursor/search", baseRefName: "main", headRefOid: sha(11), isCrossRepository: false, authorAssociation: "MEMBER", reviewDecision: "APPROVED",
      author: { login: "Dana" }, labels: { nodes: [{ name: "feature" }] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] } }] },
    open: { totalCount: 0, nodes: [] },
    deployments: { nodes: [{ databaseId: 501, environment: "production", createdAt: "2026-10-19T09:10:00Z", commitOid: sha(11), ref: { name: "main" }, creator: { login: "Dana" }, latestStatus: { state: "SUCCESS", createdAt: "2026-10-19T09:14:00Z" } }] },
    releases: { nodes: [{ databaseId: 9, name: "v2", tagName: "v2.0.0", publishedAt: "2026-10-19T09:20:00Z", isPrerelease: false, isDraft: false, url: "https://github.com/acme/api/releases/v2.0.0" }] },
    refs: { nodes: [] },
  };
  const fetch = fakeFetch([
    ["/orgs/acme/repos", { body: [repoRest], headers: { etag: '"r1"' } }],
    ["/graphql", (u, init) => {
      const q = JSON.parse(init.body).query;
      if (q.includes("r0: repository")) return { body: { data: { r0: node } }, headers: { "x-ratelimit-resource": "graphql" } };
      return { body: { data: {} } };
    }],
    ["/repos/acme/api/events", { body: [{ type: "PushEvent", created_at: "2026-10-19T07:00:00Z", actor: { login: "Ruth" }, payload: { ref: "refs/heads/feature/x", head: sha(21), before: "0".repeat(40) } }], headers: { etag: '"e1"' } }],
    ["/repos/acme/api/compare/main...", { body: { total_commits: 1, commits: [{ sha: sha(21), commit: { message: "WIP", author: { name: "Ruth", date: "2026-10-19T06:59:00Z" } }, author: { login: "Ruth" } }] } }],
    ["/repos/acme/api/commits/", { body: { files: [{ filename: "src/x.ts" }], stats: { additions: 1, deletions: 0 } } }],
  ]);
  const store = memStore();
  const r = await runSync({ store, cfg, gh: createGitHub(cfg, { fetchImpl: fetch, maxRequests: 40 }) }, now);
  assert.deepEqual(r.errors, []);
  assert.equal(r.repos, 1);
  const c = await store.first("SELECT * FROM commits WHERE sha = ?", sha(11));
  assert.equal(c.agent, "cursor");
  assert.equal(c.additions, 40);
  assert.equal(c.pr_number, 41);
  assert.equal(c.on_default, 1);
  const pr = await store.first("SELECT * FROM prs");
  assert.equal(pr.review, "approved");
  assert.equal(pr.merged, 1);
  assert.equal(pr.agent, "cursor");
  assert.equal((await store.first("SELECT state FROM ci WHERE sha = ?", sha(11))).state, "success");
  assert.equal((await store.first("SELECT state FROM markers WHERE kind = 'deploy'")).state, "success");
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM markers WHERE kind = 'release'")).n, 1);
  // The other branch's push came from the events and the compare API; a new branch is compared with main.
  const push = await store.first("SELECT * FROM pushes");
  assert.equal(push.branch, "feature/x");
  assert.equal(push.created, 1);
  assert.ok(fetch.calls.some((x) => x.url.includes("/compare/main...")));
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM commits")).n, 2);
  const repo = await store.first("SELECT * FROM repos WHERE id = 7");
  assert.equal(repo.synced_pushed_at, Date.parse("2026-10-19T09:00:00Z"));
  assert.equal(repo.events_etag, '"e1"');
  // Nothing changed: the next run asks for the first page with its ETag and no snapshot.
  const fetch2 = fakeFetch([["/orgs/acme/repos", { status: 304 }]]);
  const r2 = await runSync({ store, cfg, gh: createGitHub(cfg, { fetchImpl: fetch2, maxRequests: 40 }) }, now + 120_000);
  assert.equal(r2.repos, 0);
  assert.equal(fetch2.calls.length, 1);
  assert.equal(fetch2.calls[0].init.headers["if-none-match"], '"r1"');
});

test("only one run at a time", async () => {
  const cfg = readConfig({ GITHUB_ORG: "acme", GITHUB_TOKEN: "t" });
  const store = memStore();
  await store.run("INSERT INTO state (key, value, updated_at) VALUES ('sync_lock', ?, 0)", String(Date.now() + 60_000));
  const r = await runSync({ store, cfg, gh: createGitHub(cfg, { fetchImpl: fakeFetch([]) }) });
  assert.match(r.skipped, /another run/);
});

test("retention removes old rows once a day", async () => {
  const store = memStore();
  const cfg = readConfig({ RETENTION_DAYS: "30" });
  const now = Date.now();
  await store.run("INSERT INTO repos (id, full_name) VALUES (1, 'acme/a')");
  await store.run("INSERT INTO commits (repo_id, sha, at, message) VALUES (1, ?, ?, 'old'), (1, ?, ?, 'new')", sha(1), now - 40 * 86_400_000, sha(2), now);
  await store.run("INSERT INTO commit_files (repo_id, sha, path) VALUES (1, ?, 'a'), (1, ?, 'b')", sha(1), sha(2));
  await prune(store, cfg, now);
  assert.deepEqual((await store.all("SELECT message FROM commits")).map((r) => r.message), ["new"]);
  assert.deepEqual((await store.all("SELECT path FROM commit_files")).map((r) => r.path), ["b"]);
});
