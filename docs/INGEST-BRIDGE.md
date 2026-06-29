# Hermes → career-ops ingest bridge

A doorway that lets an external agent (Hermes, on the same Docker host) hand a
job URL to career-ops, which then evaluates it end to end with the existing
batch machinery — no manual PDF printing, no manual "process this" step.

```
Telegram ─▶ Hermes ─▶ POST http://career-ops:8765/ingest {url,note}
                          (careerops-bridge network, bearer token)
                              ▼
   ingest-server.mjs → batch/batch-input.tsv → batch-runner.sh → claude -p worker
       (auth, URL guard, dedup, single-flight drain)   fetch JD → score A–G →
                                                        render CV PDF → tracker
```

## What it is
- `ingest-server.mjs` — a zero-dependency Node HTTP server that runs as the
  career-ops container's main process. It listens on `:8765`, bound only to the
  internal `careerops-bridge` network (no published host port).
- `POST /ingest` requires `Authorization: Bearer $CAREEROPS_INGEST_TOKEN`,
  rejects private/invalid URLs (reuses `rejectPrivateOrInvalid` from
  `liveness-browser.mjs`), dedups against `data/scan-history.tsv` +
  `data/applications.md`, appends a row to `batch/batch-input.tsv`, and fires a
  **single-flight** `batch-runner.sh` drain. Returns `202 {accepted, id}`.
- `GET /health` → `200 {ok, configured}`.
- Everything after enqueue (score Blocks A–G, render the tailored CV PDF, merge
  the tracker) is the unchanged batch pipeline.

## Robust JD fetching (`fetch-jd.mjs`)
`batch-runner.sh` pre-fetches the JD before the worker runs, so SPA/company pages
(Workday, Ashby, custom React) — which the worker's built-in WebFetch can't render
(no JS) — still produce real content. Tiered, cheapest first:
1. **ATS API** (no browser): Greenhouse (`?content=true` → HTML → text) and Lever
   (`descriptionPlain`), via `resolveAtsApi` in `liveness-api.mjs`.
2. **Headless Chromium render** for everything else, using the project's desktop-UA
   context (`liveness-browser.mjs`); also saves a PDF artifact to `jds/`.
3. **Failure** → the worker falls back to WebFetch exactly as before (no regression).

This means the final post-Apply company URL your wife sends (Greenhouse/Lever/Ashby/
Workday/careers page — public, not LinkedIn) evaluates well without any manual
print-to-PDF. Manual `jds/` drop remains for the rare login-walled page.

## One-time setup on juanito

1. **Create the shared network** (must exist before `up`, it's external):
   ```bash
   docker network create careerops-bridge
   ```
2. **Set the ingest token** in `~/career-ops/.env`:
   ```bash
   grep -q CAREEROPS_INGEST_TOKEN .env || echo "CAREEROPS_INGEST_TOKEN=$(openssl rand -hex 32)" >> .env
   ```
3. **Build + start** — `rebuild` (not `up`) because the image changed; `-v` clears
   stale volumes:
   ```bash
   docker compose down -v && ./cops rebuild
   ```
4. **Log Claude in *inside* the container** (one time — same Max account; the
   session is saved in the container-owned `careerops-claude-home` volume, never
   your host `~/.claude`):
   ```bash
   docker compose exec -it career-ops claude        # then /login, approve in a browser, /exit
   docker compose exec career-ops claude -p "say hi"   # verify auth
   ```
   No restart needed — the next `claude -p` worker reads the saved session.
5. **Join Hermes** to the same network. Pin it in Hermes' config
   (`terminal.network: careerops-bridge`) so it survives sandbox restarts, rather
   than relying on the hashed container name.

## Hermes side
Give Hermes one instruction/skill: *when an allowlisted user sends a job-posting
URL, POST `{url, note}` to `http://career-ops:8765/ingest` with the bearer
token.* v1 is a shell `curl` from Hermes' tool; the token lives in Hermes'
secrets. Hermes stays browserless — career-ops does the fetch and the render.

## Security
The workers read **untrusted content** (job postings), so the container is
hardened against a prompt-injected JD:
- **Runs unprivileged** (uid 1000) — no root, so an injected worker can't escalate
  or overwrite root-owned files. This is also why `--dangerously-skip-permissions`
  is allowed (Claude Code blocks that flag only for root).
- **Container-owned Claude login** — the host's `~/.claude` is never mounted in.
  The worker only ever sees the container's own session (revoke/rotate it
  separately without touching your host login).
- No published host port; reachable only on `careerops-bridge` + a bearer token.
- URL guard rejects loopback/private/link-local/invalid hosts.
- `ANTHROPIC_API_KEY` not forwarded, so the container login is used.
- **Never auto-submits.** Evaluate + render only; sending an application stays a
  manual, human-reviewed step.

> [!warning] Residual risk: token exfiltration
> The in-container session token is still readable by the worker (it must be, to
> call the API). Non-root + container-owned login stop *tampering* and protect your
> host credentials, but the real defense against a hijacked worker **sending** the
> token somewhere is **egress control**: restrict the container's outbound traffic
> to the job boards + `api.anthropic.com`. That's a host-side firewall step
> (`DOCKER-USER` / a filtered network), tracked separately.

## Verify
```bash
docker network inspect careerops-bridge        # lists career-ops + the Hermes sandbox
docker compose exec career-ops claude --version
# from the Hermes sandbox (or `docker compose exec career-ops sh -c '...'`):
curl -H "Authorization: Bearer $CAREEROPS_INGEST_TOKEN" -H 'content-type: application/json' \
  -X POST http://career-ops:8765/ingest \
  -d '{"url":"https://boards.greenhouse.io/<co>/jobs/<id>","note":"test"}'
# → 202 {accepted,id}; then a new reports/NNN-*.md and a data/applications.md row.
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://career-ops:8765/ingest -d '{}'   # 401 (no token)
```

## Later (v1.5)
Wrap `/ingest` as an MCP server (HTTP/SSE) so Hermes calls it as a native tool
and can pull results back (`get_evaluation`) — that unlocks a Telegram feedback
reply ("scored 4.2, here's why").
