#!/usr/bin/env bash
set -euo pipefail

agent_id="${OPENCLAW_AGENT_ID:-main}"
agent_state_id="$(printf '%s' "$agent_id" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-180)"
if [ -z "$agent_state_id" ]; then
  agent_state_id="main"
fi
message="${AGENT_MESSAGE:-}"
if [ -n "${AGENT_MESSAGE_FILE:-}" ]; then
  if [ ! -r "$AGENT_MESSAGE_FILE" ]; then
    printf 'openclaw-agent-bus: AGENT_MESSAGE_FILE is set but is not readable: %s\n' "$AGENT_MESSAGE_FILE" >&2
    exit 64
  fi
  message="$(cat "$AGENT_MESSAGE_FILE")"
fi
session_id="${AGENT_SESSION_ID:-${AGENT_CACHE_KEY:-}}"
if [ -n "$session_id" ]; then
  session_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-180)"
fi
openclaw_bin="${OPENCLAW_BIN:-${OPENCLAW_COMMAND:-openclaw}}"
case "$openclaw_bin" in
  */*)
    if [ ! -e "$openclaw_bin" ]; then
      printf 'openclaw-agent-bus: OpenClaw executable does not exist: %s\n' "$openclaw_bin" >&2
      printf 'openclaw-agent-bus: set OPENCLAW_BIN to the installed openclaw executable, or add openclaw to PATH.\n' >&2
      exit 127
    fi
    if [ ! -x "$openclaw_bin" ]; then
      printf 'openclaw-agent-bus: OpenClaw executable is not executable: %s\n' "$openclaw_bin" >&2
      printf 'openclaw-agent-bus: fix file permissions or set OPENCLAW_BIN to an executable path.\n' >&2
      exit 126
    fi
    ;;
  *)
    if ! command -v "$openclaw_bin" >/dev/null 2>&1; then
      printf 'openclaw-agent-bus: OpenClaw executable not found on PATH: %s\n' "$openclaw_bin" >&2
      printf 'openclaw-agent-bus: install OpenClaw, set OPENCLAW_BIN, or add its directory to PATH.\n' >&2
      exit 127
    fi
    ;;
esac
timestamp_prefix="${AGENT_BUS_OPENCLAW_TIMESTAMP_PREFIX:-[Agent Bus 2000-01-01 00:00 UTC; cache-stable envelope, not current time]}"

prompt=$(cat <<EOF
$timestamp_prefix Agent Bus request.
Reply plainly and directly.
Do not roleplay, do not introduce yourself, and do not mention OpenClaw unless the user asks.
Return only the answer to the user's request.

User request:
$message
EOF
)

raw_file="$(mktemp)"
prompt_file=""
cleanup() {
  rm -f "$raw_file"
  if [ -n "$prompt_file" ]; then
    rm -f "$prompt_file"
  fi
}
trap cleanup EXIT

prune_oversized_session() {
  [ -n "$session_id" ] || return 0
  local max_bytes="${OPENCLAW_AGENT_BUS_MAX_SESSION_BYTES:-65536}"
  case "$max_bytes" in
    ''|*[!0-9]*) max_bytes=65536 ;;
  esac
  [ "$max_bytes" -gt 0 ] || return 0

  local home_dir="${HOME:-${TMPDIR:-/tmp}}"
  local state_dir="${OPENCLAW_STATE_DIR:-$home_dir/.openclaw}"
  local session_dir="$state_dir/agents/$agent_state_id/sessions"
  [ -d "$session_dir" ] || return 0

  local stamp
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  for file in \
    "$session_dir/$session_id.jsonl" \
    "$session_dir/$session_id.trajectory.jsonl" \
    "$session_dir/$session_id.trajectory-path.json"
  do
    [ -f "$file" ] || continue
    local bytes
    bytes="$(wc -c < "$file" | tr -d ' ')"
    if [ "${bytes:-0}" -gt "$max_bytes" ]; then
      mv "$file" "$file.bak-agent-bus-pruned-$stamp"
    fi
  done
}

prune_oversized_session

max_arg_bytes="${OPENCLAW_AGENT_BUS_MAX_ARG_BYTES:-20000}"
case "$max_arg_bytes" in
  ''|*[!0-9]*) max_arg_bytes=20000 ;;
esac
prompt_bytes="$(printf '%s' "$prompt" | wc -c | tr -d ' ')"
if [ "${prompt_bytes:-0}" -gt "$max_arg_bytes" ]; then
  prompt_file="$(mktemp)"
  printf '%s' "$prompt" > "$prompt_file"
  prompt=$(cat <<EOF
$timestamp_prefix Agent Bus request.
The full request is too large to pass directly as a CLI argument.
Read this UTF-8 file first:
$prompt_file

Then follow the instructions in that file and answer the user's request.
EOF
)
fi

args=(agent --agent "$agent_id" --json --message "$prompt")
if [ -n "$session_id" ]; then
  args+=(--session-id "$session_id")
fi

openclaw_status=0
openclaw_child_pid=""

signal_exit_status() {
  case "$1" in
    INT) printf '130' ;;
    TERM) printf '143' ;;
    HUP) printf '129' ;;
    *) printf '128' ;;
  esac
}

forward_signal() {
  local signal="$1"
  local status
  status="$(signal_exit_status "$signal")"
  trap - INT TERM HUP
  if [ -n "$openclaw_child_pid" ] && kill -0 "$openclaw_child_pid" 2>/dev/null; then
    printf 'openclaw-agent-bus: received SIG%s; forwarding to OpenClaw child %s\n' "$signal" "$openclaw_child_pid" >&2
    kill -"$signal" "$openclaw_child_pid" 2>/dev/null || true
    wait "$openclaw_child_pid" 2>/dev/null || true
  fi
  exit "$status"
}
trap 'forward_signal INT' INT
trap 'forward_signal TERM' TERM
trap 'forward_signal HUP' HUP

"$openclaw_bin" "${args[@]}" < /dev/null > "$raw_file" &
openclaw_child_pid="$!"
set +e
wait "$openclaw_child_pid"
openclaw_status="$?"
set -e
openclaw_child_pid=""
trap - INT TERM HUP

if command -v jq >/dev/null 2>&1; then
  text="$(jq -r 'reduce .result.payloads[]?.text as $item ([]; if ($item == null or $item == "" or index($item)) then . else . + [$item] end) | join("\n")' "$raw_file" 2>/dev/null || true)"
  if [ -n "$text" ] && [ "$text" != "null" ]; then
    printf '%s\n' "$text"
    exit "$openclaw_status"
  fi
fi

cat "$raw_file"
exit "$openclaw_status"
