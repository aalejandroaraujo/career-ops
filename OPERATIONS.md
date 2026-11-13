# career-ops — Operations Manual

Your personal operating guide. Written 2026-08-21.

Everything below reflects how *your* machine is actually wired, not the generic
upstream docs.

---

## 1. The daily loop (what you actually do)

| When | You do | Takes |
|------|--------|-------|
| Every morning | Open the **Scouted** tab or read today's digest | 2 min |
| When something looks good | Ask Hermes (or Claude Code) to evaluate it | 0 min of yours |
| When a score lands ≥ 4.0 | Review the report, then apply | 20–30 min |
| Target | **3–5 applications per week** | — |

Everything before "review the report" is automated. You are only in the loop for
judgement and the send button.

---

## 2. Where to look

### The dashboard (best on your phone)

    http://192.168.1.16:8767

Sign in with `CAREEROPS_WEB_PASSWORD` (in `.env`). Four tabs:

- **My day** (the default) — what is waiting on *you*, in the order that
  ignoring it costs you something. Every row carries **Open JD ↗**, **Read
  report** (the full evaluation, rendered — no file manager needed) and one-tap
  actions:
  1. **Follow-ups owed** — sent, and going cold. **Draft follow-up** opens a
     ready-to-send message with the role and elapsed days filled in, a Copy
     button, and the evaluator's own note beside it so you can see who to write
     to and what was agreed. It is a factual skeleton — edit before sending; it
     never asserts anything about you that is not already in your own files.
     Then tap **I followed up**, which writes `data/follow-ups.md` —
     a file `followup-cadence.mjs` has always read and nothing ever wrote. That
     is why Hexagon still said "never followed up" a week after you applied.
  2. **Hot — decide now** — scored 4.0+ and evaluated in the last 7 days,
     **freshest first**. One tap: **Applied ✓** / **SKIP** / **Discarded**.
  3. **Older, still undecided** — collapsed behind a summary. Traction drops
     after week two; these are mostly one tap on SKIP to clear.
  4. **Backlog** — the counts, with "new in 48h" called out separately.

  If a report recorded `local:jds/...` instead of a live link (a filed capture,
  like RED Global) the row says so rather than showing a dead "no link".
- **Applications** — your tracker. Status, score, notes, drag between states.
- **Scouted** — roles the scanner found that are *not yet evaluated*, **newest
  first** with a scout date and an age badge (`NEW`, `3d`, `42d`) joined from
  `scan-history.tsv`. 🇨🇭 marks the Swiss ones. Act on a row:
  - **Preview** — pulls the actual job description (ATS API, else a headless
    render) so you are not deciding from a title alone. Cached per URL: ~2s the
    first time, instant after. Hovering a card reveals an already-cached
    preview; it never starts a fetch, so a mouse sweep cannot trigger 20 scrapes.
  - **Evaluate** — enqueues a real evaluation. Reports back "Queued as #N", or
    tells you it was already evaluated and points at the report.
  - **Scan for new roles** — runs the scanner on demand, zero tokens. It only
    ran on cron at 06:30 before; "wait twelve hours" is not an answer at 18:00.
    Single-flight — two scanners racing on `pipeline.md` would lose rows.
  - **Dismiss 5d+ / 15d+ / 30d+** — bulk triage with a confirmation and a count.
    Floor of 5 days, so no single tap can empty the inbox. Reversible: rows are
    marked `- [x] DISMISSED`, never deleted.
  - **Dismiss** — two-tap (it asks "Sure?"). Marks the row processed so
    `daily-scout.sh` stops re-queuing it. Reversible: the row is *marked*
    `- [x] DISMISSED`, never deleted, so it stays greppable.
- **Queue** — can the evaluation leg actually do work right now? Four checks:
  container login, batch runner, queued jobs, workers. Plus every unfinished
  job, with its age. **Every problem that can be repaired from here has a
  button**, because "check batch/logs/" is not an action on a phone:
  - **Worker log #N** — the transcript, rendered in the drawer, newest attempt
    first. An empty log is itself the finding: the worker was *killed*, not
    failed. (That is what a container restart under a live worker looks like —
    it is how job 204 wedged.)
  - **Release job #N** — flips a row wedged at `processing` back to `failed`,
    which batch-runner treats as retryable. Refuses while a runner is alive.
  - **Clear stale lock** — removes `batch-runner.pid`. Refuses if the pid is
    actually running.
  - **Clear pause & retry**, **Run the queue now** — unpause, and kick a drain.

  Anything without a button keeps its command in a tap-to-select block.

### Why the Scouted buttons are safe

`web-server.mjs` still refuses to proxy `/ingest` — a browser session can never
name a URL of its own choosing. The two write endpoints are gated three ways:

1. **Session cookie**, like every other API call.
2. **The URL must currently be pending in `data/pipeline.md`** — checked in the
   web server *and* again in the ingest server, so one layer being wrong is not
   enough. An attacker-chosen URL, or the cloud metadata service, is a 404.
3. **A per-minute budget** (`CAREEROPS_WEB_WRITE_LIMIT`, default 12), because
   each evaluation costs minutes of a credentialed worker.

The request body is *rebuilt*, never forwarded: a `force` flag from the browser
is stripped. A paid re-score stays a deliberate CLI/Hermes act.

Only reachable on your LAN (`192.168.1.16`), never from the internet.

**Restarting the `career-ops` container kills any worker mid-run.** The row is
left at `processing`, the pid file goes stale, and the health panel flags both.
Check the Queue tab is idle before `docker compose restart career-ops`; if you
forget, **Release job #N** and **Clear stale lock** are the repair.

**You do not have to open the Queue tab to notice a problem.** A red banner
appears above every tab when evaluation is blocked, the tab grows a coloured
dot, and the browser tab title becomes `⚠ (1) career-ops …` so a backgrounded
tab still shows it. It refreshes every 60s and re-checks the moment you return
to the tab.

Why the tab exists: on 2026-09-01 a job submitted through Telegram sat at
`queued` for 45 minutes and was then deleted by the next morning's scout run.
The container's `claude` CLI was logged out, so `batch-runner.sh` refused to
start — correctly — but nothing surfaced that anywhere. Applications and
Scouted both show *finished* work, so the outage rendered as an empty list.

### Alerts when the browser is closed

The ingest server re-checks queue health every two minutes and POSTs to
`CAREEROPS_ALERT_WEBHOOK` (in `.env`) when the state **changes** — once per
transition, in both directions, never once per tick. Point it at anything that
takes a JSON POST: a Hermes webhook that relays to Telegram, ntfy, Gotify, a
Slack incoming webhook. The body carries a ready-to-send `text` field.

Unset by default: with no webhook you still get the banner, the dot, the title
badge, and a `[ingest] health: DEGRADED — …` line in `docker compose logs`.

There is deliberately no browser push notification: the UI is served over plain
HTTP on the LAN, which is not a secure context, so the Notification and
ServiceWorker APIs are unavailable. The webhook is the out-of-browser path.

### The morning digest

    reports/digests/{YYYY-MM-DD}-digest.md

Same queue as the Scouted tab, plus **salary bands** where the source publishes
them. Readable in WinSCP or any editor. Regenerate at any time:

    node pipeline-digest.mjs              # rewrite today's digest
    node pipeline-digest.mjs --stdout     # print, write nothing
    node pipeline-digest.mjs --limit 25   # cap rows per section

---

## 3. What runs by itself

A cron job fires **every day at 06:30**:

    30 6 * * * /home/kenseitak/career-ops/daily-scout.sh --max 6

Four steps:

1. **Scan** every source in `portals.yml` — zero tokens
2. **Liveness sweep** the Swiss pending set, retire dead postings — zero tokens
3. **Evaluate** up to 6 new Swiss roles via `claude -p` workers — *this is the only step that spends tokens*
4. **Digest** written to `reports/digests/`

Run it by hand any time:

    ./daily-scout.sh              # full pass
    ./daily-scout.sh --no-eval    # scan + digest only, completely free
    ./daily-scout.sh --max 3      # evaluate at most 3

It refuses to run twice at once (concurrent Playwright browsers produce false
"uncertain" liveness results, which look exactly like a dead job board).

**To stop all unattended token spend:** `crontab -e`, delete the daily-scout
line. Or change `--max 6` to `--no-eval` to keep the free scanning.

Logs: `logs/daily-scout/{date}.log`

---

## 4. Evaluating a role

### Via Hermes (your preference — and it is *not* a downgrade)

Hermes reaches career-ops over MCP on `127.0.0.1:8766`. Worth understanding why
quality is unaffected:

> Hermes' own LLM (local LM Studio, qwen) only **reads your message and picks a
> tool**. The evaluation itself runs inside the career-ops container as a full
> `claude -p` worker using the real mode files. The local model never writes
> your evaluation, report, or CV.

So use Hermes freely. Just say:

- *"Evaluate this: {url}"* → `evaluate_url` (queues it, returns a job id)
- *"Evaluate this and wait: {url}"* → `evaluate_and_wait` (blocks ~6 min, returns the score)
- *"What's the status of job X?"* → `get_status`
- *"Give me the evaluation for X"* → `get_evaluation`
- *"Show my applications"* / *"summary"* → `list_applications`, `applications_summary`
- *"Mark {company} as Applied"* → `update_status`
- *"Add a note to {company}"* → `add_note`
- *"Which applications need a follow-up?"* → `applications_needing_followup`
- *"Render a CV for X"* → `render_cv`

An evaluation takes roughly **6 minutes** of worker time. `evaluate_url` returns
immediately; prefer it, then ask for the result later.

### Via Claude Code (this chat)

- Paste a URL → full auto-pipeline (evaluate → report → CV → tracker row)
- `/career-ops pipeline` → work the whole pending queue
- `/career-ops apply` → fill a form and draft answers
- `/career-ops cover {company}` → cover letter
- `/career-ops pdf {company}` → tailored CV
- `/career-ops interview-prep` → company interview intel
- `/career-ops tracker` → status overview

**Both front doors write to the same files.** There is no separate state.

---

## 5. Applying

The system never submits anything. It prepares; you send.

1. Read the report in `reports/{num}-{slug}-{date}.md` — check **Score**,
   **hard_stops**, **next_action**.
2. CV is in `output/`. Regenerate with `/career-ops pdf {company-slug}`.
3. Cover letter: `/career-ops cover {company-slug}`.
4. Submit it yourself.
5. **Then mark it**, or the tracker silently drifts out of date:

   *Hermes:* "Mark {company} as Applied"
   *Claude Code:* ask, or use the tracker API — never hand-edit `applications.md`.

Below 4.0/5 the system will argue against applying. That is deliberate.

---

## 6a. Sources (audited 2026-09-03)

Before the audit the inbox ran on **5 of 26 available providers**: greenhouse
(83 rows), ashby (53), devitjobs (28), lever (13), ictjobs (7).

**Added — remote-first boards.** Providers already shipped, never configured:
Remotive, RemoteOK, Working Nomads, We Work Remotely. Board-wide feeds, so
`title_filter` + `location_filter` narrow them.

**Added — Swiss employers.** Every one verified by calling its API and getting
real postings back:

| Employer | Provider | Postings |
|----------|----------|----------|
| Swisscom | workday | 83 |
| Roche | workday | 1191 |
| Novartis | workday | 925 |
| Richemont | workday | 1315 |
| Lombard Odier | workday | 38 |
| Swissquote | smartrecruiters | 38 |

**Verify before adding another — guessing does not work here:**

- `*.wd3.myworkdayjobs.com` is a **wildcard**. Any invented tenant answers 406
  or 422, so a non-existent company looks exactly like a wrong site path.
- SmartRecruiters returns **HTTP 200 with `totalFound: 0`** for unknown slugs,
  so 20 of 21 guessed Swiss slugs "succeeded" and meant nothing.

Only a response containing actual postings counts. One request settles it:

    docker compose exec career-ops node -e 'fetch("https://TENANT.wd3.myworkdayjobs.com/wday/cxs/TENANT/SITE/jobs",{method:"POST",headers:{"content-type":"application/json"},body:"{\"limit\":5,\"offset\":0,\"searchText\":\"\",\"appliedFacets\":{}}"}).then(r=>r.json()).then(j=>console.log(j.total, j.jobPostings?.[0]?.title))'

**UBS, Swiss Re, Zurich Insurance and SIX have no public ATS API** — UBS runs a
custom board at `ubs.com/global/en/careers/search-jobs.html`, Swiss Re a custom
`careers.swissre.com`. They are configured with `scan_method: websearch`, the
same mechanism already used for OpenAI and AWS.

---

## 6. Adding sources

Sources live in `portals.yml`:

- `tracked_companies:` — a specific employer's careers page
- `job_boards:` — a whole board (SwissDevJobs, ictjobs.ch, …)
- `title_filter:` — keywords that decide relevance
- `location_filter:` — `always_allow` beats `block` beats `allow`

Just ask either front door: *"add {company} to my portals"*, *"scan for
{keyword} too"*.

Currently enabled Swiss boards: **SwissDevJobs** (salary on every posting) and
**ictjobs.ch** (enterprise + public sector). Six sister boards
(Germany/UK/France/NL/US/Romania) are configured but disabled — their salary
bands sit below your CHF target.

---

## 7. Health checks

    node doctor.mjs --json          # is the system set up correctly
    node verify-pipeline.mjs        # tracker/report integrity
    docker compose ps               # are the three containers up
    curl -s localhost:8766/health   # is the Hermes bridge alive

    # can the evaluation queue actually do work? (same data as the Queue tab)
    docker compose exec career-ops \
      curl -s -H "authorization: Bearer $CAREEROPS_INGEST_TOKEN" \
      http://localhost:8765/health/queue

    # the single check that broke on 2026-09-01
    docker compose exec career-ops claude auth status

**If the Queue tab says the container is logged out** (or Telegram warns the
login expires soon):

    claude setup-token                 # on the host, in your own terminal; browser sign-in
    # paste the printed token into .env:
    #   CLAUDE_CODE_OAUTH_TOKEN=<token>
    #   CLAUDE_CODE_OAUTH_TOKEN_EXPIRES=<today + 1 year, YYYY-MM-DD>
    docker compose up -d career-ops    # recreate so the new env is picked up
    docker compose exec career-ops claude auth status

Do not use `docker exec -it career-ops claude auth login` as the fix: that
session's refresh token hard-expires ~30 days after login, which is why the
outage recurred monthly (2026-09-01, 2026-09-30). The setup-token lasts ~1 year,
and the ingest server alerts on Telegram 14, 7, 3 and 1 days before the date in
`CLAUDE_CODE_OAUTH_TOKEN_EXPIRES`. Set a calendar reminder for that date too.

Then re-run the queue — the runner picks up anything still pending:

    docker compose exec career-ops ./batch/batch-runner.sh

Do NOT run `batch-runner.sh` from the host: the runner's lock and the tracker
lock both check pid liveness with `process.kill(pid, 0)`, which only resolves
pids in the caller's PID namespace.

The three containers:

| Container | Port | Job |
|-----------|------|-----|
| `career-ops` | — | evaluation workers + ingest API |
| `career-ops-mcp` | 8766 (loopback) | Hermes bridge |
| `career-ops-web` | 8767 (LAN) | dashboard |

If Hermes says "provider failed", that is **LM Studio being down, not an auth
problem** — restart LM Studio.

---

## 8. After a system update

`node update-system.mjs apply` overwrites System-Layer files. These local
customisations live in System-Layer files and must be re-applied (the updater
leaves a `backup-pre-update-*` git branch, so nothing is lost):

- `web-server.mjs` — `readPipeline()` + the `GET /api/pipeline` route,
  the `GET /api/health` and `GET /api/today` proxies, the
  `POST /api/pipeline/{evaluate,dismiss}` endpoints and `allowWrite()`
- `web/index.html` — the `.tabs` block, `<div id="pipeline">`,
  `<div id="banner">` and `<div id="health">`
- `web/app.js` — `loadPipeline()`, `renderPipeline()`, `setTab()`,
  `loadHealth()`, `renderHealth()`, `renderBanner()`, the health poll in boot,
  `renderToday()`, `decisionHtml()`, `todayAction()`, `openReport()`,
  `mdToHtml()`, `loadPreview()`, `ageBadge()`
- `web/style.css` — `.tabs` / `.badge` / `.pipe-row` rules, and the
  `.banner` / `.dot` / `.checks` / `.prob` / `.qrow` block
- `ingest-server.mjs` — the `QUEUE_LOG` append in `appendRow()`, the
  `GET /health/queue` and `GET /today` routes, the `/pipeline/*` routes,
  `enqueueUrl()`, `todayPayload()`, `findDuplicate()`'s `includeScanHistory`
  option, and the `alertTick()` + `sendAlert()` loop
- `followup-cadence.mjs` — `analyze()` is exported (upstream keeps it private)
- `ingest-server.mjs` — also `reportMeta()`, `jdPreview()`, `logFollowup()`,
  and the `/report/:num`, `/followups/log`, `/pipeline/preview` routes
- `test-web-server.mjs` — section 6b (queue health is the one non-tracker
  proxy exception); upstream's section 6 asserts `/api/health` must 404
- `test-all.mjs` — `test-queue-health.mjs` and `test-pipeline-store.mjs` in
  the focused-suite list
- `test-web-server.mjs` — sections 6c/6d/6e (the scouted write gates and Today)

Safe (new files, not upstream): `daily-scout.sh`, `pipeline-digest.mjs`,
`queue-health.mjs`, `test-queue-health.mjs`,
`pipeline-store.mjs`, `test-pipeline-store.mjs`,
`providers/devitjobs.mjs`, `providers/ictjobs.mjs`, `providers/_rss.mjs`,
this file.

Never touched by updates: `cv.md`, `config/profile.yml`, `modes/_profile.md`,
`modes/_custom.md`, `portals.yml`, `data/*`, `reports/*`, `output/*`.

---

## 9. Cheat sheet

    # see what's waiting
    node pipeline-digest.mjs --stdout | head -40

    # free scan, no tokens
    ./daily-scout.sh --no-eval

    # full pass incl. evaluation
    ./daily-scout.sh --max 6

    # counts
    grep -c '^- \[ \]' data/pipeline.md      # scouted, unevaluated
    ls reports/*.md | wc -l                  # evaluations done

    # health
    node doctor.mjs --json && docker compose ps
