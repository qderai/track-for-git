// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Every setting, read once from the environment (Worker vars and secrets, or process.env in Node). Secrets are kept
 * here only to be used; nothing in this module or anywhere else prints them, and /api/status says only whether each
 * is set.
 */
import { parseAgents } from "./agents.js";
import { validTz } from "./time.js";

const str = (v) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const list = (v) => str(v).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const int = (v, d, min, max) => { const n = Number.parseInt(str(v), 10); return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
const on = (v) => /^(1|true|yes|on)$/i.test(str(v));

/**
 * @typedef {ReturnType<typeof readConfig>} Config
 */
export function readConfig(env = {}) {
  const apiUrl = (str(env.GITHUB_API_URL) || "https://api.github.com").replace(/\/+$/, "");
  const ghes = apiUrl !== "https://api.github.com";
  // GitHub Enterprise Server: https://host/api/v3 for REST, https://host/api/graphql for GraphQL, https://host for pages.
  const graphqlUrl = ghes ? apiUrl.replace(/\/v3$/, "") + "/graphql" : "https://api.github.com/graphql";
  const webUrl = ghes ? apiUrl.replace(/\/api\/v3$/, "") : "https://github.com";
  const token = str(env.GITHUB_TOKEN);
  const appId = str(env.GITHUB_APP_ID);
  const appKey = str(env.GITHUB_APP_PRIVATE_KEY);
  const demo = on(env.DEMO);
  const mode = demo ? "demo" : appId && appKey ? "app" : token ? "token" : "none";
  let teams = null;
  try { teams = env.TEAMS ? JSON.parse(str(env.TEAMS)) : null; } catch { teams = null; }
  return {
    mode,
    demo,
    org: str(env.GITHUB_ORG).toLowerCase(),
    repos: list(env.REPOS),
    includeArchived: on(env.INCLUDE_ARCHIVED),
    token,
    appId,
    appKey,
    installationId: str(env.GITHUB_APP_INSTALLATION_ID),
    webhookSecrets: list(env.GITHUB_WEBHOOK_SECRET),
    apiUrl,
    graphqlUrl,
    webUrl,
    // Who may open the dashboard: "access" (Cloudflare Access), "github" (members of the organisation sign in with
    // GitHub), "none" (anyone who can reach it; only for a private network or the demo).
    auth: str(env.AUTH).toLowerCase(),
    accessTeam: str(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
    accessAud: list(env.ACCESS_AUD),
    oauthClientId: str(env.GITHUB_OAUTH_CLIENT_ID),
    oauthClientSecret: str(env.GITHUB_OAUTH_CLIENT_SECRET),
    sessionSecret: str(env.SESSION_SECRET),
    allowedTeams: list(env.ALLOWED_TEAMS).map((s) => s.toLowerCase()),
    teams: teams && typeof teams === "object" && !Array.isArray(teams) ? teams : null,
    agents: parseAgents(env.AGENTS),
    staleDays: int(env.STALE_DAYS, 7, 1, 365),
    retentionDays: int(env.RETENTION_DAYS, 180, 7, 3650),
    backfillDays: int(env.BACKFILL_DAYS, 30, 1, 365),
    maxRequests: int(env.MAX_GITHUB_REQUESTS_PER_RUN, 40, 5, 900),
    budgetMs: int(env.SYNC_BUDGET_MS, 25_000, 2_000, 600_000),
    // The team's own time zone for days and hours (an IANA name, "Asia/Jerusalem"); unset, each viewer's own.
    timeZone: validTz(str(env.TIME_ZONE)) ? str(env.TIME_ZONE) : "",
    title: str(env.TITLE) || "Track for Git",
    // Where the dashboard lives on its host: "/" on its own, a path such as "/tools/code/" when mounted inside
    // another app (src/embed.js sets it).
    base: "/",
  };
}

/** Is the dashboard allowed to answer at all? Fail closed: no sign-in configured means a setup page, not the data. */
export function authProblem(cfg) {
  if (cfg.demo && !cfg.auth) return null;
  if (cfg.auth === "none") return null;
  if (cfg.auth === "access") return cfg.accessTeam && cfg.accessAud.length ? null : "AUTH=access needs ACCESS_TEAM_DOMAIN and ACCESS_AUD";
  if (cfg.auth === "github") {
    if (!cfg.oauthClientId || !cfg.oauthClientSecret) return "AUTH=github needs GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET";
    if (cfg.sessionSecret.length < 32) return "AUTH=github needs SESSION_SECRET (32 characters or more)";
    if (!cfg.org) return "AUTH=github needs GITHUB_ORG (only its members may sign in)";
    return null;
  }
  return "Choose who may open the dashboard: AUTH=access, AUTH=github or AUTH=none";
}

/** Which of the settings are set, for the setup page and /api/status. Never a value. */
export function setupState(cfg) {
  return {
    mode: cfg.mode,
    org: cfg.org || null,
    repos: cfg.repos.length,
    github: cfg.mode === "app" ? "app" : cfg.mode === "token" ? "token" : cfg.demo ? "demo" : null,
    webhook: cfg.webhookSecrets.length > 0,
    auth: cfg.auth || (cfg.demo ? "none" : null),
    authProblem: authProblem(cfg),
    ghes: cfg.apiUrl !== "https://api.github.com",
  };
}
