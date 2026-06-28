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
- Everything after enqueue (fetch JD, score Blocks A–G, render the tailored CV
  PDF, merge the tracker) is the unchanged batch pipeline.

## One-time setup on juanito

1. **Auth must exist on the host first** (the container mounts it):
   ```bash
   claude            # then /login once, so ~/.claude and ~/.claude.json exist
   ```
2. **Create the shared network:**
   ```bash
   docker network create careerops-bridge
   ```
3. **Set the token** in `~/career-ops/.env`:
   ```bash
   echo "CAREEROPS_INGEST_TOKEN=$(openssl rand -hex 32)" >> .env
   ```
4. **Rebuild + restart** (the `-v` refreshes the node_modules volume so the new
   in-image Claude Code install isn't shadowed — same trap as the Playwright fix):
   ```bash
   docker compose down -v && ./cops up
   ```
5. **Join Hermes** to the same network. Pin it in Hermes' config
   (`terminal.network: careerops-bridge`) so it survives sandbox restarts, rather
   than relying on the hashed container name.

## Hermes side
Give Hermes one instruction/skill: *when an allowlisted user sends a job-posting
URL, POST `{url, note}` to `http://career-ops:8765/ingest` with the bearer
token.* v1 is a shell `curl` from Hermes' tool; the token lives in Hermes'
secrets. Hermes stays browserless — career-ops does the fetch and the render.

## Security
- No published host port; reachable only on `careerops-bridge`.
- Bearer token required; lives in `.env` / Hermes secrets, never in git.
- URL guard rejects loopback/private/link-local/invalid hosts.
- `ANTHROPIC_API_KEY` is intentionally not forwarded into the container, so
  `claude -p` uses the mounted subscription token.
- **Never auto-submits.** The pipeline evaluates and renders only; sending an
  application stays a manual, human-reviewed step.

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
