// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { shapeFiles, PATCH_LINES } from "../src/diff.js";
import { appJwt, forgetTokens, installationToken, pemToPkcs8 } from "../src/github/app-auth.js";
import { ciOf, prRow, releaseMarker, tagMarker } from "../src/github/normalize.js";
import { snapshotQuery } from "../src/github/queries.js";
import { binSize, offsetAt, segments, validTz } from "../src/time.js";
import { fakeFetch } from "./helpers.js";

test("a GitHub App key in PKCS#1 signs a JWT GitHub can verify", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" });
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.deepEqual(Buffer.from(pemToPkcs8(pkcs1)), Buffer.from(pemToPkcs8(pkcs8)), "the wrapped PKCS#1 key is the PKCS#8 key");
  const jwt = await appJwt("123", pkcs1.replace(/\n/g, "\\n"), Date.parse("2026-10-19T00:00:00Z"));
  const [h, p, s] = jwt.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url")));
  const claims = JSON.parse(Buffer.from(p, "base64url"));
  assert.equal(claims.iss, "123");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.throws(() => pemToPkcs8("not a key"), /not a PEM/);
});

test("the installation token is found, fetched once and kept until near its end", async () => {
  forgetTokens();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cfg = { appId: "9", appKey: privateKey.export({ type: "pkcs1", format: "pem" }), org: "acme", apiUrl: "https://api.github.com" };
  const fetch = fakeFetch([
    ["/orgs/acme/installation", { body: { id: 42 } }],
    ["/app/installations/42/access_tokens", { status: 201, body: { token: "ghs_x", expires_at: new Date(Date.now() + 3_600_000).toISOString() } }],
  ]);
  assert.equal(await installationToken(cfg, fetch), "ghs_x");
  assert.equal(await installationToken(cfg, fetch), "ghs_x");
  assert.equal(fetch.calls.length, 2);
  assert.match(fetch.calls[1].init.headers.authorization, /^Bearer ey/);
});

test("time zones: offsets, daylight saving, bins", () => {
  assert.equal(validTz("Asia/Jerusalem"), true);
  assert.equal(validTz("Mars/Olympus"), false);
  assert.equal(offsetAt("Asia/Kolkata", Date.now()), 5.5 * 3_600_000);
  const s = segments("Europe/London", Date.UTC(2026, 9, 20), Date.UTC(2026, 10, 5));
  assert.equal(s.length, 2);
  assert.equal(s[0].to, Date.UTC(2026, 9, 25, 1));
  assert.deepEqual(s.map((x) => x.offset / 3_600_000), [1, 0]);
  assert.equal(segments("UTC", 0, 86_400_000).length, 1);
  assert.equal(binSize(0, 86_400_000), 3_600_000);
  assert.equal(binSize(0, 7 * 86_400_000), 3 * 3_600_000);
  assert.equal(binSize(0, 90 * 86_400_000), 86_400_000);
});

test("diffs are cut to what a page can draw, and lock files are marked", () => {
  const long = Array.from({ length: PATCH_LINES + 50 }, (_, i) => `+line ${i}`).join("\n");
  const out = shapeFiles([
    { filename: "package-lock.json", status: "modified", additions: 3000, deletions: 10, patch: long },
    { filename: "src/a.ts", status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
    { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
  ]);
  assert.equal(out.files[0].cut, true);
  assert.equal(out.files[0].patch.split("\n").length, PATCH_LINES);
  assert.equal(out.files[0].generated, true);
  assert.equal(out.files[1].generated, false);
  assert.equal(out.files[2].binary, true);
  const many = shapeFiles(Array.from({ length: 400 }, (_, i) => ({ filename: `f${i}`, patch: "x".repeat(10_000) })));
  assert.equal(many.files.length, 300);
  assert.equal(many.cutAll, true);
  assert.ok(many.files.reduce((a, f) => a + (f.patch?.length ?? 0), 0) <= 1_500_000);
});

test("GraphQL pull requests, releases, tags and CI states into rows", () => {
  const row = prRow(1, { number: 5, title: "x", state: "OPEN", isDraft: true, headRefName: "codex/x", baseRefName: "main", headRefOid: "b".repeat(40), isCrossRepository: false,
    authorAssociation: "MEMBER", reviewDecision: "CHANGES_REQUESTED", author: { login: "Dana" }, labels: { nodes: [{ name: "bug" }] }, createdAt: "2026-10-18T00:00:00Z",
    updatedAt: "2026-10-18T01:00:00Z", url: "https://evil.example/x", commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] } });
  assert.equal(row.agent, "codex");
  assert.equal(row.review, "changes_requested");
  assert.equal(row.ci, "failure");
  assert.equal(row.draft, 1);
  assert.equal(row.url, null, "only GitHub's own URLs are kept");
  assert.equal(releaseMarker(1, { databaseId: 3, isDraft: true }), null);
  assert.equal(tagMarker(1, { name: "v1", target: { oid: "c".repeat(40), committedDate: "2026-10-01T00:00:00Z" } }).at, Date.parse("2026-10-01T00:00:00Z"));
  assert.deepEqual(["SUCCESS", "NEUTRAL", "FAILURE", "ERROR", "PENDING", "EXPECTED", null].map(ciOf), ["success", "success", "failure", "failure", "pending", "pending", null]);
});

test("the snapshot query asks about several repositories in one request, with bound variables", () => {
  const q = snapshotQuery([{ owner: "acme", name: "api", since: "2026-10-01T00:00:00Z", historyAfter: null, full: true }, { owner: "acme", name: "web\" }", since: null, historyAfter: "c1", full: false }]);
  assert.match(q.query, /r0: repository\(owner: \$o0, name: \$n0\)/);
  assert.match(q.query, /r1: repository/);
  assert.ok(!q.query.includes("web\""), "names never go into the query text");
  assert.equal(q.variables.n1, "web\" }");
  assert.equal(q.variables.a1, "c1");
});
