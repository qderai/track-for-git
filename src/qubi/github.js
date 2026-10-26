// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * Qubi's own way into GitHub, apart from the dashboard's read-only one: a GitHub App of the operator's
 * (QUBI_GITHUB_APP_ID + QUBI_GITHUB_APP_PRIVATE_KEY, recommended) or a fine-grained token (QUBI_GITHUB_TOKEN).
 *
 * With an App every token is minted for one repository and only the permissions a step needs: the model's tools read
 * through a token that can read that one repository and nothing else, so a pull request that talks the model into
 * something still cannot reach another repository or write anything. Posting the review, and opening a fix PR when the
 * operator allows it, gets its own token after the model is done. Tokens stay in memory; nothing is logged or stored.
 */
import { appJwt } from "../github/app-auth.js";

export class GhError extends Error {
  constructor(status, what, message) { super(`GitHub ${what}: ${status}${message ? ` (${message})` : ""}`); this.status = status; }
}

const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[\w-][\w.-]*\/[\w-][\w.-]*$/;

/** Pure. A repository path for the contents API: plain segments only, each encoded; null for anything else. */
export function repoPath(p) {
  const clean = String(p ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.length > 400 || /[%?#\\\0]/.test(clean) || clean.split("/").some((s) => s === ".." || s === ".")) return null;
  return clean.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Which credentials Qubi has, never their values. */
export const githubMode = (q) => (q.appId && q.appKey ? "app" : q.token ? "token" : null);

const installs = new Map();   // owner → installation id
const tokens = new Map();     // repo|permissions → { token, expires }

/** For tests. */
export const forgetQubiTokens = () => { installs.clear(); tokens.clear(); };

/**
 * @param {{ apiUrl: string, qubi: { appId: string, appKey: string, installationId: string, token: string } }} cfg
 * @param {typeof fetch} fetchImpl
 */
export function qubiGitHub(cfg, fetchImpl, now = Date.now) {
  const q = cfg.qubi;
  const mode = githubMode(q);
  const headers = (auth, extra = {}) => ({ authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "track-for-git-qubi", ...extra });

  async function gh(path, token, init = {}) {
    const res = await fetchImpl(cfg.apiUrl + path, {
      ...init,
      headers: headers(token, { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) }),
    });
    if (res.status === 204) return {};
    const text = await res.text();
    if (!res.ok) {
      let msg = "";
      try { msg = String(JSON.parse(text)?.message ?? "").slice(0, 160); } catch { /* not JSON */ }
      throw new GhError(res.status, `${init.method ?? "GET"} ${path.split("?")[0]}`, msg);
    }
    if (init.raw) return text;
    try { return JSON.parse(text); } catch { return text; }
  }

  /** A token for one repository with the permissions asked for (an App), or the fine-grained token. */
  async function token(repo, permissions) {
    if (!REPO.test(repo)) throw new Error(`not a repository: ${String(repo).slice(0, 80)}`);
    if (mode === "token") return q.token;
    if (mode !== "app") throw new Error("Qubi has no GitHub credentials: set QUBI_GITHUB_APP_ID and QUBI_GITHUB_APP_PRIVATE_KEY, or QUBI_GITHUB_TOKEN");
    const key = `${repo.toLowerCase()}|${JSON.stringify(permissions)}`;
    const hit = tokens.get(key);
    if (hit && hit.expires - 5 * 60_000 > now()) return hit.token;
    const jwt = await appJwt(q.appId, q.appKey, now());
    const [owner, name] = repo.split("/");
    let id = q.installationId || installs.get(owner.toLowerCase());
    if (!id) {
      id = String((await gh(`/repos/${owner}/${name}/installation`, jwt)).id ?? "");
      if (!id) throw new Error(`Qubi's GitHub App is not installed on ${repo}`);
      installs.set(owner.toLowerCase(), id);
    }
    const t = await gh(`/app/installations/${encodeURIComponent(id)}/access_tokens`, jwt, {
      method: "POST", body: JSON.stringify({ repositories: [name], permissions: { metadata: "read", ...permissions } }),
    });
    tokens.set(key, { token: t.token, expires: Date.parse(t.expires_at) || now() + 55 * 60_000 });
    return t.token;
  }

  /** A file at a commit, as text, or null when it is not there (or not a plain path). */
  async function file(repo, path, ref, tok) {
    const p = repoPath(path);
    if (!p || !SHA.test(ref)) return null;
    try { return await gh(`/repos/${repo}/contents/${p}?ref=${ref}`, tok, { headers: { accept: "application/vnd.github.raw" }, raw: true }); }
    catch (e) { if (e instanceof GhError && (e.status === 404 || (e.status === 403 && /too large/i.test(e.message)))) return null; throw e; }
  }

  return { mode, gh, token, file };
}

/** The permissions of each step. Reading never gets write. */
export const READ = { contents: "read", pull_requests: "read" };
export const POST = { contents: "write", pull_requests: "write" };
