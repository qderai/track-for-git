// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The files and diff of one commit or one pull request, fetched from GitHub when someone opens it. A diff is source
 * code: it never goes into the database, only into the HTTP cache of the platform (the Worker's edge cache, or memory
 * in Node), keyed by the commit, which never changes. Each file's patch is cut at PATCH_LINES lines and the whole
 * answer at MAX_BYTES, so a vendored library or a lock file cannot freeze the page; lock files and generated output
 * are marked so the page can keep them folded.
 */
import { SHA } from "./github/normalize.js";

export const PATCH_LINES = 2000;
export const MAX_BYTES = 1_500_000;
export const MAX_FILES = 300;

/** Pure. Lock files, minified and generated output: real changes, but nobody reads them line by line. */
export const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Podfile\.lock|uv\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|node_modules|__generated__|generated)\/|\.snap$|\.pb\.go$|_pb2\.py$/i;

/** Pure. GitHub's file list into what the page shows, within the line and byte limits. */
export function shapeFiles(files) {
  let bytes = 0, cutAll = false;
  const out = [];
  for (const f of (Array.isArray(files) ? files : []).slice(0, MAX_FILES)) {
    const path = String(f?.filename ?? "").slice(0, 500);
    const patchRaw = typeof f?.patch === "string" ? f.patch : null;
    let patch = patchRaw, cut = false;
    if (patch) {
      const lines = patch.split("\n");
      if (lines.length > PATCH_LINES) { patch = lines.slice(0, PATCH_LINES).join("\n"); cut = true; }
      if (bytes + patch.length > MAX_BYTES) { patch = null; cut = true; cutAll = true; }
    }
    bytes += patch?.length ?? 0;
    out.push({
      path, previous: f?.previous_filename ? String(f.previous_filename).slice(0, 500) : null, status: String(f?.status ?? "modified"),
      additions: Number(f?.additions) || 0, deletions: Number(f?.deletions) || 0,
      patch, cut, binary: !patchRaw && (Number(f?.additions) || 0) + (Number(f?.deletions) || 0) === 0 && f?.status !== "renamed",
      generated: GENERATED.test(path),
    });
  }
  return { files: out, filesTotal: Array.isArray(files) ? files.length : 0, cutAll };
}

/**
 * One commit's files: from the cache, else from GitHub (and its totals and paths onto its row).
 * @param {{ store: any, gh: any, cache: { get(k: string): Promise<any>, put(k: string, v: any, ttl: number): Promise<void> } }} ctx
 */
export async function commitFiles(ctx, repo, sha) {
  if (!SHA.test(sha)) return null;
  const key = `commit/${repo.id}/${sha}`;
  const hit = await ctx.cache.get(key);
  if (hit) return hit;
  const res = await ctx.gh.rest(`/repos/${repo.full_name}/commits/${sha}`);
  const c = res.data ?? {};
  const shaped = shapeFiles(c.files);
  const out = { ...shaped, additions: Number(c?.stats?.additions) || 0, deletions: Number(c?.stats?.deletions) || 0, message: String(c?.commit?.message ?? "").slice(0, 8000),
    url: typeof c?.html_url === "string" ? c.html_url : null };
  await ctx.store.batch([
    { sql: "UPDATE commits SET additions = ?, deletions = ?, files_n = ?, paths_known = 1 WHERE repo_id = ? AND sha = ?", binds: [out.additions, out.deletions, out.filesTotal, repo.id, sha] },
    ...shaped.files.map((f) => ({ sql: "INSERT OR IGNORE INTO commit_files (repo_id, sha, path) VALUES (?,?,?)", binds: [repo.id, sha, f.path] })),
  ]).catch(() => undefined);
  // A commit never changes: a week in the cache.
  await ctx.cache.put(key, out, 7 * 86_400);
  return out;
}

/** One pull request's files, up to 300 (three pages), cached by its head commit. */
export async function prFiles(ctx, repo, number, headSha) {
  const key = `pr/${repo.id}/${number}/${headSha ?? "x"}`;
  const hit = await ctx.cache.get(key);
  if (hit) return hit;
  const files = [];
  for (let page = 1; page <= 3; page++) {
    const res = await ctx.gh.rest(`/repos/${repo.full_name}/pulls/${number}/files?per_page=100&page=${page}`);
    const list = Array.isArray(res.data) ? res.data : [];
    files.push(...list);
    if (list.length < 100) break;
  }
  const out = shapeFiles(files);
  await ctx.cache.put(key, out, headSha ? 7 * 86_400 : 60);
  return out;
}
