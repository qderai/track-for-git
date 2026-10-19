# Set up Track for Git

About fifteen minutes, once. You need a Cloudflare account (the free plan is enough to start; Workers Paid is better for
organisations with hundreds of repositories) or any machine that runs Node 22.13+ or Docker. You also need to be an
owner of the GitHub organisation, or have one at hand.

1. [Deploy it](#1-deploy-it)
2. [Connect GitHub, read-only](#2-connect-github-read-only)
3. [Real time: the webhook](#3-real-time-the-webhook)
4. [Put it behind your sign-in](#4-put-it-behind-your-sign-in)
5. [Turn the demo off](#5-turn-the-demo-off)

Every setting is listed in [the reference](#settings) at the end. Secrets are set with `npx wrangler secret put NAME`
(Cloudflare) or in the environment (Node, Docker), and never in a file you commit. When a step asks for a random
secret, make one with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 1. Deploy it

**Cloudflare, one click.** Press the button in the [README](../README.md#quick-start). Cloudflare copies the repository
to your GitHub account, creates the D1 database, applies the migrations and deploys. It first shows the demo
organisation (`DEMO=1`), so you can see it working before you connect anything.

**Cloudflare, from a terminal.**

```sh
git clone https://github.com/qderai/track-for-git && cd track-for-git
npm install
npx wrangler login
npm run deploy        # creates the D1 database on the first run, applies migrations, deploys
```

**Node or Docker**, for companies that do not use Cloudflare:

```sh
npm run demo                                   # try it: http://localhost:8787, made-up data, no token
PORT=8787 DATABASE_PATH=./data/track.db node server/node.js
docker compose up                              # settings from .env, data in a volume
```

Run it behind your reverse proxy with TLS. The dashboard keeps its data in one SQLite file (`DATABASE_PATH`).

## 2. Connect GitHub, read-only

Track for Git only reads. It never writes to GitHub, and it asks for no write permission anywhere.

### Recommended: a GitHub App

An App is installed on the organisation, not tied to one person's account. It has its own rate limit (more than a
person's for large organisations), and it brings its own webhook for every repository it can see.

1. Open `https://github.com/organizations/YOUR-ORG/settings/apps/new` (the dashboard's setup page has this link with
   everything below filled in).
2. Name it, for example *Track for Git (Acme)*. Set the homepage URL to your dashboard's address.
3. **Webhook:** active. URL `https://YOUR-DASHBOARD/api/github/webhook`. Secret: a long random string. Keep it for
   step 3.
4. **Repository permissions, all Read-only:** Contents, Metadata, Pull requests, Deployments, Commit statuses,
   Checks.
5. **Organization permissions:** Members, Read-only (for teams, and for "members only" sign-in).
6. **Subscribe to events:** Push, Pull request, Pull request review, Check suite, Status, Deployment, Deployment
   status, Release, Create, Delete, Repository.
7. *Where can this GitHub App be installed?* Only on this account. Create it.
8. On the App's page: note the **App ID**, then *Generate a private key* (a `.pem` file downloads).
9. *Install App* on your organisation: all repositories, or the ones you choose.

```sh
npx wrangler secret put GITHUB_APP_ID            # the App ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the whole .pem file, BEGIN and END lines included
```

Set `GITHUB_ORG` (in `wrangler.jsonc` `vars`, or the environment) to the organisation's login. The App's
installation is found from it; if the App is installed more than once, set `GITHUB_APP_INSTALLATION_ID` too.

### Simpler: a fine-grained token

Good for a small organisation or a trial. It is tied to the person who makes it.

GitHub → Settings → Developer settings → Fine-grained tokens → Generate:

- **Resource owner:** your organisation (an owner may have to approve it).
- **Repository access:** all repositories, or the ones you choose.
- **Repository permissions, Read-only:** Contents, Metadata, Pull requests, Deployments, Commit statuses.
- **Organization permissions, Read-only:** Members (for teams).

```sh
npx wrangler secret put GITHUB_TOKEN
```

If CI always shows "No CI" with a token, the token cannot see your check runs. A GitHub App with Checks: read can.

### Which repositories

By default, every repository of `GITHUB_ORG` that the App or token can see, except archived ones. To choose:

```
REPOS = "api-*, web, mobile-*, !legacy-*, partner-org/sdk"
```

Names, `owner/name`, `*` wildcards, `!` to leave out. `INCLUDE_ARCHIVED=1` keeps archived repositories.

The first sync reads the last `BACKFILL_DAYS` (30 by default) a little at a time, inside the rate limit. Large
organisations fill in over the first hour or so; everything new arrives at once.

### GitHub Enterprise Server

Set `GITHUB_API_URL=https://github.example.com/api/v3`. GraphQL and the web links follow from it. This is written for
Enterprise Server 3.x but has only been tested against github.com: please open an issue with what you find.

## 3. Real time: the webhook

Without a webhook the dashboard still fills, from polling once a minute. With one, a push or a merged pull request
shows within seconds.

- **With the App:** its webhook is already set (step 2.3). Put the same secret here:
  `npx wrangler secret put GITHUB_WEBHOOK_SECRET`.
- **With a token:** add one webhook on the organisation (Organisation → Settings → Webhooks → Add webhook):
  URL `https://YOUR-DASHBOARD/api/github/webhook`, content type `application/json`, a long random secret, and the
  events listed in step 2.6. Then `npx wrangler secret put GITHUB_WEBHOOK_SECRET`.

Every delivery is checked against its HMAC-SHA256 signature before anything is read. Deliveries from repositories you
do not watch are ignored. To rotate the secret without missing deliveries, set both secrets, comma-separated, change it
on GitHub, then remove the old one.

The status pill at the top of the dashboard says when the last delivery arrived. GitHub's *Recent Deliveries* tab
shows each one with the dashboard's answer.

## 4. Put it behind your sign-in

The dashboard shows your organisation's code activity, so it refuses to show any data until you choose who may open
it (`AUTH`).

### Cloudflare Access (recommended on Cloudflare)

Works with any identity provider Cloudflare Access supports (Okta, Microsoft Entra ID, Google Workspace, GitHub, a
one-time PIN to company email…).

1. Give the Worker a hostname of yours (Workers → your Worker → Settings → Domains & Routes), for example
   `git.example.com`. In the same settings, turn off the `workers.dev` route, or protect it with Access as well.
2. Zero Trust → Access → Applications → *Add an application* → Self-hosted. Domain: `git.example.com`. Add a policy:
   Allow, include *Emails ending in* `@example.com` or your IdP's engineering group.
3. Add a **second** application for `git.example.com/api/github/webhook` with a **Bypass** policy (Everyone). GitHub
   cannot sign in to Access; that route is protected by the webhook signature instead.
4. Copy the first application's **Application Audience (AUD) tag**, and set:

```jsonc
// wrangler.jsonc "vars"
"AUTH": "access",
"ACCESS_TEAM_DOMAIN": "acme.cloudflareaccess.com",
"ACCESS_AUD": "<the AUD tag>"
```

The Worker checks Access's signed token on every request (signature, audience, expiry), so a request that reaches it
any other way is refused.

### GitHub sign-in, members of the organisation only

For Node and Docker, or if you do not use Access. People sign in with GitHub. The dashboard checks with its own
read-only credentials that they are members of `GITHUB_ORG` (and, with `ALLOWED_TEAMS`, of one of those teams). Their
own GitHub token is used once to learn who they are, then dropped. Sessions last 12 hours.

1. Use the GitHub App's own OAuth credentials (on the App's page: *Client ID*, *Generate a new client secret*), or
   create an OAuth App. Callback URL: `https://YOUR-DASHBOARD/auth/callback`.
2. Set:

```sh
AUTH=github
npx wrangler secret put GITHUB_OAUTH_CLIENT_ID
npx wrangler secret put GITHUB_OAUTH_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET          # 32+ random characters
# optional: ALLOWED_TEAMS="engineering, leads"
```

### Your own proxy

With Node or Docker you can also put the dashboard behind the sign-in proxy you already run (oauth2-proxy, an
identity-aware proxy, Cloudflare Tunnel with Access) and set `AUTH=none`. Only do that when nothing can reach the
dashboard except through the proxy.

## 5. Turn the demo off

Set `DEMO` to `""` (or remove it) and deploy. The first sync starts within a minute; the status pill shows it, and
*Connection* shows what it did and how much of GitHub's hourly allowance is left.

## Settings

| Setting | Where | What |
|---|---|---|
| `GITHUB_ORG` | var | The organisation's login. |
| `REPOS` | var | Which repositories (see above). Empty: all of `GITHUB_ORG`. |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | secret | The GitHub App (recommended). |
| `GITHUB_APP_INSTALLATION_ID` | var | Only when the App is installed more than once. |
| `GITHUB_TOKEN` | secret | A fine-grained token, instead of an App. |
| `GITHUB_WEBHOOK_SECRET` | secret | The webhook's secret; several, comma-separated, while rotating. |
| `AUTH` | var | `access`, `github` or `none`. Required unless `DEMO=1`. |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | var | With `AUTH=access`. |
| `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET` | secret | With `AUTH=github`. |
| `ALLOWED_TEAMS` | var | With `AUTH=github`: only members of these teams (slugs). |
| `TEAMS` | var | Teams without the Members permission: `{"Payments": ["dana", "ruth"]}`. |
| `AGENTS` | var | Your own AI agents (see the README, *Make your agents visible*). |
| `STALE_DAYS` | var | An open pull request with no activity this long is *stuck*. Default 7. |
| `BACKFILL_DAYS` | var | How far back the first sync reads. Default 30. |
| `RETENTION_DAYS` | var | Rows older than this are deleted nightly. Default 180. |
| `INCLUDE_ARCHIVED` | var | `1` to keep archived repositories. |
| `GITHUB_API_URL` | var | GitHub Enterprise Server's API, `https://host/api/v3`. |
| `MAX_GITHUB_REQUESTS_PER_RUN` | var | GitHub requests per sync run (default 40: the Workers free plan allows 50 requests to outside services per run). |
| `SYNC_BUDGET_MS` | var | How long one sync run may work (default 25 s). |
| `TITLE` | var | The page title. |
| `DEMO`, `DEMO_SCALE` | var | The made-up organisation, and how busy it is (default 1). |
| `PORT`, `HOST`, `DATABASE_PATH` | env | Node and Docker only. |
