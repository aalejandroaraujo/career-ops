# Web portal

A small browser UI to view every analyzed job and change its status
(Applied / Rejected / Interview / …) from any device on your network — phone
included. Complements the Telegram intake: links come in via Hermes, you manage
the results here.

```
browser (laptop/phone) ──▶ http://<juanito>:8090  ──▶ portal-server.mjs
                              (basic auth)               │
                              GET  /api/jobs  ───────────┤ reads data/applications.md
                              POST /api/jobs/N/status ───┘ writes via `merge-tracker.mjs --set-status`
                                                            (same /tmp lock as the worker's merges)
```

## What it shows
- A card per job (mobile-first): company, role, **fit score** (color-coded),
  status, date, pay, links to the report and CV.
- Tap a card → detail drawer with the report's Machine Summary (decision,
  archetype, legitimacy, risk, next action, top strengths) + the full report and
  a CV download.
- Search, filter by status, sort by score/status/date.
- Change status from the card's dropdown — writes straight to `applications.md`.

## How it runs
`portal-server.mjs` runs **in the career-ops container, alongside the ingest
server** (one container, two servers). Same container = they share the `/tmp`
tracker lock, so the portal's status writes never race the worker's tracker
merges. Only the portal port (`8090`) is published; the ingest endpoint stays
bridge-internal.

## Setup on juanito
1. Set portal credentials in `~/career-ops/.env`:
   ```bash
   echo "CAREEROPS_PORTAL_USER=admin" >> .env
   echo "CAREEROPS_PORTAL_PASS=$(openssl rand -hex 16)" >> .env   # use something you'll type, or this
   ```
2. Pull + restart (compose changed — new command, port, env):
   ```bash
   cd ~/career-ops && git pull
   docker compose down && ./cops up
   ```
3. Open `http://<juanito-host-or-LAN-IP>:8090`, log in with those credentials.

## Security
- **Basic auth** over the LAN; the portal **edits your tracker**, so it always
  requires `CAREEROPS_PORTAL_USER`/`PASS` (it fails closed if unset).
- Only `:8090` is exposed; the ingest token endpoint is not published.
- Status writes go through `merge-tracker.mjs`'s battle-tested file lock + atomic
  write — no partial files, no races with ingest.

## Phase 2 — Entra ID (Microsoft) login
Not in v1 (Entra requires HTTPS for non-localhost redirects, i.e. a TLS layer).
The clean path: put the portal behind a reverse proxy (Caddy/Traefik +
oauth2-proxy) that does Entra OIDC **and** TLS, then set
`CAREEROPS_PORTAL_TRUST_PROXY=1` — the portal will trust the proxy's
`X-Auth-Request-User` header and skip basic auth. No app changes needed.
