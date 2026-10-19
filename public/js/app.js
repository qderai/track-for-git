// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The page: one state (tab, range, filters, what is open) kept in the address so a view can be shared as a link,
 * four views (Overview, Commits, Pull requests, Story), and a quiet refresh every 15 seconds while the tab is visible.
 * A refresh redraws only what changed and never moves the reader: new commits above a scrolled list wait behind a
 * "new commits" button.
 */
import { drawHeatmap, drawLegend, drawTimeline, drawWho, fillOf, spanText, whoName } from "./charts.js";
import { drawFiles } from "./diffview.js";
import { $, $$, clear, h, hideTip, icon, initTooltips, pref, setPref } from "./dom.js";
import { ago, dateTime, dayWords, duration, num, pct, setLocale, signed, t, timeZone } from "./i18n.js";
import { apiQuery, initials, paramsFromState, stateFromParams, whoOf } from "./lib.js";
import { closePicker, openPicker } from "./picker.js";
import { VirtualList } from "./virtual-list.js";

setLocale();
const tz = timeZone();
let state = stateFromParams(new URLSearchParams(location.search));
let me = null;
let facets = { repos: [], teams: [], people: [], agents: [], branches: [], labels: [] };
const names = {};          // agent id → name
const sigs = {};           // last drawn data of each block
const repoName = new Map();
let commitList, pushList, prList;

// ---------------------------------------------------------------------------------------------------- data

class HttpError extends Error { constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; } }
async function get(path) {
  const r = await fetch(path, { headers: { accept: "application/json" }, credentials: "same-origin" });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 503) { boot(); throw new HttpError(r.status, body); }
  if (!r.ok) throw new HttpError(r.status, body);
  return body;
}
const q = (extra) => apiQuery(state, tz, extra);

function setState(patch, { push = false, reload = true } = {}) {
  state = { ...state, ...patch, filter: patch.filter ? { ...patch.filter } : state.filter };
  const p = paramsFromState(state).toString();
  const url = `${location.pathname}${p ? `?${p}` : ""}`;
  if (push) history.pushState(null, "", url); else history.replaceState(null, "", url);
  if (reload) render();
}
const setFilter = (patch) => {
  const filter = { ...state.filter, ...patch };
  for (const k of Object.keys(filter)) if (!filter[k]) delete filter[k];
  setState({ filter, sel: "" });
};

/** Draw a block only when its data changed. */
function changed(id, data) {
  const sig = JSON.stringify(data);
  if (sigs[id] === sig) return false;
  sigs[id] = sig;
  return true;
}

// ---------------------------------------------------------------------------------------------------- boot

async function boot() {
  try { me = await (await fetch("/api/me", { headers: { accept: "application/json" } })).json(); }
  catch { document.body.classList.add("ready"); $("#main").replaceChildren(h("p", { class: "note warn" }, t("error.load"))); return; }
  document.body.classList.add("ready");
  if (me.setup) return renderSetup(me.setup);
  if (!me.user && me.auth && me.auth !== "none" && !me.org) return renderSignIn();
  document.title = me.title;
  $("#app").hidden = false;
  $("#gate").hidden = true;
  $("#org").textContent = me.org ?? "";
  for (const a of me.agents ?? []) names[a.id] = a.name;
  $("#banner").hidden = !(me.demo || me.auth === "none");
  $("#banner").textContent = me.demo ? t("demo.banner") : t("open.banner");
  $("#signout").hidden = me.auth !== "github";
  get("/api/facets").then((f) => { facets = f; for (const a of f.agents) names[a.id] ??= a.name; for (const r of f.repos) repoName.set(String(r.id), r.name); drawFilters(); }).catch(() => undefined);
  status();
  render();
}

/** "Built by Qder.ai", with the logo, for the screens before the dashboard. */
const builtBy = () => h("a", { class: "built", href: "https://qder.ai", rel: "noopener" }, h("span", null, t("app.builtBy")),
  h("img", { class: "qder on-light", src: "/brand/qder-lockup-ltr-cobalt.svg", alt: "Qder.ai", width: "98", height: "20" }),
  h("img", { class: "qder on-dark", src: "/brand/qder-lockup-ltr-white.svg", alt: "Qder.ai", width: "98", height: "20" }));

/**
 * GitHub's "new App" page with everything filled in: read-only permissions, the events, this dashboard's webhook
 * and callback addresses. The webhook secret and the private key are made on GitHub by the person, never here.
 */
function appLink(org) {
  const u = new URL(`https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`);
  const p = u.searchParams;
  p.set("name", `Track for Git (${org})`.slice(0, 34));
  p.set("url", location.origin);
  p.set("public", "false");
  p.set("webhook_active", "true");
  p.set("webhook_url", `${location.origin}/api/github/webhook`);
  p.append("callback_urls[]", `${location.origin}/auth/callback`);
  for (const perm of ["contents", "metadata", "pull_requests", "deployments", "statuses", "checks", "members"]) p.set(perm, "read");
  for (const e of ["push", "pull_request", "pull_request_review", "check_suite", "status", "deployment", "deployment_status", "release", "create", "delete", "repository"]) p.append("events[]", e);
  return u.toString();
}

function renderSetup(s) {
  document.title = t("setup.title");
  $("#app").hidden = true;
  const gate = clear($("#gate"));
  gate.hidden = false;
  const item = (ok, text) => h("li", { class: ok ? "ok" : "todo" }, icon(ok ? "check" : "dot"), h("span", null, text));
  gate.append(h("div", { class: "gate-card" },
    h("h1", null, t("setup.title")), h("p", null, t("setup.intro")),
    h("ol", { class: "checklist" }, item(!!s.github, t("setup.github")), item(s.webhook, t("setup.webhook")), item(!s.authProblem, t("setup.auth"))),
    s.authProblem ? h("p", { class: "note warn" }, t("setup.problem", { problem: s.authProblem })) : null,
    h("p", { class: "gate-actions" }, h("a", { class: "btn", href: "https://github.com/qderai/track-for-git/blob/main/docs/setup.md", rel: "noopener" }, t("setup.docs")),
      s.org && !s.github ? h("a", { class: "btn ghost", href: appLink(s.org), rel: "noopener" }, icon("github"), t("setup.app")) : null),
    h("p", { class: "note" }, t("setup.demo")), builtBy()));
}

function renderSignIn() {
  $("#app").hidden = true;
  const gate = clear($("#gate"));
  gate.hidden = false;
  gate.append(h("div", { class: "gate-card" }, h("h1", null, me.title ?? t("app.title")),
    me.signIn ? [h("p", null, t("signin.intro")), h("p", null, h("a", { class: "btn", href: `${me.signIn}?back=${encodeURIComponent(location.pathname + location.search)}` }, icon("github"), t("signin.github")))]
      : h("p", null, t("signin.access")), builtBy()));
}

// ---------------------------------------------------------------------------------------------------- toolbar

function drawFilters() {
  for (const b of $$("[data-range]")) b.setAttribute("aria-pressed", String(b.dataset.range === state.range && !state.filter.from));
  const f = state.filter;
  const count = (k) => (f[k] ? f[k].split(",").length : 0);
  const label = (k, base) => (count(k) ? `${base} · ${count(k)}` : base);
  $("#f-repos").lastChild.textContent = label("repos", t("filter.repos"));
  $("#f-team").lastChild.textContent = f.team ? `${t("filter.team")} · ${facets.teams.find((x) => x.slug === f.team)?.name ?? f.team}` : t("filter.team");
  $("#f-author").lastChild.textContent = label("author", t("filter.author"));
  $("#f-agent").lastChild.textContent = label("agent", t("filter.agent"));
  $("#f-branch").lastChild.textContent = f.branch ? `${t("filter.branch")} · ${f.branch}` : t("filter.branch");
  $("#f-path").lastChild.textContent = f.path ? `${t("filter.path")} · ${f.path}` : t("filter.path");
  $("#f-label").lastChild.textContent = f.label ? `${t("filter.label")} · ${f.label}` : t("filter.label");
  $("#f-label").hidden = state.tab !== "prs";
  for (const k of ["repos", "team", "author", "agent", "branch", "path", "label"]) $(`#f-${k}`).classList.toggle("on", !!f[k]);
  if ($("#q") !== document.activeElement) $("#q").value = f.q ?? "";

  // Chips: one per value, each removable.
  const chips = clear($("#chips"));
  const chip = (text, remove) => chips.append(h("li", null, h("span", null, text), h("button", { type: "button", class: "x", "aria-label": t("filter.remove", { name: text }), onclick: remove }, icon("x"))));
  if (f.from && f.to) chip(spanText(Number(f.from), Number(f.to)), () => setFilter({ from: "", to: "" }));
  for (const id of (f.repos ?? "").split(",").filter(Boolean)) chip(repoName.get(id) ?? id, () => setFilter({ repos: f.repos.split(",").filter((x) => x !== id).join(",") }));
  if (f.team) chip(facets.teams.find((x) => x.slug === f.team)?.name ?? f.team, () => setFilter({ team: "" }));
  for (const a of (f.author ?? "").split(",").filter(Boolean)) chip(a, () => setFilter({ author: f.author.split(",").filter((x) => x !== a).join(",") }));
  for (const a of (f.agent ?? "").split(",").filter(Boolean)) chip(agentFilterName(a), () => setFilter({ agent: f.agent.split(",").filter((x) => x !== a).join(",") }));
  if (f.branch) chip(`${t("filter.branch")}: ${f.branch}`, () => setFilter({ branch: "" }));
  if (f.path) chip(`${t("filter.path")}: ${f.path}`, () => setFilter({ path: "" }));
  if (f.label) chip(`${t("filter.label")}: ${f.label}`, () => setFilter({ label: "" }));
  if (f.q) chip(`“${f.q}”`, () => setFilter({ q: "" }));
  if (chips.childElementCount > 1) chips.append(h("li", { class: "clear" }, h("button", { type: "button", class: "btn ghost sm", onclick: () => setState({ filter: {}, sel: "" }) }, t("filter.clear"))));
}
const agentFilterName = (a) => (a === "human" ? t("who.humanAlone") : a === "bot" ? t("who.bot") : a === "agent" ? t("who.agent") : whoName(a, names));

function initToolbar() {
  for (const b of $$("[data-range]")) b.addEventListener("click", () => setState({ range: b.dataset.range, filter: { ...state.filter, from: "", to: "" }, sel: "" }));
  let timer;
  $("#q").addEventListener("input", (e) => { clearTimeout(timer); timer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 300); });
  $("#search").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(timer); setFilter({ q: $("#q").value.trim() }); });
  const multi = (key, title, options) => (e) => openPicker(e.currentTarget, { title, multi: true, options: options(), selected: (state.filter[key] ?? "").split(",").filter(Boolean), onApply: (v) => setFilter({ [key]: v.join(",") }) });
  const one = (key, title, options) => (e) => openPicker(e.currentTarget, { title, options: options(), selected: state.filter[key] ? [state.filter[key]] : [], onApply: (v) => setFilter({ [key]: v[0] ?? "" }) });
  $("#f-repos").addEventListener("click", multi("repos", t("filter.repos"), () => facets.repos.map((r) => ({ value: String(r.id), label: r.name }))));
  $("#f-team").addEventListener("click", one("team", t("filter.team"), () => facets.teams.map((x) => ({ value: x.slug, label: x.name, hint: num(x.members) }))));
  $("#f-author").addEventListener("click", multi("author", t("filter.author"), () => facets.people.map((p) => ({ value: p.login, label: p.name ?? p.login, hint: p.login }))));
  $("#f-agent").addEventListener("click", multi("agent", t("filter.agent"), () => [
    { value: "human", label: t("who.humanAlone"), sw: fillOf("~human") }, { value: "agent", label: t("who.agent") },
    ...facets.agents.map((a) => ({ value: a.id, label: a.name, hint: num(a.commits), sw: fillOf(a.id) })), { value: "bot", label: t("who.bot"), sw: fillOf("~bot") }]));
  $("#f-branch").addEventListener("click", one("branch", t("filter.branch"), () => facets.branches.map((b) => ({ value: b, label: b }))));
  $("#f-label").addEventListener("click", one("label", t("filter.label"), () => facets.labels.map((l) => ({ value: l, label: l }))));
  $("#f-path").addEventListener("click", (e) => openPicker(e.currentTarget, { title: t("filter.path"), text: { placeholder: t("filter.pathHint"), value: state.filter.path ?? "" }, onApply: (v) => setFilter({ path: v[0] ?? "" }) }));

  // Tabs, with the arrow keys between them.
  const tabs = $$("[role=tab]");
  for (const tab of tabs) {
    tab.addEventListener("click", () => setState({ tab: tab.dataset.tab, sel: "" }, { push: true }));
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      const j = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
      if (j === null) return;
      e.preventDefault();
      const next = tabs[(j + tabs.length) % tabs.length];
      next.focus();
      setState({ tab: next.dataset.tab, sel: "" }, { push: true });
    });
  }
  // "/" searches; Escape closes what is open.
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !e.target.closest("input, textarea, select, [contenteditable]")) { e.preventDefault(); $("#q").focus(); }
    if (e.key === "Escape" && state.sel && !document.querySelector(".picker")) { closeDetail(); }
  });
  addEventListener("popstate", () => { state = stateFromParams(new URLSearchParams(location.search)); render(); });

  // Theme: the system's, or light, or dark; kept in this browser.
  const themes = ["auto", "light", "dark"];
  const applyTheme = (v) => {
    if (v === "auto") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = v;
    $("#theme").setAttribute("aria-label", `${t("theme.label")}: ${t(`theme.${v}`)}`);
    $("#theme").title = t(`theme.${v}`);
    $("#theme use").setAttribute("href", `#i-${v === "auto" ? "contrast" : v === "light" ? "sun" : "moon"}`);
  };
  applyTheme(pref("theme", "auto"));
  $("#theme").addEventListener("click", () => { const next = themes[(themes.indexOf(pref("theme", "auto")) + 1) % 3]; setPref("theme", next); applyTheme(next); });
  $("#status").addEventListener("click", () => openStatus());
}

// ---------------------------------------------------------------------------------------------------- render

function render() {
  closePicker(false);
  hideTip();
  drawFilters();
  for (const tab of $$("[role=tab]")) {
    const on = tab.dataset.tab === state.tab;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
  }
  for (const panel of $$("[role=tabpanel]")) panel.hidden = panel.id !== `p-${state.tab}`;
  if (state.tab === "overview") loadOverview();
  else if (state.tab === "commits") loadCommits();
  else if (state.tab === "prs") loadPrs();
  else loadStory();
}

function failed(box, e) {
  if (e instanceof HttpError && (e.status === 401 || e.status === 503)) return;
  clear(box).append(h("p", { class: "note warn" }, t("error.load")));
}

// ---------------------------------------------------------------------------------------------------- overview

async function loadOverview() {
  const range = rangeOf();
  let d;
  try { d = await get(`/api/overview?${q({ group: state.group })}`); } catch (e) { return failed($("#tiles"), e); }
  if (state.tab !== "overview") return;
  for (const w of d.who) if (w.name) names[w.id] ??= w.name;
  if (changed("tiles", d.tiles)) drawTiles(d.tiles);
  if (changed("timeline", [d.timeline, d.markers, state.group, Math.floor(Date.now() / 60_000), $("#timeline").clientWidth])) {
    drawTimeline($("#timeline"), d.timeline, { from: range.from, to: range.to, group: state.group, markers: d.markers, names, onPick: pickBin });
    drawLegend($("#legend"), [...new Set(d.timeline.bins.flatMap((b) => Object.keys(b.who)).map((k) => (k === "~human" || k === "~bot" || ["claude", "codex", "grok", "copilot", "gemini", "cursor"].includes(k) ? k : "~other")))], names);
    $("#timeline-sum").textContent = t("timeline.summary", { commits: t("n.commits", { n: d.tiles.commits }), deploys: t("n.deploys", { n: d.tiles.deploys }), releases: t("n.releases", { n: d.tiles.releases }) });
  }
  if (changed("who", [d.who, state.filter.agent])) drawWho($("#who"), d.who, { names, total: d.tiles.commits, active: (state.filter.agent ?? "").split(","), onPick: (id) => {
    const cur = (state.filter.agent ?? "").split(",").filter(Boolean);
    setFilter({ agent: cur.includes(id) ? cur.filter((x) => x !== id).join(",") : id });
  } });
  if (changed("attention", d.attention)) drawAttention(d.attention);
  for (const b of $$("[data-group]")) b.setAttribute("aria-pressed", String(b.dataset.group === state.group));
  loadHeat();
}

/** The range actually shown: a picked span, or the range up to now. */
function rangeOf() {
  if (state.filter.from && state.filter.to) return { from: Number(state.filter.from), to: Number(state.filter.to) };
  const days = { "1d": 1, "7d": 7, "30d": 30, "90d": 90 }[state.range];
  const to = Date.now() + 60_000;
  return { from: to - days * 86_400_000, to };
}

function drawTiles(x) {
  const delta = (cur, prev) => {
    if (!prev && !cur) return null;
    const d = prev ? (cur - prev) / prev : 1;
    return h("span", { class: `delta ${d > 0.02 ? "up" : d < -0.02 ? "down" : ""}` }, t("tile.vsPrev", { delta: prev ? signed(Math.round(d * 100)) + "%" : signed(cur) }));
  };
  const tile = (label, value, sub, extra) => h("div", { class: "tile" }, h("p", { class: "tl-l" }, label), h("p", { class: "tl-v" }, value), sub ? h("p", { class: "tl-s" }, sub) : null, extra ?? null);
  clear($("#tiles")).append(
    tile(t("tile.commits"), num(x.commits, true), t("tile.lines", { add: num(x.additions, true), del: num(x.deletions, true) }), delta(x.commits, x.commitsPrev)),
    tile(t("tile.merged"), num(x.prsMerged, true), null, delta(x.prsMerged, x.prsMergedPrev)),
    h("button", { type: "button", class: "tile go", onclick: () => setState({ tab: "prs", prState: x.stuckPrs ? "stuck" : "open", sel: "" }, { push: true }) },
      h("p", { class: "tl-l" }, t("tile.open")), h("p", { class: "tl-v" }, num(x.openPrs, true)),
      h("p", { class: `tl-s ${x.stuckPrs ? "warn" : ""}` }, t("tile.stuck", { n: x.stuckPrs, days: me.staleDays ?? 7 }))),
    tile(t("tile.deploys"), num(x.deploys, true), t("tile.releases", { n: x.releases })),
    tile(t("tile.people"), num(x.people, true), t("tile.repos", { n: x.repos })),
    tile(t("tile.agents"), x.commits ? pct(x.agentCommits / x.commits) : "—", t("tile.agentsSub", { n: x.agentCommits })),
  );
}

/** A timeline bar: its commits, in the Commits view. */
function pickBin(lane, t0, t1) {
  const patch = { from: String(t0), to: String(t1) };
  if (lane.key !== "~rest") {
    if (state.group === "repo") patch.repos = lane.key;
    else if (state.group === "person") patch.author = lane.key;
    else if (lane.key !== "~none") patch.team = lane.key;
  }
  state = { ...state, tab: "commits", sel: "", filter: { ...state.filter, ...patch } };
  setState({}, { push: true });
}

function drawAttention(a) {
  const box = clear($("#attention"));
  const kinds = [["stuck", t("attention.stuck"), t("attention.emptyStuck", { days: me.staleDays ?? 7 })], ["failing", t("attention.failing"), t("attention.emptyFailing")], ["changes", t("attention.changes"), t("attention.emptyChanges")]];
  for (const [k, title, empty] of kinds) {
    const list = a[k];
    box.append(h("section", { class: "att" },
      h("h3", null, title, h("span", { class: "n" }, num(list.length))),
      list.length ? h("ul", null, list.map((p) => h("li", null, h("button", { type: "button", class: "att-row", onclick: () => setState({ tab: "prs", prState: k === "stuck" ? "stuck" : "open", sel: `${p.repo}#${p.number}` }, { push: true }) },
        h("span", { class: "t" }, p.title), h("span", { class: "m" }, `${short(p.repoName)} #${p.number} · ${whoText(p)} · ${t("pr.updated", { ago: ago(p.updatedAt) })}`)))))
        : h("p", { class: "empty" }, empty)));
  }
}

async function loadHeat() {
  for (const b of $$("[data-heat]")) b.setAttribute("aria-pressed", String(b.dataset.heat === state.heat));
  let d;
  try { d = await get(`/api/heatmap?${q({ by: state.heat })}`); } catch (e) { return failed($("#heat"), e); }
  if (!changed("heat", [d, $("#heat").clientWidth, heatTable])) return;
  drawHeatmap($("#heat"), d, { table: heatTable, onPick: (row, col, unit) => {
    const from = unit === "hour" ? col : new Date(`${col}T00:00:00`).getTime();
    const to = unit === "hour" ? col + 3_600_000 : new Date(new Date(`${col}T00:00:00`).getTime() + 26 * 3_600_000).setHours(0, 0, 0, 0);
    const patch = { from: String(from), to: String(to) };
    if (state.heat === "repo") patch.repos = row.key; else if (state.heat === "person") patch.author = row.key; else if (row.key !== "~none") patch.team = row.key;
    state = { ...state, tab: "commits", sel: "", filter: { ...state.filter, ...patch } };
    setState({}, { push: true });
  } });
  $("#heat-table").textContent = heatTable ? t("heat.chart") : t("heat.table");
}
let heatTable = false;

// ---------------------------------------------------------------------------------------------------- shared rows

const short = (full) => String(full ?? "").replace(`${me?.org ?? ""}/`, "");
const agentLabel = (id) => whoName(id, names);
/** "Maya Cohen with Claude", "Copilot", "dependabot". */
function whoText(r) {
  const person = r.authorName ?? r.author ?? "?";
  if (!r.agent) return person;
  const own = /\[bot\]$/.test(r.author ?? "") || String(person).toLowerCase() === agentLabel(r.agent).toLowerCase();
  return own ? agentLabel(r.agent) : `${person} ${t("who.with", { agent: agentLabel(r.agent) })}`;
}
function whoBadge(r) {
  const who = whoOf(r);
  if (who === "~human") return null;
  return h("span", { class: "agent" }, h("i", { class: `sw ${fillOf(who)}`, "aria-hidden": "true" }), who === "~bot" ? t("who.bot") : agentLabel(who));
}
const avatar = (name) => h("span", { class: "av", "aria-hidden": "true" }, initials(name));
const lines = (a, d) => (a == null ? null : h("span", { class: "lines" }, h("span", { class: "add" }, `+${num(a, true)}`), h("span", { class: "del" }, `−${num(d ?? 0, true)}`)));
const ghLink = (url, label) => (url && /^https:\/\//.test(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer", class: "gh" }, icon("external"), label) : null);
const commitUrl = (c) => (me.webUrl && c.repoName ? `${me.webUrl}/${c.repoName}/commit/${c.sha}` : null);

// ---------------------------------------------------------------------------------------------------- commits

function commitRow(c) {
  return h("div", { class: `row commit${fresh.has(c.sha) ? " fresh" : ""}` },
    h("i", { class: `dot ${fillOf(whoOf(c))}`, "aria-hidden": "true" }),
    h("span", { class: "subj" }, c.subject || "(no message)"),
    h("time", { class: "when", datetime: new Date(c.at).toISOString(), title: dateTime(c.at) }, ago(c.at)),
    h("span", { class: "meta" }, h("span", { class: "by" }, whoText(c)), h("span", null, short(c.repoName)), c.branch ? h("span", { class: "br" }, c.branch) : null, lines(c.additions, c.deletions)));
}
function pushRow(p) {
  return h("div", { class: "row push" },
    h("i", { class: `dot ${fillOf(p.agent ?? "~human")}`, "aria-hidden": "true" }),
    h("span", { class: "subj" }, `${p.actor ?? "?"} ${t("push.line", { n: p.commits, branch: p.branch ?? "?" })}`),
    h("time", { class: "when", datetime: new Date(p.at).toISOString(), title: dateTime(p.at) }, ago(p.at)),
    h("span", { class: "meta" }, h("span", null, short(p.repoName)), p.agent ? h("span", null, t("who.with", { agent: agentLabel(p.agent) })) : null,
      p.forced ? h("span", { class: "warn" }, t("push.forced")) : null, p.created ? h("span", null, t("push.newBranch")) : null, h("span", { class: "mono" }, p.head.slice(0, 7))));
}
const fresh = new Set();
let commitNext = null, pushNext = null;

async function loadCommits({ refresh = false } = {}) {
  for (const b of $$("[data-list]")) b.setAttribute("aria-pressed", String(b.dataset.list === state.list));
  $("#commit-list").hidden = state.list !== "commits";
  $("#push-list").hidden = state.list !== "pushes";
  if (!commitList) {
    commitList = new VirtualList($("#commit-list"), { id: "c", label: t("list.aria"), key: (c) => `${c.repo}:${c.sha}`, render: commitRow,
      onOpen: (c) => setState({ sel: `${c.repo}:${c.sha}` }), onMore: () => moreCommits() });
    pushList = new VirtualList($("#push-list"), { id: "s", label: t("list.pushAria"), key: (p) => p.id, render: pushRow,
      onOpen: (p) => setFilter({ repos: String(p.repo), branch: p.branch ?? "" }), onMore: () => morePushes() });
  }
  try {
    if (state.list === "pushes") {
      const d = await get(`/api/pushes?${q()}`);
      pushNext = d.next;
      if (changed("pushes", [d.items.map((p) => p.id), q()])) pushList.set(d.items, { hasMore: !!d.next, keepActive: refresh });
      $("#list-count").textContent = "";
    } else {
      const d = await get(`/api/commits?${q()}`);
      const key = q();
      const top = commitList.items[0];
      if (refresh && sigs.commitsQuery === key && top && commitList.el.scrollTop > 64) {
        // The reader is further down: say how many arrived instead of moving the list.
        const n = d.items.findIndex((c) => c.sha === top.sha);
        newer(n > 0 ? n : d.items.length && d.items[0].at > top.at ? d.items.length : 0, d);
      } else if (changed("commits", [d.items.map((c) => c.sha + c.additions), key])) {
        if (fresh.size > 500) fresh.clear();
      if (refresh && sigs.commitsQuery === key && top) for (const c of d.items) { if (c.sha === top.sha) break; fresh.add(c.sha); }
        commitNext = d.next;
        commitList.set(d.items, { total: d.total, hasMore: !!d.next, keepActive: refresh && sigs.commitsQuery === key });
        newer(0);
      }
      sigs.commitsQuery = key;
      if (d.total !== null) $("#list-count").textContent = t("list.count", { n: d.total });
      if (!d.items.length) commitList.foot.textContent = t("list.empty");
    }
  } catch (e) { return failed($("#detail-commit"), e); }
  commitList.select(state.sel);
  if (state.sel && /^\d+:/.test(state.sel)) openCommit(state.sel); else showDetail(false, "commit");
}
function newer(n, d) {
  const btn = $("#newer");
  btn.hidden = !n;
  if (!n) return;
  btn.textContent = t("list.newer", { n });
  btn.onclick = () => { btn.hidden = true; commitList.set(d.items, { total: d.total, hasMore: !!d.next }); commitNext = d.next; };
}
async function moreCommits() {
  if (!commitNext) return;
  const d = await get(`/api/commits?${q({ cursor: commitNext })}`).catch(() => null);
  if (!d) { commitList.loading = false; return; }
  commitNext = d.next;
  commitList.append(d.items, !!d.next);
}
async function morePushes() {
  if (!pushNext) return;
  const d = await get(`/api/pushes?${q({ cursor: pushNext })}`).catch(() => null);
  if (!d) { pushList.loading = false; return; }
  pushNext = d.next;
  pushList.append(d.items, !!d.next);
}

let openSeq = 0;
async function openCommit(sel) {
  const [repo, sha] = sel.split(":");
  const box = $("#detail-commit");
  if (box.dataset.sel === sel) { showDetail(true, "commit"); return; }
  box.dataset.sel = sel;
  const seq = ++openSeq;
  clear(box).append(backButton(), h("p", { class: "note" }, t("diff.loading")));
  showDetail(true, "commit");
  let d;
  try { d = await get(`/api/commits/${repo}/${sha}`); } catch (e) { if (seq === openSeq) failed(box, e); return; }
  if (seq !== openSeq) return;
  const [subject, ...body] = String(d.message ?? d.subject ?? "").split("\n");
  const copy = h("button", { type: "button", class: "btn ghost sm mono", "aria-label": t("commit.copy"), onclick: async (e) => { try { await navigator.clipboard.writeText(d.sha); e.target.closest("button").lastChild.textContent = t("commit.copied"); } catch { /* not allowed */ } } }, icon("copy"), h("span", null, d.sha.slice(0, 10)));
  clear(box).append(
    backButton(),
    h("header", { class: "d-head" },
      h("h2", { id: "detail-title", tabindex: "-1" }, subject || "(no message)"),
      h("p", { class: "d-who" }, avatar(d.authorName ?? d.author), h("span", null, h("strong", null, whoText(d)), d.author && !/\[bot\]$/.test(d.author) ? h("small", null, ` @${d.author}`) : null), whoBadge(d)),
      h("p", { class: "d-meta" },
        h("span", null, d.repoName), d.branch ? h("span", { class: "br" }, d.branch) : null,
        h("time", { datetime: new Date(d.at).toISOString(), title: dateTime(d.at) }, `${dateTime(d.at)} · ${ago(d.at)}`),
        d.pr ? h("button", { type: "button", class: "link", onclick: () => setState({ tab: "prs", prState: "all", sel: `${d.repo}#${d.pr}` }, { push: true }) }, t("commit.pr", { n: d.pr })) : null),
      h("p", { class: "d-actions" }, copy, d.files ? h("span", { class: "stat" }, t("commit.files", { n: d.filesTotal ?? d.files.length }), " ", lines(d.additions, d.deletions)) : null, ghLink(d.url ?? commitUrl(d), t("commit.onGithub")))),
    body.join("\n").trim() ? h("pre", { class: "msg" }, body.join("\n").trim()) : null,
    h("div", { class: "files" }));
  drawFiles(box.querySelector(".files"), d);
  if (matchMedia("(max-width: 899px)").matches) $("#detail-title").focus({ preventScroll: false });
}

function backButton() {
  return h("button", { type: "button", class: "btn ghost sm back", onclick: closeDetail }, icon("back"), t("commit.back"));
}
function closeDetail() {
  const tab = state.tab;
  setState({ sel: "" });
  const list = tab === "prs" ? $("#pr-list") : $("#commit-list");
  list?.focus();
}
function showDetail(on, kind) {
  const pane = kind === "pr" ? $("#detail-pr") : $("#detail-commit");
  pane.closest(".split").classList.toggle("open", on);
  if (!on) {
    delete pane.dataset.sel;
    clear(pane).append(h("div", { class: "pick" }, icon(kind === "pr" ? "pr" : "commit", "i big"), h("h2", null, t(kind === "pr" ? "pr.pick" : "commit.pick")), h("p", null, t(kind === "pr" ? "pr.pickHint" : "commit.pickHint"))));
  }
}

// ---------------------------------------------------------------------------------------------------- pull requests

const REVIEW_ICON = { approved: "check", changes_requested: "x", review_required: "dot", commented: "comment" };
const CI_ICON = { success: "check", failure: "x", pending: "clock" };
function prBadges(p) {
  return [
    p.ci ? h("span", { class: `badge ci-${p.ci}` }, icon(CI_ICON[p.ci]), t(`pr.ci.${p.ci}`)) : null,
    p.state === "open" ? h("span", { class: `badge rv-${p.review ?? "none"}` }, icon(REVIEW_ICON[p.review] ?? "dot"), t(`pr.review.${p.review ?? "none"}`)) : null,
  ];
}
function prRow(p) {
  const when = p.state === "merged" ? t("pr.mergedAgo", { ago: ago(p.mergedAt) }) : p.state === "closed" ? t("pr.closedAgo", { ago: ago(p.closedAt ?? p.updatedAt) }) : t("pr.opened", { ago: ago(p.createdAt) });
  const stale = p.state === "open" && !p.draft && Date.now() - p.updatedAt > (me.staleDays ?? 7) * 86_400_000;
  return h("div", { class: `row pr st-${p.state}` },
    h("span", { class: `pr-state ${p.draft ? "draft" : p.state}`, title: p.draft ? t("pr.draft") : t(`pr.${p.state}`) }, icon(p.state === "merged" ? "merged" : p.state === "closed" ? "closed" : "pr"), h("span", { class: "sr-only" }, p.draft ? t("pr.draft") : t(`pr.${p.state}`))),
    h("span", { class: "subj" }, h("span", { class: "num" }, `#${p.number}`), " ", p.title),
    h("span", { class: "badges" }, prBadges(p)),
    h("span", { class: "meta" }, h("span", null, short(p.repoName)), h("span", { class: "by" }, whoText(p)), h("span", { class: stale ? "warn" : "" }, stale ? `${when} · ${t("pr.updated", { ago: ago(p.updatedAt) })}` : when),
      lines(p.additions, p.deletions), p.labels.slice(0, 3).map((l) => h("span", { class: "label" }, l))));
}
let prNext = null;
async function loadPrs({ refresh = false } = {}) {
  for (const b of $$("[data-state]")) b.setAttribute("aria-pressed", String(b.dataset.state === state.prState));
  $("#pr-sort").value = state.prSort;
  if (!prList) prList = new VirtualList($("#pr-list"), { id: "p", label: t("pr.aria"), key: (p) => `${p.repo}#${p.number}`, render: prRow, onOpen: (p) => setState({ sel: `${p.repo}#${p.number}` }), onMore: () => morePrs() });
  let d;
  try { d = await get(`/api/prs?${q({ state: state.prState, sort: state.prSort })}`); } catch (e) { return failed($("#detail-pr"), e); }
  for (const [k, v] of Object.entries(d.counts)) { const el = $(`[data-state="${k}"] .n`); if (el) el.textContent = num(v, true); }
  prNext = d.next;
  const key = q({ state: state.prState, sort: state.prSort });
  if (changed("prs", [d.items.map((p) => [p.number, p.updatedAt, p.ci, p.review]), key])) {
    if (!(refresh && sigs.prsQuery === key && prList.el.scrollTop > 72)) prList.set(d.items, { total: null, hasMore: !!d.next, keepActive: refresh && sigs.prsQuery === key });
  }
  sigs.prsQuery = key;
  if (!d.items.length) prList.foot.textContent = t("list.empty");
  prList.select(state.sel);
  if (state.sel && /^\d+#/.test(state.sel)) openPr(state.sel); else showDetail(false, "pr");
}
async function morePrs() {
  if (!prNext) return;
  const d = await get(`/api/prs?${q({ state: state.prState, sort: state.prSort, cursor: prNext })}`).catch(() => null);
  if (!d) { prList.loading = false; return; }
  prNext = d.next;
  prList.append(d.items, !!d.next);
}
async function openPr(sel) {
  const [repo, number] = sel.split("#");
  const box = $("#detail-pr");
  if (box.dataset.sel === sel) { showDetail(true, "pr"); return; }
  box.dataset.sel = sel;
  const seq = ++openSeq;
  clear(box).append(backButton(), h("p", { class: "note" }, t("diff.loading")));
  showDetail(true, "pr");
  let p;
  try { p = await get(`/api/prs/${repo}/${number}`); } catch (e) { if (seq === openSeq) failed(box, e); return; }
  if (seq !== openSeq) return;
  const age = (p.mergedAt ?? p.closedAt ?? Date.now()) - p.createdAt;
  clear(box).append(
    backButton(),
    h("header", { class: "d-head" },
      h("h2", { id: "detail-title", tabindex: "-1" }, h("span", { class: "num" }, `#${p.number}`), " ", p.title),
      h("p", { class: "d-badges" }, h("span", { class: `badge state-${p.draft ? "draft" : p.state}` }, p.draft ? t("pr.draft") : t(`pr.${p.state}`)), prBadges(p)),
      h("p", { class: "d-who" }, avatar(p.author), h("strong", null, whoText(p)), whoBadge(p)),
      h("p", { class: "d-meta" }, h("span", null, p.repoName), h("span", { class: "br" }, t("pr.branches", { head: p.head ?? "?", base: p.base ?? "?" })),
        h("span", null, t("pr.age", { age: duration(age) })), h("span", null, t("pr.updated", { ago: ago(p.updatedAt) }))),
      p.labels.length ? h("p", { class: "d-labels" }, p.labels.map((l) => h("button", { type: "button", class: "label", onclick: () => setFilter({ label: l }) }, l))) : null,
      h("p", { class: "d-actions" }, p.files ? h("span", { class: "stat" }, t("commit.files", { n: p.filesTotal ?? p.files.length }), " ", lines(p.additions, p.deletions)) : null, ghLink(p.url ?? (me.webUrl ? `${me.webUrl}/${p.repoName}/pull/${p.number}` : null), t("commit.onGithub")))),
    p.commits?.length ? h("details", { class: "pr-commits" }, h("summary", null, `${t("pr.commits")} (${num(p.commits.length)})`),
      h("ul", null, p.commits.map((c) => h("li", null, h("button", { type: "button", class: "link", onclick: () => setState({ tab: "commits", sel: `${c.repo}:${c.sha}` }, { push: true }) }, c.subject), h("small", null, ` ${whoText(c)} · ${ago(c.at)}`))))) : null,
    h("div", { class: "files" }));
  drawFiles(box.querySelector(".files"), p);
  if (matchMedia("(max-width: 899px)").matches) $("#detail-title").focus();
}

// ---------------------------------------------------------------------------------------------------- story

async function loadStory() {
  let d;
  try { d = await get(`/api/story?${q()}`); } catch (e) { return failed($("#story"), e); }
  if (!changed("story", d)) return;
  const box = clear($("#story"));
  if (!d.days.length) { box.append(h("p", { class: "empty" }, t("story.empty"))); return; }
  for (const day of d.days) {
    const card = h("article", { class: "day" }, h("h3", null, dayWords(day.day, { weekday: "long", day: "numeric", month: "long" })));
    if (!day.commits) card.append(h("p", { class: "quiet" }, t("story.quiet")));
    else {
      card.append(h("p", { class: "lead" }, t("story.day", { commits: t("n.commits", { n: day.commits }), people: t("n.people", { n: day.people }), repos: t("n.repos", { n: day.repoCount }) })));
      if (day.agentCommits) card.append(h("p", { class: "agents" }, h("span", { class: "stack", "aria-hidden": "true" }, day.agents.map((a) => h("i", { class: fillOf(a.id), style: { flexGrow: a.commits } }))),
        t("story.agents", { share: pct(day.agentCommits / day.commits), list: day.agents.slice(0, 5).map((a) => `${a.name} ${num(a.commits)}`).join(", ") })));
      if (day.repos.length) card.append(h("p", null, t("story.busiest", { list: day.repos.map((r) => `${short(r.name)} (${num(r.commits)})`).join(", ") })));
    }
    if (day.mergedCount) {
      card.append(h("h4", null, t("story.merged", { n: day.mergedCount })),
        h("ul", { class: "merged" }, day.merged.map((p) => h("li", null, h("button", { type: "button", class: "link", onclick: () => setState({ tab: "prs", prState: "merged", sel: `${p.repo}#${p.number}` }, { push: true }) }, p.title),
          h("small", null, ` ${short(p.repoName)} · ${whoText(p)}`))), day.mergedCount > day.merged.length ? h("li", { class: "more" }, t("story.more", { n: day.mergedCount - day.merged.length })) : null));
    }
    if (day.deploysCount || day.releases.length) {
      card.append(h("ul", { class: "ships" },
        day.deploys.map((m) => h("li", { class: ["failure", "error"].includes(m.state) ? "bad" : "" }, icon(["failure", "error"].includes(m.state) ? "x" : "rocket"), `${["failure", "error"].includes(m.state) ? t("marker.failed") : t("marker.deploy")}: ${short(m.repoName)} → ${m.environment ?? ""} · ${dateTime(m.at).split(", ").pop()}`)),
        day.deploysCount > day.deploys.length ? h("li", { class: "more" }, t("story.more", { n: day.deploysCount - day.deploys.length })) : null,
        day.releases.map((m) => h("li", { class: "rel" }, icon("tag"), `${t("story.released")} ${short(m.repoName)} ${m.name ?? ""}`))));
    }
    box.append(card);
  }
}

// ---------------------------------------------------------------------------------------------------- status

let lastStatus = null;
async function status() {
  try { lastStatus = await get("/api/status"); } catch { return; }
  const s = lastStatus, now = Date.now();
  const pill = $("#status");
  const err = s.sync?.errors?.length;
  const waiting = s.sync?.waiting && s.sync.waiting.until > now;
  const live = s.webhookAt && now - s.webhookAt < 30 * 60_000;
  const [cls, text, title] = s.setup.mode === "demo" ? ["live", t("status.demo"), t("demo.banner")]
    : err ? ["bad", t("status.error"), s.sync.errors[0]]
    : waiting ? ["warn", t("status.waiting"), dateTime(s.sync.waiting.until)]
    : live ? ["live", t("status.live"), t("status.liveTitle", { ago: ago(s.webhookAt) })]
    : ["", t("status.polling"), t("status.pollingTitle")];
  pill.className = `status ${cls}`;
  pill.querySelector(".txt").textContent = text;
  pill.title = title;
}
function openStatus() {
  const s = lastStatus;
  const dlg = $("#status-dialog");
  const body = clear($("#status-body"));
  if (s) {
    const row = (k, v) => body.append(h("dt", null, k), h("dd", null, v));
    row(t("status.mode"), t(`status.mode.${s.setup.mode}`));
    row(t("status.repos"), num(s.repos));
    row(t("status.webhook"), s.webhookAt ? `${ago(s.webhookAt)} (${dateTime(s.webhookAt)})` : t("status.never"));
    row(t("status.sync"), s.sync?.at ? `${ago(s.sync.at)} · ${t("status.syncDetail", { repos: num(s.sync.repos ?? 0), ms: num(s.sync.ms ?? 0), requests: num(s.sync.requests ?? 0) })}` : t("status.never"));
    const rates = Object.entries(s.rate ?? {});
    if (rates.length) row(t("status.rate"), h("ul", null, rates.map(([k, v]) => h("li", null, t("status.rateLine", { resource: k === "core" ? "REST" : "GraphQL", remaining: num(v.remaining), limit: num(v.limit), at: dateTime(v.reset) })))));
    if (s.teamsNote) row(t("status.teams"), s.teamsNote);
    if (s.sync?.errors?.length) row(t("status.errors"), h("ul", null, s.sync.errors.map((e) => h("li", null, e))));
  }
  dlg.showModal();
}

// ---------------------------------------------------------------------------------------------------- refresh

function tick() {
  if (document.visibilityState !== "visible" || !me || me.setup || $("#app").hidden) return;
  if (document.querySelector(".picker")) return;
  if (state.tab === "overview") loadOverview();
  else if (state.tab === "commits") loadCommits({ refresh: true });
  else if (state.tab === "prs") loadPrs({ refresh: true });
}
setInterval(tick, 15_000);
setInterval(() => { if (document.visibilityState === "visible" && me && !me.setup) status(); }, 30_000);
setInterval(() => { if (document.visibilityState === "visible" && state.tab === "story") loadStory(); }, 60_000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") tick(); });
let resizeTimer;
addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state.tab === "overview") loadOverview(); }, 200); });

// ---------------------------------------------------------------------------------------------------- start

for (const el of $$("[data-t]")) el.textContent = t(el.dataset.t);
for (const el of $$("[data-t-label]")) el.setAttribute("aria-label", t(el.dataset.tLabel));
for (const el of $$("[data-t-placeholder]")) el.setAttribute("placeholder", t(el.dataset.tPlaceholder));
initTooltips();
initToolbar();
for (const b of $$("[data-group]")) b.addEventListener("click", () => setState({ group: b.dataset.group }));
for (const b of $$("[data-heat]")) b.addEventListener("click", () => setState({ heat: b.dataset.heat }));
for (const b of $$("[data-list]")) b.addEventListener("click", () => setState({ list: b.dataset.list, sel: "" }));
for (const b of $$("[data-state]")) b.addEventListener("click", () => setState({ prState: b.dataset.state, sel: "" }));
$("#pr-sort").addEventListener("change", (e) => setState({ prSort: e.target.value }));
$("#heat-table").addEventListener("click", () => { heatTable = !heatTable; loadHeat(); });
$("#status-close").addEventListener("click", () => $("#status-dialog").close());
boot();
