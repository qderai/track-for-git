// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Qubi, Track for Git's reviewer: reviews pull requests and pushes to the default branch, runs bug hunts on a schedule
 * or on demand, and opens fix PRs when the operator allows it, with the operator's own model API key and GitHub App.
 *
 *   webhook   the dashboard's own webhook (push, pull_request) only queues: a pull request head at once, a push once
 *             the branch has been quiet for quiet_minutes (a burst of pushes is one review). Qubi's own fix branches
 *             (qubi/*) and their merges are never reviewed again.
 *   tick      the minute cron: queues the scheduled bug hunts, then works the queue one job at a time. The caps are
 *             checked before every paid run; a job over a cap is marked "capped", never kept for later.
 *   api       GET /api/qubi (any signed-in viewer: status, spend, runs, findings; never a key) and, for the people in
 *             QUBI_ADMINS only, POST /api/qubi/settings and POST /api/qubi/run. Every change is logged with who made it.
 */
import { getState, setState } from "../db.js";
import { json } from "../http.js";
import { repoMatcher } from "../sync.js";
import { githubMode, qubiGitHub } from "./github.js";
import { providerOf } from "./providers/index.js";
import { RunError, runJob } from "./review.js";
import {
  ceilings, claimJob, cleanPatch, finishJob, findingStmt, getSettings, huntDue, huntState, logChange, mayRun, nextHunt,
  outsideOk, outsideUsage, queuePr, queuePush, queueRun, saveSettings, setHuntState, setJobCost, spend,
} from "./state.js";

const SHA = /^[0-9a-f]{40}$/;
const OURS = /^qubi\//;

/** Pure. What a webhook delivery asks Qubi to do: a job to queue, or why not. */
export function webhookJob(event, p) {
  const repo = String(p?.repository?.full_name ?? "").toLowerCase();
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo)) return { kind: "none", why: "no repository" };
  if (event === "push") {
    if (p.ref !== `refs/heads/${p.repository?.default_branch}`) return { kind: "none", why: "not the default branch" };
    if (p.deleted || !SHA.test(String(p.after)) || /^0+$/.test(p.after)) return { kind: "none", why: "branch deleted" };
    const commits = Array.isArray(p.commits) ? p.commits : [];
    const merge = (c) => /^Merge pull request #\d+ from [\w.-]+\/qubi\//.test(String(c?.message ?? ""));
    if (commits.length && commits.every(merge)) return { kind: "none", why: "only merges of Qubi's fix PRs" };
    return { kind: "push", repo, before: String(p.before ?? ""), head: p.after, author: String(p.sender?.login ?? "").toLowerCase() };
  }
  if (event === "pull_request") {
    const pr = p.pull_request;
    if (!["opened", "synchronize", "reopened", "ready_for_review"].includes(p.action)) return { kind: "none", why: `action ${p.action}` };
    if (!pr || pr.draft) return { kind: "none", why: "draft" };
    if (!SHA.test(String(pr.head?.sha)) || !Number.isInteger(pr.number)) return { kind: "none", why: "no head" };
    const sameRepo = String(pr.head?.repo?.full_name ?? "").toLowerCase() === repo;
    if (sameRepo && OURS.test(String(pr.head?.ref ?? ""))) return { kind: "none", why: "Qubi's own fix PR" };
    // From inside the organisation and from a branch of this repository: trusted. A fork, or a stranger: an allowance of its own.
    const trusted = sameRepo && ["OWNER", "MEMBER", "COLLABORATOR"].includes(pr.author_association);
    return { kind: "pr", repo, pr: pr.number, head: pr.head.sha, title: String(pr.title ?? ""), author: String(pr.user?.login ?? "").toLowerCase(), trusted };
  }
  return { kind: "none", why: `event ${event}` };
}

/** Pure. Which settings are missing for Qubi to run, by name. */
export function missingOf(cfg) {
  const q = cfg.qubi;
  const out = [];
  const provider = providerOf(q.provider, q);
  if (!provider) out.push(`QUBI_PROVIDER (unknown: ${String(q.provider).slice(0, 40)})`);
  else if (provider.problem) out.push(provider.problem);
  if (!q.key) out.push("QUBI_API_KEY");
  if (!githubMode(q)) out.push("QUBI_GITHUB_APP_ID + QUBI_GITHUB_APP_PRIVATE_KEY (or QUBI_GITHUB_TOKEN)");
  return out;
}

/**
 * @param {{ cfg: any, store: any, fetchImpl: typeof fetch }} deps
 */
export function createQubi({ cfg, store, fetchImpl }) {
  const ceil = ceilings(cfg);
  const provider = providerOf(cfg.qubi.provider, cfg.qubi);
  const ready = !cfg.demo && missingOf(cfg).length === 0;
  // Shown when something of Qubi is set (or in the demo, to show what it is); an app that embeds the dashboard and
  // sets nothing sees no Qubi at all.
  const visible = cfg.demo || !!(cfg.qubi.key || githubMode(cfg.qubi) || cfg.qubi.admins.length);
  const matches = repoMatcher(cfg.repos, cfg.org);
  let ai = null;
  const aiOf = () => (ai ??= { provider, client: provider.create({ key: cfg.qubi.key, fetchImpl, baseUrl: cfg.qubi.apiUrl }) });
  const gh = () => qubiGitHub(cfg, fetchImpl);

  /** The repositories Qubi works on: the chosen ones that are watched, or every watched one. */
  async function reposOf(s) {
    const watched = (await store.all("SELECT full_name FROM repos WHERE removed = 0 ORDER BY full_name")).map((r) => String(r.full_name).toLowerCase());
    return s.repos.length ? watched.filter((r) => s.repos.includes(r)) : watched;
  }

  async function onWebhook(event, payload, now = Date.now()) {
    if (!ready || (event !== "push" && event !== "pull_request")) return null;
    const job = webhookJob(event, payload);
    if (job.kind === "none") return job.why;
    if (!matches(job.repo)) return "not a watched repository";
    const s = await getSettings(store, ceil);
    // Queued while switched off too would only pile up: nothing is kept for later.
    if (!s.enabled || !s.triggers[job.kind]) return `${job.kind} reviews are off`;
    if (s.repos.length && !s.repos.includes(job.repo)) return "this repository is off";
    if (job.kind === "pr") return (await queuePr(store, job, now)) ? "queued" : "already queued";
    return queuePush(store, job, s.quiet_minutes, now);
  }

  async function runOne(s, job, now) {
    const manual = !!job.requested_by;
    const repos = await reposOf(s);
    const off = !repos.includes(job.repo) ? "this repository is off"
      : !manual && job.kind !== "hunt" && !s.triggers[job.kind] ? `${job.kind} reviews are off` : "";
    if (off) return finishJob(store, job.id, { status: "skipped", note: off }, now);
    // "Run now" runs while the automatic reviews are off; never past a pause or a cap.
    const gate = mayRun(manual ? { ...s, enabled: true } : s, (await spend(store, now)).week, now);
    if (!gate.ok) return finishJob(store, job.id, { status: s.enabled || manual ? "capped" : "skipped", note: gate.why }, now);
    if (job.kind === "pr" && !job.trusted) {
      const o = outsideOk(s, await outsideUsage(store, job.author ?? "", now, job.id));
      if (!o.ok) return finishJob(store, job.id, { status: "capped", note: o.why }, now);
    }
    try {
      const r = await runJob({ cfg, store, gh: gh(), ai: aiOf() }, job, s, { onCost: (usd) => setJobCost(store, job.id, usd) });
      await store.batch(r.findings.map((f) => findingStmt({ ...f, job: job.id, repo: job.repo, sha: r.head }, now)));
      await finishJob(store, job.id, { status: r.status, cost: r.cost, findings: r.findings.length, fixPrs: r.fixPrs, url: r.url, note: r.note, model: r.model }, Date.now());
    } catch (e) {
      await finishJob(store, job.id, { status: "failed", cost: e instanceof RunError ? e.cost : undefined, note: String(e?.message ?? e).slice(0, 300) }, Date.now());
    }
  }

  /** The minute tick. */
  async function tick(now = Date.now()) {
    if (!ready) return { skipped: true };
    await setState(store, "qubi:last_tick", String(now), now);
    const s = await getSettings(store, ceil);
    if (s.enabled) {
      const due = huntDue(s.hunt, now, await huntState(store), cfg.timeZone);
      if (due.due) {
        // The day is claimed first: a second tick meanwhile queues nothing.
        await setHuntState(store, due.date, now);
        for (const repo of await reposOf(s)) await queueRun(store, { kind: "hunt", repo }, now);
      }
    }
    const job = await claimJob(store, now);
    if (job) await runOne(s, job, now);
    return { ran: job ? job.id : null };
  }

  // ---------------------------------------------------------------------------------------------------- the page's API

  const canEdit = (user) => {
    if (cfg.demo) return { ok: false, why: "the demo cannot change Qubi" };
    if (!user?.id) return { ok: false, why: "changing Qubi needs a sign-in (AUTH=access or AUTH=github)" };
    const a = cfg.qubi.admins;
    if (!a.length) return { ok: false, why: "nobody may change Qubi yet: set QUBI_ADMINS" };
    return a.includes("*") || a.includes(String(user.id).toLowerCase()) ? { ok: true } : { ok: false, why: "only the people in QUBI_ADMINS may change Qubi" };
  };

  async function view(user, now) {
    const s = await getSettings(store, ceil);
    const [sp, lastTick, huntDate, jobs, findings, log, repos] = await Promise.all([
      spend(store, now), getState(store, "qubi:last_tick"), huntState(store),
      store.all("SELECT id, kind, repo, pr, base, head, focus, title, author, trusted, status, created_at, started_at, finished_at, model, cost_usd, findings, fix_prs, posted_url, note, requested_by FROM qubi_jobs ORDER BY id DESC LIMIT 40"),
      store.all("SELECT job_id, repo, sha, path, line, severity, kind, title, url, fix_url, created_at FROM qubi_findings ORDER BY id DESC LIMIT 40"),
      store.all("SELECT at, who, action, detail FROM qubi_log ORDER BY id DESC LIMIT 15"),
      reposOf({ repos: [] }),
    ]);
    const missing = cfg.demo ? [] : missingOf(cfg);
    const ticking = lastTick && now - Number(lastTick) < 3 * 60_000;
    const gate = mayRun(s, sp.week, now);
    const edit = canEdit(user);
    return {
      available: true, demo: cfg.demo, ready, missing, ticking: !!ticking, lastTick: lastTick ? Number(lastTick) : null,
      why: cfg.demo ? "demo" : missing.length ? "missing" : !gate.ok ? gate.why : !ticking ? "the minute tick has not run lately" : null,
      provider: provider ? { id: provider.id, name: provider.name, models: provider.models.map((m) => ({ id: m.id, name: m.name, in: m.rates.in, out: m.rates.out })), defaultModel: provider.defaultModel, defaultHuntModel: provider.defaultHuntModel } : null,
      keySet: !!cfg.qubi.key, github: githubMode(cfg.qubi), admins: cfg.qubi.admins.length, canEdit: edit.ok, editWhy: edit.ok ? null : edit.why,
      settings: s, ceilings: ceil, spend: sp, nextHunt: s.enabled ? nextHunt(s.hunt, now, huntDate, cfg.timeZone) : null, huntTz: s.hunt.tz || cfg.timeZone || "UTC",
      repos, jobs, findings, log,
    };
  }

  /** Cross-site requests cannot change anything: a JSON body, sent from this very origin. */
  const sameOrigin = (req, url) => [url.origin, cfg.qubi.origin].filter(Boolean).includes(req.headers.get("origin") ?? "") &&/^application\/json\b/i.test(req.headers.get("content-type") ?? "");

  async function api(req, url, user, now = Date.now()) {
    const p = url.pathname;
    if (p === "/api/qubi" && req.method === "GET") return json(await view(user, now));
    if (req.method !== "POST" || !["/api/qubi/settings", "/api/qubi/run"].includes(p)) return json({ error: "not_found" }, 404);
    if (!sameOrigin(req, url)) return json({ error: "send JSON from the dashboard itself" }, 403);
    const edit = canEdit(user);
    if (!edit.ok) return json({ error: edit.why }, 403);
    let body;
    try { body = await req.json(); } catch { return json({ error: "a JSON body is needed" }, 400); }
    const who = String(user.id);

    if (p === "/api/qubi/settings") {
      const { patch, error } = cleanPatch(body, ceil);
      if (error) return json({ error }, 400);
      if (patch.repos) {
        const watched = await reposOf({ repos: [] });
        const unknown = patch.repos.filter((r) => !watched.includes(r));
        if (unknown.length) return json({ error: `not watched by the dashboard: ${unknown.slice(0, 5).join(", ")}` }, 400);
      }
      // Switching hunts on (or Qubi itself) after today's hunt time: the first one is the next, not a surprise one now.
      const before = await getSettings(store, ceil);
      const after = { ...before, ...patch, hunt: { ...before.hunt, ...(patch.hunt ?? {}) } };
      if (after.enabled && (!before.enabled || before.hunt.every === "off") && huntDue(after.hunt, now, await huntState(store), cfg.timeZone).due) {
        await setHuntState(store, huntDue(after.hunt, now, null, cfg.timeZone).date, now);
      }
      return json({ settings: await saveSettings(store, patch, who, ceil, now) });
    }

    // "Run now": a paid run, so it must say so.
    if (body?.confirm !== true) return json({ error: "a paid run needs confirm: true" }, 400);
    if (!ready) return json({ error: `Qubi is not set up: ${missingOf(cfg).join(", ")}` }, 409);
    const s = await getSettings(store, ceil);
    const repo = String(body.repo ?? "").toLowerCase();
    const repos = await reposOf(s);
    const targets = repo === "all" && body.kind === "hunt" ? repos : repos.includes(repo) ? [repo] : [];
    if (!targets.length) return json({ error: "repo is one of Qubi's repositories (or all, for a bug hunt)" }, 400);
    const sp = await spend(store, now);
    if (sp.week + targets.length * s.per_run_usd > s.weekly_usd + 1e-9) {
      return json({ error: `that could pass the weekly cap ($${sp.week.toFixed(2)} of $${s.weekly_usd} spent; up to $${(targets.length * s.per_run_usd).toFixed(2)} more)` }, 409);
    }
    if (s.paused_until && Date.parse(s.paused_until) > now) return json({ error: `paused until ${s.paused_until}` }, 409);
    const queued = [];
    if (body.kind === "hunt") {
      const focus = typeof body.focus === "string" && body.focus.trim() ? body.focus.trim().replace(/^\/+/, "").slice(0, 200) : null;
      if (focus && (/(^|\/)\.\.(\/|$)/.test(focus) || /[\0\\]/.test(focus))) return json({ error: "focus is a folder or file of the repository" }, 400);
      for (const r of targets) queued.push(await queueRun(store, { kind: "hunt", repo: r, focus, who, model: s.hunt_model || null }, now));
    } else if (body.kind === "pr") {
      const n = Number(body.pr);
      if (!Number.isInteger(n) || n < 1) return json({ error: "pr is a pull request number" }, 400);
      queued.push(await queueRun(store, { kind: "pr", repo: targets[0], pr: n, who }, now));
    } else return json({ error: "kind is hunt or pr" }, 400);
    await logChange(store, who, "run", JSON.stringify({ kind: body.kind, repos: targets, pr: body.pr ?? undefined, focus: body.focus ?? undefined, cap: s.per_run_usd }), now);
    // Queued: the minute tick starts it.
    return json({ queued, capPerRun: s.per_run_usd });
  }

  return { ready, visible, onWebhook, tick, api };
}
