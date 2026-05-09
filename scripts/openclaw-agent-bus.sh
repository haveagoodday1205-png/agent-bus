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

home_dir="${HOME:-${TMPDIR:-/tmp}}"
state_dir="${OPENCLAW_STATE_DIR:-$home_dir/.openclaw}"
raw_file="$(mktemp)"
prompt_file=""
session_lock_dir=""
session_lock_touch_pid=""
release_session_lock() {
  if [ -n "$session_lock_touch_pid" ]; then
    kill "$session_lock_touch_pid" 2>/dev/null || true
    wait "$session_lock_touch_pid" 2>/dev/null || true
    session_lock_touch_pid=""
  fi
  if [ -n "$session_lock_dir" ] && [ -d "$session_lock_dir" ]; then
    rm -rf "$session_lock_dir"
  fi
  session_lock_dir=""
}
cleanup() {
  rm -f "$raw_file"
  if [ -n "$prompt_file" ]; then
    rm -f "$prompt_file"
  fi
  release_session_lock
}
trap cleanup EXIT

prune_oversized_session() {
  [ -n "$session_id" ] || return 0
  local max_bytes="${OPENCLAW_AGENT_BUS_MAX_SESSION_BYTES:-65536}"
  case "$max_bytes" in
    ''|*[!0-9]*) max_bytes=65536 ;;
  esac
  [ "$max_bytes" -gt 0 ] || return 0

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

start_session_lock_touch() {
  [ -n "$session_lock_dir" ] || return 0
  local touch_seconds="${OPENCLAW_AGENT_BUS_SESSION_LOCK_TOUCH_SECONDS:-60}"
  case "$touch_seconds" in
    ''|*[!0-9]*) touch_seconds=60 ;;
  esac
  [ "$touch_seconds" -ge 1 ] || touch_seconds=60
  (
    while :; do
      sleep "$touch_seconds"
      [ -d "$session_lock_dir" ] || exit 0
      touch "$session_lock_dir" "$session_lock_dir/pid" 2>/dev/null || exit 0
    done
  ) >/dev/null 2>&1 &
  session_lock_touch_pid="$!"
}

acquire_session_lock() {
  [ -n "$session_id" ] || return 0
  local timeout_seconds="${OPENCLAW_AGENT_BUS_SESSION_LOCK_TIMEOUT_SECONDS:-300}"
  local stale_seconds="${OPENCLAW_AGENT_BUS_SESSION_LOCK_STALE_SECONDS:-3600}"
  case "$timeout_seconds" in
    ''|*[!0-9]*) timeout_seconds=300 ;;
  esac
  case "$stale_seconds" in
    ''|*[!0-9]*) stale_seconds=3600 ;;
  esac
  [ "$timeout_seconds" -ge 0 ] || timeout_seconds=300
  [ "$stale_seconds" -ge 1 ] || stale_seconds=3600

  local lock_root="$state_dir/agents/$agent_state_id/agent-bus-session-locks"
  local lock_dir="$lock_root/$session_id.lock"
  mkdir -p "$lock_root"
  local started now lock_mtime age
  started="$(date +%s)"
  while ! mkdir "$lock_dir" 2>/dev/null; do
    now="$(date +%s)"
    lock_mtime="$(stat -c %Y "$lock_dir" 2>/dev/null || printf '0')"
    age=$((now - lock_mtime))
    if [ "$lock_mtime" -gt 0 ] && [ "$age" -ge "$stale_seconds" ]; then
      printf 'openclaw-agent-bus: removing stale session lock after %ss: %s\n' "$age" "$lock_dir" >&2
      rm -rf "$lock_dir"
      continue
    fi
    if [ "$timeout_seconds" -eq 0 ] || [ $((now - started)) -ge "$timeout_seconds" ]; then
      printf 'openclaw-agent-bus: timed out waiting for session lock: %s\n' "$lock_dir" >&2
      printf 'openclaw-agent-bus: another run is using session id %s; retry later or use a different AGENT_SESSION_ID.\n' "$session_id" >&2
      exit 75
    fi
    sleep 1
  done
  session_lock_dir="$lock_dir"
  printf '%s\n' "$$" > "$lock_dir/pid" 2>/dev/null || true
  start_session_lock_touch
}

acquire_session_lock

openclaw_status=0
openclaw_child_pid=""
signal_grace_seconds="${OPENCLAW_AGENT_BUS_SIGNAL_GRACE_SECONDS:-10}"
case "$signal_grace_seconds" in
  ''|*[!0-9]*) signal_grace_seconds=10 ;;
esac

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
    (
      sleep "$signal_grace_seconds"
      if kill -0 "$openclaw_child_pid" 2>/dev/null; then
        printf 'openclaw-agent-bus: OpenClaw child %s did not exit within %ss after SIG%s; sending SIGKILL\n' "$openclaw_child_pid" "$signal_grace_seconds" "$signal" >&2
        kill -KILL "$openclaw_child_pid" 2>/dev/null || true
      fi
    ) &
    signal_watchdog_pid="$!"
    wait "$openclaw_child_pid" 2>/dev/null || true
    kill "$signal_watchdog_pid" 2>/dev/null || true
    wait "$signal_watchdog_pid" 2>/dev/null || true
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
