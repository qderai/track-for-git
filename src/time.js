// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Days and hours in the viewer's own time zone. SQLite knows only UTC, so a range is split where its UTC offset
 * changes (daylight saving: at most a few times a year) and each piece is binned with its own fixed offset:
 * CAST((at + offset) / size AS INTEGER). The result is exact for every zone, including half-hour ones, and a night
 * owl's 01:00 commit belongs to the evening it was made in their zone, not to UTC's tomorrow.
 */

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Pure. Is this an IANA time zone this runtime knows? */
export function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; }
}

const fmts = new Map();
function fmt(tz) {
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmts.set(tz, f);
  }
  return f;
}

/** Pure. The zone's offset from UTC at an instant, in milliseconds (Jerusalem in summer: +3 h). */
export function offsetAt(tz, at) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return local - Math.floor(at / 1000) * 1000;
}

/**
 * Pure. [from, to) cut into pieces of constant offset. It probes every 6 hours (no zone changes twice in 6 hours)
 * and narrows each change down to the minute it happens on (zones change on the minute).
 * @returns {{ from: number, to: number, offset: number }[]}
 */
export function segments(tz, from, to) {
  const out = [];
  let start = from, off = offsetAt(tz, from), prev = from;
  for (let t = Math.min(from + 6 * HOUR, to - 1); t > prev; prev = t, t = Math.min(t + 6 * HOUR, to - 1)) {
    if (offsetAt(tz, t) === off) continue;
    let lo = prev, hi = t;                       // offset(lo) is the old one, offset(hi) the new one
    while (hi - lo > 60_000) {
      const mid = lo + Math.max(60_000, Math.floor((hi - lo) / 120_000) * 60_000);
      if (offsetAt(tz, mid) === off) lo = mid; else hi = mid;
    }
    let change = Math.floor(hi / 60_000) * 60_000;
    if (change <= lo || offsetAt(tz, change) === off) change = hi;
    out.push({ from: start, to: change, offset: off });
    start = change;
    off = offsetAt(tz, change);
  }
  out.push({ from: start, to, offset: off });
  return out.filter((s) => s.to > s.from);
}

/** Pure. A local bucket number back into the UTC instant where that local bucket starts. */
export const bucketStart = (bucket, size, offset) => bucket * size - offset;

/** Pure. A local day number (days since 1970-01-01 local) as YYYY-MM-DD. */
export const dayLabel = (dayNumber) => new Date(dayNumber * DAY).toISOString().slice(0, 10);

/** Pure. The local day number of an instant. */
export const dayNumber = (tz, at) => Math.floor((at + offsetAt(tz, at)) / DAY);

/** Pure. The bin size of the timeline for a range: 1 h for a day, 3 h for a week, 12 h for a month, a day beyond. */
export const binSize = (from, to) => { const d = (to - from) / DAY; return d <= 1.01 ? HOUR : d <= 7.01 ? 3 * HOUR : d <= 31.01 ? 12 * HOUR : DAY; };
