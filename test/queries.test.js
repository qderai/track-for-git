// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { ensureDemo } from "../src/demo.js";
import { commitPage, commitWhere, facets, heatmap, overview, parseFilter, prPage, story } from "../src/queries.js";
import { memStore } from "./helpers.js";

const now = Date.parse("2026-10-19T12:00:00Z");
let store;
before(async () => {
  store = memStore();
  await ensureDemo(store, now, { scale: 0.4 });
});
const f = (q = "") => parseFilter(new URLSearchParams(q), now);

test("the filter keeps only sane values", () => {
  const x = f("range=30d&repos=1,abc,-3,99999999999999999,7&author=Dana,%20ruth&agent=claude,human,DROP%20TABLE&tz=Not/AZone&q=%25_x&path=/src/api&from=5&to=1");
  assert.deepEqual(x.repos, [1, 7]);
  assert.deepEqual(x.authors, ["dana", "ruth"]);
  assert.deepEqual(x.agents, ["claude", "human"]);
  assert.equal(x.tz, "UTC");
  assert.equal(x.path, "src/api");
  assert.ok(x.from < x.to);
  const w = commitWhere(f("q=50%25_off"));
  assert.ok(w.binds.includes("%50\\%\\_off%"), "LIKE wildcards in a search are escaped");
});

test("pages of commits cover the range once, newest first, with no repeats", async () => {
  const seen = new Set();
  let cursor = null, pages = 0, last = Infinity, total = null;
  do {
    const p = await commitPage(store, f("range=7d"), cursor, 100);
    total ??= p.total;
    for (const c of p.items) { assert.ok(c.at <= last); last = c.at; assert.ok(!seen.has(c.sha)); seen.add(c.sha); }
    cursor = p.next;
    pages++;
  } while (cursor && pages < 100);
  assert.equal(seen.size, total);
  assert.ok(total > 300);
});

test("who: people alone, any agent, one agent, bots add up", async () => {
  const count = async (q) => (await commitPage(store, f(`range=30d&${q}`), null, 1)).total;
  const all = await count("");
  const human = await count("agent=human"), bot = await count("agent=bot"), agent = await count("agent=agent");
  assert.equal(human + bot + agent, all);
  assert.ok(await count("agent=claude") > 0);
  assert.equal(await count("agent=claude,human"), (await count("agent=claude")) + human);
  const ov = await overview(store, f("range=30d"), { now });
  assert.equal(ov.who.reduce((a, w) => a + w.commits, 0), ov.tiles.commits);
  assert.equal(ov.tiles.agentCommits, agent);
});

test("team, person, path, branch and text filters narrow the commits", async () => {
  const total = (q) => commitPage(store, f(`range=30d&${q}`), null, 1).then((p) => p.total);
  const all = await total("");
  for (const q of ["team=payments", "path=src/handlers", "branch=main", "q=fix"]) {
    const n = await total(q);
    assert.ok(n > 0 && n < all, `${q}: ${n} of ${all}`);
  }
  const person = (await store.first("SELECT author_login FROM commits WHERE bot = 0 LIMIT 1")).author_login;
  const mine = await commitPage(store, f(`range=30d&author=${person}`), null, 200);
  assert.ok(mine.items.every((c) => c.author === person));
});

test("the timeline adds up to the commits, in ten lanes and the rest", async () => {
  for (const group of ["repo", "person", "team"]) {
    const ov = await overview(store, f("range=7d&tz=Asia/Jerusalem"), { now, group });
    const binned = ov.timeline.bins.reduce((a, b) => a + b.n, 0);
    if (group !== "team") assert.equal(binned, ov.tiles.commits, group);
    assert.ok(ov.timeline.lanes.length <= 11);
    assert.equal(ov.timeline.binMs, 3 * 3_600_000);
  }
});

test("the heatmap's days are the viewer's days", async () => {
  const utc = await heatmap(store, f("range=30d&tz=UTC"), "repo");
  const tokyo = await heatmap(store, f("range=30d&tz=Asia/Tokyo"), "repo");
  const sum = (h) => h.cells.reduce((a, c) => a + c[2], 0);
  assert.equal(sum(utc), utc.rows.reduce((a, r) => a + r.total, 0));
  assert.equal(sum(tokyo), sum(utc), "the same commits, binned into other days");
  assert.notDeepEqual(tokyo.cells, utc.cells);
  assert.equal(utc.unit, "day");
  assert.equal((await heatmap(store, f("range=1d"), "person")).unit, "hour");
});

test("pull request states and their counts agree", async () => {
  const x = f("range=30d");
  const open = await prPage(store, x, { state: "open", now });
  const stuck = await prPage(store, x, { state: "stuck", now });
  assert.equal(open.counts.open, (await store.first("SELECT COUNT(*) AS n FROM prs WHERE state = 'open'")).n);
  assert.ok(stuck.items.every((p) => p.state === "open" && !p.draft && now - p.updatedAt > 7 * 86_400_000));
  const merged = await prPage(store, x, { state: "merged", now, limit: 100 });
  assert.equal(merged.counts.merged, (await store.first("SELECT COUNT(*) AS n FROM prs WHERE merged = 1 AND merged_at >= ? AND merged_at < ?", x.from, x.to)).n);
  assert.ok(merged.items.every((p) => p.state === "merged") && merged.next === "100");
  const labelled = await prPage(store, f("range=30d&label=bug"), { state: "all", now, limit: 500 });
  assert.ok(labelled.items.length > 0 && labelled.items.every((p) => p.labels.includes("bug")));
  const big = await prPage(store, x, { state: "merged", sort: "largest", now });
  const sizes = big.items.map((p) => (p.additions ?? 0) + (p.deletions ?? 0));
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

test("the story tells each day, newest first", async () => {
  const s = await story(store, f("range=7d&tz=Europe/London"));
  assert.ok(s.days.length >= 7);
  assert.ok(s.days[0].day > s.days[1].day);
  const d = s.days.find((x) => x.commits > 50);
  assert.ok(d.people > 0 && d.repoCount > 0 && d.repos.length <= 3);
  assert.ok(d.merged.length <= 6);
});

test("facets list what the filters offer", async () => {
  const x = await facets(store, now);
  assert.equal(x.repos.length, 36);
  assert.equal(x.teams.length, 7);
  assert.ok(x.people.length >= 50);
  assert.ok(x.agents.some((a) => a.id === "claude" && a.name === "Claude"));
  assert.ok(x.branches.includes("main"));
  assert.ok(x.labels.includes("bug"));
});
