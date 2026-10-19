# Security policy

Track for Git shows an organisation's code activity, so we take reports seriously.

## Reporting a vulnerability

Email **security@qder.ai**, or use GitHub's private vulnerability reporting on this repository
(*Security* → *Report a vulnerability*). Please include what you found, how to reproduce it, and the impact you
expect. Never in a public issue.

- We acknowledge reports within 3 business days and keep you updated until a fix is released.
- We ask for up to 90 days before public disclosure, and we credit reporters who want to be named.
- Test against your own deployment (`npm run demo` runs one in a minute). Please do not test against anyone else's.

## Scope

The code in this repository: the Worker and Node server, the webhook handler, sign-in (Cloudflare Access and GitHub),
the sync, and the page. Each deployment is run by the company that hosts it; problems in how a particular one is
configured should go to that company.

## What we do by design

- GitHub access is read-only; secrets are environment secrets only and never shown, logged or stored in the database.
- Webhook deliveries are verified (HMAC-SHA256, constant time) before they are read, capped at 25 MB, and handled once.
- The dashboard refuses to answer until its owner chooses who may open it (`AUTH`).
- Diffs and file contents are never stored; a strict Content Security Policy and text-only rendering protect the page.
