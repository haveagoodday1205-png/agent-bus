#!/usr/bin/env bash
set -euo pipefail

message="${AGENT_MESSAGE:-}"
message_file="${AGENT_MESSAGE_FILE:-}"
if [ -n "$message_file" ] && [ -r "$message_file" ]; then
  message="$(cat "$message_file")"
fi

codex_command="${CODEX_COMMAND:-codex}"
max_arg_bytes="${CODEX_AGENT_BUS_MAX_ARG_BYTES:-60000}"
case "$max_arg_bytes" in
  ''|*[!0-9]*) max_arg_bytes=60000 ;;
esac

message_bytes="$(printf '%s' "$message" | wc -c | tr -d ' ')"
if [ -n "$message_file" ] && [ "${message_bytes:-0}" -gt "$max_arg_bytes" ]; then
  message="Agent Bus request is too large to pass as one CLI argument. Read the full UTF-8 task from: $message_file"
fi

exec "$codex_command" exec --color never --dangerously-bypass-approvals-and-sandbox "$message" < /dev/null
