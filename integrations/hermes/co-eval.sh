#!/bin/sh
# co-eval.sh — Hermes → career-ops job-fit evaluation over HTTP only (no console
# access into the career-ops container). Submits a job URL, polls until the
# evaluation finishes, then prints a Telegram-ready summary + the raw JSON.
#
# Usage:   co-eval.sh <job-posting-url> [note]
# Needs:   curl, and env var CAREEROPS_INGEST_TOKEN (same value as career-ops/.env)
# Reaches: http://career-ops:8765 (both containers must share the careerops-bridge network)
#
# Exit codes: 0 done/duplicate · 1 submit-or-eval error · 2 still-running at timeout
set -eu

BASE="${CAREEROPS_BASE:-http://career-ops:8765}"
# Token: prefer the env var; else fall back to a 0600 file in the sandbox home.
if [ -z "${CAREEROPS_INGEST_TOKEN:-}" ]; then
  for tf in "${CAREEROPS_TOKEN_FILE:-}" "$HOME/.config/careerops/token" "/root/.config/careerops/token"; do
    if [ -n "$tf" ] && [ -f "$tf" ]; then CAREEROPS_INGEST_TOKEN=$(cat "$tf"); break; fi
  done
fi
: "${CAREEROPS_INGEST_TOKEN:?no token: set CAREEROPS_INGEST_TOKEN env or create ~/.config/careerops/token}"
URL="${1:?usage: co-eval.sh <url> [note]}"
NOTE="${2:-from telegram}"
AUTH="Authorization: Bearer ${CAREEROPS_INGEST_TOKEN}"
POLL_SECONDS="${CO_POLL_SECONDS:-10}"
MAX_POLLS="${CO_MAX_POLLS:-150}"   # ~25 min ceiling

# tiny JSON field readers (server sends compact single-line JSON)
jstr() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -1; }
jnum() { sed -n "s/.*\"$1\":\\([0-9.]*\\).*/\\1/p" | head -1; }

# 1) submit -----------------------------------------------------------------
resp=$(curl -s -X POST "$BASE/ingest" -H "$AUTH" -H 'content-type: application/json' \
  -d "{\"url\":\"$URL\",\"note\":\"$NOTE\"}")
if printf '%s' "$resp" | grep -q '"duplicate":true'; then
  echo "ℹ️ Already in the pipeline — this URL was submitted before."
  exit 0
fi
id=$(printf '%s' "$resp" | jnum id)
[ -n "${id:-}" ] || { echo "❌ Submit failed: $resp"; exit 1; }
echo "⏳ Submitted (id $id). Evaluating…"

# 2) poll status until done -------------------------------------------------
status=""
n=0
while [ "$n" -lt "$MAX_POLLS" ]; do
  status=$(curl -s "$BASE/status/$id" -H "$AUTH" | jstr status)
  case "$status" in
    completed) break ;;
    failed)    echo "❌ Evaluation failed (id $id)."; exit 1 ;;
  esac
  n=$((n + 1)); sleep "$POLL_SECONDS"
done
[ "$status" = "completed" ] || { echo "⌛ Still running (id $id) — re-check with GET /status/$id later."; exit 2; }

# 3) fetch + format ---------------------------------------------------------
ev=$(curl -s "$BASE/evaluation/$id" -H "$AUTH")
company=$(printf '%s' "$ev" | jstr company)
role=$(printf '%s' "$ev" | jstr role)
score=$(printf '%s' "$ev" | jnum score)
decision=$(printf '%s' "$ev" | jstr final_decision)
tier=$(printf '%s' "$ev" | jstr legitimacy_tier)
next=$(printf '%s' "$ev" | jstr next_action)

printf '📋 %s — %s\n⭐ %s/5 · %s%s\n' "${company:-?}" "${role:-?}" "${score:-?}" "${decision:-?}" "${tier:+ · $tier}"
[ -n "${next:-}" ] && printf '➡️ %s\n' "$next"
# Raw JSON so an LLM-driven Hermes can enrich the reply (strengths / gaps):
printf '\n---JSON---\n%s\n' "$ev"
