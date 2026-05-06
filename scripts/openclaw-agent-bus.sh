#!/usr/bin/env bash
set -euo pipefail

agent_id="${OPENCLAW_AGENT_ID:-main}"
message="${AGENT_MESSAGE:-}"
if [ -n "${AGENT_MESSAGE_FILE:-}" ] && [ -r "$AGENT_MESSAGE_FILE" ]; then
  message="$(cat "$AGENT_MESSAGE_FILE")"
fi
session_id="${AGENT_SESSION_ID:-${AGENT_CACHE_KEY:-}}"
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

max_arg_bytes="${OPENCLAW_AGENT_BUS_MAX_ARG_BYTES:-20000}"
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

openclaw "${args[@]}" < /dev/null > "$raw_file"

if command -v jq >/dev/null 2>&1; then
  text="$(jq -r '[.result.payloads[]?.text] | map(select(. != null and . != "")) | join("\n")' "$raw_file")"
  if [ -n "$text" ] && [ "$text" != "null" ]; then
    printf '%s\n' "$text"
    exit 0
  fi
fi

cat "$raw_file"
