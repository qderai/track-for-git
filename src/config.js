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
const dec = (v, d, min, max) => { const n = Number(str(v)); return str(v) && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d; };
/** Where each Qubi provider's key usually lives, when QUBI_API_KEY is not set. */
const QUBI_KEY_ENV = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", xai: "XAI_API_KEY", gemini: "GEMINI_API_KEY", mistral: "MISTRAL_API_KEY",
  deepseek: "DEEPSEEK_API_KEY", groq: "GROQ_API_KEY", openrouter: "OPENROUTER_API_KEY" };
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
  const qubiProvider = str(env.QUBI_PROVIDER).toLowerCase() || "anthropic";
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
    // Qubi, the reviewer (src/qubi/): the operator's own model key and GitHub App, apart from the dashboard's read-only
    // credentials. Nothing runs until these are set and Qubi is switched on in the dashboard.
    qubi: {
      provider: qubiProvider,
      // https anywhere; plain http only to this machine (a local Ollama or vLLM).
      apiUrl: /^(https:\/\/[^\s"<>]+|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/[^\s"<>]*)?)$/.test(str(env.QUBI_API_URL)) ? str(env.QUBI_API_URL).replace(/\/+$/, "") : "",
      // QUBI_API_KEY, or the provider's usual variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, XAI_API_KEY, …).
      key: str(env.QUBI_API_KEY) || (QUBI_KEY_ENV[qubiProvider] ? str(env[QUBI_KEY_ENV[qubiProvider]]) : ""),
      // For the OpenAI-compatible providers: the models and their prices per million tokens, "id:in/out[/cached], …".
      models: str(env.QUBI_MODELS),
      // The dashboard's public address, when a proxy in front of Node rewrites the Host header (the settings check it).
      origin: /^https?:\/\/[^\s/"<>]+$/.test(str(env.QUBI_ORIGIN)) ? str(env.QUBI_ORIGIN) : "",
      appId: str(env.QUBI_GITHUB_APP_ID),
      appKey: str(env.QUBI_GITHUB_APP_PRIVATE_KEY),
      installationId: str(env.QUBI_GITHUB_APP_INSTALLATION_ID),
      token: str(env.QUBI_GITHUB_TOKEN),
      // Who may change the settings and press "Run now": GitHub logins (AUTH=github) or emails (AUTH=access); * for everyone signed in.
      admins: list(env.QUBI_ADMINS).map((s) => s.toLowerCase()),
      // The ceilings the page cannot pass, in US dollars.
      maxRunUsd: dec(env.QUBI_MAX_RUN_USD, 2, 0.01, 100),
      maxWeekUsd: dec(env.QUBI_MAX_WEEK_USD, 50, 0.01, 10_000),
    },
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
