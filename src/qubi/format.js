// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * What Qubi posts on GitHub: a review comment per finding, the review's summary, a commit comment for a push or a bug
 * hunt, and the body of a fix PR. Pure. Calm and scannable: a coloured mark per severity, the failing case in its own
 * line, a ```suggestion block GitHub can apply in one click, and the run's cost. Text from the model is data: any
 * assistant credit it writes is dropped, and nothing it writes can close a code block early.
 */
export const MARK = { critical: "🔴", high: "🟠", medium: "🟡", low: "🔵" };
const LABEL = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

// Any credit line a model might add is dropped.
const CREDIT = /^.*(co-authored-by:|generated with \[?claude|🤖 generated).*$\n?/gim;
export const clean = (s) => String(s ?? "").replace(CREDIT, "").replace(/\r/g, "").trim();
// A one-line value in running text: no newlines, no markdown headings or HTML.
const one = (s) => clean(s).replace(/\s*\n\s*/g, " ").replace(/</g, "&lt;");
const code = (s) => { const t = one(s).replace(/`/g, "ʼ"); return t ? `\`${t}\`` : ""; };

export const money = (usd) => { const n = Number(usd || 0); return `$${n > 0 && n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`; };
export const blobUrl = (webUrl, repo, sha, path, start, end) =>
  `${webUrl}/${repo}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}${start ? `#L${start}${end && end !== start ? `-L${end}` : ""}` : ""}`;
const where = (c, f) => (f.path ? `[\`${f.path}:${f.line}${f.end_line && f.end_line !== f.line ? `-${f.end_line}` : ""}\`](${blobUrl(c.webUrl, c.repo, c.sha, f.path, f.line, f.end_line)})` : "");
const footer = (c) => `<sub>${c.what ?? "Reviewed"} by Qubi · cost ${money(c.cost)}${c.dropped ? ` · ${c.dropped} unconfirmed finding${c.dropped === 1 ? "" : "s"} left out` : ""}</sub>`;

/** One finding, as a review comment on its line (or a commit comment). */
export function findingComment(f, { suggestion = true } = {}) {
  const head = `${MARK[f.severity] ?? MARK.medium} **${LABEL[f.severity] ?? "Medium"} ${f.kind === "security" ? "security issue" : "bug"}: ${one(f.title)}**`;
  const body = [
    head, "",
    f.what && `**What goes wrong:** ${one(f.what)}`,
    f.failing_input && `**Failing case:** ${one(f.failing_input)}`,
    f.fix && `**Fix:** ${one(f.fix)}`,
    f.fixUrl && `**Fix PR:** ${f.fixUrl}`,
  ].filter((x) => typeof x === "string").join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // A suggestion block needs a fence its own text cannot close.
  if (!suggestion || !f.suggestion) return body;
  const fence = "`".repeat(Math.max(3, ...[...String(f.suggestion).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${body}\n\n${fence}suggestion\n${String(f.suggestion).replace(/\r/g, "").replace(/\n$/, "")}\n${fence}`;
}

const line = (c, f) => `- ${MARK[f.severity] ?? MARK.medium} ${where(c, f)} **${one(f.title)}**${f.what ? `: ${one(f.what)}` : ""}${f.fixUrl ? ` · [fix PR](${f.fixUrl})` : ""}`;

/**
 * The summary of a review or a hunt: what was found, the findings that could not sit on a changed line, the fix PRs.
 * @param {{ kind: "pr"|"push"|"hunt", findings: any[], unanchored?: any[], summary?: string, fixes?: any[],
 *   repo: string, sha: string, webUrl: string, cost: number, dropped?: number, focus?: string }} o
 */
export function reviewSummary(o) {
  const n = o.findings.length;
  const what = o.kind === "pr" ? "pull request" : o.kind === "push" ? "push" : `code${o.focus ? ` under ${code(o.focus)}` : ""}`;
  const title = o.kind === "hunt"
    ? (n ? `**Qubi bug hunt: ${n} issue${n === 1 ? "" : "s"}** in this ${what}.` : `✅ **Qubi bug hunt: no issues found** in this ${what}.`)
    : (n ? `**Qubi found ${n} issue${n === 1 ? "" : "s"}** in this ${what}.` : `✅ **No issues found** in this ${what}.`);
  const parts = [title, n && clean(o.summary) ? one(o.summary) : ""];
  if (o.unanchored?.length) parts.push(`${o.kind === "pr" ? "**Not on a changed line:**" : "**Findings:**"}\n${o.unanchored.map((f) => line(o, f)).join("\n")}`);
  const failed = (o.fixes ?? []).filter((x) => x.error);
  if (failed.length) parts.push(`**Fixes not opened:**\n${failed.map((x) => `- ${one(x.title)}: ${one(x.error)}`).join("\n")}`);
  return `${parts.filter(Boolean).join("\n\n")}\n\n${footer({ ...o, what: n ? "Found" : "Reviewed" })}`;
}

/** The title and body of a fix PR. */
export const fixTitle = (f) => `Fix: ${one(f.title).replace(/^fix\s*:\s*/i, "")}`.slice(0, 120);
export function fixBody(f, c) {
  return [
    `${MARK[f.severity] ?? MARK.medium} **${LABEL[f.severity] ?? "Medium"} ${f.kind === "security" ? "security issue" : "bug"}** in ${where(c, f)}${c.source ? `, found in ${c.source}` : ""}.`,
    f.what && `**What goes wrong:** ${one(f.what)}`,
    f.failing_input && `**Failing case:** ${one(f.failing_input)}`,
    f.fix && `**The fix:** ${one(f.fix)}`,
    "Nothing was run: Qubi reads code, it does not execute it. Check the change and let the tests run before you merge.",
  ].filter(Boolean).join("\n\n") + `\n\n---\n${footer({ ...c, what: "Opened" })}`;
}
