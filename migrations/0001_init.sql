-- Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
-- Track for Git: what the dashboard keeps. Metadata only (who, when, which repository, how many lines, which
-- paths); a diff is never stored: it is fetched from GitHub when someone opens a commit or a pull request and kept
-- in the HTTP cache. Rows older than RETENTION_DAYS (180 by default) are deleted every night.
--
-- Logins are stored in lower case (GitHub logins are case-insensitive). Times are milliseconds since the epoch, UTC.

-- Every repository the dashboard watches. id is GitHub's own repository id, so a rename keeps its history.
CREATE TABLE IF NOT EXISTS repos (
  id               INTEGER PRIMARY KEY,
  full_name        TEXT NOT NULL,
  default_branch   TEXT,
  private          INTEGER NOT NULL DEFAULT 0,
  archived         INTEGER NOT NULL DEFAULT 0,
  removed          INTEGER NOT NULL DEFAULT 0,  -- no longer watched (uninstalled, deleted, filtered out)
  pushed_at        INTEGER,                     -- GitHub's last push, from the listing or a webhook
  synced_pushed_at INTEGER,                     -- the pushed_at the last sync saw
  synced_at        INTEGER,
  dirty            INTEGER NOT NULL DEFAULT 0,  -- a webhook said a review or a check changed: refresh soon
  history_at       INTEGER,                     -- the default branch is complete up to here
  history_cursor   TEXT,                        -- a walk back through the default branch, in progress
  history_since    INTEGER,
  history_started  INTEGER,
  prs_at           INTEGER,                     -- pull requests are complete up to this update time
  events_etag      TEXT,
  open_prs         INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS repos_full_name ON repos (full_name COLLATE NOCASE);

-- One commit, seen on any branch. agent: the AI agent that wrote it or helped (src/agents.js), NULL for a person
-- working alone. bot: an automation account (Dependabot, Renovate…). branch: where it was first seen.
CREATE TABLE IF NOT EXISTS commits (
  repo_id      INTEGER NOT NULL,
  sha          TEXT NOT NULL,
  at           INTEGER NOT NULL,
  branch       TEXT,
  on_default   INTEGER NOT NULL DEFAULT 0,
  author_login TEXT,
  author_name  TEXT,
  agent        TEXT,
  bot          INTEGER NOT NULL DEFAULT 0,
  message      TEXT NOT NULL DEFAULT '',
  additions    INTEGER,
  deletions    INTEGER,
  files_n      INTEGER,
  pr_number    INTEGER,
  paths_known  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, sha)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS commits_at ON commits (at);
CREATE INDEX IF NOT EXISTS commits_repo_at ON commits (repo_id, at);
CREATE INDEX IF NOT EXISTS commits_author_at ON commits (author_login, at);
CREATE INDEX IF NOT EXISTS commits_agent_at ON commits (agent, at);

-- The paths a commit touched, for the path filter. Webhooks deliver them for every commit; polling fills them for
-- the newest commits as the rate limit allows.
CREATE TABLE IF NOT EXISTS commit_files (
  repo_id INTEGER NOT NULL,
  sha     TEXT NOT NULL,
  path    TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS commit_files_path ON commit_files (path);

-- One push of one head to one branch: the same id from the webhook and from polling.
CREATE TABLE IF NOT EXISTS pushes (
  id        TEXT PRIMARY KEY,
  repo_id   INTEGER NOT NULL,
  branch    TEXT,
  at        INTEGER NOT NULL,
  actor     TEXT,
  head      TEXT,
  before    TEXT,
  commits_n INTEGER NOT NULL DEFAULT 0,
  forced    INTEGER NOT NULL DEFAULT 0,
  created   INTEGER NOT NULL DEFAULT 0,
  agent     TEXT
);
CREATE INDEX IF NOT EXISTS pushes_at ON pushes (at);

-- The latest state of each pull request. review: approved | changes_requested | review_required | commented.
-- CI is in `ci`, by the head commit.
CREATE TABLE IF NOT EXISTS prs (
  repo_id      INTEGER NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  state        TEXT NOT NULL,                 -- open | closed
  merged       INTEGER NOT NULL DEFAULT 0,
  draft        INTEGER NOT NULL DEFAULT 0,
  author_login TEXT,
  agent        TEXT,
  bot          INTEGER NOT NULL DEFAULT 0,
  head_ref     TEXT,
  base_ref     TEXT,
  head_sha     TEXT,
  created_at   INTEGER,
  updated_at   INTEGER,
  merged_at    INTEGER,
  closed_at    INTEGER,
  review       TEXT,
  additions    INTEGER,
  deletions    INTEGER,
  files_n      INTEGER,
  labels       TEXT NOT NULL DEFAULT '[]',    -- JSON array of label names
  url          TEXT,
  PRIMARY KEY (repo_id, number)
);
CREATE INDEX IF NOT EXISTS prs_updated ON prs (updated_at);
CREATE INDEX IF NOT EXISTS prs_state ON prs (state, updated_at);
CREATE INDEX IF NOT EXISTS prs_merged ON prs (merged_at);
CREATE INDEX IF NOT EXISTS prs_created ON prs (created_at);

-- CI on a commit: success | failure | pending, from GitHub's status rollup or a check webhook.
CREATE TABLE IF NOT EXISTS ci (
  repo_id INTEGER NOT NULL,
  sha     TEXT NOT NULL,
  state   TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (repo_id, sha)
) WITHOUT ROWID;

-- Deploys (GitHub Deployments), releases and tags, drawn on the timeline.
CREATE TABLE IF NOT EXISTS markers (
  id          TEXT PRIMARY KEY,               -- deploy:<repo id>:<id> | release:<repo id>:<id> | tag:<repo id>:<name>
  repo_id     INTEGER NOT NULL,
  kind        TEXT NOT NULL,                  -- deploy | release | tag
  name        TEXT,
  environment TEXT,
  state       TEXT,
  sha         TEXT,
  ref         TEXT,
  at          INTEGER NOT NULL,
  finished_at INTEGER,
  actor       TEXT,
  url         TEXT,
  prerelease  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS markers_at ON markers (at);

-- The organisation's teams (GitHub, or the TEAMS setting) and who is in them.
CREATE TABLE IF NOT EXISTS teams (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team  TEXT NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (team, login)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS team_members_login ON team_members (login);

-- Everyone who has committed, with the last time, for the people filter.
CREATE TABLE IF NOT EXISTS people (
  login   TEXT PRIMARY KEY,
  name    TEXT,
  last_at INTEGER NOT NULL
);

-- Webhook deliveries already handled (GitHub redelivers), kept two days.
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);

-- Small settings and bookkeeping: the sync lock, the rate limit, the last webhook, the last error.
CREATE TABLE IF NOT EXISTS state (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER NOT NULL
);
