-- Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
-- Qubi, the reviewer (src/qubi/): reviews pull requests and pushes to the default branch and runs bug hunts with the
-- operator's own model API key, under spend caps the server enforces. Everything here is off until the operator sets
-- a key and switches Qubi on. Times are milliseconds since the epoch, UTC. Repositories are full names ("acme/api").
--
-- qubi_settings  one row per setting, its value JSON (src/qubi/state.js DEFAULTS has the keys)
-- qubi_jobs      the work queue: one row per run
--   kind pr | push | hunt; pr: the pull request's number; base..head the reviewed range (pr and hunt: head only);
--   trusted 0 for a pull request from outside the organisation (its own small allowance, never a fix PR);
--   status pending → running → done | failed | skipped | capped; due_at when it may start (a push waits for the
--   branch to be quiet); cost_usd what the run cost so far, written after every model call; posted_url the review
--   or comment on GitHub; focus a path a bug hunt keeps to
-- qubi_findings  what each run found and could back up with the file's own text
-- qubi_log       every change of the settings and every "Run now", with who made it
CREATE TABLE IF NOT EXISTS qubi_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS qubi_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  repo         TEXT NOT NULL,
  pr           INTEGER,
  base         TEXT,
  head         TEXT,
  focus        TEXT,
  title        TEXT,
  author       TEXT,
  trusted      INTEGER NOT NULL DEFAULT 1,
  status       TEXT NOT NULL DEFAULT 'pending',
  due_at       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  started_at   INTEGER,
  beat_at      INTEGER,                         -- a running job's last sign of life (each model call)
  finished_at  INTEGER,
  model        TEXT,
  cost_usd     REAL NOT NULL DEFAULT 0,
  findings     INTEGER NOT NULL DEFAULT 0,
  fix_prs      INTEGER NOT NULL DEFAULT 0,
  posted_url   TEXT,
  note         TEXT,
  requested_by TEXT
);
CREATE INDEX IF NOT EXISTS qubi_jobs_status_due ON qubi_jobs (status, due_at);
CREATE INDEX IF NOT EXISTS qubi_jobs_started ON qubi_jobs (started_at);
-- One review per pull request head: a redelivery or a second webhook for the same push never queues it twice.
CREATE UNIQUE INDEX IF NOT EXISTS qubi_jobs_pr_head ON qubi_jobs (repo, pr, head) WHERE kind = 'pr';

CREATE TABLE IF NOT EXISTS qubi_findings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL,
  repo       TEXT NOT NULL,
  sha        TEXT NOT NULL,
  path       TEXT,
  line       INTEGER,
  severity   TEXT NOT NULL,
  kind       TEXT NOT NULL,
  title      TEXT NOT NULL,
  url        TEXT,
  fix_url    TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS qubi_findings_created ON qubi_findings (created_at);

CREATE TABLE IF NOT EXISTS qubi_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  who    TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
