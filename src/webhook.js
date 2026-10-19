// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * GitHub's webhooks: a push, a pull request, a review, a check, a deploy or a release lands within a second. Every
 * delivery is checked against its HMAC-SHA256 signature (X-Hub-Signature-256) before anything is read; several
 * secrets may be set at once (comma-separated) so one can be rotated without missing deliveries. A delivery GitHub
 * sends twice is handled once. Only watched repositories are stored, whatever the hook covers.
 *
 * Reviews and checks are written at once from the event and the repository is flagged, so the next sync asks
 * GitHub for the exact review decision and CI rollup (an event alone cannot say what the other checks are doing).
 */
import { setState } from "./db.js";
import {
  SHA, ciOf, commitStmts, deployMarker, markerSql, prRow, prSql, pushFromWebhook, pushSql, releaseMarker, repoFromPayload, repoSql,
} from "./github/normalize.js";
import { repoMatcher } from "./sync.js";

const enc = new TextEncoder();

/** Pure but async. Is `header` (sha256=<hex>) the HMAC of `raw` with any of the secrets? Constant time. */
export async function verifySignature(secrets, raw, header) {
  if (!secrets?.length || typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/i.test(header)) return false;
  const sig = Uint8Array.from(header.slice(7).match(/../g).map((h) => parseInt(h, 16)));
  const body = typeof raw === "string" ? enc.encode(raw) : raw;
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (await crypto.subtle.verify("HMAC", key, sig, body)) return true;
  }
  return false;
}

/** GitHub caps a delivery at 25 MB; anything bigger is not GitHub. */
export const MAX_BODY = 25 * 1024 * 1024;

/** The body, read a chunk at a time and given up on past `max` bytes: null when too large. */
export async function readBody(req, max = MAX_BODY) {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => undefined); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.byteLength; }
  return all;
}

const REVIEW = { approved: "approved", changes_requested: "changes_requested", commented: "commented" };

/**
 * Store what one delivery says. Returns a short word for the response and the log.
 * @param {{ store: any, cfg: import("./config.js").Config }} ctx
 */
export async function ingest(ctx, event, delivery, payload, now = Date.now()) {
  const { store, cfg } = ctx;
  if (delivery) {
    const r = await store.run("INSERT OR IGNORE INTO deliveries (id, at) VALUES (?, ?)", String(delivery).slice(0, 80), now);
    if (!r.changes) return "duplicate";
  }
  await setState(store, "webhook_at", String(now), now);
  if (event === "ping") return "ping";

  // The App's own events: repositories added to or removed from its installation.
  if (event === "installation_repositories" || event === "installation") {
    await store.run("UPDATE state SET value = '0' WHERE key = 'discover_at'");     // list them again on the next run
    const removed = (payload?.repositories_removed ?? (payload?.action === "deleted" ? payload?.repositories : [])) ?? [];
    for (const r of removed) if (Number.isInteger(r?.id)) await store.run("UPDATE repos SET removed = 1 WHERE id = ?", r.id);
    return event;
  }

  const repo = repoFromPayload(payload?.repository);
  if (!repo) return "ignored";
  const matches = repoMatcher(cfg.repos, cfg.org);
  if (!matches(repo.full_name)) return "ignored: not a watched repository";
  if (event === "repository") {
    if (["deleted", "transferred"].includes(payload?.action) || (payload?.action === "archived" && !cfg.includeArchived)) {
      await store.run("UPDATE repos SET removed = 1 WHERE id = ?", repo.id);
      return `repository ${payload.action}`;
    }
    await store.batch([repoSql(repo)]);
    return `repository ${payload?.action ?? ""}`.trim();
  }
  // Any other event about a repository makes sure it is known (a new repository's first push comes before a listing).
  const stmts = [repoSql(repo)];

  switch (event) {
    case "push": {
      if (String(payload?.ref ?? "").startsWith("refs/tags/") && SHA.test(String(payload?.after)) && !/^0+$/.test(payload.after)) {
        const name = String(payload.ref).slice(10, 210);
        stmts.push(markerSql({ id: `tag:${repo.id}:${name}`, repo_id: repo.id, kind: "tag", name, environment: null, state: null, sha: payload.after, ref: name,
          at: repo.pushed_at ?? now, finished_at: null, actor: String(payload?.sender?.login ?? "").toLowerCase() || null, url: null, prerelease: 0 }));
        await store.batch(stmts);
        return "tag";
      }
      const r = pushFromWebhook(payload, cfg.agents, now);
      if (!r) { await store.batch(stmts); return "ignored"; }
      // The commits before the push: a push row is the claim that its commits are stored. The push is then synced:
      // polling does not fetch it again (their line counts follow from the sync's small fill-in step).
      stmts.push(...commitStmts(r.commits), pushSql(r.push),
        { sql: "UPDATE repos SET synced_pushed_at = MAX(COALESCE(synced_pushed_at, 0), COALESCE(pushed_at, 0)) WHERE id = ? AND synced_at IS NOT NULL", binds: [repo.id] });
      await store.batch(stmts);
      return `push ${r.commits.length}`;
    }
    case "pull_request": {
      const row = prRow(repo.id, payload?.pull_request, cfg.agents, cfg.webUrl);
      if (!row) return "ignored";
      stmts.push(prSql(row), { sql: "UPDATE repos SET dirty = 1 WHERE id = ?", binds: [repo.id] });
      await store.batch(stmts);
      return `pull request ${row.number}`;
    }
    case "pull_request_review": {
      const row = prRow(repo.id, payload?.pull_request, cfg.agents, cfg.webUrl);
      const state = REVIEW[String(payload?.review?.state ?? "").toLowerCase()];
      if (!row) return "ignored";
      stmts.push(prSql(row));
      if (state) stmts.push({ sql: "UPDATE prs SET review = ? WHERE repo_id = ? AND number = ? AND (review IS NULL OR ? != 'commented')", binds: [state, repo.id, row.number, state] });
      stmts.push({ sql: "UPDATE repos SET dirty = 1 WHERE id = ?", binds: [repo.id] });
      await store.batch(stmts);
      return `review ${row.number}`;
    }
    case "check_suite":
    case "check_run":
    case "status": {
      const obj = event === "status" ? payload : payload?.[event];
      const sha = event === "status" ? payload?.sha : obj?.head_sha;
      if (!SHA.test(String(sha))) return "ignored";
      const state = event === "status" ? ciOf(payload?.state) : obj?.status === "completed" ? ciOf(obj?.conclusion) : "pending";
      if (!state) return "ignored";
      // One check finishing well says nothing about the others: a success is written only over a pending; a failure
      // always wins; the next sync replaces it with GitHub's rollup.
      stmts.push({ sql: `INSERT INTO ci (repo_id, sha, state, at) VALUES (?,?,?,?) ON CONFLICT(repo_id, sha) DO UPDATE SET state = CASE
          WHEN excluded.state = 'failure' THEN 'failure' WHEN ci.state = 'failure' THEN ci.state ELSE excluded.state END, at = excluded.at`, binds: [repo.id, sha, state, now] });
      stmts.push({ sql: "UPDATE repos SET dirty = 1 WHERE id = ?", binds: [repo.id] });
      await store.batch(stmts);
      return `ci ${state}`;
    }
    case "deployment": {
      const m = deployMarker(repo.id, { ...payload?.deployment, creator: payload?.deployment?.creator, state: "pending" });
      if (!m) return "ignored";
      stmts.push(markerSql(m));
      await store.batch(stmts);
      return "deploy";
    }
    case "deployment_status": {
      const d = payload?.deployment;
      const st = payload?.deployment_status;
      const m = deployMarker(repo.id, { ...d, latestStatus: { state: st?.state, createdAt: st?.created_at } });
      if (!m) return "ignored";
      stmts.push(markerSql(m));
      await store.batch(stmts);
      return `deploy ${m.state}`;
    }
    case "release": {
      if (payload?.action === "deleted" || payload?.action === "unpublished") {
        stmts.push({ sql: "DELETE FROM markers WHERE id = ?", binds: [`release:${repo.id}:${payload?.release?.id}`] });
        await store.batch(stmts);
        return "release removed";
      }
      const m = releaseMarker(repo.id, payload?.release, cfg.webUrl);
      if (!m) return "ignored";
      stmts.push(markerSql(m));
      await store.batch(stmts);
      return "release";
    }
    case "delete": {
      if (payload?.ref_type === "tag") stmts.push({ sql: "DELETE FROM markers WHERE id = ?", binds: [`tag:${repo.id}:${String(payload.ref).slice(0, 200)}`] });
      await store.batch(stmts);
      return "delete";
    }
    default:
      await store.batch(stmts);
      return "ignored";
  }
}

/** A tiny helper for tests and the demo: sign a body the way GitHub does. */
export async function sign(secret, raw) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, typeof raw === "string" ? enc.encode(raw) : raw));
  return `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

