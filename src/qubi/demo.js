// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Made-up Qubi runs and findings for the demo organisation, so the Qubi view shows what it looks like before anyone
 * sets a key. Nothing here talks to GitHub or a model.
 */
const MIN = 60_000, HOUR = 60 * MIN;

/** @param {{ id: number, full_name: string }[]} repos */
export function qubiDemoStmts(repos, now) {
  const pick = (i) => repos[i % repos.length].full_name;
  const sha = (n) => (n.toString(16).repeat(40)).slice(0, 40);
  const jobs = [
    // kind, repo, pr, ago, status, cost, findings, fix PRs, note, author, trusted, focus, requested_by
    ["pr", 0, 214, 12 * MIN, "done", 0.0142, 1, 0, "", "maya", 1, null, null],
    ["push", 1, null, 48 * MIN, "done", 0.0061, 0, 0, "", "noam", 1, null, null],
    ["pr", 2, 88, 2 * HOUR, "done", 0.0213, 2, 1, "1 unconfirmed finding left out", "dev-bot", 1, null, null],
    ["hunt", 0, null, 6 * HOUR, "done", 0.1840, 1, 0, "", null, 1, "src/billing", "dana"],
    ["pr", 3, 41, 9 * HOUR, "capped", 0, 0, 0, "outside author: 3 reviews a week", "stranger", 0, null, null],
    ["push", 2, null, 26 * HOUR, "skipped", 0, 0, 0, "no code changed", "lee", 1, null, null],
    ["hunt", 1, null, 3 * 24 * HOUR, "done", 0.2210, 0, 0, "", null, 1, null, null],
  ];
  const stmts = [
    { sql: "DELETE FROM qubi_findings", binds: [] }, { sql: "DELETE FROM qubi_jobs", binds: [] }, { sql: "DELETE FROM qubi_settings", binds: [] },
  ];
  jobs.forEach(([kind, r, pr, ago, status, cost, findings, fixes, note, author, trusted, focus, who], i) => {
    const at = now - ago;
    stmts.push({ sql: `INSERT INTO qubi_jobs (id, kind, repo, pr, base, head, focus, author, trusted, status, due_at, created_at, started_at, finished_at, model, cost_usd, findings, fix_prs, note, requested_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      binds: [jobs.length - i, kind, pick(r), pr, kind === "push" ? sha(i + 3) : null, sha(i + 4), focus, author, trusted, status, at, at, at, at + 70_000,
        kind === "hunt" ? "claude-sonnet-5-5" : "claude-haiku-5-5", cost, findings, fixes, note, who] });
  });
  const found = [
    [1, 0, "src/api/orders.ts", 118, "high", "bug", "A refund of 0 passes the check and marks the order refunded", 12 * MIN],
    [3, 2, "lib/session.js", 42, "critical", "security", "The session cookie is accepted after its expiry", 2 * HOUR],
    [3, 2, "lib/session.js", 77, "medium", "bug", "Logging out on two tabs at once throws on the second", 2 * HOUR],
    [4, 0, "src/billing/invoice.ts", 63, "high", "bug", "Totals are summed in floating point and drift by a cent", 6 * HOUR],
  ];
  // Ids from the oldest up, as a real queue has them; a finding names its job by its place in the list above.
  for (const [n, r, path, line, severity, kind, title, ago] of found.reverse()) {
    const job = jobs.length - n + 1;
    const repo = pick(r);
    stmts.push({ sql: "INSERT INTO qubi_findings (job_id, repo, sha, path, line, severity, kind, title, url, fix_url, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      binds: [job, repo, sha(job + 3), path, line, severity, kind, title, null, null, now - ago] });
  }
  stmts.push({ sql: "INSERT INTO qubi_settings (key, value, updated_at, updated_by) VALUES ('enabled', 'true', ?, 'demo'), ('hunt', ?, ?, 'demo')",
    binds: [now, JSON.stringify({ every: "week", at: "09:00", day: 1, tz: "" }), now] });
  return stmts;
}
