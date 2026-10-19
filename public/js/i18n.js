// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Words, numbers, dates and times in the viewer's language and time zone. Messages live in ../locales/<code>.js;
 * numbers and dates come from Intl, so they are local even before a language has its own messages.
 */
import en from "../locales/en.js";

/** Languages with their own messages. Add one here after adding its file. */
export const LOCALES = { en };

let messages = en;
let lang = "en";
let plural = new Intl.PluralRules("en");
let tz = "UTC";
try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* very old runtime */ }
const fmtCache = new Map();

/** Pick the language: the first of the browser's that has messages; formats follow the browser's own locale. */
export function setLocale(preferred = (globalThis.navigator?.languages ?? ["en"])) {
  const code = preferred.map((l) => String(l).toLowerCase().split("-")[0]).find((l) => LOCALES[l]) ?? "en";
  messages = LOCALES[code];
  lang = preferred[0] ?? code;
  try { plural = new Intl.PluralRules(lang); } catch { plural = new Intl.PluralRules("en"); lang = "en"; }
  fmtCache.clear();
  if (globalThis.document) {
    document.documentElement.lang = code;
    document.documentElement.dir = ["ar", "he", "fa", "ur"].includes(code) ? "rtl" : "ltr";
  }
  return code;
}

export const timeZone = () => tz;
export const locale = () => lang;

/** A message with {placeholders}; an object message is chosen by the plural of `vars.n`. */
export function t(key, vars = {}) {
  let m = messages[key] ?? en[key] ?? key;
  if (m && typeof m === "object") {
    const n = Number(vars.n ?? 0);
    m = (n === 0 && m.zero) || m[plural.select(n)] || m.other;
    vars = { ...vars, n: num(n) };
  }
  return String(m).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

function fmt(kind, opts) {
  const key = `${kind}|${JSON.stringify(opts)}`;
  let f = fmtCache.get(key);
  if (!f) {
    f = kind === "n" ? new Intl.NumberFormat(lang, opts) : kind === "r" ? new Intl.RelativeTimeFormat(lang, opts) : new Intl.DateTimeFormat(lang, { timeZone: tz, ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

/** 1,284 · 12.9K for big numbers when `compact`. */
export const num = (n, compact = false) => fmt("n", compact && Math.abs(n) >= 10_000 ? { notation: "compact", maximumFractionDigits: 1 } : {}).format(n);
export const pct = (x) => fmt("n", { style: "percent", maximumFractionDigits: x < 0.1 && x > 0 ? 1 : 0 }).format(x);
export const signed = (n) => fmt("n", { signDisplay: "exceptZero" }).format(n);

/** "3 minutes ago", "yesterday" — in words a person reads at a glance. */
export function ago(at, now = Date.now()) {
  const s = Math.round((at - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return t("ago.now");
  const rel = fmt("r", { numeric: "auto" });
  if (a < 3600) return rel.format(Math.round(s / 60), "minute");
  if (a < 86_400) return rel.format(Math.round(s / 3600), "hour");
  if (a < 30 * 86_400) return rel.format(Math.round(s / 86_400), "day");
  if (a < 365 * 86_400) return rel.format(Math.round(s / (30 * 86_400)), "month");
  return rel.format(Math.round(s / (365 * 86_400)), "year");
}

/** A duration in the largest unit that fits ("4 days"). */
export function duration(ms) {
  const unit = ms >= 86_400_000 ? ["day", 86_400_000] : ms >= 3_600_000 ? ["hour", 3_600_000] : ["minute", 60_000];
  return fmt("n", { style: "unit", unit: unit[0], unitDisplay: "long", maximumFractionDigits: 0 }).format(Math.max(1, Math.round(ms / unit[1])));
}

export const dateTime = (at) => fmt("d", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(at);
export const clock = (at) => fmt("d", { hour: "2-digit", minute: "2-digit" }).format(at);
export const dayShort = (at) => fmt("d", { weekday: "short", day: "numeric" }).format(at);
export const dayMonth = (at) => fmt("d", { day: "numeric", month: "short" }).format(at);
export const fullDay = (at) => fmt("d", { weekday: "long", day: "numeric", month: "long" }).format(at);
/** A YYYY-MM-DD day label (already in the viewer's zone) as words, without shifting it to another zone. */
export const dayWords = (label, opts = { weekday: "short", day: "numeric", month: "short" }) =>
  new Intl.DateTimeFormat(lang, { ...opts, timeZone: "UTC" }).format(new Date(`${label}T12:00:00Z`));
