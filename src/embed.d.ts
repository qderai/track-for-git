// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/** Types for `track-for-git/embed` (src/embed.js): Track for Git mounted inside another app. */

/** The small database interface Track for Git runs on (src/db.js). */
export interface Store {
  kind: "d1" | "sqlite";
  all(sql: string, ...binds: unknown[]): Promise<any[]>;
  first(sql: string, ...binds: unknown[]): Promise<any | null>;
  run(sql: string, ...binds: unknown[]): Promise<{ changes: number }>;
  batch(stmts: { sql: string; binds?: unknown[] }[]): Promise<void>;
}

/** A deploy (or release) from the app's own pipeline, drawn among GitHub's on the timeline and in the Story. */
export interface HookMarker {
  /** Unique and stable for this deploy: the same id is the same marker. */
  id: string;
  /** "owner/name" of a watched repository; markers of other repositories are left out. */
  repo: string;
  kind?: "deploy" | "release";
  /** "success", "failure", "error", "in_progress", "pending", "inactive"… failure and error are drawn as failed. */
  state?: string;
  environment?: string | null;
  name?: string | null;
  /** The commit it deployed (40 hex characters). */
  sha?: string | null;
  /** Milliseconds since the epoch: when it started, and when it finished (the marker sits at finishedAt). */
  at: number;
  finishedAt?: number | null;
  actor?: string | null;
  url?: string | null;
}

/** What runs now, for the "Live now" tile. */
export interface HookLive {
  repo: string;
  sha: string;
  environment?: string | null;
  name?: string | null;
  at?: number | null;
  url?: string | null;
}

export interface Hooks {
  /** The app's own deploys in [from, to). Called at most every few seconds; a throw adds nothing. */
  markers?: (range: { from: number; to: number }) => HookMarker[] | Promise<HookMarker[]>;
  /** What runs now. Without it, the newest successful deploy (production first). A throw or null hides the tile. */
  live?: () => HookLive | null | Promise<HookLive | null>;
}

export interface MountOptions {
  /** Where the dashboard lives in the app: "/tools/code/". Default "/". */
  base?: string;
  /** Track for Git's settings (GITHUB_ORG, REPOS, GITHUB_TOKEN, AUTH, TIME_ZONE…): README and docs/setup.md. */
  env: Record<string, unknown>;
  store: Store;
  hooks?: Hooks;
  /** The Worker's edge cache (caches.default), for answers and diffs. */
  edgeCache?: unknown;
  fetchImpl?: typeof fetch;
  waitUntil?: (p: Promise<unknown>) => void;
  /** Who may show the page in a frame: "'none'" (default), "'self'", or https origins separated by spaces. */
  frameAncestors?: string;
}

export interface Mounted {
  base: string;
  cfg: Record<string, any>;
  app: { fetch(request: Request): Promise<Response>; scheduled(now?: number): Promise<any> };
  /** A Response for a path under base; null for every other path. */
  fetch(request: Request): Promise<Response | null>;
  /** GitHub's webhook deliveries, at whatever address the app receives them. */
  webhook(request: Request): Promise<Response>;
  /** One sync run, from the app's cron (once a minute). */
  scheduled(now?: number): Promise<any>;
}

export function mount(opts: MountOptions): Mounted;

/** History from an earlier tool; `repo_id` is GitHub's repository id (from the `repos` table, after the first sync). */
export interface ImportRows {
  commits?: { repo_id: number; sha: string; at: number; branch?: string | null; on_default?: boolean | number; author_login?: string | null;
    author_name?: string | null; agent?: string | null; bot?: boolean | number; message?: string | null; additions?: number | null;
    deletions?: number | null; files_n?: number | null; pr_number?: number | null }[];
  pushes?: { repo_id: number; branch: string | null; head: string; at: number; actor?: string | null; before?: string | null;
    commits_n?: number; forced?: boolean | number; created?: boolean | number; agent?: string | null }[];
  prs?: { repo_id: number; number: number; title?: string | null; state: "open" | "closed"; merged?: boolean | number; draft?: boolean | number;
    author_login?: string | null; agent?: string | null; bot?: boolean | number; head_ref?: string | null; base_ref?: string | null;
    created_at?: number | null; updated_at?: number | null; merged_at?: number | null; closed_at?: number | null; url?: string | null }[];
}
/** Never over what GitHub said: commits fill empty fields only; pushes and pull requests are added only when missing. */
export function importHistory(store: Store, rows: ImportRows): Promise<{ commits: number; pushes: number; prs: number; skipped: number }>;
export function d1Store(d1: unknown): Store;
export function sqliteStore(db: unknown): Store;
export function migrateSqlite(db: unknown, migrations: { name: string; sql: string }[]): void;
export function normalBase(base?: string): string;
export function frameAncestorsOf(v?: string): string;
export function pageHeaders(frameAncestors?: string): Record<string, string>;
export function rebase(html: string, base: string): string;
