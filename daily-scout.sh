#!/usr/bin/env bash
# daily-scout.sh — unattended scout pass for career-ops.
#
# Runs the whole discovery half of the funnel so the human only has to do the
# half that needs judgement:
#
#   1. scan.mjs          refresh the pipeline from every configured source (zero tokens)
#   2. liveness sweep    drop postings that died since the last pass (zero tokens)
#   3. batch evaluation  score the newest Swiss roles with claude -p workers
#   4. merge + digest    fold results into the tracker, render the morning digest
#
# Steps 1, 2 and 4 are deterministic and free. Step 3 spends tokens, so it is
# capped (--max) and skippable (--no-eval).
#
# Usage:
#   ./daily-scout.sh                 # full pass, evaluates up to MAX_EVAL Swiss roles
#   ./daily-scout.sh --no-eval       # scan + digest only, zero tokens
#   ./daily-scout.sh --max 5         # cap how many roles get evaluated
#
# Designed for cron. Everything is logged; nothing is interactive.

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR" || exit 1

LOG_DIR="$PROJECT_DIR/logs/daily-scout"
mkdir -p "$LOG_DIR"
TODAY="$(date +%F)"
LOG="$LOG_DIR/$TODAY.log"

MAX_EVAL=6
RUN_EVAL=true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-eval) RUN_EVAL=false; shift ;;
    --max) MAX_EVAL="${2:-6}"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date +%T)] $*" | tee -a "$LOG"; }

# Single-instance guard. Two concurrent runs fight over Playwright browser
# contexts and the loser reports every posting as "uncertain" — a false signal
# that looks exactly like a dead board. Refuse rather than produce garbage.
LOCK="$PROJECT_DIR/.daily-scout.lock"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "[$(date +%T)] another daily-scout is already running — exiting" | tee -a "$LOG"
  exit 0
fi

# cron gets a minimal PATH; node and claude live in the user's toolchain dirs.
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:/usr/local/bin:/usr/bin:/bin"
command -v node >/dev/null || { log "FATAL: node not on PATH"; exit 1; }

log "=== daily-scout start (eval=$RUN_EVAL, max=$MAX_EVAL) ==="

# ── 1. Scan ────────────────────────────────────────────────────────────────
BEFORE=$(grep -c '^- \[ \]' data/pipeline.md 2>/dev/null || echo 0)
if node scan.mjs >>"$LOG" 2>&1; then
  AFTER=$(grep -c '^- \[ \]' data/pipeline.md 2>/dev/null || echo 0)
  log "scan ok: pending $BEFORE -> $AFTER"
else
  log "scan FAILED (see log) — continuing with existing pipeline"
  AFTER="$BEFORE"
fi

# ── 2. Liveness sweep of Swiss pending ─────────────────────────────────────
# Only Swiss roles, because that is the market we act on and the sweep is slow.
SWISS_URLS="$(mktemp)"
grep '^- \[ \]' data/pipeline.md 2>/dev/null \
  | grep -iE 'switzerland|schweiz|suisse|zürich|zurich|bern|basel|zug|luzern|genève|lausanne|winterthur|st\. gallen|lugano' \
  | sed 's/^- \[ \] //' | awk -F' \\| ' '{print $1}' > "$SWISS_URLS"
SWISS_COUNT=$(wc -l < "$SWISS_URLS" | tr -d ' ')
log "swiss pending: $SWISS_COUNT"

if [[ "$SWISS_COUNT" -gt 0 ]]; then
  node check-liveness.mjs --file "$SWISS_URLS" --throttle >>"$LOG" 2>&1
  log "liveness sweep done (exit $?)"
fi

# ── 3. Evaluate the newest Swiss roles ─────────────────────────────────────
if [[ "$RUN_EVAL" == true && "$SWISS_COUNT" -gt 0 ]]; then
  if command -v claude >/dev/null; then
    # Feed the batch runner only roles with no tracker row yet, newest first.
    INPUT="batch/batch-input.tsv"
    cp "$INPUT" "$INPUT.bak-$TODAY" 2>/dev/null || true
    {
      printf 'id\turl\tsource\tnotes\n'
      n=0
      while read -r url; do
        [[ -z "$url" ]] && continue
        grep -qF "$url" data/applications.md 2>/dev/null && continue   # already tracked
        n=$((n+1))
        [[ "$n" -gt "$MAX_EVAL" ]] && break
        printf '%s\t%s\tdaily-scout\tauto %s\n' "$n" "$url" "$TODAY"
      done < <(tac "$SWISS_URLS")
    } > "$INPUT"
    QUEUED=$(( $(wc -l < "$INPUT") - 1 ))
    log "queued $QUEUED role(s) for evaluation"
    if [[ "$QUEUED" -gt 0 ]]; then
      ./batch/batch-runner.sh >>"$LOG" 2>&1
      log "batch runner done (exit $?)"
      # Merge inside the container: the tracker write lock is pid-namespaced.
      if docker compose exec -T career-ops node merge-tracker.mjs >>"$LOG" 2>&1; then
        log "tracker merged"
      else
        log "WARN: container merge failed — run 'docker compose exec career-ops node merge-tracker.mjs' by hand"
      fi
    fi
  else
    log "WARN: claude CLI not on PATH — skipping evaluation"
  fi
fi
rm -f "$SWISS_URLS"

# ── 4. Digest ──────────────────────────────────────────────────────────────
node pipeline-digest.mjs >>"$LOG" 2>&1 && log "digest written: reports/digests/$TODAY-digest.md"

log "=== daily-scout done ==="
