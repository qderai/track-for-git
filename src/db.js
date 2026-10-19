// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * One small interface over the two databases Track for Git runs on: Cloudflare D1 and SQLite in Node (node:sqlite,
 * built into Node 22.13 and later). Both speak the same SQL, so every query in the project is written once.
 *
 *   all(sql, ...binds)    rows
 *   first(sql, ...binds)  the first row or null
 *   run(sql, ...binds)    { changes }
 *   batch([{ sql, binds }])  in order, in one transaction
 *
 * Every value is bound, never spliced into the SQL. D1 takes at most 100 bound values per statement: callers with
 * long lists use `chunks`.
 */

/** D1 refuses undefined and booleans: null and 0/1 instead. */
const norm = (v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v);

/** @param {any} d1 the D1 binding */
export function d1Store(d1) {
  const prep = (sql, binds) => d1.prepare(sql).bind(...binds.map(norm));
  return {
    kind: "d1",
    async all(sql, ...binds) { return (await prep(sql, binds).all()).results ?? []; },
    async first(sql, ...binds) { return (await prep(sql, binds).first()) ?? null; },
    async run(sql, ...binds) { const r = await prep(sql, binds).run(); return { changes: r.meta?.changes ?? 0 }; },
    async batch(stmts) {
      if (!stmts.length) return;
      // D1 runs a batch as one transaction; 50 at a time keeps each call well under its limits.
      for (const part of chunks(stmts, 50)) await d1.batch(part.map((s) => prep(s.sql, s.binds ?? [])));
    },
  };
}

/** @param {any} db a node:sqlite DatabaseSync */
export function sqliteStore(db) {
  const cache = new Map();
  const prep = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    kind: "sqlite",
    async all(sql, ...binds) { return prep(sql).all(...binds.map(norm)).map((r) => ({ ...r })); },
    async first(sql, ...binds) { const r = prep(sql).get(...binds.map(norm)); return r ? { ...r } : null; },
    async run(sql, ...binds) { const r = prep(sql).run(...binds.map(norm)); return { changes: Number(r.changes) }; },
    async batch(stmts) {
      if (!stmts.length) return;
      db.exec("BEGIN");
      try {
        for (const s of stmts) prep(s.sql).run(...(s.binds ?? []).map(norm));
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

/**
 * Apply the migrations a node:sqlite database has not had yet (D1 uses `wrangler d1 migrations apply`, which keeps
 * its own table; this one mirrors it under the same name).
 * @param {any} db a node:sqlite DatabaseSync
 * @param {{ name: string, sql: string }[]} migrations in order
 */
export function migrateSqlite(db, migrations) {
  db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)");
  const done = new Set(db.prepare("SELECT name FROM d1_migrations").all().map((r) => r.name));
  for (const m of migrations) {
    if (done.has(m.name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(m.name);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** @template T @param {T[]} list @param {number} n @returns {T[][]} */
export function chunks(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/** "?,?,?" for a list of values. */
export const marks = (list) => list.map(() => "?").join(",");

/** A small key/value table for settings and bookkeeping. */
export const getState = async (store, key) => (await store.first("SELECT value FROM state WHERE key = ?", key))?.value ?? null;
export const setState = (store, key, value, now = Date.now()) =>
  store.run("INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, value, now);
export const stateStmt = (key, value, now = Date.now()) => ({
  sql: "INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  binds: [key, value, now],
});
export async function getJson(store, key) {
  const v = await getState(store, key);
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}
