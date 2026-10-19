// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/** The page's pure helpers and its words, run in Node (no DOM needed). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, setLocale, t } from "../public/js/i18n.js";
import { apiQuery, clusterMarkers, heatStep, initials, paramsFromState, parsePatch, slotOf, stackOf, stateFromParams } from "../public/js/lib.js";
import en from "../public/locales/en.js";

test("each agent keeps its colour whatever else is on screen; other agents share one", () => {
  assert.equal(slotOf("~human"), 1);
  assert.equal(slotOf("claude"), 2);
  assert.equal(slotOf("cursor"), 7);
  assert.equal(slotOf("devin"), 8);
  assert.equal(slotOf("x-acme-coder"), 8);
  assert.equal(slotOf("~bot"), "bot");
  assert.deepEqual(stackOf({ devin: 2, "~bot": 1, claude: 3, aider: 1, "~human": 5 }), [["~human", 5], ["claude", 3], ["~other", 3], ["~bot", 1]]);
});

test("a patch becomes lines with old and new numbers", () => {
  const lines = parsePatch("@@ -10,3 +10,4 @@ fn\n ctx\n-old\n+new\n+more\n\\ No newline at end of file");
  assert.deepEqual(lines.map((l) => [l.t, l.a ?? null, l.b ?? null]), [["h", null, null], ["c", 10, 10], ["d", 11, null], ["a", null, 11], ["a", null, 12], ["n", null, null]]);
  assert.equal(lines[2].text, "old");
});

test("the address keeps the view, and only sane values come back from it", () => {
  const s = stateFromParams(new URLSearchParams("tab=prs&range=30d&repos=1,2&agent=claude&state=stuck&sel=7%2312&evil=1&group=nope"));
  assert.equal(s.tab, "prs");
  assert.equal(s.prState, "stuck");
  assert.equal(s.sel, "7#12");
  assert.equal(s.group, "repo");
  assert.deepEqual(s.filter, { repos: "1,2", agent: "claude" });
  assert.equal(paramsFromState(s).toString(), "tab=prs&range=30d&repos=1%2C2&agent=claude&state=stuck&sel=7%2312");
  assert.equal(stateFromParams(new URLSearchParams("sel=javascript:alert(1)")).sel, "");
  assert.match(apiQuery(s, "Asia/Jerusalem", { state: "stuck" }), /^range=30d&tz=Asia%2FJerusalem&repos=1%2C2&agent=claude&state=stuck$/);
});

test("markers close together become one", () => {
  const c = clusterMarkers([{ at: 0 }, { at: 3 }, { at: 100 }], (x) => x, 8);
  assert.deepEqual(c.map((x) => x.items.length), [2, 1]);
});

test("small helpers", () => {
  assert.equal(initials("Maya Cohen"), "MC");
  assert.equal(initials("dependabot[bot]"), "DE");
  assert.equal(heatStep(0, 10), 0);
  assert.equal(heatStep(10, 10), 5);
  assert.equal(heatStep(1, 100), 1);
});

test("words: placeholders, plurals, and every message has its placeholders", () => {
  setLocale(["en-US"]);
  assert.equal(t("n.commits", { n: 1 }), "1 commit");
  assert.equal(t("n.commits", { n: 2400 }), "2,400 commits");
  assert.equal(t("n.commits", { n: 0 }), "no commits");
  assert.equal(t("who.with", { agent: "Claude" }), "with Claude");
  assert.equal(t("no.such.key"), "no.such.key");
  assert.match(duration(3 * 86_400_000), /^3 days$/);
  for (const [k, v] of Object.entries(en)) {
    const forms = typeof v === "string" ? [v] : Object.values(v);
    for (const f of forms) assert.ok(!/\{\s|\s\}/.test(f), `${k}: malformed placeholder`);
  }
});
