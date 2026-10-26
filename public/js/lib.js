// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Pure helpers shared by the page's modules, with no DOM, so test/client.test.js can run them in Node.
 */

/**
 * The colour slot of each "who": people working alone take slot 1, the six most common agents keep fixed slots
 * (a colour always means the same agent, whatever the filters), every other agent shares slot 8 ("Other agents"),
 * bots are neutral grey. Slots are the CSS variables --s1 … --s8 and --bot. Stacks are drawn in this order: the
 * palette's neighbours were chosen to stay distinct for colour-blind readers in exactly this order.
 */
export const AGENT_SLOTS = { claude: 2, codex: 3, grok: 4, copilot: 5, gemini: 6, cursor: 7 };
export const slotOf = (who) => (who === "~human" ? 1 : who === "~bot" ? "bot" : AGENT_SLOTS[who] ?? 8);
export const STACK = ["~human", "claude", "codex", "grok", "copilot", "gemini", "cursor", "~other", "~bot"];

/** Pure. The stack key of a who (agents without a slot fold into "~other"). */
export const stackKey = (who) => (who === "~human" || who === "~bot" || AGENT_SLOTS[who] ? who : "~other");

/** Pure. A commit's or pull request's who: "~human", "~bot" or the agent id. */
/** The repositories to send for Qubi's scope: none (= all watched) for "All", the ticked ones for "Only these"; null when "Only these" has none ticked (that would silently mean all). */
export const qubiRepos = (scope, chosen) => (scope === "all" ? [] : chosen.length ? chosen : null);
export const whoOf = (row) => row.agent ?? (row.bot ? "~bot" : "~human");

/** Pure. Fold a bin's { who: n } into the stack keys, in drawing order. */
export function stackOf(counts) {
  const out = new Map();
  for (const [who, n] of Object.entries(counts ?? {})) { const k = stackKey(who); out.set(k, (out.get(k) ?? 0) + n); }
  return STACK.filter((k) => out.get(k)).map((k) => [k, out.get(k)]);
}

/**
 * Pure. A unified-diff patch into lines with their old and new line numbers (for the two gutters).
 * t: "h" hunk header, "a" added, "d" deleted, "c" context, "n" "\ No newline at end of file".
 */
export function parsePatch(patch) {
  const out = [];
  let a = 0, b = 0;
  for (const line of String(patch ?? "").split("\n")) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (h) { a = Number(h[1]); b = Number(h[2]); out.push({ t: "h", text: line }); continue; }
    if (line.startsWith("+")) out.push({ t: "a", text: line.slice(1), b: b++ });
    else if (line.startsWith("-")) out.push({ t: "d", text: line.slice(1), a: a++ });
    else if (line.startsWith("\\")) out.push({ t: "n", text: line });
    else out.push({ t: "c", text: line.slice(1), a: a++, b: b++ });
  }
  return out;
}

/** Pure. Markers closer than `gap` pixels on the timeline into one cluster (a count and the list). */
export function clusterMarkers(markers, x, gap = 8) {
  const sorted = [...markers].sort((p, q) => p.at - q.at);
  const out = [];
  for (const m of sorted) {
    const px = x(m.at);
    const last = out.at(-1);
    if (last && px - last.x1 < gap) { last.items.push(m); last.x1 = px; last.x = (last.x0 + px) / 2; }
    else out.push({ x0: px, x1: px, x: px, items: [m] });
  }
  return out;
}

/** Pure. A person's initials for the round avatar ("Maya Cohen" → "MC", "dependabot[bot]" → "D"). */
export function initials(name) {
  const words = String(name ?? "?").replace(/\[bot\]$/, "").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length > 1 ? words[0][0] + words.at(-1)[0] : words[0].slice(0, 2)).toUpperCase();
}

/** The filter's keys in the URL, in order. */
export const FILTER_KEYS = ["repos", "team", "author", "agent", "branch", "path", "q", "label", "from", "to"];

/** Pure. The page's state from a URL's search params (only known keys, only sane values). */
export function stateFromParams(params) {
  const get = (k) => params.get(k) ?? "";
  const tab = ["overview", "commits", "prs", "story", "qubi"].includes(get("tab")) ? get("tab") : "overview";
  return {
    tab,
    range: ["1d", "7d", "30d", "90d"].includes(get("range")) ? get("range") : "7d",
    filter: Object.fromEntries(FILTER_KEYS.map((k) => [k, get(k).slice(0, 300)]).filter(([, v]) => v)),
    group: ["repo", "person", "team"].includes(get("group")) ? get("group") : "repo",
    heat: ["repo", "person", "team"].includes(get("heat")) ? get("heat") : "repo",
    prState: ["open", "stuck", "merged", "closed", "all"].includes(get("state")) ? get("state") : "open",
    prSort: ["updated", "oldest", "largest"].includes(get("sort")) ? get("sort") : "",
    list: get("list") === "pushes" ? "pushes" : "commits",
    sel: /^\d+:[0-9a-f]{40}$|^\d+#\d+$/.test(get("sel")) ? get("sel") : "",
  };
}

/** Pure. The page's state into search params (defaults left out, so links stay short). */
export function paramsFromState(s) {
  const p = new URLSearchParams();
  if (s.tab !== "overview") p.set("tab", s.tab);
  if (s.range !== "7d") p.set("range", s.range);
  for (const k of FILTER_KEYS) if (s.filter[k]) p.set(k, s.filter[k]);
  if (s.group !== "repo") p.set("group", s.group);
  if (s.heat !== "repo") p.set("heat", s.heat);
  if (s.prState !== "open") p.set("state", s.prState);
  if (s.prSort) p.set("sort", s.prSort);
  if (s.list !== "commits") p.set("list", s.list);
  if (s.sel) p.set("sel", s.sel);
  return p;
}

/** Pure. The API query for the current range and filter. */
export function apiQuery(s, tz, extra = {}) {
  const p = new URLSearchParams({ range: s.range, tz });
  for (const k of FILTER_KEYS) if (s.filter[k]) p.set(k, s.filter[k]);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  return p.toString();
}

/** Pure. The step of the heatmap's five-step scale for a count (0 stays empty). */
export function heatStep(n, max) {
  if (!n) return 0;
  const r = n / Math.max(1, max);
  return r <= 0.12 ? 1 : r <= 0.3 ? 2 : r <= 0.55 ? 3 : r <= 0.8 ? 4 : 5;
}

/** Pure. Lines that are only noise in a review: lock files, minified and generated output. */
export const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Podfile\.lock|uv\.lock)$|\.min\.(js|css)$|\.map$|(^|\/)(dist|build|vendor|node_modules|__generated__|generated)\//i;
