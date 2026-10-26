// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Demo mode (DEMO=1): a made-up company, Acme, with 36 repositories, 56 people in 7 teams, the AI agents they work
 * with, and bots, generated the same way every time and placed in the last 30 days, so anyone can try the dashboard
 * without a token. A few commits arrive every quarter minute while someone is looking, so "real time" is real.
 * Every name, message and line of code here is invented. The data is rebuilt every six hours so it stays recent.
 *
 * The raw commits go through the same agent detection as GitHub's (src/agents.js): what the demo shows for Claude,
 * Cursor, Copilot, Grok and the others is what a real organisation's commits would show.
 */
import { detectAgent } from "./agents.js";
import { chunks, getState, setState } from "./db.js";
import { qubiDemoStmts } from "./qubi/demo.js";
import { DAY, HOUR } from "./time.js";

/** A small, seeded random generator (mulberry32): the same demo every time. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const r = {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    weighted: (pairs) => { const total = pairs.reduce((s, p) => s + p[1], 0); let x = next() * total; for (const [v, w] of pairs) { x -= w; if (x <= 0) return v; } return pairs.at(-1)[0]; },
    /** A long-tailed size: most changes small, a few large. */
    size: (median) => Math.max(1, Math.round(median * Math.exp((next() + next() + next() - 1.5) * 1.6))),
    hex: (n = 40) => { let s = ""; for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(next() * 16)]; return s; },
  };
  return r;
}

export const ORG = "acme";
const TEAMS = [
  { slug: "platform", name: "Platform", repos: ["api-gateway", "auth-service", "feature-flags", "notifications", "partner-api", "legacy-monolith"] },
  { slug: "payments", name: "Payments", repos: ["payments-service", "billing", "checkout-web", "orders-service", "inventory-service"] },
  { slug: "web", name: "Web", repos: ["web-app", "design-system", "admin-console", "marketing-site", "email-templates", "localization"] },
  { slug: "mobile", name: "Mobile", repos: ["mobile-ios", "mobile-android", "sdk-js"] },
  { slug: "data", name: "Data", repos: ["data-pipeline", "analytics-dashboard", "ml-ranking", "recommendations", "search-service", "sdk-python"] },
  { slug: "infra", name: "Infrastructure", repos: ["infra-terraform", "k8s-config", "observability", "load-tests", "status-page", "security-scanner"] },
  { slug: "devex", name: "Developer Experience", repos: ["ci-templates", "cli", "docs-site", "internal-tools"] },
];
const FIRST = ["Maya", "Noah", "Ava", "Liam", "Zoe", "Omar", "Lena", "Arjun", "Sofia", "Kenji", "Amara", "Diego", "Ines", "Tomas", "Priya", "Yusuf", "Hana",
  "Mateo", "Chloe", "Ravi", "Elif", "Jonas", "Nadia", "Theo", "Mei", "Samir", "Olivia", "Felix", "Aisha", "Lucas", "Ingrid", "Tariq", "Camila", "Viktor", "Leah",
  "Kofi", "Rosa", "Daniel", "Yara", "Erik", "Nina", "Hugo", "Sara", "Malik", "Julia", "Ari", "Freya", "Tal", "Marco", "Asha", "Ben", "Clara", "Idris", "Mila", "Oren", "June"];
const LAST = ["Cohen", "Nakamura", "Okafor", "Silva", "Novak", "Haddad", "Larsen", "Patel", "Romero", "Fischer", "Mensah", "Kowalski", "Duarte", "Ivanova", "Singh",
  "Brennan", "Kaya", "Moreau", "Ahmed", "Lindqvist", "Tanaka", "Reyes", "Volkov", "Osei", "Berg", "Costa", "Shah", "Weber", "Azoulay", "Park"];

/** The cast: people (each in a team, with the agents they use), the agents' own accounts, the bots. */
export function cast(seed = 7) {
  const r = rng(seed);
  const people = [];
  const usedLogins = new Set();
  for (let i = 0; i < 56; i++) {
    const first = FIRST[i % FIRST.length], last = r.pick(LAST);
    let login = `${first}${last}`.toLowerCase().slice(0, 14);
    while (usedLogins.has(login)) login += r.int(1, 9);
    usedLogins.add(login);
    const team = TEAMS[i % TEAMS.length];
    // Each person has a habit: some work alone, most use one agent a lot and another now and then.
    const main = r.weighted([[null, 30], ["claude", 26], ["cursor", 18], ["copilot", 10], ["codex", 8], ["grok", 4], ["gemini", 3], ["aider", 1]]);
    const share = main ? 0.25 + r.next() * 0.5 : 0.05;
    people.push({ login, name: `${first} ${last}`, team: team.slug, main, share, pace: 0.4 + r.next() * 1.4 });
  }
  return { people, teams: TEAMS };
}

const VERBS = ["Fix", "Add", "Update", "Refactor", "Remove", "Improve", "Speed up", "Handle", "Document", "Test", "Simplify", "Rename", "Validate", "Retry", "Cache"];
const THINGS = {
  service: ["token refresh", "rate limiter", "pagination on list endpoints", "idempotency keys", "health check", "retry on 503", "request logging", "timeout handling",
    "webhook signature check", "connection pool", "error responses", "OpenAPI schema", "background job queue", "audit log", "tenant isolation", "feature flag lookup"],
  web: ["checkout form", "date picker", "dark mode colours", "empty states", "table sorting", "keyboard navigation", "loading skeletons", "toast messages", "search box",
    "settings page", "onboarding flow", "image lazy loading", "focus ring", "invoice view", "navigation menu", "error boundary"],
  mobile: ["push notification permissions", "offline mode", "deep links", "biometric sign-in", "crash on rotation", "image cache", "app start time", "share sheet", "widget"],
  data: ["daily aggregation job", "late events", "schema migration", "deduplication", "ranking features", "backfill script", "partition pruning", "embedding refresh", "metrics export"],
  infra: ["autoscaling thresholds", "TLS certificates", "alert routing", "node pool", "secrets rotation", "log retention", "dashboards", "load test scenarios", "DNS records"],
  devex: ["CI cache", "release script", "lint rules", "docs navigation", "CLI help text", "test runner", "code owners", "pre-commit hooks", "templates"],
};
const KIND = { platform: "service", payments: "service", web: "web", mobile: "mobile", data: "data", infra: "infra", devex: "devex" };
const DIRS = {
  service: ["src/handlers", "src/middleware", "src/db", "src/clients", "tests", "migrations", "docs"],
  web: ["src/components", "src/pages", "src/hooks", "src/styles", "tests", "public"],
  mobile: ["App/Sources", "App/Views", "app/src/main/java", "app/src/test", "Shared"],
  data: ["pipelines", "jobs", "models", "sql", "tests", "notebooks"],
  infra: ["modules", "environments/prod", "environments/staging", "charts", "alerts", "scripts"],
  devex: ["src", "templates", "docs", "scripts", "tests"],
};
const EXT = { service: [".ts", ".go"], web: [".tsx", ".css", ".ts"], mobile: [".swift", ".kt"], data: [".py", ".sql"], infra: [".tf", ".yaml"], devex: [".ts", ".md"] };
const LABELS = ["bug", "feature", "security", "performance", "dependencies", "needs-review", "breaking-change", "docs", "tech-debt", "ux"];
const TRAILER = {
  claude: () => "Co-Authored-By: Claude <noreply@anthropic.com>",
  cursor: () => "Co-authored-by: Cursor Agent <cursoragent@cursor.com>",
  copilot: () => "Co-authored-by: Copilot <175728472+Copilot@users.noreply.github.com>",
  codex: () => "Co-authored-by: Codex <codex@openai.com>",
  grok: () => "Assisted-by: Grok",
  gemini: () => "Co-authored-by: Gemini CLI <gemini-cli@google.com>",
  aider: () => "",
};

/**
 * Pure. The whole demo organisation as rows, for a given "now". Deterministic for a given (now rounded to the hour,
 * scale).
 */
export function generate(now, { scale = 1, seed = 7 } = {}) {
  const r = rng(seed);
  const { people, teams } = cast(seed);
  const repos = [];
  let rid = 100_000;
  for (const t of teams) for (const name of t.repos) repos.push({ id: ++rid, name, full_name: `${ORG}/${name}`, team: t.slug, kind: KIND[t.slug], weight: 0.3 + r.next() * r.next() * 4 });
  const byTeam = (slug) => people.filter((p) => p.team === slug);
  const commits = [], files = [], pushes = [], prs = [], markers = [], ci = [];
  // Whole UTC days, so "working hours" fall in working hours: the 30 days before today and today so far.
  const start = Math.floor(now / DAY) * DAY - 30 * DAY;
  const prNo = Object.fromEntries(repos.map((x) => [x.id, 100 + r.int(0, 900)]));

  // Work comes in sessions: a person (alone or with an agent) or a bot makes one to six commits on one branch of one
  // repository a few minutes apart and pushes them. A person's branch in a repository lasts a day or two, then a pull
  // request is opened from it.
  const branchOf = new Map();
  for (let day = 0; day <= 30; day++) {
    const d0 = start + day * DAY;
    const dow = new Date(d0).getUTCDay();
    const weekend = dow === 0 || dow === 6;
    const sessions = Math.round(((weekend ? 70 : 430) * scale * (0.85 + r.next() * 0.3)) / 2.6);
    for (let s = 0; s < sessions; s++) {
      const repo = r.weighted(repos.map((x) => [x, x.weight]));
      const kind = repo.kind;
      const team = byTeam(repo.team);
      const botTurn = r.next() < 0.035;
      const person = r.next() < 0.85 ? r.weighted(team.map((p) => [p, p.pace])) : r.pick(people);
      // Working hours spread over a few time zones, quieter at night.
      const hour = r.weighted([[1, 1], [4, 1], [6, 3], [7, 6], [8, 9], [9, 10], [10, 10], [11, 9], [12, 8], [13, 9], [14, 10], [15, 9], [16, 8], [17, 6], [18, 4], [19, 3], [21, 2], [23, 1]]);
      let at = d0 + hour * HOUR + r.int(0, HOUR - 1);
      const agent = botTurn ? null : r.next() < person.share
        ? (r.next() < 0.85 ? person.main : r.weighted([["claude", 5], ["cursor", 4], ["copilot", 3], ["codex", 2], ["devin", 1], ["grok", 1], ["gemini", 1]]))
        : null;
      const viaAccount = agent === "devin" || (agent === "copilot" && r.next() < 0.3);
      let branch;
      if (botTurn) branch = r.next() < 0.5 ? "main" : `${r.pick(["dependabot", "renovate"])}/update-${r.hex(6)}`;
      else if (viaAccount) branch = `${agent}/${r.pick(THINGS[kind]).replace(/\W+/g, "-")}-${r.hex(4)}`;
      else if (r.next() < 0.45) branch = "main";
      else {
        const k = `${person.login}|${repo.id}|${Math.floor(day / 2)}`;
        branch = branchOf.get(k);
        if (!branch) {
          const prefix = agent && ["claude", "cursor", "codex"].includes(agent) && r.next() < 0.6 ? agent : r.pick(["feature", "fix", "chore"]);
          branch = `${prefix}/${r.pick(THINGS[kind]).toLowerCase().replace(/\W+/g, "-")}-${r.hex(4)}`;
          branchOf.set(k, branch);
        }
      }
      const n = botTurn ? 1 : r.weighted([[1, 30], [2, 25], [3, 17], [4, 12], [5, 9], [6, 7]]);
      const made = [];
      for (let i = 0; i < n; i++) {
        if (at > now) break;
        let raw;
        if (botTurn) {
          const bot = branch.startsWith("renovate") ? "renovate[bot]" : branch === "main" ? "github-actions[bot]" : "dependabot[bot]";
          raw = { login: bot, name: bot, email: `${bot}@users.noreply.github.com`, message: bot.startsWith("github") ? "Update generated API client" : `Bump ${r.pick(["axios", "react", "eslint", "pytest", "terraform-aws", "kotlin", "lodash", "vite"])} from 1.${r.int(1, 9)}.${r.int(0, 9)} to 1.${r.int(1, 9)}.${r.int(0, 9)}` };
        } else {
          const subj = `${r.pick(VERBS)} ${r.pick(THINGS[kind])}${r.next() < 0.3 ? ` in ${r.pick(DIRS[kind]).split("/").at(-1)}` : ""}`;
          const conv = r.next() < 0.35 ? `${r.pick(["feat", "fix", "chore", "refactor", "perf", "test", "docs"])}(${repo.name.split("-")[0]}): ${subj[0].toLowerCase()}${subj.slice(1)}` : subj;
          if (viaAccount) {
            const acct = agent === "devin" ? "devin-ai-integration[bot]" : "copilot-swe-agent[bot]";
            raw = { login: acct, name: acct, email: `${acct}@users.noreply.github.com`, message: conv };
          } else {
            const trailer = agent ? TRAILER[agent]?.() ?? "" : "";
            raw = { login: person.login, name: agent === "aider" ? `${person.name} (aider)` : person.name, email: `${person.login}@acme.example`,
              message: `${conv}${r.next() < 0.4 ? `\n\n${r.pick(["The old path dropped the error.", "Covered by a new test.", "Measured: 30% faster on the staging data.", "Follows the review on the last PR."])}` : ""}${trailer ? `\n\n${trailer}` : ""}` };
          }
        }
        const who = detectAgent(raw);
        const sha = r.hex();
        const nFiles = Math.min(40, r.size(2.2));
        const add = r.next() < 0.01 ? r.int(1500, 6000) : r.size(38);
        const del = Math.round(add * r.next() * 0.7);
        const paths = new Set();
        for (let k = 0; k < nFiles; k++) paths.add(`${r.pick(DIRS[kind])}/${r.pick(THINGS[kind]).replace(/\W+/g, "_")}${r.pick(EXT[kind])}`);
        if (raw.login === "dependabot[bot]" || raw.login === "renovate[bot]") { paths.clear(); paths.add(kind === "data" ? "requirements.txt" : "package.json"); paths.add(kind === "data" ? "poetry.lock" : "package-lock.json"); }
        const c = { repo_id: repo.id, sha, at, branch, on_default: branch === "main" ? 1 : 0, author_login: raw.login.toLowerCase(), author_name: raw.name, agent: who.agent,
          bot: who.bot ? 1 : 0, message: raw.message, additions: add, deletions: del, files_n: paths.size, pr_number: null, paths_known: 1 };
        commits.push(c);
        made.push(c);
        for (const p of paths) files.push([repo.id, sha, p]);
        at += r.int(3, 25) * 60_000;
      }
      if (!made.length) continue;
      // One push for the session, or two when it was long.
      const cut = made.length >= 4 && r.next() < 0.4 ? Math.ceil(made.length / 2) : made.length;
      for (const part of [made.slice(0, cut), made.slice(cut)]) {
        if (!part.length) continue;
        const head = part.at(-1);
        const pushAt = Math.min(now, head.at + r.int(1, 6) * 60_000);
        pushes.push({ id: `push:${repo.id}:${branch}:${head.sha}`, repo_id: repo.id, branch, at: pushAt, actor: botTurn || viaAccount ? head.author_login : person.login, head: head.sha,
          before: null, commits_n: part.length, forced: r.next() < 0.02 ? 1 : 0, created: 0, agent: part.find((c) => c.agent)?.agent ?? null });
      }
    }
  }
  commits.sort((a, b) => a.at - b.at);

  // Pull requests: one per feature branch of each repository, most merged, some open, a few stuck or failing.
  const branches = new Map();
  for (const c of commits) if (!c.on_default) { const k = `${c.repo_id}|${c.branch}`; const b = branches.get(k) ?? { repo_id: c.repo_id, branch: c.branch, commits: [] }; b.commits.push(c); branches.set(k, b); }
  for (const b of branches.values()) {
    const first = b.commits[0], last = b.commits.at(-1);
    const number = ++prNo[b.repo_id];
    const age = now - first.at;
    const roll = r.next();
    const state = age < 2 * DAY ? (roll < 0.55 ? "open" : roll < 0.95 ? "merged" : "closed") : roll < 0.035 ? "open" : roll < 0.93 ? "merged" : "closed";
    const mergedAt = state === "merged" ? Math.min(now - 60_000, last.at + r.int(20, 60 * 30) * 60_000) : null;
    const closedAt = state === "closed" ? Math.min(now - 60_000, last.at + r.int(60, 4000) * 60_000) : mergedAt;
    const stale = state === "open" && age > 2 * DAY && r.next() < 0.6;
    const updatedAt = state === "open" ? (stale ? last.at : Math.min(now - 60_000, last.at + r.int(5, 600) * 60_000)) : closedAt;
    const additions = b.commits.reduce((s, c) => s + c.additions, 0), deletions = b.commits.reduce((s, c) => s + c.deletions, 0);
    const head = last.sha;
    const labels = r.next() < 0.6 ? [r.pick(LABELS), ...(r.next() < 0.25 ? [r.pick(LABELS)] : [])] : [];
    const ciState = state === "open" ? r.weighted([["success", 70], ["failure", 14], ["pending", 16]]) : "success";
    const review = state === "open" ? r.weighted([["review_required", 45], ["approved", 30], ["changes_requested", 15], ["commented", 10]]) : "approved";
    const title = b.commits[0].message.split("\n")[0];
    prs.push({ repo_id: b.repo_id, number, title, state: state === "open" ? "open" : "closed", merged: state === "merged" ? 1 : 0, draft: state === "open" && r.next() < 0.12 ? 1 : 0,
      author_login: first.author_login, agent: first.agent, bot: first.bot, head_ref: b.branch, base_ref: "main", head_sha: head, created_at: first.at, updated_at: updatedAt,
      merged_at: mergedAt, closed_at: state === "open" ? null : closedAt, review, additions, deletions, files_n: Math.min(60, b.commits.reduce((s, c) => s + c.files_n, 0)),
      labels: JSON.stringify([...new Set(labels)]), url: null });
    for (const c of b.commits) c.pr_number = number;
    ci.push([b.repo_id, head, ciState, updatedAt]);
  }

  // Deploys to production and staging for the services, releases for the things people install.
  const services = repos.filter((x) => ["service", "web", "data"].includes(x.kind));
  for (let day = 0; day <= 30; day++) {
    const d0 = start + day * DAY;
    const dow = new Date(d0).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const n = Math.round(9 * scale + r.int(0, 4));
    for (let i = 0; i < n; i++) {
      const repo = r.weighted(services.map((x) => [x, x.weight]));
      const at = d0 + r.int(9, 18) * HOUR + r.int(0, HOUR);
      if (at > now) continue;
      const env = r.next() < 0.55 ? "production" : "staging";
      const state = r.weighted([["success", 90], ["failure", 6], ["error", 2], ["in_progress", 2]]);
      const near = commits.filter((c) => c.repo_id === repo.id && c.on_default && c.at < at).at(-1);
      markers.push({ id: `deploy:${repo.id}:${markers.length + 1}`, repo_id: repo.id, kind: "deploy", name: env, environment: env, state, sha: near?.sha ?? null, ref: "main", at,
        finished_at: state === "in_progress" ? null : at + r.int(2, 14) * 60_000, actor: near?.author_login ?? null, url: null, prerelease: 0 });
    }
  }
  for (const repo of repos.filter((x) => ["mobile-ios", "mobile-android", "sdk-js", "sdk-python", "cli", "design-system"].includes(x.name))) {
    let v = r.int(1, 4), m = r.int(0, 9);
    for (let t = start + r.int(1, 6) * DAY; t < now; t += r.int(5, 9) * DAY) {
      m++;
      const at = t + r.int(10, 16) * HOUR;
      if (at > now) break;
      markers.push({ id: `release:${repo.id}:${markers.length + 1}`, repo_id: repo.id, kind: "release", name: `v${v}.${m}.0`, environment: null, state: "published", sha: null,
        ref: `v${v}.${m}.0`, at, finished_at: null, actor: null, url: null, prerelease: r.next() < 0.15 ? 1 : 0 });
    }
  }
  const memberships = people.map((p) => [p.team, p.login]);
  return { repos, people, teams, commits, files, pushes, prs, markers, ci, memberships };
}

/** Rows into multi-row INSERTs (D1 binds at most 100 values a statement). */
function inserts(table, cols, rows, verb = "INSERT OR REPLACE") {
  const per = Math.max(1, Math.floor(99 / cols.length));
  return chunks(rows, per).map((part) => ({
    sql: `${verb} INTO ${table} (${cols.join(", ")}) VALUES ${part.map(() => `(${cols.map(() => "?").join(",")})`).join(",")}`,
    binds: part.flatMap((row) => (Array.isArray(row) ? row : cols.map((c) => row[c]))),
  }));
}

const COMMIT_COLS = ["repo_id", "sha", "at", "branch", "on_default", "author_login", "author_name", "agent", "bot", "message", "additions", "deletions", "files_n", "pr_number", "paths_known"];
const PR_COLS = ["repo_id", "number", "title", "state", "merged", "draft", "author_login", "agent", "bot", "head_ref", "base_ref", "head_sha", "created_at", "updated_at", "merged_at", "closed_at", "review", "additions", "deletions", "files_n", "labels", "url"];
const PUSH_COLS = ["id", "repo_id", "branch", "at", "actor", "head", "before", "commits_n", "forced", "created", "agent"];
const MARKER_COLS = ["id", "repo_id", "kind", "name", "environment", "state", "sha", "ref", "at", "finished_at", "actor", "url", "prerelease"];

/**
 * Fill the database with the demo, unless a demo younger than six hours is there. Wipes the tables first: demo mode
 * never runs against real data (DEMO=1 ignores every GitHub setting).
 */
export async function ensureDemo(store, now = Date.now(), { scale = 1 } = {}) {
  const seeded = Number((await getState(store, "demo_seeded_at")) ?? 0);
  if (now - seeded < 6 * HOUR) return false;
  // One seeder at a time: the claim moves demo_seeded_at forward first.
  await store.run("INSERT OR IGNORE INTO state (key, value, updated_at) VALUES ('demo_seeded_at', '0', ?)", now);
  const claim = await store.run("UPDATE state SET value = ?, updated_at = ? WHERE key = 'demo_seeded_at' AND value = ?", String(now), now, String(seeded));
  if (!claim.changes) return false;
  const g = generate(Math.floor(now / HOUR) * HOUR + (now % HOUR), { scale });
  const wipe = ["commit_files", "commits", "pushes", "prs", "ci", "markers", "team_members", "teams", "people", "repos"].map((t) => ({ sql: `DELETE FROM ${t}`, binds: [] }));
  await store.batch(wipe);
  await store.batch([
    ...inserts("repos", ["id", "full_name", "default_branch", "private", "archived", "removed", "pushed_at", "synced_at"], g.repos.map((x) => [x.id, x.full_name, "main", 1, 0, 0, now, now])),
    ...inserts("teams", ["slug", "name"], g.teams.map((t) => [t.slug, t.name])),
    ...inserts("team_members", ["team", "login"], g.memberships),
    ...inserts("people", ["login", "name", "last_at"], g.people.map((p) => [p.login, p.name, now])),
  ]);
  await store.batch(inserts("commits", COMMIT_COLS, g.commits));
  await store.batch(inserts("commit_files", ["repo_id", "sha", "path"], g.files, "INSERT OR IGNORE"));
  await store.batch(inserts("pushes", PUSH_COLS, g.pushes));
  await store.batch(inserts("prs", PR_COLS, g.prs));
  await store.batch(inserts("ci", ["repo_id", "sha", "state", "at"], g.ci));
  await store.batch(inserts("markers", MARKER_COLS, g.markers));
  // Qubi's made-up runs; a database without migration 0002 still gets the rest of the demo.
  await store.batch(qubiDemoStmts(g.repos, now)).catch(() => undefined);
  await setState(store, "webhook_at", String(now), now);
  await setState(store, "demo_tick", String(now), now);
  return true;
}

/** While someone watches: every 15 seconds, one to three new commits in one push, as a webhook would bring them. */
export async function demoTick(store, now = Date.now()) {
  const last = Number((await getState(store, "demo_tick")) ?? 0);
  if (now - last < 15_000) return false;
  const claim = await store.run("UPDATE state SET value = ?, updated_at = ? WHERE key = 'demo_tick' AND value = ?", String(now), now, String(last));
  if (!claim.changes) return false;
  const r = rng(Math.floor(now / 1000));
  const g = cast();
  const person = r.pick(g.people);
  const team = TEAMS.find((t) => t.slug === person.team);
  const repoName = r.pick(team.repos);
  const repo = await store.first("SELECT id FROM repos WHERE full_name = ?", `${ORG}/${repoName}`);
  if (!repo) return false;
  const kind = KIND[team.slug];
  const n = r.int(1, 3);
  const agent = r.next() < person.share ? person.main : null;
  const branch = r.next() < 0.6 ? "main" : `${agent && ["claude", "cursor", "codex"].includes(agent) ? agent : "feature"}/${r.pick(THINGS[kind]).replace(/\W+/g, "-")}`;
  const stmts = [];
  let head = null;
  for (let i = 0; i < n; i++) {
    const sha = r.hex();
    head = sha;
    const message = `${r.pick(VERBS)} ${r.pick(THINGS[kind])}${agent && TRAILER[agent]?.() ? `\n\n${TRAILER[agent]()}` : ""}`;
    const who = detectAgent({ login: person.login, name: agent === "aider" ? `${person.name} (aider)` : person.name, message });
    const add = r.size(30), del = Math.round(add * r.next() * 0.6);
    const path = `${r.pick(DIRS[kind])}/${r.pick(THINGS[kind]).replace(/\W+/g, "_")}${r.pick(EXT[kind])}`;
    stmts.push({ sql: `INSERT OR IGNORE INTO commits (${COMMIT_COLS.join(", ")}) VALUES (${COMMIT_COLS.map(() => "?").join(",")})`,
      binds: [repo.id, sha, now - (n - i) * 20_000, branch, branch === "main" ? 1 : 0, person.login, person.name, who.agent, 0, message, add, del, 1, null, 1] });
    stmts.push({ sql: "INSERT OR IGNORE INTO commit_files (repo_id, sha, path) VALUES (?,?,?)", binds: [repo.id, sha, path] });
  }
  stmts.push({ sql: `INSERT OR IGNORE INTO pushes (${PUSH_COLS.join(", ")}) VALUES (${PUSH_COLS.map(() => "?").join(",")})`,
    binds: [`push:${repo.id}:${branch}:${head}`, repo.id, branch, now, person.login, head, null, n, 0, 0, agent] });
  stmts.push({ sql: "UPDATE people SET last_at = ? WHERE login = ?", binds: [now, person.login] });
  stmts.push({ sql: "UPDATE state SET value = ?, updated_at = ? WHERE key = 'webhook_at'", binds: [String(now), now] });
  await store.batch(stmts);
  return true;
}

/**
 * A made-up diff for a demo commit or pull request, the same every time for the same commit: plausible code in the
 * file's language, so the diff view can be tried. Lock files come out long, to show how the page folds them.
 */
export function demoFiles(paths, sha, totals = { additions: 40, deletions: 10 }) {
  const r = rng(parseInt(sha.slice(0, 8), 16) || 1);
  const list = paths.length ? paths : ["src/index.ts"];
  const files = list.map((path, i) => {
    const lock = /lock|\.lock$/.test(path) || path.endsWith(".json") && /package/.test(path);
    const share = i === list.length - 1 ? 1 : 1 / (list.length - i);
    const add = lock ? r.int(800, 4200) : Math.max(1, Math.round(totals.additions * share * (0.6 + r.next() * 0.8)));
    const del = lock ? r.int(300, 2000) : Math.round(totals.deletions * share * (0.4 + r.next()));
    return { filename: path, status: i === 0 && r.next() < 0.2 ? "added" : "modified", additions: add, deletions: del, patch: fakePatch(r, path, add, del) };
  });
  return files;
}

function fakePatch(r, path, add, del) {
  const ext = path.split(".").pop();
  const line = () => {
    const name = r.pick(["user", "order", "invoice", "session", "token", "result", "items", "retry", "config", "event"]);
    switch (ext) {
      case "py": return r.pick([`    ${name} = fetch_${name}(client, timeout=30)`, `    if not ${name}:`, `        return None`, `def handle_${name}(payload):`, `    logger.info("handled %s", ${name})`]);
      case "go": return r.pick([`\t${name}, err := s.load${cap(name)}(ctx, id)`, "\tif err != nil {", "\t\treturn nil, err", "\t}", `func (s *Service) ${cap(name)}(ctx context.Context) error {`]);
      case "tf": return r.pick([`  ${name}_count = var.${name}_count`, `resource "aws_${name}" "main" {`, "  tags = local.tags", "}"]);
      case "yaml": case "yml": return r.pick([`  ${name}: true`, `  replicas: ${r.int(2, 8)}`, `    - name: ${name}`, `  timeout: ${r.int(5, 60)}s`]);
      case "json": return r.pick([`    "${name}-lib": "^${r.int(1, 9)}.${r.int(0, 20)}.${r.int(0, 9)}",`, `      "integrity": "sha512-${r.hex(32)}",`, `      "resolved": "https://registry.npmjs.org/${name}/-/${name}-${r.int(1, 9)}.0.0.tgz",`]);
      case "lock": return r.pick([`${name} = "${r.int(1, 9)}.${r.int(0, 20)}.${r.int(0, 9)}"`, `checksum = "${r.hex(32)}"`]);
      case "swift": return r.pick([`    let ${name} = try await api.${name}()`, `    guard let ${name} else { return }`, `func load${cap(name)}() async throws {`]);
      case "kt": return r.pick([`    val ${name} = repository.${name}()`, `    if (${name} == null) return`, `fun load${cap(name)}() {`]);
      case "md": return r.pick([`The ${name} is checked before it is saved.`, `## ${cap(name)}`, `- ${cap(name)} is retried three times.`]);
      case "css": return r.pick([`  color: var(--${name});`, `.${name} {`, "}", `  padding: ${r.int(2, 24)}px;`]);
      case "sql": return r.pick([`SELECT ${name}_id, COUNT(*) FROM ${name}s`, `  WHERE created_at >= :since`, `GROUP BY ${name}_id;`]);
      default: return r.pick([`  const ${name} = await get${cap(name)}(id);`, `  if (!${name}) return null;`, `export function ${name}Of(input) {`, `  return { ...${name}, updatedAt: Date.now() };`, "}"]);
    }
  };
  const out = [];
  let a = r.int(1, 400), b = a, left = add + del;
  while (left > 0) {
    const hunkAdd = Math.min(add, r.int(1, 30)), hunkDel = Math.min(del, r.int(0, 12));
    out.push(`@@ -${a},${hunkDel + 3} +${b},${hunkAdd + 3} @@`);
    for (let i = 0; i < 2; i++) out.push(` ${line()}`);
    for (let i = 0; i < hunkDel; i++) out.push(`-${line()}`);
    for (let i = 0; i < hunkAdd; i++) out.push(`+${line()}`);
    out.push(` ${line()}`);
    add -= hunkAdd; del -= hunkDel; left = add + del;
    a += hunkDel + r.int(10, 80); b += hunkAdd + r.int(10, 80);
    if (hunkAdd === 0 && hunkDel === 0) break;
  }
  return out.join("\n");
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);
