# Hermes ↔ career-ops via MCP (no terminal)

This replaces the shell/`co-eval.sh` path. Hermes calls career-ops as a **native
MCP tool** (like mailbox/calendar) — **no terminal, no readable token, no shell**.
That's the guardrailsfirst win: the only thing Hermes can do is call four fixed,
validated operations; it cannot run arbitrary commands.

## What's already deployed (career-ops side — done)
- Service **`career-ops-mcp`**, reachable **two ways**:
  - **`http://127.0.0.1:8766/mcp`** — host loopback (for the Hermes agent, which runs
    as a host-side `hermes` systemd --user process; **use this one**).
  - **`http://career-ops-mcp:8766/mcp`** — `careerops-bridge` DNS name, only resolvable
    from a container *on that bridge* (use this only if Hermes dials MCP from inside a
    bridge container, not from the host).
- Tools: `evaluate_url`, `get_status`, `get_evaluation`, `evaluate_and_wait`.
- The **ingest bearer token stays server-side** (the MCP server holds it to call the
  ingest server); Hermes never sees it.
- Inbound auth on `/mcp` uses a **bearer token** (`CAREEROPS_MCP_TOKEN`, in `.env`);
  `/health` stays open. See "Auth token" below for the header to send.
- Verified: an MCP client lists all four tools and calls them successfully.

> **Why loopback and not just the bridge name?** The MCP call is issued by the Hermes
> *agent* (host-side `hermes` systemd --user), **not** by Hermes' terminal sandbox
> container. The host can't resolve the `career-ops-mcp` Docker DNS name and the port
> is bound to `127.0.0.1` only, so the agent uses the loopback URL. (An earlier version
> of this doc wrongly assumed the sandbox's bridge membership was enough — it isn't,
> because the sandbox isn't what makes MCP calls.)

## Step 1 — Register the MCP server in Hermes (YOU do this)
Hermes' MCP config is owned by the `hermes` user (I can't write it). Add a **remote
HTTP MCP server** entry, mirroring how your mailbox/calendar connectors are defined.
The config lives under `~/.hermes/` (the same place `terminal.docker_extra_args` /
`docker_forward_env` are set). Add an entry equivalent to:

```jsonc
// in Hermes' MCP servers config — mirror your existing remote (mailbox/calendar) entries
{
  "career-ops": {
    "type": "http",                     // remote/streamable-HTTP MCP server
    "url": "http://127.0.0.1:8766/mcp",
    "headers": { "Authorization": "Bearer <CAREEROPS_MCP_TOKEN from career-ops/.env>" }
  }
}
```

Notes:
- **URL:** use `http://127.0.0.1:8766/mcp` (the Hermes agent dials from the host). Only
  switch to `http://career-ops-mcp:8766/mcp` if you confirm Hermes issues MCP calls from
  inside a container attached to `careerops-bridge`.
- **Token:** copy the `CAREEROPS_MCP_TOKEN` value from `career-ops/.env` into the
  `Authorization` header. If Hermes' MCP config can't send custom headers, tell me and
  we'll fall back to loopback-without-token (still off-LAN, but no bearer).
- Use whatever exact key/format Hermes uses for its other remote MCP servers — the
  essentials are **transport = HTTP**, the **url**, and the **bearer header**.

## Step 2 — Remove the old shell path (cutover)
Once the MCP tools show up in Hermes:
1. **Delete/replace the `careerops-ingest` shell skill** (via Hermes' curator) — it
   depends on a terminal and now 401s anyway. Delete the `career-ops`
   integration-analysis memo-skill too.
2. **Remove the leftover shell artifacts** in Hermes' sandbox (the readable token is
   the attack surface we're eliminating):
   - `~/.config/careerops/token`
   - `~/bin/co-eval.sh`
   (Say the word and I'll remove these from the sandbox for you — they persist on the
   writable home mount.)

The repo keeps `integrations/hermes/co-eval.sh` + `SKILL.md` as an archived fallback.

## Step 3 — Verify end-to-end
- In Telegram, confirm Hermes now lists/uses the career-ops tools.
- Send a **real, open** job posting URL (Greenhouse/Lever/Ashby/Workday/careers page —
  not LinkedIn). Hermes should call `evaluate_url`, poll `get_status`, then reply from
  `get_evaluation` — **without any terminal**.
- Or use `evaluate_and_wait` for a one-call result (waits up to ~6 min).

Smoke test from any bridge peer (optional):
```bash
docker compose exec career-ops-mcp node -e '
(async()=>{const {Client}=await import("@modelcontextprotocol/sdk/client/index.js");
const {StreamableHTTPClientTransport}=await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
const c=new Client({name:"t",version:"1"});await c.connect(new StreamableHTTPClientTransport(new URL("http://localhost:8766/mcp")));
console.log((await c.listTools()).tools.map(t=>t.name).join(", "));await c.close();process.exit(0)})()'
# → evaluate_url, get_status, get_evaluation, evaluate_and_wait
```

## Auth token
Since the endpoint is now published on the host loopback, a bearer on `/mcp` is the
primary boundary (loopback keeps it off the LAN). `CAREEROPS_MCP_TOKEN` is set in
`career-ops/.env`; the MCP server picks it up on `docker compose up -d career-ops-mcp`.
Confirm it's active: `GET /health` returns `"auth":"token"` (not `network-only`).
Put the same value in Hermes' `Authorization: Bearer <token>` header (Step 1).

To rotate: replace the value in `.env`, `docker compose up -d career-ops-mcp`, and
update the header in Hermes' config.

## Tool reference
| Tool | Args | Returns |
|------|------|---------|
| `evaluate_url` | `url`, `note?` | `{accepted,id,status}` — or `{duplicate:true,id,report_num}` if already seen |
| `get_status` | `id` | `{status,done,score,report_num,...}` (`queued→processing→completed\|failed`) |
| `get_evaluation` | `id` | full eval: `score,final_decision,legitimacy_tier,top_strengths,hard_stops,next_action,report_num` |
| `evaluate_and_wait` | `url`, `note?` | full eval if ready within ~6 min, else `{id,status}` to fetch later |
