// Copyright 2026 Qder AI. Licensed under the Apache License, Version 2.0.
/**
 * The GraphQL queries polling uses. One query asks about several repositories at once (aliases r0, r1, …): their
 * default branch's new commits with line counts and pull request numbers, their recently updated and their open pull
 * requests with review decision, CI and labels, their deploys, releases and tags. That is one request (and a few
 * points of GraphQL's hourly allowance) where REST would need dozens.
 */

const PR_FIELDS = `number title state isDraft merged mergedAt closedAt createdAt updatedAt url additions deletions changedFiles
  headRefName baseRefName headRefOid isCrossRepository authorAssociation reviewDecision author { login }
  labels(first: 10) { nodes { name } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

const COMMIT_FIELDS = `oid message authoredDate committedDate additions deletions changedFilesIfAvailable
  author { name email user { login } } committer { name email user { login } }
  associatedPullRequests(first: 1) { nodes { number } }`;

/**
 * Pure. The snapshot query for a batch of repositories.
 * @param {{ owner: string, name: string, since: string|null, historyAfter: string|null, full: boolean }[]} repos
 *   full: also deploys, releases and tags (every few runs, not every run)
 */
export function snapshotQuery(repos, { deployments = true } = {}) {
  const vars = {};
  const defs = [];
  const parts = repos.map((r, i) => {
    vars[`o${i}`] = r.owner; vars[`n${i}`] = r.name; vars[`s${i}`] = r.since; vars[`a${i}`] = r.historyAfter;
    defs.push(`$o${i}: String!`, `$n${i}: String!`, `$s${i}: GitTimestamp`, `$a${i}: String`);
    return `r${i}: repository(owner: $o${i}, name: $n${i}) {
      databaseId nameWithOwner isArchived isPrivate pushedAt
      defaultBranchRef { name target { ... on Commit { history(first: 100, since: $s${i}, after: $a${i}) { pageInfo { hasNextPage endCursor } nodes { ${COMMIT_FIELDS} } } } } }
      recent: pullRequests(first: 30, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PR_FIELDS} } }
      open: pullRequests(first: 30, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) { totalCount nodes { ${PR_FIELDS} } }
      ${r.full ? `${deployments ? "deployments(first: 20, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { databaseId environment createdAt commitOid ref { name } creator { login } latestStatus { state createdAt } } }" : ""}
      releases(first: 10, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { databaseId name tagName publishedAt createdAt isPrerelease isDraft url tagCommit { oid } author { login } } }
      refs(refPrefix: "refs/tags/", first: 10, orderBy: { field: TAG_COMMIT_DATE, direction: DESC }) { nodes { name target { oid ... on Commit { committedDate } ... on Tag { tagger { date } target { oid ... on Commit { committedDate } } } } } }` : ""}
    }`;
  });
  return { query: `query(${defs.join(", ")}) {\n${parts.join("\n")}\n}`, variables: vars };
}

/** Pure. Older pull requests of one repository, a page further back (backfill). */
export function prPageQuery() {
  return {
    query: `query($o: String!, $n: String!, $a: String) { repository(owner: $o, name: $n) {
      pullRequests(first: 50, after: $a, orderBy: { field: UPDATED_AT, direction: DESC }) { pageInfo { hasNextPage endCursor } nodes { ${PR_FIELDS} } } } }`,
  };
}

/** Pure. Line counts of commits polling found on other branches (they come from REST without them). */
export function commitStatsQuery(items) {
  const vars = {};
  const defs = [];
  const parts = items.map((c, i) => {
    vars[`o${i}`] = c.owner; vars[`n${i}`] = c.name; vars[`h${i}`] = c.sha;
    defs.push(`$o${i}: String!`, `$n${i}: String!`, `$h${i}: GitObjectID!`);
    return `c${i}: repository(owner: $o${i}, name: $n${i}) { object(oid: $h${i}) { ... on Commit { oid additions deletions changedFilesIfAvailable associatedPullRequests(first: 1) { nodes { number } } } } }`;
  });
  return { query: `query(${defs.join(", ")}) {\n${parts.join("\n")}\n}`, variables: vars };
}

/** Pure. The CI rollup of one commit (after a check webhook). */
export function ciQuery() {
  return { query: `query($o: String!, $n: String!, $h: GitObjectID!) { repository(owner: $o, name: $n) { object(oid: $h) { ... on Commit { statusCheckRollup { state } } } } }` };
}

/** Pure. Repositories named one by one (REPOS without an organisation). */
export function reposQuery(names) {
  const vars = {};
  const defs = [];
  const parts = names.map((full, i) => {
    const [o, n] = full.split("/");
    vars[`o${i}`] = o; vars[`n${i}`] = n;
    defs.push(`$o${i}: String!`, `$n${i}: String!`);
    return `r${i}: repository(owner: $o${i}, name: $n${i}) { databaseId nameWithOwner isArchived isPrivate pushedAt defaultBranchRef { name } }`;
  });
  return { query: `query(${defs.join(", ")}) {\n${parts.join("\n")}\n}`, variables: vars };
}
