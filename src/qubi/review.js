// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * One Qubi run: a pull request, a settled push to the default branch, or a bug hunt. It reads the change (or the
 * repository) from GitHub with a read-only token, gives the model three read-only tools on the reviewed commit, keeps
 * the findings whose quoted evidence is really in the file (prompt.js), and only then posts, with a second token: a
 * review on the pull request, comments on the commit, and (when the operator turned it on, for trusted work only) a
 * pull request per fix Qubi is sure of. Nothing is executed.
 *
 * Money: the cost is written to the job after every model call (onCost), so a run that fails or is cut off still
 * counts against the week; each call's output is clamped to what the per-run cap has left, and a slice of the cap is
 * kept back so the last turn (the result, tools off) always fits.
 */
import { clip, huntScope, huntSystem, parseResult, reviewScope, reviewSystem, TOOLS, verifyFindings, RANK } from "./prompt.js";
import * as fmt from "./format.js";
import { POST, READ, GhError, repoPath } from "./github.js";
import { outputRoom, priceOf } from "./providers/index.js";

const SHA = /^[0-9a-f]{40}$/;
const MAX_TURNS = 25;
const MAX_TOOL_CALLS = 60;
// Pessimistic: a token per three characters of English and code, a token and a half per character of any other script
// (Chinese, Hebrew and emoji can take a token or more each).
export const tokensOf = (s) => { const t = String(s); const other = t.replace(/[\x00-\x7f]+/g, "").length; return Math.ceil((t.length - other) / 3 + other * 1.5); };

/** A failure that still knows what the run cost. */
export class RunError extends Error {
  constructor(message, cost) { super(message); this.cost = cost; }
}

/** Pure. For each file of a diff: every new-side line it shows, and the hunk it is in. */
export function patchLines(files) {
  const out = new Map();
  for (const f of files) {
    const lines = new Map();
    let n = 0, hunk = -1;
    for (const l of String(f.patch ?? "").split("\n")) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
      if (h) { n = Number(h[1]); hunk++; continue; }
      if (l.startsWith("-") || l.startsWith("\\")) continue;
      if (hunk >= 0) { lines.set(n, hunk); n++; }
    }
    out.set(f.filename, lines);
  }
  return out;
}
/** Pure. May a review comment sit on these lines? In the diff, and a range inside one hunk, or GitHub refuses the review. */
export function anchorable(lines, f) {
  const m = f.path ? lines.get(f.path) : undefined;
  if (!m || !f.line || !m.has(f.line)) return false;
  return !f.end_line || f.end_line === f.line || (m.has(f.end_line) && m.get(f.end_line) === m.get(f.line));
}
/** Pure. A commit comment's "position" for a new-side line (lines below the file's first @@), 0 if it is not shown. */
export function patchPosition(patch, line) {
  let pos = 0, n = 0, started = false;
  for (const l of String(patch ?? "").split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (h) { if (started) pos++; started = true; n = Number(h[1]); continue; }
    if (!started) continue;
    pos++;
    if (l.startsWith("-") || l.startsWith("\\")) continue;
    if (n === line) return pos;
    n++;
  }
  return 0;
}

/** The model's three tools, on one commit, through the read-only token. File reads are kept for the evidence check. */
function toolbox(ctx, repo, ref, token) {
  const files = new Map();
  const read = async (path) => {
    const p = String(path ?? "").replace(/^\.?\/+/, "");
    if (!files.has(p)) files.set(p, await ctx.gh.file(repo, p, ref, token));
    return files.get(p);
  };
  async function run(name, input) {
    if (name === "read_file") {
      const text = await read(input?.path);
      if (text === null) return { content: `No such file at this commit: ${String(input?.path ?? "").slice(0, 200)}`, error: true };
      const lines = text.split("\n");
      const a = Math.max(1, Number(input?.start_line) || 1), b = Math.min(lines.length, Number(input?.end_line) || lines.length);
      return { content: clip(lines.slice(a - 1, b).map((l, i) => `${String(a + i).padStart(6)}\t${l}`).join("\n"), 40_000) };
    }
    if (name === "list_dir") {
      const p = repoPath(input?.path ?? "");
      if (p === null) return { content: "Paths are plain repository paths.", error: true };
      try {
        const list = await ctx.gh.gh(`/repos/${repo}/contents/${p}?ref=${ref}`, token);
        return { content: Array.isArray(list) ? list.map((e) => (e.type === "dir" ? `${e.name}/` : e.name)).join("\n") || "(empty)" : "Not a directory." };
      } catch (e) { return { content: String(e?.message ?? e).slice(0, 300), error: true }; }
    }
    if (name === "find_in_repo") {
      const q = String(input?.query ?? "").replace(/[\r\n"]/g, " ").trim().slice(0, 120);
      if (q.length < 2) return { content: "Ask for at least two characters.", error: true };
      try {
        const r = await ctx.gh.gh(`/search/code?per_page=15&q=${encodeURIComponent(`"${q}" repo:${repo}`)}`, token, { headers: { accept: "application/vnd.github.text-match+json" } });
        const items = (r.items ?? []).map((i) => `${i.path}${(i.text_matches ?? []).slice(0, 2).map((m) => `\n    ${String(m.fragment ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("")}`);
        return { content: items.length ? items.join("\n") : "Not found on the default branch." };
      } catch (e) { return { content: `Search is not available: ${String(e?.message ?? e).slice(0, 200)}`, error: true }; }
    }
    return { content: `Unknown tool ${String(name).slice(0, 40)}`, error: true };
  }
  return { run, read };
}

/**
 * The model loop under the per-run cap. Returns the final answer, the cost and the turns.
 * @param {{ provider: any, client: any }} ai
 */
export async function loop(ai, { model, system, scope, budget, effort, tools, onCost }) {
  const messages = [{ role: "user", content: scope }];
  // The next prompt is the last one (read from the cache) plus the last answer and the new tool results (written to it).
  let cost = 0, turns = 0, calls = 0, warned = false, cached = 0, answered = 0, fresh = tokensOf(system) + tokensOf(scope) + 1500;
  const call = async (toolsOff, maxTokens) => {
    let res;
    try { res = await ai.client.call({ model, system, messages, tools: TOOLS, maxTokens, toolsOff, effort }); }
    catch (e) { throw new RunError(`the model API: ${String(e?.status ?? "")} ${String(e?.message ?? e).slice(0, 200)}`.trim(), cost); }
    cost += priceOf(ai.provider, model, res.usage, res.model);
    cached = res.usage.input + res.usage.cacheRead + res.usage.cacheWrite;
    answered = res.usage.output;
    await onCost(cost);
    return res;
  };
  const reserve = budget * 0.15;
  for (; turns < MAX_TURNS; turns++) {
    const room = outputRoom(ai.provider, model, budget - reserve - cost, cached, answered + fresh);
    if (!room) break;
    const res = await call(false, room);
    messages.push({ role: "assistant", content: res.content });
    if (res.stop === "refusal") return { report: "", cost, turns: turns + 1, note: "the model declined this run" };
    if (res.stop === "pause") { messages.push({ role: "user", content: [{ type: "text", text: "Go on." }] }); fresh = 50; continue; }
    if (res.stop === "end" || !res.toolUses.length) return { report: res.text, cost, turns: turns + 1 };
    const results = [];
    for (const u of res.toolUses) {
      if (res.stop === "max_tokens") { results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "Cut off before the input was complete: ask again, shorter." }); continue; }
      if (++calls > MAX_TOOL_CALLS) { results.push({ type: "tool_result", tool_use_id: u.id, is_error: true, content: "No more reading in this run: write the result now." }); continue; }
      const out = await tools.run(u.name, u.input);
      results.push({ type: "tool_result", tool_use_id: u.id, content: out.content, ...(out.error ? { is_error: true } : {}) });
    }
    if (!warned && cost >= (budget - reserve) * 0.75) { warned = true; results.push({ type: "text", text: "Most of this run's budget is spent: settle what you have and write the result with its json block." }); }
    messages.push({ role: "user", content: results });
    fresh = tokensOf(JSON.stringify(results)) + 50;
  }
  if (!turns) return { report: "", cost, turns, note: "the per-run cap is too small for this run" };
  // The cap or the turn limit is reached: one last turn without tools, if it fits in what is left.
  const last = messages.at(-1);
  const ask = { type: "text", text: "Write the result now, with its json block. No more tools." };
  if (last.role === "user") last.content = typeof last.content === "string" ? [{ type: "text", text: last.content }, ask] : [...last.content, ask];
  else messages.push({ role: "user", content: [ask] });
  const fits = outputRoom(ai.provider, model, budget - cost, cached, answered + fresh + 40, 1024, 6000);
  if (!fits) return { report: "", cost, turns, note: "stopped at the per-run cap before a result" };
  const res = await call(true, fits);
  return { report: res.text, cost, turns: turns + 1, note: "stopped at the per-run cap" };
}

const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(String(s).replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const BOM = [0xef, 0xbb, 0xbf];

/** Pure. The file with the patch applied, or why not: the text to replace must be there exactly once. */
export function applyPatch(text, patch, path) {
  if (!path || /^\.github\//i.test(path)) return { error: "workflow files are left to people" };
  const crlf = text.includes("\r\n");
  const old = crlf ? patch.old.replace(/\r?\n/g, "\r\n") : patch.old;
  const neu = crlf ? patch.new.replace(/\r?\n/g, "\r\n") : patch.new;
  const at = text.indexOf(old);
  if (at < 0) return { error: "the text to replace is not in the file" };
  if (text.indexOf(old, at + 1) >= 0) return { error: "the text to replace is in the file more than once" };
  return { text: text.slice(0, at) + neu + text.slice(at + old.length) };
}

/**
 * Pure. A file's bytes as text to patch, and back, keeping a byte-order mark; null for anything that is not UTF-8
 * text (a fix there could only write it back broken).
 */
export function fileText(bytes) {
  const bom = bytes.length >= 3 && BOM.every((b, i) => bytes[i] === b);
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes), bom }; } catch { return null; }
}
export const fileBytes = ({ text, bom }) => { const body = new TextEncoder().encode(text); if (!bom) return body; const out = new Uint8Array(body.length + 3); out.set(BOM); out.set(body, 3); return out; };

/**
 * One fix PR: a branch from the reviewed commit, the one-file change, the pull request. Its URL, or why not. The file
 * and its blob id come from GitHub as they are (the raw bytes), so the replace never races or mangles an encoding; a
 * branch left without its change is removed again.
 */
async function openFix(ctx, repo, token, f, { head, baseBranch, source, cost }) {
  const gh = ctx.gh.gh;
  const path = repoPath(f.path);
  if (!path) return { error: "not a plain path" };
  let file;
  try { file = await gh(`/repos/${repo}/contents/${path}?ref=${head}`, token); } catch { return { error: "the file could not be read" }; }
  if (file?.type !== "file" || file.encoding !== "base64" || !file.sha) return { error: "the file is too large to change here" };
  const t = fileText(unb64(file.content));
  if (!t) return { error: "the file is not UTF-8 text" };
  const p = applyPatch(t.text, f.patch, f.path);
  if (p.error) return { error: p.error };
  // The time in the name: a second run on the same commit opens a branch of its own.
  const branch = `qubi/fix-${head.slice(0, 7)}-${String(f.path).replace(/[^\w]+/g, "-").slice(-30).replace(/^-+|-+$/g, "")}-${f.line}-${Date.now().toString(36)}`;
  let created = false;
  try {
    await gh(`/repos/${repo}/git/refs`, token, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: head }) });
    created = true;
    await gh(`/repos/${repo}/contents/${path}`, token, { method: "PUT", body: JSON.stringify({ message: fmt.fixTitle(f), content: b64(fileBytes({ text: p.text, bom: t.bom })), sha: file.sha, branch }) });
    const pr = await gh(`/repos/${repo}/pulls`, token, { method: "POST", body: JSON.stringify({
      title: fmt.fixTitle(f), head: branch, base: baseBranch, maintainer_can_modify: true,
      body: fmt.fixBody(f, { repo, sha: head, webUrl: ctx.cfg.webUrl, cost, source }),
    }) });
    return { url: pr.html_url ?? null };
  } catch (e) {
    if (created) await gh(`/repos/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, token, { method: "DELETE" }).catch(() => undefined);
    return { error: String(e instanceof GhError ? e.message : e?.message ?? e).slice(0, 200) };
  }
}

/**
 * Runs one job. Returns { status, cost, findings, url, note, fixPrs, head }.
 * @param {{ cfg: any, store: any, gh: ReturnType<typeof import("./github.js").qubiGitHub>, ai: { provider: any, client: any } }} ctx
 */
export async function runJob(ctx, job, s, { onCost = async () => undefined } = {}) {
  const { cfg, gh } = ctx;
  const repo = job.repo;
  const hunt = job.kind === "hunt";
  const model = job.model || (hunt ? s.hunt_model || ctx.ai.provider.defaultHuntModel : s.model || ctx.ai.provider.defaultModel);
  const read = await gh.token(repo, READ);
  const meta = await gh.gh(`/repos/${repo}`, read);
  const defaultBranch = meta.default_branch;
  let head = job.head, base = job.base, kind = "", about = "", pr = null;
  const skip = (note) => ({ status: "skipped", cost: 0, findings: [], note, head, model });

  if (job.kind === "pr") {
    pr = await gh.gh(`/repos/${repo}/pulls/${job.pr}`, read);
    if (pr.state !== "open") return skip("closed");
    if (pr.draft) return skip("draft");
    if (head && pr.head?.sha !== head) return skip("a newer head was pushed");
    head = pr.head.sha;
    base = pr.base.sha;
    kind = "a pull request";
    about = `Pull request #${job.pr} by ${JSON.stringify(String(pr.user?.login ?? ""))}, ${JSON.stringify(String(pr.head?.ref ?? ""))} into ${JSON.stringify(String(pr.base?.ref ?? ""))}. Its title, as its author wrote it: ${JSON.stringify(String(pr.title ?? "").slice(0, 200))}. Its description, as its author wrote it: ${JSON.stringify(String(pr.body ?? "").slice(0, 2000))}`;
  } else {
    // A push is reviewed up to the branch's tip now; a late or out-of-order delivery never leaves the newest commits out.
    head = (await gh.gh(`/repos/${repo}/commits/${encodeURIComponent(defaultBranch)}`, read)).sha;
    if (job.kind === "push") {
      if (!SHA.test(String(base)) || /^0+$/.test(base)) return skip("a new branch: nothing to compare with");
      if (base === head) return skip("nothing new");
      kind = `a push to ${defaultBranch}`;
      about = `The range ${base.slice(0, 8)}..${head.slice(0, 8)} on ${defaultBranch}.`;
    }
  }

  let change = { files: [], commits: [] };
  let system, scope;
  if (hunt) {
    const tree = (await gh.gh(`/repos/${repo}/git/trees/${head}?recursive=1`, read)).tree ?? [];
    const files = tree.filter((t) => t.type === "blob").map((t) => ({ path: String(t.path), size: Number(t.size ?? 0) }));
    const recent = (await ctx.store.all(`SELECT f.path AS path, MAX(c.at) AS at FROM commit_files f JOIN commits c ON c.repo_id = f.repo_id AND c.sha = f.sha
      JOIN repos r ON r.id = f.repo_id WHERE r.full_name = ? COLLATE NOCASE AND c.at >= ? GROUP BY f.path ORDER BY at DESC LIMIT 30`, repo, Date.now() - 30 * 86_400_000)).map((r) => r.path);
    if (!files.length) return skip("the repository is empty");
    system = huntSystem(repo, { patches: s.fix_prs && job.trusted });
    scope = huntScope({ head, tree: files, recent, focus: job.focus });
  } else {
    const c = await gh.gh(`/repos/${repo}/compare/${base}...${head}`, read);
    change = {
      files: (c.files ?? []).map((f) => ({ filename: String(f.filename), status: String(f.status), patch: f.patch })),
      commits: (c.commits ?? []).map((x) => ({ sha: String(x.sha), author: String(x.author?.login ?? x.commit?.author?.name ?? ""), message: String(x.commit?.message ?? "").split("\n")[0].slice(0, 200) })),
    };
    // Nothing but documentation or generated files: no model call.
    if (!change.files.some((f) => !/\.(md|mdx|txt|rst)$/i.test(f.filename) && !/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.filename))) return skip("no code changed");
    system = reviewSystem(repo, kind, { patches: s.fix_prs && job.trusted });
    scope = reviewScope({ about, commits: change.commits, files: change.files });
  }

  const tools = toolbox(ctx, repo, head, read);
  const run = await loop(ctx.ai, { model, system, scope, budget: s.per_run_usd, effort: s.effort, tools, onCost });
  const res = parseResult(run.report);
  if (!res.parsed) return { status: "failed", cost: run.cost, findings: [], note: run.note ?? "the model gave no result", head, model };
  const { kept, dropped } = await verifyFindings(res.findings, tools.read, s.min_severity);
  const droppedN = dropped.unverified + dropped.duplicate;
  const ctxFmt = { repo, sha: head, webUrl: cfg.webUrl, cost: run.cost, dropped: droppedN, focus: job.focus };
  const findings = kept.map((f) => ({ ...f, url: fmt.blobUrl(cfg.webUrl, repo, head, f.path, f.line, f.end_line) }));

  // Posting, with the write token. A pull request with nothing found gets a short review only when the operator wants it.
  let url = null, fixPrs = 0;
  let postToken = null;
  const writer = async () => (postToken ??= await gh.token(repo, POST));
  const fixes = [];
  if (s.fix_prs && job.trusted) {
    // Into the pull request's own branch when it lives in this repository, else into the default branch.
    const baseBranch = pr ? (pr.head?.repo?.full_name?.toLowerCase() === repo.toLowerCase() ? pr.head.ref : null) : defaultBranch;
    for (const f of findings.filter((x) => x.patch && RANK[x.severity] <= RANK.medium).slice(0, 3)) {
      if (!baseBranch) break;
      const r = await openFix(ctx, repo, await writer(), f, { head, baseBranch, source: pr ? `#${job.pr}` : hunt ? "a bug hunt" : `a push to ${defaultBranch}`, cost: run.cost });
      if (r.url) { f.fixUrl = r.url; fixPrs++; } else fixes.push({ title: f.title, error: r.error });
    }
  }
  try {
    if (job.kind === "pr") {
      if (findings.length || s.post_clean) {
        const lines = patchLines(change.files);
        const inline = findings.filter((f) => anchorable(lines, f));
        const send = async (inl) => gh.gh(`/repos/${repo}/pulls/${job.pr}/reviews`, await writer(), { method: "POST", body: JSON.stringify({
          commit_id: head, event: "COMMENT",
          body: fmt.reviewSummary({ kind: "pr", findings, unanchored: findings.filter((f) => !inl.includes(f)), summary: res.summary, fixes, ...ctxFmt }),
          comments: inl.map((f) => ({ path: f.path, line: f.end_line || f.line, side: "RIGHT", ...(f.end_line && f.end_line > f.line ? { start_line: f.line, start_side: "RIGHT" } : {}), body: fmt.findingComment(f) })),
        }) });
        // GitHub refuses a whole review over one bad anchor: then every finding goes in the summary instead.
        const review = await send(inline).catch((e) => (e?.status === 422 && inline.length ? send([]) : Promise.reject(e)));
        url = review.html_url ?? null;
      }
    } else if (findings.length) {
      // A push: a comment on the line when the head commit itself changed it, one summary for the rest. A hunt: the summary.
      const headFiles = hunt ? [] : (await gh.gh(`/repos/${repo}/commits/${head}`, read)).files ?? [];
      const rest = [];
      for (const f of findings) {
        const pos = hunt ? 0 : patchPosition(headFiles.find((x) => x.filename === f.path)?.patch, f.line);
        if (pos) {
          const c = await gh.gh(`/repos/${repo}/commits/${head}/comments`, await writer(), { method: "POST", body: JSON.stringify({ body: fmt.findingComment(f, { suggestion: false }), path: f.path, position: pos }) });
          url ||= c.html_url ?? null;
        } else rest.push(f);
      }
      if (rest.length) {
        const c = await gh.gh(`/repos/${repo}/commits/${head}/comments`, await writer(), { method: "POST", body: JSON.stringify({ body: fmt.reviewSummary({ kind: hunt ? "hunt" : "push", findings, unanchored: rest, summary: res.summary, fixes, ...ctxFmt }) }) });
        url = c.html_url ?? url;
      }
    }
  } catch (e) {
    throw new RunError(`posting failed: ${String(e?.message ?? e).slice(0, 200)}`, run.cost);
  }
  const notes = [run.note, droppedN ? `${droppedN} unconfirmed finding${droppedN === 1 ? "" : "s"} left out` : "", ...fixes.map((x) => `fix not opened: ${x.error}`)].filter(Boolean);
  return { status: "done", cost: run.cost, findings, url, note: notes.join("; "), fixPrs, head, model };
}
