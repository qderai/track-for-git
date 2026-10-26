// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The Qubi view: is it set up (the key is shown only as "set" or "missing", never its value), on or off, what it spent
 * this week against the cap, its settings, "Run now", and the latest runs and findings. Everyone signed in can look;
 * only the people in QUBI_ADMINS can change anything (the server checks; the page only greys the controls out).
 */
import { clear, h, icon } from "./dom.js";
import { ago, dateTime, num, t } from "./i18n.js";

const MARK = { critical: "sev-critical", high: "sev-high", medium: "sev-medium", low: "sev-low" };
const money = (n) => { const v = Number(n || 0); return `$${v > 0 && v < 0.1 ? v.toFixed(3) : v.toFixed(2)}`; };
const DAYS = [0, 1, 2, 3, 4, 5, 6];

let data = null;
let busy = false;
let flash = null;   // { ok, text } after a save or a run

/** Draw (or redraw) the view into `box`. `at` builds this dashboard's own addresses. */
export async function loadQubi(box, at, { quiet = false } = {}) {
  // A refresh never throws away what someone is typing.
  if (quiet && (busy || box.contains(document.activeElement) && document.activeElement.matches("input, select"))) return;
  try {
    const r = await fetch(at("api/qubi"), { headers: { accept: "application/json" }, credentials: "same-origin" });
    if (!r.ok) throw new Error(String(r.status));
    data = await r.json();
    if (quiet) flash = null;   // a note after a save stays until the next refresh
  } catch {
    clear(box).append(h("p", { class: "note warn" }, t("error.load")));
    return;
  }
  draw(box, at);
}

async function send(at, path, body) {
  busy = true;
  try {
    const r = await fetch(at(path), { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, body: j } : { ok: false, text: j.error ?? `HTTP ${r.status}` };
  } catch { return { ok: false, text: t("error.load") }; }
  finally { busy = false; }
}

function draw(box, at) {
  const d = data;
  const s = d.settings;
  const edit = d.canEdit;
  const keyRow = d.demo ? t("qubi.demoKey") : d.keySet ? t("qubi.keySet", { provider: d.provider?.name ?? "" }) : t("qubi.keyMissing");
  const ghRow = d.demo ? "—" : d.github === "app" ? t("qubi.ghApp") : d.github === "token" ? t("qubi.ghToken") : t("qubi.ghMissing");
  const state = d.demo ? ["", t("qubi.state.demo")] : !d.ready ? ["warn", t("qubi.state.setup")] : !s.enabled ? ["", t("qubi.state.off")]
    : d.why ? ["warn", t("qubi.state.held")] : ["live", t("qubi.state.on")];
  const share = s.weekly_usd ? Math.min(1, d.spend.week / s.weekly_usd) : 0;

  const status = h("section", { class: "card qubi-status", "aria-labelledby": "h-qubi" },
    h("header", { class: "card-head" },
      h("h2", { id: "h-qubi" }, t("qubi.title")),
      h("span", { class: `status ${state[0]}` }, h("i", { "aria-hidden": "true" }), state[1]),
      edit && d.ready ? h("button", { type: "button", class: `btn sm ${s.enabled ? "ghost" : ""}`, onclick: () => save(box, at, { enabled: !s.enabled }) }, s.enabled ? t("qubi.switchOff") : t("qubi.switchOn")) : null),
    h("p", { class: "card-sub" }, t("qubi.intro")),
    h("dl", { class: "facts" },
      fact(t("qubi.key"), keyRow, d.keySet || d.demo),
      fact(t("qubi.github"), ghRow, !!d.github || d.demo),
      fact(t("qubi.week"), h("span", { class: "meter-row" }, h("span", { class: `meter ${share > 0.85 ? "hot" : ""}`, role: "img", "aria-label": t("qubi.spentOf", { spent: money(d.spend.week), cap: money(s.weekly_usd) }) }, h("i", { style: { width: `${Math.round(share * 100)}%` } })),
        t("qubi.spentOf", { spent: money(d.spend.week), cap: money(s.weekly_usd) }), " · ", t("qubi.runsN", { n: d.spend.runs }))),
      fact(t("qubi.today"), money(d.spend.today)),
      fact(t("qubi.tick"), d.lastTick ? ago(d.lastTick) : t("status.never"), d.ticking || d.demo || !d.ready),
      fact(t("qubi.nextHunt"), d.nextHunt ? t("qubi.nextHuntLine", { when: dateTime(d.nextHunt), at: s.hunt.at, tz: d.huntTz }) : t("qubi.noHunts"))),
    d.missing.length ? h("p", { class: "note warn" }, t("qubi.missing", { list: d.missing.join(", ") })) : null,
    d.why && d.ready && s.enabled ? h("p", { class: "note warn" }, d.why) : null,
    !edit ? h("p", { class: "note" }, sentence(d.editWhy)) : null,
    flash ? h("p", { class: `note ${flash.ok ? "good" : "warn"}`, role: "status" }, sentence(flash.text)) : null);

  clear(box).append(h("div", { class: "qubi-grid" }, status, settingsCard(box, at, d), runCard(box, at, d)), runsCard(d), findingsCard(d));
}

/** The server's short reasons ("only the people in …") as a sentence. */
const sentence = (s) => { const v = String(s ?? ""); return v ? `${v[0].toUpperCase()}${v.slice(1)}${/[.!?]$/.test(v) ? "" : "."}` : v; };
const fact = (k, v, ok = true) => [h("dt", null, k), h("dd", { class: ok ? "" : "warn" }, v)];

async function save(box, at, patch) {
  const r = await send(at, "api/qubi/settings", patch);
  flash = r.ok ? { ok: true, text: t("qubi.saved") } : { ok: false, text: r.text };
  await loadQubi(box, at);
}

function settingsCard(box, at, d) {
  const s = d.settings;
  const off = !d.canEdit;
  const models = d.provider?.models ?? [];
  const modelSelect = (name, value, fallback) => h("select", { name, disabled: off },
    h("option", { value: "" }, t("qubi.modelDefault", { name: models.find((m) => m.id === fallback)?.name ?? fallback ?? "" })),
    models.map((m) => h("option", { value: m.id, selected: m.id === value }, t("qubi.modelLine", { name: m.name, in: money(m.in), out: money(m.out) }))));
  const check = (name, on, label, hint) => h("label", { class: "check" }, h("input", { type: "checkbox", name, checked: on, disabled: off }), h("span", null, label, hint ? h("small", null, hint) : null));
  const numIn = (name, value, { step = "0.01", min = "0", max } = {}) => h("input", { class: "input", type: "number", name, value: String(value), step, min, max: max != null ? String(max) : undefined, disabled: off, inputmode: "decimal" });
  const field = (label, control, hint) => h("label", { class: "field" }, h("span", null, label), control, hint ? h("small", null, hint) : null);
  const allRepos = !s.repos.length;

  const form = h("form", { class: "qubi-form", onsubmit: (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const chosen = f.getAll("repo");
    const patch = {
      triggers: { pr: f.has("pr"), push: f.has("push") }, fix_prs: f.has("fix_prs"), post_clean: f.has("post_clean"),
      model: f.get("model"), hunt_model: f.get("hunt_model"), effort: f.get("effort"), min_severity: f.get("min_severity"),
      per_run_usd: Number(f.get("per_run_usd")), weekly_usd: Number(f.get("weekly_usd")),
      outside_runs_week: Number(f.get("outside_runs_week")), outside_weekly_usd: Number(f.get("outside_weekly_usd")), quiet_minutes: Number(f.get("quiet_minutes")),
      repos: f.get("scope") === "all" ? [] : chosen,
      hunt: { every: f.get("every"), at: f.get("at"), day: Number(f.get("day")), tz: String(f.get("tz") ?? "").trim() },
    };
    save(box, at, patch);
  } },
    h("fieldset", null, h("legend", null, t("qubi.reviews")),
      check("pr", s.triggers.pr, t("qubi.onPr")),
      check("push", s.triggers.push, t("qubi.onPush")),
      check("post_clean", s.post_clean, t("qubi.postClean")),
      check("fix_prs", s.fix_prs, t("qubi.fixPrs"), t("qubi.fixPrsHint"))),
    h("fieldset", null, h("legend", null, t("qubi.model")),
      field(t("qubi.reviewModel"), modelSelect("model", s.model, d.provider?.defaultModel)),
      field(t("qubi.huntModel"), modelSelect("hunt_model", s.hunt_model, d.provider?.defaultHuntModel)),
      field(t("qubi.effort"), h("select", { name: "effort", disabled: off }, ["low", "medium", "high"].map((v) => h("option", { value: v, selected: s.effort === v }, t(`qubi.effort.${v}`))))),
      field(t("qubi.minSeverity"), h("select", { name: "min_severity", disabled: off }, ["critical", "high", "medium", "low"].map((v) => h("option", { value: v, selected: s.min_severity === v }, t(`qubi.sev.${v}`)))), t("qubi.minSeverityHint"))),
    h("fieldset", null, h("legend", null, t("qubi.caps")),
      field(t("qubi.perRun"), numIn("per_run_usd", s.per_run_usd, { min: "0.01", max: d.ceilings.per_run_usd }), t("qubi.ceiling", { usd: money(d.ceilings.per_run_usd) })),
      field(t("qubi.perWeek"), numIn("weekly_usd", s.weekly_usd, { min: "0.01", max: d.ceilings.weekly_usd }), t("qubi.ceiling", { usd: money(d.ceilings.weekly_usd) })),
      field(t("qubi.outsideRuns"), numIn("outside_runs_week", s.outside_runs_week, { step: "1", max: 50 })),
      field(t("qubi.outsideUsd"), numIn("outside_weekly_usd", s.outside_weekly_usd, { max: s.weekly_usd }), t("qubi.outsideHint")),
      field(t("qubi.quiet"), numIn("quiet_minutes", s.quiet_minutes, { step: "1", max: 240 }), t("qubi.quietHint"))),
    h("fieldset", null, h("legend", null, t("qubi.hunts")),
      field(t("qubi.every"), h("select", { name: "every", disabled: off }, ["off", "day", "week"].map((v) => h("option", { value: v, selected: s.hunt.every === v }, t(`qubi.every.${v}`))))),
      field(t("qubi.day"), h("select", { name: "day", disabled: off }, DAYS.map((n) => h("option", { value: String(n), selected: s.hunt.day === n }, new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2026, 9, 25 + n)))))),
      field(t("qubi.at"), h("input", { class: "input", type: "time", name: "at", value: s.hunt.at, step: "60", disabled: off })),
      field(t("qubi.tz"), h("input", { class: "input", name: "tz", value: s.hunt.tz, placeholder: d.huntTz, autocomplete: "off", spellcheck: "false", disabled: off }))),
    h("fieldset", { class: "wide" }, h("legend", null, t("qubi.repos")),
      h("label", { class: "check" }, h("input", { type: "radio", name: "scope", value: "all", checked: allRepos, disabled: off }), h("span", null, t("qubi.allRepos", { n: d.repos.length }))),
      h("label", { class: "check" }, h("input", { type: "radio", name: "scope", value: "some", checked: !allRepos, disabled: off }), h("span", null, t("qubi.someRepos"))),
      h("div", { class: "repo-list" }, d.repos.map((r) => h("label", { class: "check" }, h("input", { type: "checkbox", name: "repo", value: r, checked: allRepos || s.repos.includes(r), disabled: off }), h("span", { class: "mono" }, r))))),
    d.canEdit ? h("p", { class: "actions" }, h("button", { type: "submit", class: "btn" }, t("qubi.save"))) : null);

  return h("section", { class: "card", "aria-labelledby": "h-qubi-set" }, h("header", { class: "card-head" }, h("h2", { id: "h-qubi-set" }, t("qubi.settings"))), form);
}

function runCard(box, at, d) {
  const s = d.settings;
  const off = !d.canEdit || !d.ready;
  let kind = "hunt";
  const extra = h("input", { class: "input", name: "focus", placeholder: t("qubi.focusHint"), autocomplete: "off", spellcheck: "false", disabled: off });
  const repo = h("select", { name: "repo", disabled: off }, h("option", { value: "all" }, t("qubi.allReposShort")), d.repos.filter((r) => !s.repos.length || s.repos.includes(r)).map((r) => h("option", { value: r }, r)));
  const seg = h("div", { class: "seg sm", role: "group", "aria-label": t("qubi.runKind") },
    ["hunt", "pr"].map((k) => h("button", { type: "button", "aria-pressed": String(k === kind), disabled: off, onclick: (e) => {
      kind = k;
      for (const b of seg.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
      extra.name = k === "hunt" ? "focus" : "pr";
      extra.placeholder = k === "hunt" ? t("qubi.focusHint") : t("qubi.prHint");
      extra.inputMode = k === "pr" ? "numeric" : "text";
      repo.firstChild.hidden = k === "pr";
      if (k === "pr" && repo.value === "all") repo.selectedIndex = 1;
    } }, t(`qubi.kind.${k}`))));
  const form = h("form", { class: "run-form", onsubmit: async (e) => {
    e.preventDefault();
    const targets = repo.value === "all" ? Math.max(1, repo.options.length - 1) : 1;
    if (!confirm(t("qubi.confirm", { usd: money(targets * s.per_run_usd), n: targets }))) return;
    const body = { kind, repo: repo.value, confirm: true, ...(kind === "hunt" ? { focus: extra.value } : { pr: Number(extra.value) }) };
    const r = await send(at, "api/qubi/run", body);
    flash = r.ok ? { ok: true, text: t("qubi.queued", { n: r.body.queued.length }) } : { ok: false, text: r.text };
    await loadQubi(box, at);
  } }, seg, h("label", { class: "field" }, h("span", null, t("qubi.repo")), repo), h("label", { class: "field" }, h("span", null, t("qubi.target")), extra),
    h("p", { class: "actions" }, h("button", { type: "submit", class: "btn", disabled: off }, t("qubi.run", { usd: money(s.per_run_usd) }))));
  return h("section", { class: "card", "aria-labelledby": "h-qubi-run" }, h("header", { class: "card-head" }, h("h2", { id: "h-qubi-run" }, t("qubi.runNow"))),
    h("p", { class: "card-sub" }, t("qubi.runSub")), form);
}

const link = (url, text, bare = text) => (url && /^https:\/\//.test(url) ? h("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, text, " ", icon("external")) : bare);
const target = (j) => (j.kind === "pr" ? `#${j.pr}` : j.kind === "push" ? `${String(j.base ?? "").slice(0, 7)}…${String(j.head ?? "").slice(0, 7)}` : j.focus ? j.focus : t("qubi.wholeRepo"));

function runsCard(d) {
  const rows = d.jobs.map((j) => h("tr", null,
    h("td", { title: dateTime(j.created_at) }, ago(j.started_at ?? j.created_at)),
    h("td", null, t(`qubi.kind.${j.kind}`), j.requested_by ? h("small", null, ` · ${j.requested_by}`) : null),
    h("td", { class: "mono" }, j.repo.split("/").pop(), " ", h("small", null, target(j))),
    h("td", null, h("span", { class: `badge st-${j.status}`, title: j.note || undefined }, t(`qubi.st.${j.status}`)), j.note ? h("small", { class: "why" }, j.note) : null),
    h("td", { class: "num" }, money(j.cost_usd)),
    h("td", { class: "num" }, num(j.findings), j.fix_prs ? h("small", null, ` · ${t("qubi.fixes", { n: j.fix_prs })}`) : null),
    h("td", null, link(j.posted_url, t("qubi.onGithub"), null))));
  return h("section", { class: "card", "aria-labelledby": "h-qubi-runs" }, h("header", { class: "card-head" }, h("h2", { id: "h-qubi-runs" }, t("qubi.runs"))),
    rows.length ? h("div", { class: "table-wrap" }, h("table", { class: "runs" },
      h("thead", null, h("tr", null, ["when", "kind", "repo", "status", "cost", "found", "link"].map((k) => h("th", { scope: "col", class: ["cost", "found"].includes(k) ? "num" : "" }, t(`qubi.col.${k}`))))),
      h("tbody", null, rows))) : h("p", { class: "empty" }, t("qubi.noRuns")));
}

function findingsCard(d) {
  const items = d.findings.map((f) => h("li", null,
    h("span", { class: `sev ${MARK[f.severity] ?? ""}` }, t(`qubi.sev.${f.severity}`)),
    h("span", { class: "f-main" }, h("strong", null, f.title),
      h("small", null, link(f.url, `${f.repo.split("/").pop()} ${f.path ?? ""}${f.line ? `:${f.line}` : ""}`), " · ", t(f.kind === "security" ? "qubi.security" : "qubi.bug"), " · ", ago(f.created_at),
        f.fix_url ? [" · ", link(f.fix_url, t("qubi.fixPr"))] : null))));
  return h("section", { class: "card", "aria-labelledby": "h-qubi-found" }, h("header", { class: "card-head" }, h("h2", { id: "h-qubi-found" }, t("qubi.findings"))),
    items.length ? h("ul", { class: "findings" }, items) : h("p", { class: "empty" }, t("qubi.noFindings")));
}
