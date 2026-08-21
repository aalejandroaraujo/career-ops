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

Sign in with `CAREEROPS_WEB_PASSWORD` (in `.env`). Two tabs:

- **Applications** — your tracker. Status, score, notes, drag between states.
- **Scouted** — roles the scanner found that are *not yet evaluated*.
  Swiss roles first, flagged 🇨🇭. Tap a title to open the posting.

Only reachable on your LAN (`192.168.1.16`), never from the internet.

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

- `web-server.mjs` — `readPipeline()` + the `GET /api/pipeline` route
- `web/index.html` — the `.tabs` block and `<div id="pipeline">`
- `web/app.js` — `loadPipeline()`, `renderPipeline()`, `setTab()`
- `web/style.css` — `.tabs` / `.badge` / `.pipe-row` rules

Safe (new files, not upstream): `daily-scout.sh`, `pipeline-digest.mjs`,
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
