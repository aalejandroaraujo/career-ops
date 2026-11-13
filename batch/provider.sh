#!/usr/bin/env bash
# batch/provider.sh — CLI provider adapter for batch-runner.sh
#
# Abstracts the differences between Claude Code and Qwen Code (and future
# providers) so batch-runner.sh does not hardcode any single CLI.
#
# Source this file, then call:
#   provider_check_available  — exit 0 if the CLI is on PATH
#   provider_check_auth       — exit 0 if authenticated, 2 if not
#   provider_invoke           — run a worker (writes stdout/stderr to $log_file)
#   provider_auth_fix_hint    — print how to fix auth
#   provider_name             — display name for logs
#
# Provider selection order:
#   1. $PROVIDER env var (set by ingest server / web UI / daily-scout)
#   2. config/profile.yml → provider.name
#   3. default: "qwen"

set -euo pipefail

# ── resolve provider ─────────────────────────────────────────────────────────

# Read one key from the top-level `provider:` block of config/profile.yml.
# Scoped to that block on purpose: a bare `name:` match would also hit any
# other block that happens to carry a `name:` key.
_profile_provider_value() {
  local key="$1" profile="$PROJECT_DIR/config/profile.yml"
  [[ -f "$profile" ]] || return 0
  awk -v key="$key" '
    /^provider:[[:space:]]*(#.*)?$/ { inblock = 1; next }
    inblock && /^[^[:space:]]/ { exit }
    inblock {
      if (match($0, "^[[:space:]]+" key ":[[:space:]]*")) {
        v = substr($0, RLENGTH + 1)
        sub(/[[:space:]]*#.*$/, "", v)
        gsub(/^"|"$/, "", v)
        print v
        exit
      }
    }
  ' "$profile"
}

_resolve_provider() {
  if [[ -n "${PROVIDER:-}" ]]; then
    echo "$PROVIDER"
    return
  fi
  local val
  val=$(_profile_provider_value name)
  echo "${val:-claude}"
}

# Model: CAREEROPS_MODEL env > --model flag (MODEL) > profile.yml provider.model.
# Empty means "let the CLI use its default". The web UI saves provider.model.
provider_resolve_model() {
  if [[ -n "${CAREEROPS_MODEL:-}" ]]; then
    echo "$CAREEROPS_MODEL"
  elif [[ -n "${MODEL:-}" ]]; then
    echo "$MODEL"
  else
    _profile_provider_value model
  fi
}

PROVIDER_NAME="$(_resolve_provider)"

# ── claude adapter ───────────────────────────────────────────────────────────

_claude_check_available() {
  command -v claude &>/dev/null
}

_claude_check_auth() {
  local status_json=""
  status_json=$(claude auth status 2>&1) || true
  if [[ "$status_json" == *'"loggedIn": true'* || "$status_json" == *'"loggedIn":true'* ]]; then
    return 0
  fi
  return 1
}

_claude_auth_fix_hint() {
  echo "docker exec -it career-ops claude auth login"
}

_claude_invoke() {
  local resolved_prompt="$1" user_prompt="$2" log_file="$3"
  local -a args=(-p --dangerously-skip-permissions --strict-mcp-config)
  if [[ -n "${MODEL:-}" ]]; then
    args+=(--model "$MODEL")
  fi
  args+=(--append-system-prompt-file "$resolved_prompt" "$user_prompt")
  claude "${args[@]}" > "$log_file" 2>&1
}

_claude_is_auth_failure_log() {
  local log_file="$1"
  grep -Eiq '(failed to authenticate|oauth session expired|session expired and could not be refreshed|not authenticated|authentication_error|invalid api key|run .?claude auth login)' "$log_file"
}

_claude_display_name() {
  echo "Claude Code"
}

# ── qwen adapter ─────────────────────────────────────────────────────────────

_qwen_check_available() {
  command -v qwen &>/dev/null
}

_qwen_check_auth() {
  # Pre-flight test: make a minimal API call to verify the key works.
  # This catches expired/invalid keys before starting the batch.
  local test_output
  test_output=$(echo "hi" | timeout 30 qwen -p "reply with just 'ok'" -y \
    --auth-type openai \
    ${BAILIAN_TOKEN_PLAN_API_KEY:+--openai-api-key "$BAILIAN_TOKEN_PLAN_API_KEY"} \
    ${OPENAI_BASE_URL:+--openai-base-url "$OPENAI_BASE_URL"} \
    2>&1) || true
  
  # Quota before auth: an exhausted token plan is not a login problem, and
  # telling the user to fix a key that works sends them the wrong way.
  if echo "$test_output" | grep -qiE "quota.*exhausted|insufficient_quota|exceeded.*quota|429"; then
    return 3
  fi

  # Check for auth errors
  if echo "$test_output" | grep -qiE "401|invalid.*token|token.*expired|unauthorized|api.key"; then
    return 1
  fi

  # Success means the model actually answered "ok". This used to match
  # "ok|hello|hi|help" anywhere in the output, so the YOLO warning banner
  # ("at t-HI-s process's privilege level") passed the check on its own and a
  # dead token plan read as healthy for days (2026-09-12..15).
  if echo "$test_output" | grep -qiE "^[[:space:]'\"\`]*ok[[:space:]'\"\`.!]*$"; then
    return 0
  fi
  
  # Fallback: check if settings.json has valid keys configured
  local settings="$HOME/.qwen/settings.json"
  if [[ -f "$settings" ]]; then
    if python3 -c "
import json, sys, os
d = json.load(open('$settings'))
env = d.get('env', {})
for k, v in env.items():
    if v and not v.startswith('your_'):
        sys.exit(0)
providers = d.get('modelProviders', {})
for pname, plist in providers.items():
    for p in plist:
        ek = p.get('envKey', '')
        if ek and os.environ.get(ek):
            sys.exit(0)
sys.exit(1)
" 2>/dev/null; then
      return 0
    fi
  fi
  
  return 1
}

_qwen_auth_fix_hint() {
  echo "Set BAILIAN_TOKEN_PLAN_API_KEY in .env (get it from bailian.console.alibabacloud.com)"
}

_qwen_invoke() {
  local resolved_prompt="$1" user_prompt="$2" log_file="$3"
  # Qwen auto-loads AGENTS.md from the project directory as context (equivalent
  # to Claude's system prompt + --append-system-prompt-file). The resolved
  # batch prompt (with URL, report number, etc.) is passed as the user prompt.
  # -y enables auto-approval of all tool calls (equivalent to Claude's
  # --dangerously-skip-permissions). Without it, non-interactive mode rejects
  # every tool call.
  # --auth-type openai is required for headless mode.
  # --openai-api-key and --openai-base-url are passed explicitly to use the
  # Bailian Token Plan API (same config as local ~/.qwen/settings.json).
  local -a args=(-p "$user_prompt" -y --auth-type openai)
  if [[ -n "${BAILIAN_TOKEN_PLAN_API_KEY:-}" ]]; then
    args+=(--openai-api-key "$BAILIAN_TOKEN_PLAN_API_KEY")
  fi
  if [[ -n "${OPENAI_BASE_URL:-}" ]]; then
    args+=(--openai-base-url "$OPENAI_BASE_URL")
  fi
  if [[ -n "${MODEL:-}" ]]; then
    args+=(--model "$MODEL")
  fi
  # Feed the resolved prompt (evaluation instructions + placeholders + profile)
  # via stdin. Qwen appends stdin content to the -p prompt.
  cat "$resolved_prompt" | qwen "${args[@]}" > "$log_file" 2>&1
}

_qwen_is_auth_failure_log() {
  local log_file="$1"
  grep -Eiq '(authentication_error|invalid api key|unauthorized|api key.*not found|please.*configure.*auth|provider.*error.*auth)' "$log_file"
}

_qwen_display_name() {
  echo "Qwen Code"
}

# ── dispatch ─────────────────────────────────────────────────────────────────

provider_check_available() {
  case "$PROVIDER_NAME" in
    claude) _claude_check_available ;;
    qwen)   _qwen_check_available ;;
    *)      echo "ERROR: unknown provider '$PROVIDER_NAME'"; return 1 ;;
  esac
}

provider_check_auth() {
  case "$PROVIDER_NAME" in
    claude) _claude_check_auth ;;
    qwen)   _qwen_check_auth ;;
    *)      return 1 ;;
  esac
}

provider_auth_fix_hint() {
  case "$PROVIDER_NAME" in
    claude) _claude_auth_fix_hint ;;
    qwen)   _qwen_auth_fix_hint ;;
    *)      echo "unknown provider" ;;
  esac
}

provider_invoke() {
  case "$PROVIDER_NAME" in
    claude) _claude_invoke "$@" ;;
    qwen)   _qwen_invoke "$@" ;;
    *)      echo "ERROR: unknown provider '$PROVIDER_NAME'" >&2; return 1 ;;
  esac
}

provider_is_auth_failure_log() {
  local log_file="$1"
  case "$PROVIDER_NAME" in
    claude) _claude_is_auth_failure_log "$log_file" ;;
    qwen)   _qwen_is_auth_failure_log "$log_file" ;;
    *)      return 1 ;;
  esac
}

provider_display_name() {
  case "$PROVIDER_NAME" in
    claude) _claude_display_name ;;
    qwen)   _qwen_display_name ;;
    *)      echo "$PROVIDER_NAME" ;;
  esac
}
