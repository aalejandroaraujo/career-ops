#!/usr/bin/env bash
set -euo pipefail

# career-ops batch runner — standalone orchestrator for AI CLI workers
# Reads batch-input.tsv, delegates each offer to a worker (claude -p or qwen -p),
# tracks state in batch-state.tsv for resumability.
#
# Provider-agnostic: sources batch/provider.sh which adapts to the configured
# CLI (Claude Code, Qwen Code, or future providers). Set provider in
# config/profile.yml, via CAREEROPS_PROVIDER env var, or --provider flag.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BATCH_DIR="$SCRIPT_DIR"
INPUT_FILE="$BATCH_DIR/batch-input.tsv"
STATE_FILE="$BATCH_DIR/batch-state.tsv"
PROMPT_FILE="$BATCH_DIR/batch-prompt.md"
CV_PROMPT_FILE="$BATCH_DIR/cv-prompt.md"
LOGS_DIR="$BATCH_DIR/logs"
TRACKER_DIR="$BATCH_DIR/tracker-additions"
REPORTS_DIR="$PROJECT_DIR/reports"
APPLICATIONS_FILE="$PROJECT_DIR/data/applications.md"
LOCK_FILE="$BATCH_DIR/batch-runner.pid"
PAUSE_FILE="$BATCH_DIR/batch-runner.paused"
STATE_LOCK_DIR="$BATCH_DIR/.batch-state.lock"
STATE_LOCK_PID_FILE="$STATE_LOCK_DIR/pid"
STATE_LOCK_TIMEOUT_SECONDS=30
MAIN_PID="${BASHPID:-$$}"

# Defaults
PARALLEL=1
DRY_RUN=false
RETRY_FAILED=false
RESUME_PAUSED=false
START_FROM=0
MAX_RETRIES=2
MIN_SCORE=0
SKIP_PDF=false
MODEL=""  # empty = let the provider CLI use its default model
PROVIDER_OVERRIDE=""  # --provider flag overrides config/profile.yml
RATE_LIMIT_SLEEP=300
BATCH_PAUSED=false
STATUS_ONLY=false
WATCH_MODE=false
LIMIT=0

# Return success for non-negative integer or decimal strings.
is_decimal_number() {
  [[ "$1" =~ ^[0-9]+([.][0-9]+)?$ ]]
}

# ── Provider adapter ──────────────────────────────────────────────────────────
# CAREEROPS_PROVIDER env > --provider flag > config/profile.yml > default (qwen)
if [[ -n "${CAREEROPS_PROVIDER:-}" ]]; then
  export PROVIDER="${CAREEROPS_PROVIDER}"
elif [[ -n "$PROVIDER_OVERRIDE" ]]; then
  export PROVIDER="$PROVIDER_OVERRIDE"
fi
# shellcheck source=batch/provider.sh
source "$BATCH_DIR/provider.sh"

usage() {
  cat <<USAGE
career-ops batch runner — process job offers via AI CLI workers
Current provider: $(provider_display_name) (override with --provider or CAREEROPS_PROVIDER)

Usage: batch-runner.sh [OPTIONS]

Options:
  --parallel N         Number of parallel workers (default: 1)
  --dry-run            Show what would be processed, don't execute
  --retry-failed       Only retry offers marked as "failed" in state
  --resume-paused      Resume offers paused by a session/rate limit
  --start-from N       Start from offer ID N (skip earlier IDs)
  --limit N            Max number of offers to process in this run
  --max-retries N      Max retry attempts per offer (default: 2)
  --min-score N        Skip PDF/tracker for offers scoring below N (default: 0 = off)
  --skip-pdf           Skip PDF generation entirely (write ❌ in tracker PDF column)
  --rate-limit-sleep N Seconds to wait before retrying a rate-limited worker
                       (default: 300)
  --model NAME         Model passed to the provider CLI's --model flag
                       (default: unset = provider's default). E.g.
                       `--model claude-sonnet-4-6` or `--model qwen3.7-plus`.
  --provider NAME      Override the AI CLI provider: "claude" or "qwen"
                       (default: from config/profile.yml or CAREEROPS_PROVIDER).
  --status             Show batch progress and a per-job table, then exit
  --watch              Live-refresh progress until the run completes
  -h, --help           Show this help

Files:
  batch-input.tsv      Input offers (id, url, source, notes)
  batch-state.tsv      Processing state (auto-managed)
  batch-prompt.md      Prompt template for workers
  logs/                Per-offer logs
  tracker-additions/   Tracker lines for post-batch merge

Examples:
  # Dry run to see pending offers
  ./batch-runner.sh --dry-run

  # Process all pending
  ./batch-runner.sh

  # Retry only failed offers
  ./batch-runner.sh --retry-failed

  # Process 2 at a time starting from ID 10
  ./batch-runner.sh --parallel 2 --start-from 10
USAGE
}

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --parallel) PARALLEL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --retry-failed) RETRY_FAILED=true; shift ;;
    --resume-paused) RESUME_PAUSED=true; shift ;;
    --start-from) START_FROM="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --max-retries) MAX_RETRIES="$2"; shift 2 ;;
    --min-score) MIN_SCORE="$2"; shift 2 ;;
    --skip-pdf) SKIP_PDF=true; shift ;;
    --rate-limit-sleep)
      [[ $# -ge 2 ]] || { echo "ERROR: --rate-limit-sleep requires an argument"; exit 1; }
      RATE_LIMIT_SLEEP="$2"
      shift 2
      ;;
    --model) MODEL="$2"; shift 2 ;;
    --provider) PROVIDER_OVERRIDE="$2"; shift 2 ;;
    --status) STATUS_ONLY=true; shift ;;
    --watch) WATCH_MODE=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# The adapter was sourced before the flags were parsed, so --provider never took
# effect. Apply it now (the env var still wins), then settle the model:
# CAREEROPS_MODEL env > --model > config/profile.yml provider.model.
if [[ -z "${CAREEROPS_PROVIDER:-}" && -n "$PROVIDER_OVERRIDE" ]]; then
  PROVIDER_NAME="$PROVIDER_OVERRIDE"
fi
MODEL="$(provider_resolve_model)"

if ! [[ "$RATE_LIMIT_SLEEP" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --rate-limit-sleep must be a non-negative integer (seconds)."
  exit 1
fi

if ! is_decimal_number "$MIN_SCORE"; then
  echo "ERROR: --min-score must be a non-negative number."
  exit 1
fi

if ! [[ "$LIMIT" =~ ^[0-9]+$ ]]; then
  echo "ERROR: --limit must be a non-negative integer."
  exit 1
fi

# Lock file to prevent double execution
acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCK_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
      echo "ERROR: Another batch-runner is already running (PID $old_pid)"
      echo "If this is stale, remove $LOCK_FILE"
      exit 1
    else
      echo "WARN: Stale lock file found (PID $old_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo "$MAIN_PID" > "$LOCK_FILE"
  start_heartbeat
}

# Heartbeat — liveness that survives a PID-namespace boundary.
#
# daily-scout.sh launches this script on the HOST (daily-scout.sh:127), while the
# health probe runs inside the career-ops container. `kill -0 $pid` only resolves
# pids in the caller's own namespace, so the container sees a host-launched
# runner as dead and reports every one of its jobs "abandoned" — and would offer
# to release a job that is actively running, duplicating ~6 minutes of work.
#
# Worker logs are no help either: provider CLI output is buffered, so the log
# stays 0 bytes until the worker finishes. A file mtime is the one signal that
# crosses namespaces, so touch one on a timer.
HEARTBEAT_FILE="$BATCH_DIR/batch-runner.heartbeat"
HEARTBEAT_PID=""

start_heartbeat() {
  touch "$HEARTBEAT_FILE" 2>/dev/null || true
  # stdin/stdout/stderr all closed, and disowned: a background job that inherits
  # the script's stdout keeps the pipe open, so `out=$(./batch-runner.sh)` blocks
  # until the ticker dies instead of returning when the script exits.
  (
    while :; do
      sleep 30
      touch "$HEARTBEAT_FILE" 2>/dev/null || exit 0
    done
  ) </dev/null >/dev/null 2>&1 &
  HEARTBEAT_PID=$!
  disown "$HEARTBEAT_PID" 2>/dev/null || true
}

stop_heartbeat() {
  [[ -n "$HEARTBEAT_PID" ]] && kill "$HEARTBEAT_PID" 2>/dev/null || true
  HEARTBEAT_PID=""
  rm -f "$HEARTBEAT_FILE" 2>/dev/null || true
}

release_lock() {
  if [[ "${BASHPID:-$$}" != "$MAIN_PID" ]]; then
    return
  fi
  stop_heartbeat
  rm -f "$LOCK_FILE"
}

trap release_lock EXIT

# Validate prerequisites
check_prerequisites() {
  if [[ ! -f "$INPUT_FILE" ]]; then
    echo "ERROR: $INPUT_FILE not found. Add offers first."
    exit 1
  fi

  if [[ ! -f "$PROMPT_FILE" ]]; then
    echo "ERROR: $PROMPT_FILE not found."
    exit 1
  fi

  if ! provider_check_available; then
    echo "ERROR: '$(provider_display_name)' CLI not found in PATH."
    echo "       Provider is set to '$PROVIDER_NAME'. Install the CLI or change the provider."
    exit 1
  fi

  mkdir -p "$LOGS_DIR" "$TRACKER_DIR" "$REPORTS_DIR"
}

# Verify the container's CLI session BEFORE touching the queue. Without this a
# logged-out CLI marks every offer "failed" one by one, silently draining each
# offer's retry budget on a condition only the operator can fix.
check_auth() {
  # Some providers (e.g. qwen) cannot pre-flight auth — provider_check_auth
  # returns 1 only when it can positively confirm "not authenticated".
  local auth_rc=0
  provider_check_auth || auth_rc=$?
  if (( auth_rc == 0 )); then
    return 0
  fi

  local display
  display=$(provider_display_name)
  local hint
  hint=$(provider_auth_fix_hint)
  # 3 = the credentials work but the plan's quota is spent. Pausing is right;
  # "log in again" is not.
  if (( auth_rc == 3 )); then
    echo "ERROR: the '$display' quota is exhausted. No offers were processed; the queue is untouched."
    echo "       Fix: switch provider in the web UI (header model picker) or wait for the quota to reset."
    printf 'auth\t-\t%s quota exhausted - switch provider in the web UI or wait for the reset\n' "$display" > "$PAUSE_FILE"
    exit 2
  fi
  echo "ERROR: the '$display' CLI is not authenticated."
  echo "       No offers were processed; the queue is untouched."
  echo ""
  echo "       Fix: $hint"
  echo ""
  echo "       Then re-run the batch."
  printf 'auth\t-\t%s CLI not authenticated - run: %s\n' "$display" "$hint" > "$PAUSE_FILE"
  exit 2
}

# Status/watch mode only needs prior batch state, not worker prerequisites.
check_status_prerequisites() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    exit 0
  fi
}

# Initialize state file if it doesn't exist
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n' > "$STATE_FILE"
  fi
}

acquire_state_lock() {
  if [[ "${STATE_LOCK_DISABLED:-0}" -eq 1 ]]; then
    return 0
  fi

  local waited=0
  local max_waits=$((STATE_LOCK_TIMEOUT_SECONDS * 10))

  while true; do
    if mkdir "$STATE_LOCK_DIR" 2>/dev/null; then
      if printf '%s\n' "${BASHPID:-$$}" > "$STATE_LOCK_PID_FILE"; then
        STATE_LOCK_OWNED=1
        return 0
      fi
      rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
      rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
      echo "ERROR: Failed to initialize state lock metadata at $STATE_LOCK_DIR"
      return 1
    fi

    if [[ ! -d "$STATE_LOCK_DIR" ]]; then
      if (( PARALLEL <= 1 )); then
        echo "WARN: State lock creation failed. Falling back to lock-free operation (single-worker mode)." >&2
        STATE_LOCK_DISABLED=1
        STATE_LOCK_OWNED=0
        return 0
      fi
      echo "ERROR: Failed to create state lock directory $STATE_LOCK_DIR"
      return 1
    fi

    if [[ -f "$STATE_LOCK_PID_FILE" ]]; then
      local lock_pid
      lock_pid=$(cat "$STATE_LOCK_PID_FILE" 2>/dev/null || true)
      if [[ -n "$lock_pid" ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$STATE_LOCK_PID_FILE"
        if rmdir "$STATE_LOCK_DIR" 2>/dev/null; then
          echo "WARN: Recovered stale state lock (PID $lock_pid not running)."
          continue
        fi
      fi
    fi

    if (( waited >= max_waits )); then
      echo "ERROR: Timed out waiting for state lock at $STATE_LOCK_DIR"
      echo "If no batch-runner worker is active, remove the stale lock directory."
      return 1
    fi

    sleep 0.1
    ((waited += 1))
  done
}

release_state_lock() {
  if [[ "${STATE_LOCK_OWNED:-0}" -ne 1 ]]; then
    return
  fi
  rm -f "$STATE_LOCK_PID_FILE" 2>/dev/null || true
  rmdir "$STATE_LOCK_DIR" 2>/dev/null || true
  STATE_LOCK_OWNED=0
}

run_with_state_lock() {
  acquire_state_lock || return $?

  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi

  release_state_lock
  return "$status"
}

# An offer's identity is the (id, url) pair, never the id alone. Producers such
# as daily-scout.sh rewrite batch-input.tsv with ids restarting at 1, so a bare
# id lookup would inherit the status of whatever unrelated offer last held that
# id and skip the new one as already done.
# Get status of an offer from state file
get_status() {
  local id="$1" url="$2"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "none"
    return
  fi
  local status
  status=$(awk -F'\t' -v id="$id" -v url="$url" '$1 == id && $2 == url { print $3 }' "$STATE_FILE" | tail -1)
  echo "${status:-none}"
}

# Get retry count for an offer
get_retries() {
  local id="$1" url="$2"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "0"
    return
  fi
  local retries
  retries=$(awk -F'\t' -v id="$id" -v url="$url" '$1 == id && $2 == url { print $9 }' "$STATE_FILE" | tail -1)
  echo "${retries:-0}"
}

# Calculate next report number.
# Caller must hold STATE_LOCK_DIR while this runs.
next_report_num_unlocked() {
  local max_num=0
  if [[ -d "$REPORTS_DIR" ]]; then
    for f in "$REPORTS_DIR"/*.md; do
      [[ -f "$f" ]] || continue
      local basename
      basename=$(basename "$f")
      local num="${basename%%-*}"
      num=$((10#$num)) # Remove leading zeros for arithmetic
      if (( num > max_num )); then
        max_num=$num
      fi
    done
  fi
  # Also check state file for assigned report numbers
  if [[ -f "$STATE_FILE" ]]; then
    while IFS=$'\t' read -r _ _ _ _ _ rnum _ _ _; do
      [[ "$rnum" == "report_num" || "$rnum" == "-" || -z "$rnum" ]] && continue
      local n=$((10#$rnum))
      if (( n > max_num )); then
        max_num=$n
      fi
    done < "$STATE_FILE"
  fi
  printf '%03d' $((max_num + 1))
}

# Update or insert state for an offer.
# Caller must hold STATE_LOCK_DIR while this runs.
update_state_unlocked() {
  local id="$1" url="$2" status="$3" started="$4" completed="$5" report_num="$6" score="$7" error="$8" retries="$9"

  if [[ ! -f "$STATE_FILE" ]]; then
    init_state
  fi

  local tmp="$STATE_FILE.tmp"
  local found=false

  # Write header
  head -1 "$STATE_FILE" > "$tmp"

  # Process existing lines
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries; do
    [[ "$sid" == "id" ]] && continue  # skip header
    if [[ "$sid" == "$id" && "$surl" == "$url" ]]; then
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
      found=true
    else
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$sid" "$surl" "$sstatus" "$sstarted" "$scompleted" "$sreport" "$sscore" "$serror" "$sretries" >> "$tmp"
    fi
  done < "$STATE_FILE"

  if [[ "$found" == "false" ]]; then
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$id" "$url" "$status" "$started" "$completed" "$report_num" "$score" "$error" "$retries" >> "$tmp"
  fi

  mv "$tmp" "$STATE_FILE"
}

update_state() {
  run_with_state_lock update_state_unlocked "$@"
}

is_rate_limit_log() {
  local log_file="$1"
  grep -Eiq '(rate limit|rate_limit|too many requests|429|quota exceeded|try again later|temporarily unavailable)' "$log_file"
}

is_session_limit_log() {
  local log_file="$1"
  # An exhausted plan quota belongs here, not with transient 429s: it will not
  # clear in 300s, and treating it as a rate limit cost ~3h per job while Qwen's
  # token plan was empty (jobs 246-250, 2026-09-12..15).
  grep -Eiq '(session limit|resets [0-9:]+[ap]m|usage limit|limit[[:space:]]+reached|quota[^.]*exhausted|insufficient_quota|exceeded your current quota)' "$log_file"
}

# An unauthenticated CLI fails every worker identically, so it is an operator
# problem, not a bad offer. Treated like a session limit: pause, don't consume
# the offer's retry budget.
is_auth_failure_log() {
  local log_file="$1"
  provider_is_auth_failure_log "$log_file"
}

mark_paused_rate_limit() {
  local id="$1" url="$2" started_at="$3" report_num="$4" retries="$5" log_file="$6"
  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local error_msg
  error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "session/rate limit reached")
  update_state "$id" "$url" "paused_rate_limit" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
  printf '%s\t%s\t%s\n' "$id" "$report_num" "$error_msg" > "$PAUSE_FILE"
  BATCH_PAUSED=true
}

reserve_report_num_unlocked() {
  local id="$1" url="$2" started="$3" retries="$4"

  local report_num=""
  if report_num=$(next_report_num_unlocked); then
    update_state_unlocked "$id" "$url" "processing" "$started" "-" "$report_num" "-" "-" "$retries"
  fi

  printf '%s\n' "$report_num"
}

reserve_report_num() {
  run_with_state_lock reserve_report_num_unlocked "$@"
}

# Process a single offer
process_offer() {
  local id="$1" url="$2" source="$3" notes="$4"

  # A CV request (MCP generate_cv → ingest /cv) is marked in the notes column:
  #   [cv:force]            full evaluation, and the CV is built whatever the score
  #   [cv:only report=NNN]  no re-evaluation: tailor a CV from existing report NNN
  local cv_mode="" cv_report=""
  local cv_only_re='\[cv:only report=([0-9]+)\]'
  if [[ "$notes" =~ $cv_only_re ]]; then
    cv_mode="only"
    cv_report="${BASH_REMATCH[1]}"
  elif [[ "$notes" == *"[cv:force]"* ]]; then
    cv_mode="force"
  fi

  local started_at
  started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local retries
  retries=$(get_retries "$id" "$url")
  local report_num report_file=""
  if [[ "$cv_mode" == "only" ]]; then
    # The report already exists; reserving a fresh number would orphan it.
    report_num="$cv_report"
    for candidate_report in "$REPORTS_DIR/$report_num"-*.md; do
      [[ -f "$candidate_report" ]] && { report_file="$candidate_report"; break; }
    done
    if [[ -z "$report_file" ]]; then
      # report_num stays "-": a number recorded here would feed next_report_num.
      update_state "$id" "$url" "failed" "$started_at" "$started_at" "-" "-" "CV requested for report $report_num, but reports/$report_num-*.md does not exist" "$MAX_RETRIES"
      echo "    ❌ CV request #$id: report $report_num not found"
      return 0
    fi
    update_state "$id" "$url" "processing" "$started_at" "-" "$report_num" "-" "-" "$retries"
  else
    report_num=$(reserve_report_num "$id" "$url" "$started_at" "$retries")
  fi
  local date
  date=$(date +%Y-%m-%d)
  local jd_file="/tmp/batch-jd-${id}.txt"

  if [[ "$cv_mode" == "only" ]]; then
    echo "--- CV only for offer #$id: report $report_num, $url (attempt $((retries + 1)))"
  else
    echo "--- Processing offer #$id: $url (report $report_num, attempt $((retries + 1)))${cv_mode:+ [CV forced]}"
  fi

  # Build the prompt with placeholders replaced
  local prompt template="$PROMPT_FILE"
  if [[ "$cv_mode" == "only" ]]; then
    template="$CV_PROMPT_FILE"
    prompt="Genera SOLO el CV a medida para una oferta ya evaluada (no re-evalúes, no escribas report nuevo ni línea de tracker). Report: ${report_file#$PROJECT_DIR/}"
  elif [[ "$SKIP_PDF" == "true" && "$cv_mode" != "force" ]]; then
    prompt="Procesa esta oferta de empleo. Ejecuta el pipeline: evaluación A-F + report .md + tracker line. NO generes PDF; en el tracker escribe ❌ en la columna PDF y en el JSON final establece \"pdf\": null."
    echo "    ⏭️  --skip-pdf set — skipping PDF generation for #$id ($url)"
  else
    prompt="Procesa esta oferta de empleo. Ejecuta el pipeline completo: evaluación A-F + report .md + PDF + tracker line."
  fi
  prompt="$prompt URL: $url"
  prompt="$prompt JD file: $jd_file"
  prompt="$prompt Report number: $report_num"
  prompt="$prompt Date: $date"
  prompt="$prompt Batch ID: $id"
  if [[ "$cv_mode" == "force" ]]; then
    # The user asked for this CV explicitly. The score gate exists to avoid
    # unused PDFs; a CV somebody asked for is by definition not unused.
    prompt="$prompt FORCE_CV: the user explicitly asked for the CV for this role. In Paso 4 IGNORE the auto_pdf_score_threshold gate and ALWAYS generate the PDF. Keep the score and recommendation honest; do not inflate them to justify the CV."
  fi

  local log_file="$LOGS_DIR/${report_num}-${id}.log"
  [[ "$cv_mode" == "only" ]] && log_file="$LOGS_DIR/cv-${report_num}-${id}.log"

  # Pre-fetch the JD so the worker gets real content even for SPA pages its
  # WebFetch can't render (Workday/Ashby/custom React). `local:jds/` → use the
  # cached file; otherwise fetch-jd.mjs (ATS API → headless Chromium render).
  # On failure leave $jd_file unwritten so the worker falls back to WebFetch
  # (batch-prompt "Paso 1") — no regression vs. the previous behaviour.
  #
  # Every JD then goes through jd-intake.mjs, which writes the canonical JD
  # record ($jd_record) that the worker scores from, and replaces $jd_file with
  # extracted plain text. A filed PDF/screenshot/.docx/.eml used to be copied
  # byte-for-byte into the .txt the worker reads; intake extracts (pdftotext /
  # OCR) instead, so every input form reaches the worker as the same record.
  local jd_record="${jd_file%.txt}.json"
  rm -f "$jd_record"
  local intake_source="url"
  [[ "$source" =~ (scout|scan) ]] && intake_source="batch"
  if [[ "$url" =~ ^local:jds/ ]]; then
    local local_jd="$PROJECT_DIR/jds/${url#local:jds/}"
    if [[ -f "$local_jd" ]]; then
      local local_source=""
      [[ "$notes" =~ (jd-text|paste) && "$local_jd" =~ \.(md|txt)$ ]] && local_source="--source paste"
      # shellcheck disable=SC2086
      if node "$PROJECT_DIR/jd-intake.mjs" "$local_jd" $local_source --out "$jd_record" --text-out "$jd_file" >>"$log_file" 2>&1; then
        echo "    📄 Using cached JD: ${url#local:jds/} (canonical record written)"
      else
        echo "    ⚠️  Local JD unreadable or too thin: ${url#local:jds/} — worker will read the file itself"
        rm -f "$jd_file" "$jd_record"
      fi
    else
      echo "    ⚠️  Local JD not found: ${url#local:jds/}"
    fi
  elif node "$PROJECT_DIR/fetch-jd.mjs" "$url" --out "$jd_file" --pdf-dir "$PROJECT_DIR/jds" >>"$log_file" 2>&1; then
    echo "    📥 Pre-fetched JD ($(wc -c <"$jd_file" 2>/dev/null || echo 0) bytes)"
    node "$PROJECT_DIR/jd-intake.mjs" "$jd_file" --source "$intake_source" --url "$url" --out "$jd_record" --text-out "$jd_file" >>"$log_file" 2>&1 \
      || { echo "    ⚠️  JD intake failed — worker will build the record itself"; rm -f "$jd_record"; }
  else
    echo "    ⚠️  JD pre-fetch failed — worker will WebFetch and build the record itself"
  fi
  if [[ -s "$jd_record" ]]; then
    prompt="$prompt JD record: $jd_record"
  fi

  # Prepare system prompt with placeholders resolved
  local resolved_prompt="$BATCH_DIR/.resolved-prompt-${id}.md"
  # Escape sed delimiter characters in variables to prevent substitution breakage
  local esc_url esc_jd_file esc_report_num esc_date esc_id
  esc_url="${url//\\/\\\\}"
  esc_url="${esc_url//|/\\|}"
  esc_jd_file="${jd_file//\\/\\\\}"
  esc_jd_file="${esc_jd_file//|/\\|}"
  esc_report_num="${report_num//|/\\|}"
  esc_date="${date//|/\\|}"
  esc_id="${id//|/\\|}"
  local esc_report_file="${report_file#$PROJECT_DIR/}"
  esc_report_file="${esc_report_file//|/\\|}"
  sed \
    -e "s|{{REPORT_FILE}}|${esc_report_file}|g" \
    -e "s|{{URL}}|${esc_url}|g" \
    -e "s|{{JD_FILE}}|${esc_jd_file}|g" \
    -e "s|{{REPORT_NUM}}|${esc_report_num}|g" \
    -e "s|{{DATE}}|${esc_date}|g" \
    -e "s|{{ID}}|${esc_id}|g" \
    "$template" > "$resolved_prompt"

  # Inject user-layer personalization into the temporary worker prompt.
  # The resolved prompt is gitignored runtime state, so user profile data stays
  # out of the system layer while batch scoring matches interactive scoring.
  for context_file in "$PROJECT_DIR/modes/_profile.md" "$PROJECT_DIR/config/profile.yml"; do
    if [[ -f "$context_file" ]]; then
      {
        printf '\n\n---\n\n'
        printf '## Runtime personalization: %s\n\n' "${context_file#$PROJECT_DIR/}"
        sed 's/^/    /' "$context_file"
        printf '\n'
      } >> "$resolved_prompt"
    fi
  done

  # Launch worker via provider adapter.
  # The adapter handles CLI-specific flags (Claude: --dangerously-skip-permissions
  # --strict-mcp-config --append-system-prompt-file; Qwen: --safe-mode + stdin).
  # Model defaults to the provider's default unless --model was passed.

  local exit_code=0
  local terminal_failure_recorded=false
  local shim_retries=0
  local max_shim_retries=4
  while true; do
    exit_code=0
    provider_invoke "$resolved_prompt" "$prompt" "$log_file" || exit_code=$?

    if [[ $exit_code -eq 0 ]]; then
      break
    fi

    # Check for CLI command not found (exit code 127) — npm shim swap or missing install
    if [[ $exit_code -eq 127 ]] && grep -qE "(command not found|not found|cannot find)" "$log_file" && (( shim_retries < max_shim_retries )); then
      shim_retries=$((shim_retries + 1))
      echo "    ⏳ $(provider_display_name) command not found (shim swap detected). Retrying in 30s (attempt $shim_retries/$max_shim_retries)..."
      sleep 30
      continue
    fi

    if is_auth_failure_log "$log_file"; then
      mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
      echo "    🔑 $(provider_display_name) CLI is not authenticated; pausing batch without consuming retry budget."
      echo "       Fix: $(provider_auth_fix_hint)"
      terminal_failure_recorded=true
      break
    fi

    if is_session_limit_log "$log_file"; then
      mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
      echo "    ⏸️  Session/rate limit reached; pausing batch without consuming retry budget."
      terminal_failure_recorded=true
      break
    fi

    if is_rate_limit_log "$log_file" && (( retries < MAX_RETRIES )); then
      if (( RATE_LIMIT_SLEEP <= 0 )); then
        mark_paused_rate_limit "$id" "$url" "$started_at" "$report_num" "$retries" "$log_file"
        echo "    ⏸️  Rate limited and --rate-limit-sleep is 0; pausing batch without consuming retry budget."
        terminal_failure_recorded=true
        break
      fi
      retries=$((retries + 1))
      local retry_completed_at
      retry_completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      update_state "$id" "$url" "rate_limited" "$started_at" "$retry_completed_at" "$report_num" "-" "rate-limit; retrying after ${RATE_LIMIT_SLEEP}s" "$retries"
      echo "    ⏳ Rate limited (attempt $retries/$MAX_RETRIES). Waiting ${RATE_LIMIT_SLEEP}s before retry..."
      sleep "$RATE_LIMIT_SLEEP"
      continue
    fi

    break
  done

  # Cleanup resolved prompt
  rm -f "$resolved_prompt"

  local completed_at
  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  if [[ $exit_code -eq 0 && "$cv_mode" == "only" ]]; then
    # Success is a PDF on disk, never the worker's word for it.
    local cv_pdf
    cv_pdf=$(sed -nE 's/.*"pdf":[[:space:]]*"([^"]+\.pdf)".*/\1/p' "$log_file" 2>/dev/null | tail -1 || true)
    cv_pdf="${cv_pdf#/app/}"
    local cv_score
    cv_score=$(sed -nE 's/^score:[[:space:]]*([0-9.]+).*/\1/p' "$report_file" 2>/dev/null | head -1 || true)
    if [[ -n "$cv_pdf" && -s "$PROJECT_DIR/$cv_pdf" ]]; then
      update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "${cv_score:--}" "-" "$retries"
      echo "    ✅ CV built: $cv_pdf (report $report_num)"
    else
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "${cv_score:--}" "CV worker exited 0 but no PDF exists${cv_pdf:+ at $cv_pdf}" "$retries"
      echo "    ❌ CV worker reported success but no PDF was written"
    fi
    return 0
  fi

  if [[ $exit_code -eq 0 ]]; then
    # Try to extract score from worker output
    local score="-"
    local score_match
   score_match=$(sed -nE 's/.*"score":[[:space:]]*([0-9.]+).*/\1/p' "$log_file" 2>/dev/null | head -1 || true)
    if [[ -n "$score_match" ]]; then
      score="$score_match"
    fi

    # Check min-score gate (never for a CV the user asked for)
    if [[ "$cv_mode" != "force" ]] && is_decimal_number "$score" && awk -v min="$MIN_SCORE" 'BEGIN{exit !(min > 0)}'; then
      if awk -v score="$score" -v min="$MIN_SCORE" 'BEGIN{exit !(score < min)}'; then
        update_state "$id" "$url" "skipped" "$started_at" "$completed_at" "$report_num" "$score" "below-min-score" "$retries"
        echo "    ⏭️  Skipped (score: $score < min-score: $MIN_SCORE)"
        return 0
      fi
    fi

    # A worker can exit 0 and emit a plausible "score" without having written
    # anything — e.g. it notices the same URL was already evaluated and just
    # echoes the previous result. That produced id 29 on 2026-08-11: "completed"
    # in 68s, report_num 040, score 4.6, but no reports/040-*.md and no tracker
    # TSV. Trusting the worker's word makes a no-op indistinguishable from a real
    # evaluation, so require the artifact to exist on disk.
    local report_glob_found=""
    if [[ -n "$report_num" && "$report_num" != "-" ]]; then
      for candidate_report in "$REPORTS_DIR/$report_num"-*.md; do
        [[ -f "$candidate_report" ]] && { report_glob_found="$candidate_report"; break; }
      done
    fi
    # A worker that resolves the relative "reports/" path against some other cwd
    # writes a perfectly good report somewhere the check above cannot see (that
    # is how reports 141/206/207 were lost). Before throwing the evaluation
    # away, look for it elsewhere in the project and rescue it into REPORTS_DIR.
    if [[ -z "$report_glob_found" && -n "$report_num" && "$report_num" != "-" ]]; then
      local stray_report
      stray_report=$(find "$PROJECT_DIR" -path "$REPORTS_DIR" -prune -o \
        -type f -name "$report_num-*.md" -print 2>/dev/null | head -1)
      if [[ -n "$stray_report" ]]; then
        if mv "$stray_report" "$REPORTS_DIR/"; then
          report_glob_found="$REPORTS_DIR/$(basename "$stray_report")"
          echo "    ⚠️  Report was written to ${stray_report#$PROJECT_DIR/} instead of reports/ — rescued"
        fi
      fi
    fi
    if [[ -z "$report_glob_found" ]]; then
      update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "$score" "worker exited 0 but wrote no report ${report_num}-*.md" "$retries"
      echo "    ❌ Failed: worker reported success (score: $score, report: $report_num) but no report file was written"
      return 0
    fi

    local done_note="-"
    if [[ "$cv_mode" == "force" ]]; then
      local forced_pdf
      forced_pdf=$(sed -nE 's/^\*\*PDF:\*\*[[:space:]]*(output\/[^[:space:]]+\.pdf).*/\1/p' "$report_glob_found" 2>/dev/null | head -1 || true)
      if [[ -z "$forced_pdf" || ! -s "$PROJECT_DIR/$forced_pdf" ]]; then
        done_note="evaluated, but the requested CV was NOT produced - retry with generate_cv"
      fi
    fi
    update_state "$id" "$url" "completed" "$started_at" "$completed_at" "$report_num" "$score" "$done_note" "$retries"
    echo "    ✅ Completed (score: $score, report: $report_num)${cv_mode:+ [CV forced]}"
  elif [[ "$terminal_failure_recorded" == "false" ]]; then
    if (( retries < MAX_RETRIES )); then
      retries=$((retries + 1))
    fi
    local error_msg
    error_msg=$(tail -5 "$log_file" 2>/dev/null | tr '\n' ' ' | cut -c1-200 || echo "Unknown error (exit code $exit_code)")
    update_state "$id" "$url" "failed" "$started_at" "$completed_at" "$report_num" "-" "$error_msg" "$retries"
    echo "    ❌ Failed (attempt $retries, exit code $exit_code)"
  fi
}

# Merge tracker additions into applications.md
merge_tracker() {
  echo ""
  echo "=== Merging tracker additions ==="
  node "$PROJECT_DIR/merge-tracker.mjs"
  echo ""
  echo "=== Reconciling pipeline.md ==="
  node "$PROJECT_DIR/reconcile-pipeline.mjs" || echo "⚠️  Pipeline reconcile had issues (see above)"
  echo ""
  echo "=== Verifying pipeline integrity ==="
  node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues (see above)"
}

# Print summary
print_summary() {
  echo ""
  echo "=== Batch Summary ==="

  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found."
    return
  fi

  local total=0 completed=0 skipped=0 failed=0 pending=0
  local score_sum=0 score_count=0

  while IFS=$'\t' read -r sid _ sstatus _ _ _ sscore _ _; do
    [[ "$sid" == "id" ]] && continue
    total=$((total + 1))
    case "$sstatus" in
      completed) completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      skipped) skipped=$((skipped + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "Total: $total | Completed: $completed | Skipped: $skipped | Failed: $failed | Pending: $pending"

  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
}

print_status_table() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No state file found at $STATE_FILE"
    return
  fi

  local total=0 completed=0 processing=0 failed=0 pending=0 skipped=0 rate_limited=0 paused_rate_limit=0
  local score_sum=0 score_count=0

  # Read first line to skip header
  local header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    total=$((total + 1))
    case "$sstatus" in
      completed)
        completed=$((completed + 1))
        if is_decimal_number "$sscore"; then
          score_sum=$(awk -v sum="$score_sum" -v score="$sscore" 'BEGIN{print sum + score}' 2>/dev/null || echo "$score_sum")
          score_count=$((score_count + 1))
        fi
        ;;
      processing) processing=$((processing + 1)) ;;
      failed) failed=$((failed + 1)) ;;
      skipped) skipped=$((skipped + 1)) ;;
      rate_limited) rate_limited=$((rate_limited + 1)) ;;
      paused_rate_limit) paused_rate_limit=$((paused_rate_limit + 1)) ;;
      *) pending=$((pending + 1)) ;;
    esac
  done < "$STATE_FILE"

  echo "=== Batch Progress ==="
  echo "Total: $total | Completed: $completed | Processing: $processing | Failed: $failed | Pending: $pending | Skipped: $skipped | Rate Limited: $rate_limited | Paused: $paused_rate_limit"
  if (( score_count > 0 )); then
    local avg
    avg=$(awk -v sum="$score_sum" -v count="$score_count" 'BEGIN{printf "%.1f", sum / count}' 2>/dev/null || echo "N/A")
    echo "Average score: $avg/5 ($score_count scored)"
  fi
  echo ""

  # Format the per-job table:
  # Columns: ID, Status, Report, Score, Target (URL or Error Message)
  printf "%-4s | %-17s | %-6s | %-5s | %-40s\n" "ID" "Status" "Report" "Score" "URL / Error"
  printf "%-4s+%-19s+%-8s+%-7s+%-42s\n" "----" "-------------------" "--------" "-------" "------------------------------------------"

  header=true
  while IFS=$'\t' read -r sid surl sstatus sstarted scompleted sreport sscore serror sretries || [[ -n "$sid" ]]; do
    if [[ "$header" == "true" ]]; then
      header=false
      continue
    fi
    [[ -z "$sid" ]] && continue
    sstatus="${sstatus%$'\r'}"
    sscore="${sscore%$'\r'}"
    serror="${serror%$'\r'}"
    sreport="${sreport%$'\r'}"
    local target="$surl"
    if [[ "$sstatus" == "failed" && -n "$serror" && "$serror" != "-" ]]; then
      target="Error: $serror"
    fi
    # Trim target to fit nicely (e.g. 50 chars)
    if (( ${#target} > 50 )); then
      target="${target:0:47}..."
    fi
    printf "%-4s | %-17s | %-6s | %-5s | %-50s\n" "$sid" "$sstatus" "$sreport" "$sscore" "$target"
  done < "$STATE_FILE"
}

watch_status() {
  local active_pid=""
  if [[ -f "$LOCK_FILE" ]]; then
    active_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  fi

  if [[ -n "$active_pid" ]] && kill -0 "$active_pid" 2>/dev/null; then
    echo "Watching batch-runner (PID $active_pid)... Press Ctrl+C to stop."
    while kill -0 "$active_pid" 2>/dev/null; do
      clear || printf "\033[c"
      echo "=== Watching Batch Progress (PID $active_pid) ==="
      print_status_table
      sleep 2
    done
    echo ""
    echo "=== Batch runner process (PID $active_pid) has finished ==="
  else
    echo "No active batch-runner detected."
  fi

  echo "Showing final status:"
  print_status_table

  # Chain verify-pipeline.mjs
  if [[ -f "$PROJECT_DIR/verify-pipeline.mjs" ]]; then
    echo ""
    echo "=== Running pipeline verification ==="
    node "$PROJECT_DIR/verify-pipeline.mjs" || echo "⚠️  Verification found issues"
  fi
}

# Main
main() {
  if [[ "$STATUS_ONLY" == "true" ]]; then
    check_status_prerequisites
    print_status_table
    exit 0
  fi

  if [[ "$WATCH_MODE" == "true" ]]; then
    check_status_prerequisites
    watch_status
    exit 0
  fi

  check_prerequisites

  if [[ "$DRY_RUN" == "false" ]]; then
    acquire_lock
    rm -f "$PAUSE_FILE"
    check_auth
  fi

  init_state

  # Count input offers (skip header, ignore blank lines)
  local total_input
  total_input=$(tail -n +2 "$INPUT_FILE" | grep -c '[^[:space:]]' 2>/dev/null || true)
  total_input="${total_input:-0}"

  if (( total_input == 0 )); then
    echo "No offers in $INPUT_FILE. Add offers first."
    exit 0
  fi

  echo "=== career-ops batch runner ==="
  if (( LIMIT > 0 )); then
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES | Limit: $LIMIT"
  else
    echo "Parallel: $PARALLEL | Max retries: $MAX_RETRIES"
  fi
  echo "Input: $total_input offers"
  echo ""

  # Build list of offers to process
  local -a pending_ids=()
  local -a pending_urls=()
  local -a pending_sources=()
  local -a pending_notes=()

  while IFS=$'\t' read -r id url source notes; do
    [[ "$id" == "id" ]] && continue  # skip header
    [[ -z "$id" || -z "$url" ]] && continue

    # Guard against non-numeric id values
    [[ "$id" =~ ^[0-9]+$ ]] || continue

    # Skip if before start-from
    if (( id < START_FROM )); then
      continue
    fi

    local status
    status=$(get_status "$id" "$url")

    if [[ "$RESUME_PAUSED" == "true" ]]; then
      if [[ "$status" != "paused_rate_limit" ]]; then
        continue
      fi
    elif [[ "$RETRY_FAILED" == "true" ]]; then
      # Only process failed offers
      if [[ "$status" != "failed" ]]; then
        continue
      fi
      # Check retry limit
      local retries
      retries=$(get_retries "$id" "$url")
      if (( retries >= MAX_RETRIES )); then
        echo "SKIP #$id: max retries ($MAX_RETRIES) reached"
        continue
      fi
    else
      # Skip terminal offers
      if [[ "$status" == "completed" || "$status" == "skipped" ]]; then
        continue
      fi
      # Paused rate-limit offers resume explicitly with --resume-paused.
      if [[ "$status" == "paused_rate_limit" ]]; then
        continue
      fi
      # Skip failed offers that hit retry limit (unless --retry-failed)
      if [[ "$status" == "failed" ]]; then
        local retries
        retries=$(get_retries "$id" "$url")
        if (( retries >= MAX_RETRIES )); then
          echo "SKIP #$id: failed and max retries reached (use --retry-failed to force)"
          continue
        fi
      fi
    fi

    if (( LIMIT > 0 )) && (( ${#pending_ids[@]} >= LIMIT )); then
      break
    fi

    pending_ids+=("$id")
    pending_urls+=("$url")
    pending_sources+=("$source")
    pending_notes+=("$notes")
  done < "$INPUT_FILE"

  local pending_count=${#pending_ids[@]}

  if (( pending_count == 0 )); then
    echo "No offers to process."
    print_summary
    exit 0
  fi

  echo "Pending: $pending_count offers"
  echo ""

  # Dry run: just list
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "=== DRY RUN (no processing) ==="
    for i in "${!pending_ids[@]}"; do
      local status
      status=$(get_status "${pending_ids[$i]}" "${pending_urls[$i]}")
      echo "  #${pending_ids[$i]}: ${pending_urls[$i]} [${pending_sources[$i]}] (status: $status)"
    done
    echo ""
    echo "Would process $pending_count offers"
    exit 0
  fi

  # Process offers
  if (( PARALLEL <= 1 )); then
    # Sequential processing
    for i in "${!pending_ids[@]}"; do
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}"
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Resume later with --resume-paused. ==="
        break
      fi
    done
  else
    # Parallel processing with job control
    local running=0
    local -a pids=()
    local -a pid_ids=()

    for i in "${!pending_ids[@]}"; do
      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
        break
      fi

      # Wait if we're at parallel limit
      while (( running >= PARALLEL )); do
        # Wait for any child to finish
        for j in "${!pids[@]}"; do
          if ! kill -0 "${pids[$j]}" 2>/dev/null; then
            wait "${pids[$j]}" 2>/dev/null || true
            unset 'pids[j]'
            unset 'pid_ids[j]'
            running=$((running - 1))
          fi
        done
        # Compact arrays
        pids=("${pids[@]}")
        pid_ids=("${pid_ids[@]}")
        if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
          echo "=== Batch paused: session/rate limit reached. Waiting for running workers, not scheduling new offers. ==="
          break
        fi
        sleep 1
      done

      if [[ "$BATCH_PAUSED" == "true" || -f "$PAUSE_FILE" ]]; then
        break
      fi

      # Launch worker in background
      process_offer "${pending_ids[$i]}" "${pending_urls[$i]}" "${pending_sources[$i]}" "${pending_notes[$i]}" &
      pids+=($!)
      pid_ids+=("${pending_ids[$i]}")
      running=$((running + 1))
    done

    # Wait for remaining workers
    for pid in "${pids[@]}"; do
      wait "$pid" 2>/dev/null || true
    done
  fi

  # Merge tracker additions
  merge_tracker

  # Print summary
  print_summary

  exit 0
}

main "$@"

