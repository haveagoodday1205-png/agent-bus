#!/usr/bin/env bash
set -euo pipefail

agent_id="${OPENCLAW_AGENT_ID:-main}"
message="${AGENT_MESSAGE:-}"

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

openclaw agent --agent "$agent_id" --json --message "$prompt" < /dev/null > "$raw_file"

if command -v jq >/dev/null 2>&1; then
  text="$(jq -r '[.result.payloads[]?.text] | map(select(. != null and . != "")) | join("\n")' "$raw_file")"
  if [ -n "$text" ] && [ "$text" != "null" ]; then
    printf '%s\n' "$text"
    exit 0
  fi
fi

cat "$raw_file"
