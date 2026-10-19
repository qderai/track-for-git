// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Who made a commit or a pull request: a person alone, a person working with an AI agent, an agent on its own, or an
 * automation bot. Every commit and pull request carries the result (`agent`, `bot`), so the dashboard can say "Dana,
 * with Claude, 4 minutes ago" and stack the timeline by agent.
 *
 * An agent leaves one of these marks, checked in this order:
 *   1. its own account as the author: copilot-swe-agent[bot], devin-ai-integration[bot], Cursor Agent…;
 *   2. its own account as the committer (it committed a person's change);
 *   3. a trailer in the message: `Co-authored-by: Claude <noreply@anthropic.com>`, `Assisted-by: Grok`;
 *   4. a footer it writes: "Generated with Claude Code";
 *   5. an author name it sets: "Dana Levi (aider)";
 *   6. for a pull request opened by a member of the organisation only, the branch prefix it uses: claude/, codex/.
 *      (A branch name is never evidence for a commit: people also commit on an agent's branch.)
 *
 * Names are matched whole, never as a word inside a name: "Claude Monet" and "Devin Smith" are people.
 *
 * An agent this list does not know is still recognised from an `Assisted-by:`, `Generated-by:` or `AI-Agent:`
 * trailer, under the name it gives there. A company adds its own agents with the AGENTS setting (see README,
 * "Make your agents visible"); they are checked before these.
 */

/**
 * @typedef {{ id: string, name: string, logins?: (string|RegExp)[], emails?: (string|RegExp)[], names?: (string|RegExp)[],
 *   footers?: RegExp[], suffixes?: string[], branches?: string[] }} AgentRule
 */

/** @type {AgentRule[]} */
export const KNOWN_AGENTS = [
  { id: "claude", name: "Claude",
    logins: ["claude", "claude[bot]", /^claude-code(\[bot\])?$/],
    emails: ["noreply@anthropic.com", /^(\d+\+)?claude(\[bot\])?@users\.noreply\.github\.com$/],
    names: [/^claude( code| (opus|sonnet|haiku|fable)( [\w.]+)*)?$/, "claude[bot]"],
    footers: [/generated with \[?claude code\b/i],
    branches: ["claude/"] },
  { id: "cursor", name: "Cursor",
    logins: ["cursor", "cursor[bot]", "cursoragent", "cursor-agent"],
    emails: [/^(cursoragent|agent|noreply)@cursor\.(com|sh)$/],
    names: ["cursor", "cursor agent", "cursor[bot]"],
    branches: ["cursor/"] },
  { id: "codex", name: "Codex",
    logins: ["chatgpt-codex-connector", "chatgpt-codex-connector[bot]", "codex", "codex[bot]"],
    emails: ["codex@openai.com", /chatgpt-codex-connector\[bot\]@users\.noreply\.github\.com$/],
    names: ["codex", "openai codex", "codex[bot]", "chatgpt-codex-connector[bot]"],
    branches: ["codex/"] },
  { id: "copilot", name: "Copilot",
    logins: ["copilot", "copilot[bot]", "copilot-swe-agent", "copilot-swe-agent[bot]", "github-copilot[bot]"],
    emails: [/\+copilot@users\.noreply\.github\.com$/, /copilot-swe-agent\[bot\]@users\.noreply\.github\.com$/],
    names: ["copilot", "github copilot", "copilot-swe-agent[bot]", "copilot[bot]"],
    branches: ["copilot/"] },
  { id: "grok", name: "Grok",
    logins: ["grok", "grok[bot]", /^grok-.*\[bot\]$/],
    emails: [/^(grok|noreply)@x\.ai$/],
    names: [/^grok( (code|cli|\d[\w.]*)( [\w.]+)*)?$/],
    branches: ["grok/"] },
  { id: "gemini", name: "Gemini",
    logins: ["gemini-cli[bot]", "gemini-code-assist[bot]", "gemini[bot]"],
    emails: [/^gemini.*@google\.com$/],
    names: [/^gemini( cli| code assist| \d[\w.]*)?$/],
    branches: ["gemini/"] },
  { id: "jules", name: "Jules",
    logins: ["google-labs-jules", "google-labs-jules[bot]"],
    emails: [/google-labs-jules\[bot\]@users\.noreply\.github\.com$/],
    names: ["google-labs-jules[bot]"] },
  { id: "devin", name: "Devin",
    logins: ["devin-ai-integration", "devin-ai-integration[bot]"],
    emails: [/devin-ai-integration\[bot\]@users\.noreply\.github\.com$/, /^(devin|noreply)@cognition(-labs)?\.ai$/],
    names: ["devin ai", "devin-ai-integration[bot]"],
    branches: ["devin/"] },
  { id: "aider", name: "Aider",
    emails: [/@aider\.chat$/],
    names: [/^aider( \(.*\))?$/],
    suffixes: [" (aider)"] },
  { id: "windsurf", name: "Windsurf",
    emails: [/^(cascade|windsurf|noreply)@(windsurf|codeium)\.com$/],
    names: ["windsurf", "windsurf cascade", "cascade"] },
  { id: "amp", name: "Amp", emails: [/^(amp|noreply)@ampcode\.com$/], names: ["amp"] },
  { id: "cline", name: "Cline", emails: [/^(cline|noreply)@cline\.bot$/], names: ["cline"] },
  { id: "openhands", name: "OpenHands", logins: ["openhands-agent", "openhands[bot]"], emails: [/^(openhands|noreply)@all-hands\.dev$/], names: ["openhands", "openhands-agent"] },
  { id: "factory", name: "Factory", logins: ["factory-droid", "factory-droid[bot]"], names: ["factory droid", "factory-droid[bot]"] },
  { id: "kiro", name: "Kiro", logins: ["kiro-agent", "kiro[bot]"], emails: [/^(kiro|noreply)@kiro\.dev$/], names: ["kiro"] },
  { id: "replit", name: "Replit Agent", logins: ["replit-agent", "replit[bot]"], names: ["replit agent"] },
  { id: "v0", name: "v0", logins: ["v0", "v0[bot]"], names: ["v0[bot]", "v0"] },
  { id: "lovable", name: "Lovable", logins: ["lovable-dev", "lovable-dev[bot]", "gpt-engineer-app[bot]"], names: ["lovable", "lovable-dev[bot]", "gpt-engineer-app[bot]"] },
];

/** Automation that is not an AI agent. Any other login ending in [bot] or -bot counts too. */
const BOTS = new Set(["dependabot", "renovate", "github-actions", "mergify", "pre-commit-ci", "snyk-bot", "imgbot", "allcontributors",
  "semantic-release-bot", "release-please", "changeset-bot", "web-flow", "greenkeeper", "codecov", "sonarcloud", "vercel", "netlify"]);

const TRAILER = /^\s*(co-authored-by|assisted-by|generated-by|ai-agent|agent)\s*:\s*(.+?)\s*$/gim;
const PERSON = /^(.*?)\s*<([^>]*)>\s*$/;

const lc = (s) => String(s ?? "").trim().toLowerCase();
const test = (p, v) => (p instanceof RegExp ? p.test(v) : p !== "" && p === v);
const any = (list, v) => !!v && (list ?? []).some((p) => test(p, v));

/**
 * Pure. The AGENTS setting (JSON) into rules: [{ "id": "acme", "name": "Acme Agent", "logins": ["acme-agent[bot]"],
 * "emails": ["agent@acme.example", "@agents.acme.example"], "names": ["Acme Agent"], "branches": ["acme/"] }]. Strings are
 * matched whole and without case; an email starting with "@" matches the whole domain. Bad entries are skipped.
 * @returns {AgentRule[]}
 */
export function parseAgents(raw) {
  if (!raw) return [];
  let list;
  try { list = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
  if (!Array.isArray(list)) return [];
  const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map(lc).slice(0, 50) : []);
  return list.filter((a) => a && typeof a.id === "string" && /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(a.id)).slice(0, 50).map((a) => ({
    id: lc(a.id), name: String(a.name ?? a.id).slice(0, 60),
    logins: strs(a.logins), names: strs(a.names), branches: strs(a.branches),
    emails: strs(a.emails).map((e) => (e.startsWith("@") ? new RegExp(`${escapeRe(e)}$`) : e)),
  }));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pure. A display name into an id for an agent this list does not know ("Acme Coder 2" → "x-acme-coder-2"). */
export const customId = (name) => `x-${lc(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "agent"}`;

/**
 * Pure. Which agent (if any) made this, and whether it is a bot.
 * @param {{ login?: string|null, name?: string|null, email?: string|null, committerLogin?: string|null,
 *   committerName?: string|null, committerEmail?: string|null, message?: string|null, branch?: string|null,
 *   insider?: boolean }} who
 * @param {AgentRule[]} [custom] the AGENTS setting, checked first
 * @returns {{ agent: string|null, agentName: string|null, bot: boolean }}
 */
export function detectAgent(who, custom = []) {
  const rules = [...custom, ...KNOWN_AGENTS];
  const login = lc(who.login), name = lc(who.name), email = lc(who.email);
  const byAccount = (l, n, e) => rules.find((r) => any(r.logins, l) || any(r.emails, e) || any(r.names, n));
  const found = (r) => ({ agent: r.id, agentName: r.name, bot: false });

  // 1, 2: the agent's own account wrote or committed it.
  let r = byAccount(login, name, email) ?? byAccount(lc(who.committerLogin), lc(who.committerName), lc(who.committerEmail));
  if (r) return found(r);

  // 3: a trailer. Co-authored-by names a person or an agent; the other trailers always name an agent.
  const message = String(who.message ?? "");
  for (const m of message.matchAll(TRAILER)) {
    const kind = lc(m[1]);
    const pm = PERSON.exec(m[2]);
    const tName = lc(pm ? pm[1] : m[2]), tEmail = lc(pm ? pm[2] : "");
    r = byAccount("", tName, tEmail);
    if (r) return found(r);
    if (kind !== "co-authored-by" && tName) {
      const display = (pm ? pm[1] : m[2]).trim().replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 40);
      if (display) return { agent: customId(display), agentName: display, bot: false };
    }
  }

  // 4, 5: a footer, an author-name suffix.
  r = rules.find((x) => (x.footers ?? []).some((f) => f.test(message)) || (x.suffixes ?? []).some((s) => name.endsWith(s)));
  if (r) return found(r);

  // 6: a member's pull request on an agent's branch.
  if (who.insider && who.branch) {
    const branch = lc(who.branch);
    r = rules.find((x) => (x.branches ?? []).some((p) => branch.startsWith(p)));
    if (r) return found(r);
  }

  const bare = login.replace(/\[bot\]$/, "");
  const bot = login.endsWith("[bot]") || login.endsWith("-bot") || BOTS.has(bare) || name.endsWith("[bot]");
  return { agent: null, agentName: null, bot };
}

/** Pure. The display name of an agent id, known or custom. */
export function agentName(id, custom = [], seen = {}) {
  if (!id) return null;
  return custom.find((a) => a.id === id)?.name ?? KNOWN_AGENTS.find((a) => a.id === id)?.name ?? seen[id] ?? id.replace(/^x-/, "").replace(/-/g, " ");
}

/**
 * The chart colour slot of each agent, fixed so a colour always means the same agent (people take slot 1). Agents
 * outside these share "Other agents"; their own names still show on every commit, in the filters and in the table.
 */
export const AGENT_SLOTS = { claude: 2, codex: 3, grok: 4, copilot: 5, gemini: 6, cursor: 7 };
export const OTHER_AGENTS_SLOT = 8;
