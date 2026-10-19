// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The three pictures: the timeline (lanes of bars, each bar split by who made the commits, with deploys and releases
 * above), the heatmap (rows by day), and "who wrote the code" (bars by person, agent, bot). Colours are CSS classes
 * (f-s1 … f-s8, f-bot, h0 … h5) so light and dark themes each use their own validated steps. Every mark has a
 * tooltip; the timeline is keyboard-navigable; the heatmap has a table view.
 */
import { clear, h, s } from "./dom.js";
import { clock, dayMonth, dayShort, dayWords, dateTime, num, pct, t, timeZone } from "./i18n.js";
import { clusterMarkers, heatStep, slotOf, stackOf } from "./lib.js";

const HOUR = 3_600_000, DAY = 86_400_000;

/** The name of a who ("~human", "~bot", "~other" or an agent id). */
export function whoName(who, names = {}) {
  if (who === "~human") return t("who.human");
  if (who === "~bot") return t("who.bot");
  if (who === "~other") return t("who.other");
  return names[who] ?? who.replace(/^x-/, "").replace(/-/g, " ");
}
export const fillOf = (who) => { const sl = slotOf(who); return sl === "bot" ? "f-bot" : `f-s${sl}`; };

// One formatter per zone: the zone shown can change after the page starts (the TIME_ZONE setting, from /api/me).
const hourFmts = new Map();
const hourOf = (at) => {
  const zone = timeZone();
  let f = hourFmts.get(zone);
  if (!f) { f = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }); hourFmts.set(zone, f); }
  return Number(f.format(at));
};

/** Tick instants in the viewer's zone: every 3 hours for a day, midnights for a week, weekly or fortnightly beyond. */
function ticks(from, to) {
  const days = (to - from) / DAY;
  const out = [];
  for (let at = Math.ceil(from / HOUR) * HOUR; at < to; at += HOUR) {
    const hr = hourOf(at);
    if (days <= 1.01 ? hr % 3 === 0 : hr === 0) out.push(at);
  }
  if (days > 31.5) return out.filter((_, i) => i % 14 === 0);
  if (days > 7.5) return out.filter((_, i) => i % 7 === 0);
  return out;
}
const tickLabel = (at, from, to) => ((to - from) / DAY <= 1.01 ? clock(at) : (to - from) / DAY <= 7.5 ? dayShort(at) : dayMonth(at));

/**
 * The timeline.
 * @param {HTMLElement} box
 * @param {{ group: string, binMs: number, lanes: any[], bins: any[] }} tl
 * @param {{ from: number, to: number, markers: any[], names: Record<string,string>, onPick: (lane: any, t0: number, t1: number) => void, selected?: string }} o
 */
export function drawTimeline(box, tl, o) {
  clear(box);
  if (!tl.lanes.length) { box.append(h("p", { class: "empty" }, t("timeline.empty"))); return; }
  const labelW = Math.min(176, Math.max(box.clientWidth < 500 ? 92 : 112, Math.round(box.clientWidth * 0.16)));
  const W = Math.max(520, (box.clientWidth || 900) - labelW - 8);
  const L = 6, R = 10, laneH = 44, now = Date.now();
  const x = (at) => L + ((at - o.from) / (o.to - o.from)) * (W - L - R);
  const tk = ticks(o.from, o.to);
  const org = tl.group === "repo" ? commonOrg(tl.lanes.map((l) => l.label)) : null;
  const laneName = (l) => (l.key === "~rest" ? t("timeline.restLabel") : l.key === "~none" ? t("timeline.noTeam") : org ? l.label.slice(org.length + 1) : l.label);
  const grid = h("div", { class: "tl", style: { "--label-w": `${labelW}px` } });

  // The axis.
  const axis = s("svg", { width: W, height: 22, viewBox: `0 0 ${W} 22`, "aria-hidden": "true" },
    tk.map((at) => s("text", { x: x(at), y: 15, "text-anchor": "middle", class: "ax" }, tickLabel(at, o.from, o.to))));
  grid.append(h("div", { class: "tl-label" }), h("div", { class: "tl-plot" }, axis));

  // Deploys and releases, clustered when they would overlap.
  const markers = (o.markers ?? []).filter((m) => m.kind !== "tag" && m.at >= o.from && m.at < o.to);
  const clusters = clusterMarkers(markers, x, 22);
  const mk = s("svg", { width: W, height: 26, viewBox: `0 0 ${W} 26`, role: "img", "aria-label": `${t("timeline.markersLong")}: ${t("n.deploys", { n: markers.filter((m) => m.kind === "deploy").length })}, ${t("n.releases", { n: markers.filter((m) => m.kind === "release").length })}` });
  for (const c of clusters) {
    const bad = c.items.some((m) => m.kind === "deploy" && ["failure", "error"].includes(m.state));
    const rel = c.items.every((m) => m.kind === "release");
    const cx = c.x, cy = 13;
    const shape = rel ? s("path", { d: `M${cx} ${cy - 6} l6 6 -6 6 -6 -6z`, class: "mk-release" })
      : s("path", { d: `M${cx - 6} ${cy + 5} L${cx} ${cy - 6} L${cx + 6} ${cy + 5}z`, class: bad ? "mk-bad" : "mk-deploy" });
    const g = s("g", { class: "mk", tip: [c.items.length > 1 ? `${c.items.length} · ${t("timeline.markersLong")}` : markerKind(c.items[0]), ...c.items.slice(0, 8).map(markerLine), c.items.length > 8 ? t("filter.more", { n: c.items.length - 8 }) : null] }, shape);
    if (c.items.length > 1) g.append(s("text", { x: cx + 8, y: cy + 4, class: "mk-n" }, String(c.items.length)));
    mk.append(g);
  }
  grid.append(h("div", { class: "tl-label tl-mk" }, t("timeline.markers")), h("div", { class: "tl-plot" }, mk));

  // The lanes.
  const max = Math.max(1, ...tl.bins.map((b) => b.n));
  const lanes = tl.lanes.map((l) => ({ ...l, bins: tl.bins.filter((b) => b.lane === l.key) }));
  const all = [];
  for (const lane of lanes) {
    const svg = s("svg", { width: W, height: laneH, viewBox: `0 0 ${W} ${laneH}`, role: "group", "aria-label": laneName(lane) });
    for (const at of tk) svg.append(s("line", { x1: x(at), x2: x(at), y1: 0, y2: laneH, class: "grid" }));
    for (const c of clusters) svg.append(s("line", { x1: c.x, x2: c.x, y1: 0, y2: laneH, class: c.items.every((m) => m.kind === "release") ? "guide rel" : "guide" }));
    svg.append(s("line", { x1: 0, x2: W, y1: laneH - 4.5, y2: laneH - 4.5, class: "base" }));
    for (const b of lane.bins) {
      const x0 = x(b.t), x1 = x(b.t + tl.binMs);
      const bw = Math.max(2, Math.min(24, x1 - x0 - 2));
      const bx = (x0 + x1) / 2 - bw / 2;
      const full = laneH - 12;
      const hgt = Math.max(3, Math.sqrt(b.n / max) * full);
      const parts = stackOf(b.who);
      let y = laneH - 5;
      const g = s("g", { class: "bin", role: "button", tabindex: "-1", "data-key": `${lane.key}|${b.t}` });
      g.append(s("rect", { class: "hit", x: Math.max(0, x0), y: 2, width: Math.max(4, x1 - x0), height: laneH - 6, rx: 3 }));
      parts.forEach(([who, n], i) => {
        const sh = (hgt * n) / b.n;
        y -= sh;
        const gap = i < parts.length - 1 && sh > 2 ? 1 : 0;
        g.append(s("rect", { class: fillOf(who), x: bx, y: y + gap, width: bw, height: Math.max(0.5, sh - gap), rx: i === parts.length - 1 ? 1.5 : 0 }));
      });
      const when = spanText(b.t, b.t + tl.binMs);
      const whoText = parts.map(([w, n]) => `${whoName(w, o.names)} ${num(n)}`).join(", ");
      g.setAttribute("aria-label", t("timeline.bar", { lane: laneName(lane), when, count: t("n.commits", { n: b.n }), who: whoText }));
      g.__tip = [laneName(lane), `${when} · ${t("n.commits", { n: b.n })}`, ...parts.map(([w, n]) => `${whoName(w, o.names)}: ${num(n)}`)];
      g.__pick = () => o.onPick(lane, b.t, b.t + tl.binMs);
      svg.append(g);
      all.push({ g, lane: lane.key, t: b.t });
    }
    if (now >= o.from && now < o.to) svg.append(s("line", { x1: x(now), x2: x(now), y1: 0, y2: laneH, class: "now" }));
    const label = h("div", { class: "tl-label", title: lane.label ?? "" }, laneName(lane), h("small", null, ` ${num(lane.total, true)}`));
    grid.append(label, h("div", { class: "tl-plot" }, svg));
  }
  const wrap = h("div", { class: "tl-scroll", role: "region", tabindex: "-1", "aria-label": t("timeline.aria", { group: t(`timeline.by${o.group === "person" ? "Person" : o.group === "team" ? "Team" : "Repo"}`).toLowerCase() }) }, grid);
  box.append(wrap, h("p", { class: "note" }, t("timeline.scale")));

  // One tab stop for every bar; the arrows move along a lane and between lanes; Enter or a click lists its commits.
  const start = all.find((b) => b.g.dataset.key === o.selected) ?? all.at(-1);
  if (start) start.g.setAttribute("tabindex", "0");
  const order = lanes.map((l) => l.key);
  grid.addEventListener("click", (e) => { const g = e.target.closest?.(".bin"); if (g?.__pick) g.__pick(); });
  grid.addEventListener("keydown", (e) => {
    const g = e.target.closest?.(".bin");
    if (!g) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); g.__pick(); return; }
    const cur = all.find((b) => b.g === g);
    const mine = all.filter((b) => b.lane === cur.lane);
    const i = mine.indexOf(cur);
    let next = null;
    if (e.key === "ArrowRight") next = mine[i + 1];
    else if (e.key === "ArrowLeft") next = mine[i - 1];
    else if (e.key === "Home") next = mine[0];
    else if (e.key === "End") next = mine.at(-1);
    else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const dir = e.key === "ArrowUp" ? -1 : 1;
      for (let li = order.indexOf(cur.lane) + dir; li >= 0 && li < order.length && !next; li += dir) {
        const other = all.filter((b) => b.lane === order[li]);
        if (other.length) next = other.reduce((a, b) => (Math.abs(b.t - cur.t) < Math.abs(a.t - cur.t) ? b : a));
      }
    } else return;
    e.preventDefault();
    if (!next) return;
    g.setAttribute("tabindex", "-1");
    next.g.setAttribute("tabindex", "0");
    next.g.focus();
  });
}

const markerKind = (m) => (m.kind === "release" ? t("marker.release") : m.kind === "tag" ? t("marker.tag") : ["failure", "error"].includes(m.state) ? t("marker.failed") : t("marker.deploy"));
const markerLine = (m) => t("marker.line", { kind: markerKind(m), name: m.name ?? m.environment ?? "", repo: m.repoName, when: dateTime(m.at) });
export const spanText = (a, b) => t("time.span", { from: dateTime(a), to: clock(b) });

/** The org every label shares ("acme" for acme/api, acme/web), or null. */
function commonOrg(labels) {
  const owners = new Set(labels.filter(Boolean).map((l) => l.split("/")[0]));
  return owners.size === 1 ? [...owners][0] : null;
}

// ---------------------------------------------------------------------------------------------------- heatmap

/**
 * The heatmap: one row per repository, person or team, one column per day (or hour), five steps of one blue.
 * @param {{ by: string, unit: string, cols: any[], rows: any[], cells: number[][] }} hm
 */
export function drawHeatmap(box, hm, { table = false, onPick } = {}) {
  clear(box);
  if (!hm.rows.length) { box.append(h("p", { class: "empty" }, t("heat.empty"))); return; }
  const colLabel = (c) => (hm.unit === "hour" ? `${dayShort(c)} ${clock(c)}` : dayWords(c, { weekday: "short", day: "numeric", month: "short" }));
  const org = hm.by === "repo" ? commonOrg(hm.rows.map((r) => r.label)) : null;
  const rowName = (r) => (r.key === "~none" ? t("timeline.noTeam") : org ? r.label.slice(org.length + 1) : r.label);
  const value = new Map(hm.cells.map(([ri, ci, n]) => [`${ri}|${ci}`, n]));
  const max = Math.max(1, ...hm.cells.map((c) => c[2]));

  if (table) {
    const tbl = h("table", { class: "data" },
      h("caption", { class: "sr-only" }, t("heat.title")),
      h("thead", null, h("tr", null, h("th", { scope: "col" }, t(`timeline.by${hm.by === "person" ? "Person" : hm.by === "team" ? "Team" : "Repo"}`)), hm.cols.map((c) => h("th", { scope: "col" }, colLabel(c))))),
      h("tbody", null, hm.rows.map((r, ri) => h("tr", null, h("th", { scope: "row" }, rowName(r)), hm.cols.map((_, ci) => h("td", null, num(value.get(`${ri}|${ci}`) ?? 0)))))));
    box.append(h("div", { class: "table-scroll", tabindex: "0", role: "region", "aria-label": t("heat.title") }, tbl));
    return;
  }

  const labelW = Math.min(176, Math.max(104, Math.round(box.clientWidth * 0.16)));
  const avail = Math.max(300, (box.clientWidth || 800) - labelW - 8);
  const gap = 2;
  const cw = Math.max(7, Math.min(72, Math.floor(avail / hm.cols.length) - gap));
  const ch = 20;
  const W = hm.cols.length * (cw + gap);
  const grid = h("div", { class: "hm", style: { "--label-w": `${labelW}px` } });
  // Column labels: a few, never crowded.
  const every = Math.max(1, Math.ceil(46 / (cw + gap)));
  const head = s("svg", { width: W, height: 20, viewBox: `0 0 ${W} 20`, "aria-hidden": "true" },
    hm.cols.map((c, i) => (i % every === 0 ? s("text", { x: i * (cw + gap), y: 14, class: "ax" }, hm.unit === "hour" ? clock(c) : dayWords(c, { day: "numeric", month: "short" })) : null)));
  grid.append(h("div", { class: "hm-label" }), h("div", null, head));
  hm.rows.forEach((r, ri) => {
    const svg = s("svg", { width: W, height: ch, viewBox: `0 0 ${W} ${ch}`, "aria-hidden": "true" });
    hm.cols.forEach((c, ci) => {
      const n = value.get(`${ri}|${ci}`) ?? 0;
      const rect = s("rect", { x: ci * (cw + gap), y: 1, width: cw, height: ch - 2, rx: 3, class: `h${heatStep(n, max)}` });
      rect.__tip = [rowName(r), `${colLabel(c)}: ${t("n.commits", { n })}`];
      if (onPick && n) { rect.classList.add("pick"); rect.__pick = () => onPick(r, c, hm.unit); }
      svg.append(rect);
    });
    grid.append(h("div", { class: "hm-label", title: r.label }, rowName(r), h("small", null, ` ${num(r.total, true)}`)), h("div", null, svg));
  });
  grid.addEventListener("click", (e) => { if (e.target.__pick) e.target.__pick(); });
  const legend = h("div", { class: "hm-legend", "aria-hidden": "true" }, h("span", null, t("heat.less")), [1, 2, 3, 4, 5].map((i) => h("i", { class: `h${i}` })), h("span", null, t("heat.more")));
  const total = hm.rows.reduce((a, r) => a + r.total, 0);
  box.append(h("div", { class: "hm-scroll", role: "img", tabindex: "0", "aria-label": `${t("heat.title")}: ${t("n.commits", { n: total })}. ${t("heat.table")}.` }, grid), legend);
}

// ---------------------------------------------------------------------------------------------------- who

/** "Who wrote the code": one bar per person-alone / agent / bots, longest first. */
export function drawWho(box, rows, { names = {}, total, onPick, active = [] } = {}) {
  clear(box);
  if (!rows.length || !total) { box.append(h("p", { class: "empty" }, t("timeline.empty"))); return; }
  const max = Math.max(...rows.map((r) => r.commits));
  const list = h("ul", { class: "who" });
  for (const r of rows) {
    const name = r.id === "~human" ? t("who.humanAlone") : whoName(r.id, { ...names, [r.id]: r.name ?? names[r.id] });
    const share = r.commits / total;
    const filterId = r.id === "~human" ? "human" : r.id === "~bot" ? "bot" : r.id;
    const pressed = active.includes(filterId);
    list.append(h("li", null, h("button", { type: "button", class: "who-row", "aria-pressed": String(pressed), "aria-label": `${t("who.row", { name, count: t("n.commits", { n: r.commits }), share: pct(share) })}. ${t("who.filter", { name })}`, onclick: () => onPick?.(filterId) },
      h("span", { class: "who-name" }, h("i", { class: `sw ${fillOf(r.id)}`, "aria-hidden": "true" }), name),
      h("span", { class: "who-bar", "aria-hidden": "true" }, h("i", { class: fillOf(r.id), style: { width: `${Math.max(1.5, (r.commits / max) * 100)}%` } })),
      h("span", { class: "who-n" }, num(r.commits), h("small", null, pct(share))))));
  }
  box.append(list);
}

/** The legend of who appears in the data, in stack order, plus the markers. */
export function drawLegend(box, whos, names) {
  clear(box);
  const seen = new Set(whos);
  for (const k of ["~human", "claude", "codex", "grok", "copilot", "gemini", "cursor", "~other", "~bot"]) {
    if (!seen.has(k)) continue;
    box.append(h("li", null, h("i", { class: `sw ${fillOf(k)}`, "aria-hidden": "true" }), whoName(k, names)));
  }
  box.append(
    h("li", null, s("svg", { class: "sw-mk", viewBox: "0 0 12 12", "aria-hidden": "true" }, s("path", { d: "M0 11 L6 0 L12 11z", class: "mk-deploy" })), t("marker.deploy")),
    h("li", null, s("svg", { class: "sw-mk", viewBox: "0 0 12 12", "aria-hidden": "true" }, s("path", { d: "M6 0 l6 6 -6 6 -6 -6z", class: "mk-release" })), t("marker.release")),
  );
}

