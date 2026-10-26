// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Node (and Docker), for companies that do not run Cloudflare: the same app over SQLite (node:sqlite, built into
 * Node 22.13+), a static file server for public/, and the sync on a timer. Settings come from the environment, the
 * same names as on Workers.
 *
 *   PORT=8787 DATABASE_PATH=./data/track.db node server/node.js
 *
 * Behind a reverse proxy that does TLS; put the company's SSO in front of it (oauth2-proxy, Cloudflare Tunnel with
 * Access, or AUTH=github).
 */
import { readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/app.js";
import { migrateSqlite, sqliteStore } from "../src/db.js";
import { secure } from "../src/http.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "public");

export function start(env = process.env) {
  const path = env.DATABASE_PATH || join(root, "data", "track.db");
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const dir = join(root, "migrations");
  migrateSqlite(db, readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") })));
  const app = createApp({ env, store: sqliteStore(db) });

  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
    ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8" };

  /** A file of public/, never outside it. */
  function staticFile(pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(pub, rel));
    if (!file.startsWith(pub) || rel.includes("\0")) return null;
    try {
      if (!statSync(file).isFile()) return null;
      return new Response(readFileSync(file), { headers: { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": extname(file) === ".html" ? "no-cache" : "public, max-age=300" } });
    } catch { return null; }
  }

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `localhost:${env.PORT || 8787}`;
      const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0];
      const url = new URL(req.url ?? "/", `${proto}://${host}`);
      let response;
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/healthz") {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : req;
        const request = new Request(url, { method: req.method, headers: req.headers, body, duplex: body ? "half" : undefined });
        response = await app.fetch(request);
      } else {
        response = staticFile(url.pathname) ?? staticFile("/index.html");
        response = secure(response);
      }
      res.statusCode = response.status;
      const setCookies = response.headers.getSetCookie?.() ?? [];
      response.headers.forEach((v, k) => { if (k !== "set-cookie") res.setHeader(k, v); });
      if (setCookies.length) res.setHeader("set-cookie", setCookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error("[track-for-git]", e);
      res.statusCode = 500;
      res.end("error");
    }
  });

  const port = Number(env.PORT || 8787);
  server.listen(port, env.HOST || "0.0.0.0", () => console.log(`Track for Git on http://localhost:${port}${app.cfg.demo ? " (demo)" : ""}`));
  // The sync once a minute, as the cron trigger does on Workers.
  const tick = () => app.scheduled(Date.now()).then((r) => {
    if (r?.errors?.length) console.warn("[track-for-git] sync:", r.errors.join("; "));
    if (r?.qubi?.error) console.warn("[track-for-git] qubi:", r.qubi.error);
  }).catch((e) => console.error("[track-for-git] sync", e));
  const timer = setInterval(tick, 60_000);
  setTimeout(tick, 2_000);
  return { server, close: () => { clearInterval(timer); server.close(); db.close(); } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
