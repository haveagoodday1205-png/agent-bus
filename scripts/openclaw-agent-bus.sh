#!/usr/bin/env bash
set -euo pipefail

agent_id="${OPENCLAW_AGENT_ID:-main}"
message="${AGENT_MESSAGE:-}"
session_id="${AGENT_SESSION_ID:-${AGENT_CACHE_KEY:-}}"

prompt=$(cat <<EOF
Agent Bus request.
Reply plainly and directly.
Do not roleplay, do not introduce yourself, and do not mention OpenClaw unless the user asks.
Return only the answer to the user's request.

User request:
$message
EOF
)

raw_file="$(mktemp)"
trap 'rm -f "$raw_file"' EXIT

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
