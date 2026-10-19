// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Cloudflare Workers: the app over D1, the edge cache, and the cron trigger (wrangler.jsonc runs it every minute).
 * Static files (public/) are served by Workers Static Assets before the Worker is asked; only /api/*, /auth/* and
 * /healthz reach this code.
 */
import { createApp } from "./app.js";
import { d1Store } from "./db.js";

const app = (env, ctx) => createApp({
  env,
  store: d1Store(env.DB),
  edgeCache: globalThis.caches?.default ?? null,
  waitUntil: (p) => ctx.waitUntil(p),
});

export default {
  async fetch(request, env, ctx) {
    return app(env, ctx).fetch(request);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(app(env, ctx).scheduled(Date.now()).then((r) => {
      if (r?.errors?.length) console.warn("[track-for-git] sync:", r.errors.join("; "));
    }));
  },
};
