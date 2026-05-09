#!/usr/bin/env bash
set -euo pipefail

message="${AGENT_MESSAGE:-}"
message_file="${AGENT_MESSAGE_FILE:-}"
if [ -n "$message_file" ] && [ -r "$message_file" ]; then
  message="$(cat "$message_file")"
fi

claude_command="${CLAUDECODE_COMMAND:-}"
if [ -z "$claude_command" ]; then
  claude_command="${CLAUDE_CODE_COMMAND:-claude}"
fi
permission_mode="${CLAUDECODE_PERMISSION_MODE:-acceptEdits}"
output_format="${CLAUDECODE_OUTPUT_FORMAT:-text}"
append_system_prompt="${CLAUDECODE_APPEND_SYSTEM_PROMPT:-}"
if [ -z "$append_system_prompt" ]; then
  append_system_prompt="Agent Bus request. Reply plainly and directly. Do not roleplay, do not introduce yourself, and do not mention Claude Code unless the user asks. Return only the answer to the user's request."
fi
session_source="${AGENT_SESSION_ID:-${AGENT_CACHE_KEY:-}}"
session_id=""

derive_uuid() {
  local input="$1"
  local hash=""
  if command -v sha256sum >/dev/null 2>&1; then
    hash="$(printf %s "$input" | sha256sum)"
  elif command -v shasum >/dev/null 2>&1; then
    hash="$(printf %s "$input" | shasum -a 256)"
  fi
  hash="${hash%% *}"
  [ -n "$hash" ] || return 0
  printf '%s-%s-%s-%s-%s\n' "${hash:0:8}" "${hash:8:4}" "${hash:12:4}" "${hash:16:4}" "${hash:20:12}"
}

if [ -n "$session_source" ]; then
  if printf '%s' "$session_source" | grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    session_id="$session_source"
  else
    session_id="$(derive_uuid "agent-bus:${session_source}")"
  fi
fi

max_arg_bytes="${CLAUDECODE_AGENT_BUS_MAX_ARG_BYTES:-20000}"
case "$max_arg_bytes" in
  ''|*[!0-9]*) max_arg_bytes=20000 ;;
esac

message_bytes="$(printf '%s' "$message" | wc -c | tr -d ' ')"
if [ -n "$message_file" ] && [ "${message_bytes:-0}" -gt "$max_arg_bytes" ]; then
  message="Agent Bus request is too large to pass as one CLI argument. Read the full UTF-8 task from: $message_file"
fi

args=(--print --output-format "$output_format")
if [ -n "$permission_mode" ]; then
  args+=(--permission-mode "$permission_mode")
fi
case "${CLAUDECODE_DANGEROUSLY_SKIP_PERMISSIONS:-0}" in
  1|true|TRUE|yes|YES|on|ON) args+=(--dangerously-skip-permissions) ;;
esac
if [ -n "${CLAUDECODE_MODEL:-}" ]; then
  args+=(--model "$CLAUDECODE_MODEL")
fi
if [ -n "${CLAUDECODE_EFFORT:-}" ]; then
  args+=(--effort "$CLAUDECODE_EFFORT")
fi
if [ -n "${CLAUDECODE_MAX_BUDGET_USD:-}" ]; then
  args+=(--max-budget-usd "$CLAUDECODE_MAX_BUDGET_USD")
fi
if [ -n "${CLAUDECODE_SETTINGS:-}" ]; then
  args+=(--settings "$CLAUDECODE_SETTINGS")
fi
if [ -n "$append_system_prompt" ]; then
  args+=(--append-system-prompt "$append_system_prompt")
fi
if [ -n "$session_id" ]; then
  args+=(--session-id "$session_id")
fi
if [ "${CLAUDECODE_NO_SESSION_PERSISTENCE:-0}" = "1" ]; then
  args+=(--no-session-persistence)
fi
args+=("$message")

if [ "${CLAUDECODE_VERBOSE:-0}" = "1" ]; then
  echo "[claudecode-bridge] command=$claude_command output_format=$output_format permission_mode=${permission_mode:-none}" >&2
  echo "[claudecode-bridge] session_id=${session_id:-none} message_bytes=${message_bytes:-0} message_file=${message_file:+present}" >&2
fi

exec "$claude_command" "${args[@]}" < /dev/null
