// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../src/config.js";
import { ingest, readBody, sign, verifySignature } from "../src/webhook.js";
import { memStore, sha } from "./helpers.js";

const cfg = readConfig({ GITHUB_ORG: "acme", GITHUB_TOKEN: "t", GITHUB_WEBHOOK_SECRET: "old-secret,new-secret" });
const repo = { id: 7, full_name: "acme/api", default_branch: "main", private: true, pushed_at: 1_790_000_000 };

function push({ ref = "refs/heads/main", after = sha(9), commits = null } = {}) {
  return {
    ref, before: sha(1), after, repository: repo, sender: { login: "Dana" }, pusher: { name: "dana" },
    commits: commits ?? [
      { id: sha(2), timestamp: "2026-10-18T10:00:00Z", message: "Add the bill\n\nCo-Authored-By: Claude <noreply@anthropic.com>", author: { name: "Dana Levi", email: "d@acme.example", username: "Dana" }, added: ["src/bill.ts"], modified: ["src/app.ts"], removed: [] },
      { id: sha(3), timestamp: "2026-10-18T10:05:00Z", message: "Bump x", author: { name: "dependabot[bot]", username: "dependabot[bot]" }, added: [], modified: ["package.json"], removed: [] },
    ],
  };
}

test("the signature is GitHub's HMAC-SHA256, any of the configured secrets, constant time", async () => {
  const body = JSON.stringify({ zen: "Keep it logically awesome." });
  assert.equal(await verifySignature(["s3cret"], body, await sign("s3cret", body)), true);
  assert.equal(await verifySignature(["other", "s3cret"], body, await sign("s3cret", body)), true);   // rotation
  assert.equal(await verifySignature(["s3cret"], body + " ", await sign("s3cret", body)), false);
  assert.equal(await verifySignature(["s3cret"], body, "sha1=abc"), false);
  assert.equal(await verifySignature([], body, await sign("s3cret", body)), false);
  assert.equal(await verifySignature(["s3cret"], body, null), false);
});

test("a body over the limit is refused without being read whole", async () => {
  const big = new Request("http://x/", { method: "POST", body: "x".repeat(2000) });
  assert.equal(await readBody(big, 1000), null);
  const ok = new Request("http://x/", { method: "POST", body: "hello" });
  assert.equal(new TextDecoder().decode(await readBody(ok, 1000)), "hello");
});

test("a push stores its commits, their paths and authors, and the push, once", async () => {
  const store = memStore();
  assert.equal(await ingest({ store, cfg }, "push", "d-1", push()), "push 2");
  const commits = await store.all("SELECT * FROM commits ORDER BY sha");
  assert.equal(commits.length, 2);
  assert.equal(commits[0].agent, "claude");
  assert.equal(commits[0].author_login, "dana");
  assert.equal(commits[0].on_default, 1);
  assert.equal(commits[1].bot, 1);
  assert.deepEqual((await store.all("SELECT path FROM commit_files WHERE sha = ? ORDER BY path", sha(2))).map((r) => r.path), ["src/app.ts", "src/bill.ts"]);
  const p = await store.first("SELECT * FROM pushes");
  assert.equal(p.commits_n, 2);
  assert.equal(p.agent, "claude");
  assert.equal(p.at, 1_790_000_000_000);
  assert.equal((await store.first("SELECT name FROM people WHERE login = 'dana'")).name, "Dana Levi");
  // A repository never synced keeps waiting for its backfill; a synced one is not fetched again for this push.
  assert.equal((await store.first("SELECT synced_pushed_at FROM repos WHERE id = 7")).synced_pushed_at, null);
  await store.run("UPDATE repos SET synced_at = 1, synced_pushed_at = 1 WHERE id = 7");
  await ingest({ store, cfg }, "push", "d-0", push({ after: sha(8) }));
  assert.equal((await store.first("SELECT synced_pushed_at FROM repos WHERE id = 7")).synced_pushed_at, 1_790_000_000_000);
  // GitHub redelivers: the same delivery id is handled once.
  assert.equal(await ingest({ store, cfg }, "push", "d-1", push()), "duplicate");
  // The same push under another delivery id is still one push.
  await ingest({ store, cfg }, "push", "d-2", push());
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM pushes WHERE head = ?", sha(9))).n, 1);
});

test("a deleted branch, a tag push and an unwatched repository", async () => {
  const store = memStore();
  assert.equal(await ingest({ store, cfg }, "push", "a", push({ after: "0".repeat(40) })), "ignored");
  assert.equal(await ingest({ store, cfg }, "push", "b", push({ ref: "refs/tags/v1.2.0" })), "tag");
  assert.equal((await store.first("SELECT kind, name FROM markers")).name, "v1.2.0");
  const other = { ...push(), repository: { ...repo, id: 8, full_name: "someone/else" } };
  assert.match(await ingest({ store, cfg }, "push", "c", other), /not a watched repository/);
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM repos WHERE id = 8")).n, 0);
});

test("pull requests: newer never loses to older, reviews and CI are kept", async () => {
  const store = memStore();
  const pr = (state, updated, extra = {}) => ({ action: "edited", repository: repo, pull_request: {
    number: 12, title: "Fix the bill", state, merged_at: state === "closed" ? "2026-10-18T12:00:00Z" : null, user: { login: "dana" }, author_association: "MEMBER",
    head: { ref: "claude/fix-bill", sha: sha(5), repo: { full_name: "acme/api" } }, base: { ref: "main", repo: { full_name: "acme/api" } },
    created_at: "2026-10-18T09:00:00Z", updated_at: updated, labels: [{ name: "bug" }], additions: 10, deletions: 2, changed_files: 3, html_url: "https://github.com/acme/api/pull/12", ...extra } });
  await ingest({ store, cfg }, "pull_request", "1", pr("closed", "2026-10-18T12:00:00Z"));
  await ingest({ store, cfg }, "pull_request", "2", pr("open", "2026-10-18T11:00:00Z"));   // late, older
  const row = await store.first("SELECT * FROM prs");
  assert.equal(row.state, "closed");
  assert.equal(row.merged, 1);
  assert.equal(row.agent, "claude");                       // a member's claude/ branch
  assert.equal(row.labels, '["bug"]');
  await ingest({ store, cfg }, "pull_request_review", "3", { ...pr("closed", "2026-10-18T12:00:00Z"), review: { state: "APPROVED" } });
  assert.equal((await store.first("SELECT review FROM prs")).review, "approved");
  // CI: a failure sticks until the sync replaces it with GitHub's rollup.
  await ingest({ store, cfg }, "check_suite", "4", { repository: repo, check_suite: { head_sha: sha(5), status: "completed", conclusion: "failure" } });
  await ingest({ store, cfg }, "check_suite", "5", { repository: repo, check_suite: { head_sha: sha(5), status: "completed", conclusion: "success" } });
  assert.equal((await store.first("SELECT state FROM ci")).state, "failure");
  assert.equal((await store.first("SELECT dirty FROM repos WHERE id = 7")).dirty, 1);
});

test("a fork's branch is not evidence of an agent", async () => {
  const store = memStore();
  await ingest({ store, cfg }, "pull_request", "1", { repository: repo, pull_request: {
    number: 3, title: "x", state: "open", user: { login: "stranger" }, author_association: "NONE",
    head: { ref: "claude/x", sha: sha(6), repo: { full_name: "stranger/api" } }, base: { ref: "main", repo: { full_name: "acme/api" } },
    created_at: "2026-10-18T09:00:00Z", updated_at: "2026-10-18T09:00:00Z", labels: [] } });
  assert.equal((await store.first("SELECT agent FROM prs")).agent, null);
});

test("deploys, their status, releases and their removal", async () => {
  const store = memStore();
  await ingest({ store, cfg }, "deployment", "1", { repository: repo, deployment: { id: 55, environment: "production", sha: sha(7), ref: "main", created_at: "2026-10-18T13:00:00Z", creator: { login: "Dana" } } });
  await ingest({ store, cfg }, "deployment_status", "2", { repository: repo, deployment: { id: 55, environment: "production", sha: sha(7), ref: "main", created_at: "2026-10-18T13:00:00Z" }, deployment_status: { state: "success", created_at: "2026-10-18T13:04:00Z" } });
  const d = await store.first("SELECT * FROM markers WHERE kind = 'deploy'");
  assert.equal(d.state, "success");
  assert.equal(d.finished_at, Date.parse("2026-10-18T13:04:00Z"));
  await ingest({ store, cfg }, "release", "3", { action: "published", repository: repo, release: { id: 9, tag_name: "v2.0.0", name: "v2.0.0", published_at: "2026-10-18T14:00:00Z", html_url: "https://github.com/acme/api/releases/v2.0.0" } });
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM markers WHERE kind = 'release'")).n, 1);
  await ingest({ store, cfg }, "release", "4", { action: "deleted", repository: repo, release: { id: 9 } });
  assert.equal((await store.first("SELECT COUNT(*) AS n FROM markers WHERE kind = 'release'")).n, 0);
});

test("repositories removed from the App's installation stop counting", async () => {
  const store = memStore();
  await ingest({ store, cfg }, "push", "1", push());
  await ingest({ store, cfg }, "installation_repositories", "2", { action: "removed", repositories_removed: [{ id: 7, full_name: "acme/api" }] });
  assert.equal((await store.first("SELECT removed FROM repos WHERE id = 7")).removed, 1);
});
