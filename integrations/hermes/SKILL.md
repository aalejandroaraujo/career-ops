---
name: careerops-ingest
description: "ALWAYS load this the moment a message is or contains a job-posting URL — any greenhouse.io / lever.co / ashbyhq.com / myworkdayjobs.com / smartrecruiters.com / workable.com / breezy.hr link, or any URL whose path has /careers, /jobs, /job/, /positions, or /openings. It hands the link to the career-ops service, waits for the evaluation to finish, and reports the score + verdict back to the user. Do NOT browse, web_search, web_extract, curl, scrape, or summarize the posting yourself — that is career-ops' job; this skill is the only correct way to handle a job link. Load it before taking any other action on the URL."
version: 2.0.0
platforms: [linux, macos, windows]
triggers:
  - job posting URL
  - job link
  - job opening
  - apply to this job
  - evaluate this job
  - greenhouse.io
  - lever.co
  - ashbyhq.com
  - careers page
  - send this to career-ops
metadata:
  hermes:
    tags: [jobs, career-ops, ingest, evaluate, automation, hiring]
---

# career-ops job evaluation

Hand a job-posting URL to the **career-ops** service, wait for it to finish
evaluating (it scores fit, writes a report, updates the tracker), and report the
result back to the user. Your only job is the doorway + relaying the result.
**Do not browse, scrape, summarize, or apply to the link yourself — career-ops
does all of that.**

## When to use this

Use it when a message **is** a job-posting URL or **contains** one. Treat as a
job posting:

- **Known ATS / job boards** (high confidence — act without asking):
  `greenhouse.io` (incl. `job-boards.greenhouse.io`, `boards.greenhouse.io`),
  `lever.co` / `jobs.lever.co`, `ashbyhq.com` / `jobs.ashbyhq.com`,
  `myworkdayjobs.com`, `smartrecruiters.com`, `jobvite.com`, `bamboohr.com`,
  `breezy.hr`, `workable.com`, `recruitee.com`, `teamtailor.com`, `icims.com`,
  `taleo.net`, `rippling.com/jobs`.
- **Company careers pages** — the path contains `/careers`, `/jobs`, `/job/`,
  `/positions`, `/openings`, or `/vacancies`.

**Do NOT fire** for: a homepage with no job path, an article/blog/news link, a
LinkedIn feed post, or a bare company name with no URL. If a message has a URL
but you're unsure it's a job posting, **ask once**: "Want me to send this to
career-ops to evaluate?" — don't guess and don't submit non-job links.

Authorization is enforced upstream by the gateway (allowed chats), so by the time
you see the message the sender is permitted. You don't need to re-check.

## How to run it

One command does everything — submit, wait for the evaluation to finish, and
print a ready-to-send result. The sandbox is on the `careerops-bridge` network so
`career-ops:8765` resolves, and the ingest token is read automatically (from
`~/.config/careerops/token`, or `$CAREEROPS_INGEST_TOKEN` if set). Substitute the
real URL — change **nothing else**:

```bash
CO_MAX_POLLS=40 CO_POLL_SECONDS=12 sh /root/bin/co-eval.sh 'PASTE_THE_JOB_URL_HERE' 'from telegram'
```

Notes:
- **It blocks while career-ops works — usually 2–6 minutes.** That is expected;
  do not retry or fire it twice for the same link.
- The token is handled for you. **Never print it, never put it in the URL.**
- First it prints `⏳ Submitted (id N). Evaluating…`, then the final result.

## Replying to the user

The command prints a Telegram-ready summary, then a `---JSON---` block. **Send
the lines above `---JSON---`** to the user, e.g.:

```
📋 Acme — Staff AI Engineer
⭐ 4.2/5 · Apply · High Confidence
➡️ Apply via Greenhouse; lead with agent-eval + Copilot governance.
```

You may enrich the reply using the JSON below the marker (e.g. `top_strengths`,
`soft_gaps`, `report_num`) if the user wants detail — but keep the default reply
short. Then **stop**.

Special cases (from the command's output / exit code):
- **`ℹ️ Already in the pipeline`** → tell the user career-ops already has this one.
- **`⌛ Still running (id N)`** (exit 2) → the eval is taking longer than the wait
  window. Tell the user: "Still evaluating (id N) — I'll have the result shortly,"
  and you can re-check later by id with:
  `curl -sS http://career-ops:8765/evaluation/N -H "Authorization: Bearer $(cat ~/.config/careerops/token)"`
  (returns the full evaluation JSON once `done` is true).
- **`❌ …`** → relay a short apology; it's a submit/auth/service issue (owner-side).

## Quick health check (optional, if something seems off)

```bash
curl -sS http://career-ops:8765/health
```
Healthy: `{"ok":true,"configured":true}`.

## Troubleshooting

- **`no token` / `401 unauthorized`** — the token file `~/.config/careerops/token`
  is missing/stale, or `$CAREEROPS_INGEST_TOKEN` isn't set. (Owner: the file is the
  primary source; the env var is forwarded from `~/.hermes/.env` via
  `terminal.docker_forward_env` and needs a freshly-spawned sandbox to take effect.)
- **`could not resolve host career-ops`** — the sandbox isn't on the
  `careerops-bridge` network (`terminal.docker_extra_args: ['--network=careerops-bridge']`).
- **Hangs past the wait window** — career-ops is slow or the posting needs a
  headless render; the command exits with `⌛ Still running (id N)` so you can
  re-check by id. Confirm the career-ops container is up if it never resolves.
