# Web UI — LAN application tracker

A mobile-first web front door onto the same tracker Hermes uses. Adapted from
the portal prototype in PR #7, rebuilt on the `/tracker/*` API.

```
 phone / laptop ──► career-ops-web ──► ingest-server ──► data/applications.md
   (LAN, 8767)      presentation      SOLE WRITER        data/app-events.jsonl
                    + proxy, RO mount  + tracker lock            ▲
                                                                 │
 Telegram ──► Hermes ──► career-ops-mcp ─────────────────────────┘
```

Both front doors call the **same HTTP API**. Neither touches the tracker files
directly, which is what stops them diverging.

## Setup

1. Set a password (the server refuses to start without one):

   ```bash
   echo "CAREEROPS_WEB_PASSWORD=$(openssl rand -hex 12)" >> .env
   ```

2. Point the published port at your LAN address in `docker-compose.yml` — it is
   `192.168.1.16:8767:8767` by default. Use `ip -4 -o addr show scope global` to
   find yours.

3. Start it:

   ```bash
   docker compose up -d career-ops-web
   ```

4. Open `http://<lan-ip>:8767` on your phone and sign in. The session cookie
   lasts 30 days (`CAREEROPS_WEB_SESSION_DAYS`).

## Using it

- **Filter chips** — `Ongoing` (Applied · Responded · Interview · Offer) is the
  default; then `All`, then one chip per status that has rows.
- **▦ / ▤ toggles** card feed ⇄ kanban board. Cards flow into columns on a wide
  screen; the board is one swipeable column per status on a phone. The choice is
  remembered locally.
- **Status** changes from the dropdown on each card. The board deliberately does
  not use drag-and-drop — it is unreliable on touch and this keeps one code path.
- **Tap a company** for the detail drawer: full history plus an add-note box.

Notes and status changes go to `data/app-events.jsonl`, never to the tracker's
Notes cell — that cell is rebuilt by `merge-tracker.mjs` on re-evaluation and
would destroy them.

## Security

The UI shows salary targets, referral contacts and interview notes, so:

- **Fail-closed.** No `CAREEROPS_WEB_PASSWORD`, no server. (Note `mcp-server.mjs`
  fails *open* when its token is unset — that pattern is deliberately not copied
  here.)
- **Session cookie** is `HttpOnly` + `SameSite=Strict`, HMAC-signed with a key
  derived from the password, so changing the password invalidates every session.
  No `Secure` flag: this is plain HTTP on the LAN and `Secure` would stop the
  cookie being stored at all.
- **No write authority.** The repo is mounted `:ro` and only `/api/tracker/*` is
  proxied — `/ingest` and the batch endpoints are not reachable, so a
  compromised browser session cannot enqueue work for the container that runs
  `claude -p` with a credentialed home directory.
- **The ingest token stays server-side** and is never sent to the browser.
- **CSP** is `default-src 'self'`; nothing loads from an external origin.

### ⚠️ Docker publishes bypass ufw

Published container ports are DNAT'd in `nat/PREROUTING` and traverse `FORWARD`,
not `INPUT` — so **ufw's default-deny does not cover them**, and no `ufw allow`
rule is needed (adding one would be misleading).

The port is bound to the LAN address explicitly rather than `0.0.0.0`, which
keeps it off every other interface and makes the exposure auditable. The password
is the actual access control. To restrict by subnet, add a `DOCKER-USER` rule:

```bash
sudo iptables -I DOCKER-USER -p tcp --dport 8767 ! -s 192.168.1.0/24 -j DROP
```

## Troubleshooting

| Symptom | Cause |
|---|---|
| Container exits immediately | `CAREEROPS_WEB_PASSWORD` unset or under 8 chars — check `docker logs career-ops-web` |
| "Editing is disabled" banner | Tracker has no UID column; run `npm run tracker:migrate` |
| Status change says the row changed | A batch re-evaluation updated it while the page was open. The page reloads; re-apply. This is `If-Match` working. |
| 502 `tracker_unreachable` | The `career-ops` container is down |
| Unreachable from the phone | Port bound to the wrong interface — check `ports:` in `docker-compose.yml` |
