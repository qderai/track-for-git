// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import assert from "node:assert/strict";
import { test } from "node:test";
import { customId, detectAgent, parseAgents } from "../src/agents.js";

const who = (x) => detectAgent(x).agent;

test("Claude Code's trailer marks a person's commit as made with Claude", () => {
  assert.equal(who({ login: "dana", name: "Dana Levi", message: "Fix the bill\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" }), "claude");
  assert.equal(who({ login: "dana", name: "Dana Levi", message: "Fix\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)" }), "claude");
  assert.equal(who({ login: "claude[bot]", name: "claude[bot]", message: "x" }), "claude");
});

test("people who share a name with an agent stay people", () => {
  assert.equal(who({ login: "cmonet", name: "Claude Monet", email: "claude@monet.example", message: "Paint" }), null);
  assert.equal(who({ login: "dsmith", name: "Devin Smith", message: "Co-authored-by: Devin Jones <devin@jones.example>" }), null);
  assert.equal(who({ login: "jules", name: "Jules Verne", message: "x" }), null);
  // An OpenAI or Cursor employee committing as themselves is not the agent.
  assert.equal(who({ login: "amy", name: "Amy", email: "amy@cursor.com", message: "x" }), null);
});

test("each agent is recognised by its own mark", () => {
  assert.equal(who({ login: "dana", name: "Dana", message: "x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>" }), "cursor");
  assert.equal(who({ login: "copilot-swe-agent[bot]", name: "Copilot", message: "x" }), "copilot");
  assert.equal(who({ login: "dana", message: "x\n\nCo-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>" }), "copilot");
  assert.equal(who({ login: "devin-ai-integration[bot]", message: "x" }), "devin");
  assert.equal(who({ login: "dana", message: "x\n\nAssisted-by: Grok" }), "grok");
  assert.equal(who({ login: "dana", message: "x\n\nCo-authored-by: Grok 4 <noreply@x.ai>" }), "grok");
  assert.equal(who({ login: "dana", message: "x\n\nCo-authored-by: Gemini CLI <gemini-cli@google.com>" }), "gemini");
  assert.equal(who({ login: "dana", message: "x\n\nCo-authored-by: Codex <codex@openai.com>" }), "codex");
  assert.equal(who({ login: "dana", name: "Dana Levi (aider)", message: "x" }), "aider");
  assert.equal(who({ login: "dana", message: "x\n\nCo-authored-by: Amp <amp@ampcode.com>" }), "amp");
  assert.equal(who({ login: "google-labs-jules[bot]", message: "x" }), "jules");
});

test("an agent that commits a person's change is still the agent", () => {
  assert.equal(who({ login: "dana", name: "Dana", committerLogin: "cursor[bot]", committerName: "Cursor Agent", message: "x" }), "cursor");
});

test("an agent nobody listed is recognised from Assisted-by under its own name", () => {
  const r = detectAgent({ login: "dana", message: "x\n\nAssisted-by: Acme Coder 2 <bot@acme.example>" });
  assert.equal(r.agent, customId("Acme Coder 2"));
  assert.equal(r.agent, "x-acme-coder-2");
  assert.equal(r.agentName, "Acme Coder 2");
  // Co-authored-by alone names a person, never an unknown agent.
  assert.equal(who({ login: "dana", message: "x\n\nCo-authored-by: Ruth Ben <ruth@acme.example>" }), null);
});

test("a branch prefix counts only for a member's pull request", () => {
  assert.equal(detectAgent({ login: "dana", branch: "claude/fix-bill", insider: true }).agent, "claude");
  assert.equal(detectAgent({ login: "stranger", branch: "claude/fix-bill", insider: false }).agent, null);
  assert.equal(detectAgent({ login: "dana", branch: "claude/fix-bill" }).agent, null);
});

test("bots are bots, agents are not bots", () => {
  assert.deepEqual(detectAgent({ login: "dependabot[bot]", message: "Bump x" }), { agent: null, agentName: null, bot: true });
  assert.equal(detectAgent({ login: "renovate", message: "x" }).bot, true);
  assert.equal(detectAgent({ login: "release-bot", message: "x" }).bot, true);
  assert.equal(detectAgent({ login: "copilot-swe-agent[bot]", message: "x" }).bot, false);
});

test("a company's own agents come from the AGENTS setting and win over the list", () => {
  const custom = parseAgents(JSON.stringify([
    { id: "forge", name: "Forge", logins: ["forge-agent[bot]"], emails: ["@agents.acme.example"], names: ["Forge"], branches: ["forge/"] },
    { id: "bad id!", name: "x" },
    "nonsense",
  ]));
  assert.equal(custom.length, 1);
  assert.equal(detectAgent({ login: "forge-agent[bot]", message: "x" }, custom).agent, "forge");
  assert.equal(detectAgent({ login: "dana", message: "x\n\nCo-authored-by: Forge <run-12@agents.acme.example>" }, custom).agent, "forge");
  assert.equal(detectAgent({ login: "dana", branch: "forge/x", insider: true }, custom).agent, "forge");
  assert.deepEqual(parseAgents("{not json"), []);
});
