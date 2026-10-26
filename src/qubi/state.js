// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Qubi's settings and work queue, in the dashboard's own database (migrations/0002_qubi.sql). The caps are enforced
 * here, on the server, before any paid run starts: a run stops at per_run_usd, no run starts when the last 7 days'
 * runs plus one more could pass weekly_usd, and pull requests from outside the organisation have an allowance of their
 * own so strangers cannot spend the week's budget. Whatever the page sends, the caps never go past the ceilings the
 * operator set in the environment (QUBI_MAX_RUN_USD, QUBI_MAX_WEEK_USD): a typo cannot spend $500.
 */
import { getState, setState } from "../db.js";
import { validTz } from "../time.js";

const DAY = 86_400_000;
export const SEVERITIES = ["critical", "high", "medium", "low"];
const KINDS = ["pr", "push", "hunt"];

export const DEFAULTS = {
  enabled: false,
  // What Qubi reviews on its own. Bug hunts run only on the schedule or from "Run now".
  triggers: { pr: true, push: true },
  // Full names; empty means every repository the dashboard watches.
  repos: [],
  model: "",              // reviews; "" is the provider's default
  hunt_model: "",         // bug hunts; "" is the provider's default for hunts
  effort: "medium",       // low | medium | high: how hard the model thinks (and how much of the cap it spends doing so)
  per_run_usd: 0.25,
  weekly_usd: 5,
  outside_runs_week: 3,   // reviews per outside author per 7 days
  outside_weekly_usd: 1,  // all outside authors together per 7 days
  quiet_minutes: 10,      // the branch must be quiet this long before a push is reviewed (a burst is one review)
  min_severity: "medium", // findings below it are neither posted nor kept
  post_clean: true,       // a pull request with nothing found gets a short "no issues" review
  fix_prs: false,         // open a pull request with the fix for a finding Qubi is sure of (never for outside authors)
  hunt: { every: "off", at: "09:00", day: 1, tz: "" },   // every: off | day | week; day 0 (Sunday) … 6
  paused_until: null,     // ISO time; nothing paid starts before it
};

/** The ceilings the page cannot pass, from the environment. */
export function ceilings(cfg) {
  return { per_run_usd: cfg.qubi?.maxRunUsd ?? 2, weekly_usd: cfg.qubi?.maxWeekUsd ?? 50 };
}

const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;    // owner/name, no part made of dots alone
const money = (v) => Math.round(Number(v) * 100) / 100;

/** Pure. A settings patch made safe: known keys, the right types, caps inside the ceilings. The error, or the patch. */
export function cleanPatch(p, ceil) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { error: "a settings object is needed" };
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    switch (k) {
      case "enabled": case "post_clean": case "fix_prs":
        if (typeof v !== "boolean") return { error: `${k} is true or false` };
        out[k] = v; break;
      case "triggers": {
        if (!v || typeof v !== "object" || !Object.entries(v).every(([t, b]) => ["pr", "push"].includes(t) && typeof b === "boolean")) return { error: "triggers are pr and push, true or false" };
        out.triggers = { ...v };   // merged into the current ones by saveSettings
        break;
      }
      case "repos":
        if (!Array.isArray(v) || v.length > 200 || !v.every((r) => typeof r === "string" && REPO.test(r))) return { error: "repos is a list of owner/name" };
        out.repos = [...new Set(v.map((r) => r.toLowerCase()))]; break;
      case "model": case "hunt_model":
        if (typeof v !== "string" || !/^[\w.:/-]{0,80}$/.test(v)) return { error: `${k} is a model name` };
        out[k] = v; break;
      case "effort":
        if (!["low", "medium", "high"].includes(v)) return { error: "effort is low, medium or high" };
        out.effort = v; break;
      case "per_run_usd": case "weekly_usd": {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0.01 || n > ceil[k]) return { error: `${k} is at least $0.01 and at most $${ceil[k]}` };
        out[k] = money(n); break;
      }
      case "outside_weekly_usd": {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > ceil.weekly_usd) return { error: `outside_weekly_usd is 0 to $${ceil.weekly_usd}` };
        out[k] = money(n); break;
      }
      case "outside_runs_week": case "quiet_minutes": {
        const n = Number(v), max = k === "quiet_minutes" ? 240 : 50;
        if (!Number.isInteger(n) || n < 0 || n > max) return { error: `${k} is a whole number from 0 to ${max}` };
        out[k] = n; break;
      }
      case "min_severity":
        if (!SEVERITIES.includes(v)) return { error: `min_severity is one of ${SEVERITIES.join(", ")}` };
        out.min_severity = v; break;
      case "hunt": {
        if (!v || typeof v !== "object") return { error: "hunt is { every, at, day, tz }" };
        const h = {};
        if (v.every !== undefined) { if (!["off", "day", "week"].includes(v.every)) return { error: "hunt.every is off, day or week" }; h.every = v.every; }
        if (v.at !== undefined) { if (typeof v.at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.at)) return { error: "hunt.at is HH:MM" }; h.at = v.at; }
        if (v.day !== undefined) { if (!Number.isInteger(v.day) || v.day < 0 || v.day > 6) return { error: "hunt.day is 0 (Sunday) to 6" }; h.day = v.day; }
        if (v.tz !== undefined) { if (typeof v.tz !== "string" || (v.tz && !validTz(v.tz))) return { error: "hunt.tz is a time zone such as Europe/Berlin" }; h.tz = v.tz; }
        out.hunt = h; break;
      }
      case "paused_until":
        if (v !== null && (typeof v !== "string" || Number.isNaN(Date.parse(v)))) return { error: "paused_until is a time or null" };
        out.paused_until = v === null ? null : new Date(v).toISOString(); break;
      default: return { error: `unknown setting ${k}` };
    }
  }
  return { patch: out };
}

export async function getSettings(store, ceil) {
  const rows = await store.all("SELECT key, value FROM qubi_settings");
  const s = structuredClone(DEFAULTS);
  for (const r of rows) {
    if (!(r.key in DEFAULTS)) continue;
    try {
      const v = JSON.parse(r.value);
      s[r.key] = typeof DEFAULTS[r.key] === "object" && DEFAULTS[r.key] && !Array.isArray(DEFAULTS[r.key]) ? { ...DEFAULTS[r.key], ...v } : v;
    } catch { /* the default stays */ }
  }
  // Even a row written by hand, or a ceiling lowered later, cannot lift the caps past the ceilings.
  s.per_run_usd = Math.min(Number(s.per_run_usd) || DEFAULTS.per_run_usd, ceil.per_run_usd);
  s.weekly_usd = Math.min(Number(s.weekly_usd) || DEFAULTS.weekly_usd, ceil.weekly_usd);
  s.outside_weekly_usd = Math.min(Math.max(Number(s.outside_weekly_usd) || 0, 0), s.weekly_usd);
  return s;
}

export async function saveSettings(store, patch, who, ceil, now = Date.now()) {
  const before = await getSettings(store, ceil);
  const merged = { ...patch };
  if (patch.triggers) merged.triggers = { ...before.triggers, ...patch.triggers };
  if (patch.hunt) merged.hunt = { ...before.hunt, ...patch.hunt };
  await store.batch(Object.entries(merged).map(([k, v]) => ({
    sql: "INSERT INTO qubi_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    binds: [k, JSON.stringify(v), now, who],
  })));
  await logChange(store, who, "settings", JSON.stringify(patch), now);
  return getSettings(store, ceil);
}

export const logChange = (store, who, action, detail, now = Date.now()) =>
  store.run("INSERT INTO qubi_log (at, who, action, detail) VALUES (?, ?, ?, ?)", now, String(who).slice(0, 200), action, String(detail).slice(0, 2000));

/** What runs cost in the last 7 days and since midnight UTC, every kind together. A failed run's cost counts too. */
export async function spend(store, now = Date.now()) {
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const r = await store.first(`SELECT COALESCE(SUM(cost_usd), 0) AS week, COALESCE(SUM(CASE WHEN started_at >= ? THEN cost_usd ELSE 0 END), 0) AS today, COUNT(*) AS runs
    FROM qubi_jobs WHERE started_at >= ? AND status IN ('done', 'failed', 'running')`, day.getTime(), now - 7 * DAY);
  return { week: Number(r?.week ?? 0), today: Number(r?.today ?? 0), runs: Number(r?.runs ?? 0) };
}

/** Pure. May a paid run start now? */
export function mayRun(s, weekSpent, now = Date.now()) {
  if (!s.enabled) return { ok: false, why: "Qubi is switched off" };
  if (s.paused_until && Date.parse(s.paused_until) > now) return { ok: false, why: `paused until ${s.paused_until}` };
  if (weekSpent + s.per_run_usd > s.weekly_usd + 1e-9) return { ok: false, why: `weekly cap: $${weekSpent.toFixed(2)} of $${s.weekly_usd} spent in 7 days` };
  return { ok: true };
}

/** An outside author's reviews this week, and what every outside author's reviews cost together; `except` is the job being checked. */
export async function outsideUsage(store, author, now = Date.now(), except = 0) {
  const since = now - 7 * DAY;
  const a = await store.first("SELECT COUNT(*) AS n FROM qubi_jobs WHERE kind = 'pr' AND trusted = 0 AND author = ? AND started_at >= ? AND status IN ('done', 'failed', 'running') AND id <> ?", author, since, except);
  const t = await store.first("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM qubi_jobs WHERE kind = 'pr' AND trusted = 0 AND started_at >= ? AND id <> ?", since, except);
  return { authorRuns: Number(a?.n ?? 0), spent: Number(t?.usd ?? 0) };
}

/** Pure. May this outside author's pull request be reviewed? Counted before this run starts. */
export function outsideOk(s, u) {
  if (u.authorRuns >= s.outside_runs_week) return { ok: false, why: `outside author: ${s.outside_runs_week} reviews a week` };
  if (u.spent + s.per_run_usd > s.outside_weekly_usd + 1e-9) return { ok: false, why: `outside authors: $${s.outside_weekly_usd} a week` };
  return { ok: true };
}

/** A pull request head, once (the unique index drops a redelivery). True when it was new. */
export async function queuePr(store, j, now = Date.now()) {
  const r = await store.run("INSERT OR IGNORE INTO qubi_jobs (kind, repo, pr, head, title, author, trusted, due_at, created_at) VALUES ('pr', ?, ?, ?, ?, ?, ?, ?, ?)",
    j.repo, j.pr, j.head, String(j.title ?? "").slice(0, 300), j.author, j.trusted ? 1 : 0, now, now);
  return r.changes > 0;
}

/** A push to the default branch: the repository's waiting push grows to the new head and waits quiet_minutes again. */
export async function queuePush(store, j, quietMinutes, now = Date.now()) {
  const due = now + quietMinutes * 60_000;
  const open = await store.first("SELECT id FROM qubi_jobs WHERE kind = 'push' AND repo = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", j.repo);
  if (open) { await store.run("UPDATE qubi_jobs SET head = ?, due_at = ? WHERE id = ?", j.head, due, open.id); return "extended"; }
  await store.run("INSERT INTO qubi_jobs (kind, repo, base, head, author, due_at, created_at) VALUES ('push', ?, ?, ?, ?, ?, ?)", j.repo, j.before, j.head, j.author, due, now);
  return "new";
}

/** A bug hunt (scheduled or "Run now"), or a pull request asked for again from "Run now". */
export async function queueRun(store, j, now = Date.now()) {
  const r = await store.first("INSERT INTO qubi_jobs (kind, repo, pr, head, focus, requested_by, model, trusted, due_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id",
    j.kind, j.repo, j.pr ?? null, j.head ?? null, j.focus ?? null, j.who ?? null, j.model ?? null, now, now);
  return Number(r?.id ?? 0);
}

/**
 * The oldest due job, claimed in one statement that also checks nothing else runs: two ticks never run two jobs at
 * once, so each cap check sees every earlier run. A run with no sign of life for STALE_MS died (a cron is cut off after
 * 15 minutes): it fails first, keeping the cost it wrote. Every model call is a sign of life (setJobCost).
 */
export const STALE_MS = 16 * 60_000;
export async function claimJob(store, now = Date.now()) {
  await store.run("UPDATE qubi_jobs SET status = 'failed', note = 'timed out', finished_at = ? WHERE status = 'running' AND COALESCE(beat_at, started_at) < ?", now, now - STALE_MS);
  const next = await store.first("SELECT * FROM qubi_jobs WHERE status = 'pending' AND due_at <= ? ORDER BY due_at, id LIMIT 1", now);
  if (!next) return null;
  const r = await store.run("UPDATE qubi_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending' AND NOT EXISTS (SELECT 1 FROM qubi_jobs WHERE status = 'running')", now, next.id);
  return r.changes ? { ...next, status: "running", started_at: now } : null;
}

export const setJobCost = (store, id, usd, now = Date.now()) => store.run("UPDATE qubi_jobs SET cost_usd = MAX(cost_usd, ?), beat_at = ? WHERE id = ?", usd, now, id);

/** The end of a run. Its cost only grows; a run already declared dead keeps "failed" (its cost is still recorded). */
export const finishJob = (store, id, f, now = Date.now()) =>
  store.run(`UPDATE qubi_jobs SET status = CASE WHEN status = 'running' THEN ? ELSE status END, cost_usd = MAX(cost_usd, ?), findings = ?, fix_prs = ?, posted_url = ?,
    note = CASE WHEN status = 'running' THEN ? ELSE COALESCE(note, '') || '; finished later: ' || ? END, model = COALESCE(?, model), finished_at = ? WHERE id = ?`,
    f.status, f.cost ?? 0, f.findings ?? 0, f.fixPrs ?? 0, f.url ?? null, String(f.note ?? "").slice(0, 1000), String(f.status), f.model ?? null, now, id);

export const findingStmt = (f, now = Date.now()) => ({
  sql: "INSERT INTO qubi_findings (job_id, repo, sha, path, line, severity, kind, title, url, fix_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  binds: [f.job, f.repo, f.sha, f.path ?? null, f.line ?? null, f.severity, f.kind, String(f.title).slice(0, 300), f.url ?? null, f.fixUrl ?? null, now],
});

// ---------------------------------------------------------------------------------------------------- bug hunts

const formats = new Map();   // one formatter per zone: building one costs far more than using it
/** Pure. Date, HH:MM and weekday (0 = Sunday) in a time zone. */
export function zoned(tz, at = Date.now()) {
  const zone = tz || "UTC";
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
    formats.set(zone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}`, weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** Pure. The instant a YYYY-MM-DD date shows HH:MM in a zone (in a skipped summer-time hour: just after the gap). */
function instantOf(tz, date, hm) {
  const [y, mo, d] = date.split("-").map(Number), [h, mi] = hm.split(":").map(Number);
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  // The zone's offset, read at the guess and corrected twice: enough on either side of a change.
  for (let i = 0; i < 2; i++) {
    const z = zoned(tz, t);
    const [zy, zmo, zd] = z.date.split("-").map(Number), [zh, zmi] = z.hm.split(":").map(Number);
    t += want - Date.UTC(zy, zmo - 1, zd, zh, zmi);
  }
  return t;
}

/**
 * Pure. Is a scheduled hunt due? Once a day (or once on the chosen weekday) at or after hunt.at in its zone, and not
 * yet on that date. Moving the time later on a day it already ran does not run it again.
 */
export function huntDue(hunt, at, lastDate, fallbackTz = "") {
  if (!hunt || hunt.every === "off") return { due: false };
  const z = zoned(hunt.tz || fallbackTz, at);
  const day = hunt.every === "day" || z.weekday === hunt.day;
  return { due: day && z.hm >= hunt.at && lastDate !== z.date, date: z.date };
}

/** Pure. The next scheduled hunt, to the minute, or null when hunts are off. */
export function nextHunt(hunt, at, lastDate, fallbackTz = "") {
  if (!hunt || hunt.every === "off") return null;
  if (huntDue(hunt, at, lastDate, fallbackTz).due) return Math.floor(at / 60_000) * 60_000 + 60_000;
  const tz = hunt.tz || fallbackTz;
  const [y, mo, d] = zoned(tz, at).date.split("-").map(Number);
  // Today and the next eight days in the zone: the first that is a hunt day, has not had its hunt, and is still ahead.
  for (let k = 0; k <= 8; k++) {
    const day = new Date(Date.UTC(y, mo - 1, d + k));
    const date = day.toISOString().slice(0, 10);
    if (date === lastDate || (hunt.every === "week" && day.getUTCDay() !== hunt.day)) continue;
    const t = instantOf(tz, date, hunt.at);
    if (t > at) return Math.floor(t / 60_000) * 60_000;
  }
  return null;
}

export const huntState = (store) => getState(store, "qubi:hunt_date");
export const setHuntState = (store, date, now) => setState(store, "qubi:hunt_date", date, now);

export { KINDS };
