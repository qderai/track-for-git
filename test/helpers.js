// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/** Test helpers: a fresh in-memory database with the real migrations, and a scripted fetch. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { migrateSqlite, sqliteStore } from "../src/db.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function memStore() {
  const db = new DatabaseSync(":memory:");
  const dir = join(root, "migrations");
  migrateSqlite(db, readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") })));
  const store = sqliteStore(db);
  store.db = db;
  return store;
}

/**
 * A fetch that answers from a list of [matcher, response] pairs, in order of declaration; records every call.
 * A matcher is a string (substring of the URL) or a function (url, init) => boolean. A response is an object
 * { status, body, headers } or a function returning one.
 */
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const [match, res] of routes) {
      if (typeof match === "string" ? u.includes(match) : match(u, init)) {
        const r = typeof res === "function" ? res(u, init) : res;
        const headers = new Headers({ "content-type": "application/json", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4900", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600), ...(r.headers ?? {}) });
        // `text` is sent as it is (a raw file), `body` as JSON.
        return new Response(r.status === 304 || r.status === 204 ? null : r.text ?? JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
  };
  fn.calls = calls;
  return fn;
}

export const sha = (n) => String(n).padStart(40, "0").replace(/^0/, "a");
