#!/usr/bin/env bash
set -euo pipefail

message="${AGENT_MESSAGE:-}"
if [ -n "${AGENT_MESSAGE_FILE:-}" ] && [ -r "$AGENT_MESSAGE_FILE" ]; then
  message="$(cat "$AGENT_MESSAGE_FILE")"
fi

session_id="${AGENT_SESSION_ID:-${AGENT_CACHE_KEY:-}}"
if [ -n "$session_id" ]; then
  session_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-120)"
fi

hermes_root="${HERMES_AGENT_ROOT:-/usr/local/lib/hermes-agent}"
hermes_command="${HERMES_COMMAND:-hermes}"
python_bin="${HERMES_PYTHON:-}"
if [ -z "$python_bin" ] && [ -x "$hermes_root/venv/bin/python3" ]; then
  python_bin="$hermes_root/venv/bin/python3"
fi
python_bin="${python_bin:-python3}"

if [ -n "$session_id" ] && [ -d "$hermes_root" ]; then
  export HERMES_AGENT_BUS_MESSAGE="$message"
  export HERMES_AGENT_BUS_SESSION_ID="$session_id"
  export HERMES_SESSION_SOURCE="${HERMES_SESSION_SOURCE:-agent-bus}"
  export PYTHONPATH="$hermes_root${PYTHONPATH:+:$PYTHONPATH}"
  set +e
  "$python_bin" - <<'PY'
import os
import sys

try:
    from cli import HermesCLI
except ModuleNotFoundError as exc:
    print(
        f"Hermes Agent Bus session bootstrap unavailable: missing Python module {exc.name!r}; "
        "falling back to the hermes CLI command.",
        file=sys.stderr,
    )
    raise SystemExit(86)

message = os.environ.get("HERMES_AGENT_BUS_MESSAGE", "")
session_id = os.environ.get("HERMES_AGENT_BUS_SESSION_ID", "")

if not session_id:
    raise SystemExit(2)

cli = HermesCLI(verbose=False, compact=True)
cli.tool_progress_mode = "off"
cli.streaming_enabled = False
cli.session_id = session_id
cli._resumed = False

if not cli._ensure_runtime_credentials():
    raise SystemExit(1)

turn_route = cli._resolve_turn_agent_config(message)
if turn_route["signature"] != cli._active_agent_route_signature:
    cli.agent = None

if not cli._init_agent(
    model_override=turn_route["model"],
    runtime_override=turn_route["runtime"],
    request_overrides=turn_route.get("request_overrides"),
):
    raise SystemExit(1)

cli.agent.quiet_mode = True
cli.agent.suppress_status_output = True
cli.agent.stream_delta_callback = None
cli.agent.tool_gen_callback = None

result = cli.agent.run_conversation(
    user_message=message,
    conversation_history=[],
)
response = result.get("final_response", "") if isinstance(result, dict) else str(result)
if response:
    print(response)
print(f"\nsession_id: {cli.session_id}", file=sys.stderr)
raise SystemExit(1 if isinstance(result, dict) and result.get("failed") else 0)
PY
  status=$?
  set -e
  if [ "$status" -ne 86 ]; then
    exit "$status"
  fi
fi

exec "$hermes_command" chat -q "$message" -Q
