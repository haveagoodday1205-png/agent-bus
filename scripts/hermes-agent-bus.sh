#!/usr/bin/env bash
set -euo pipefail

message="${AGENT_MESSAGE:-}"
message_file=""
agent_bus_diag() {
  printf 'Hermes Agent Bus: %s\n' "$*" >&2
}
if [ -n "${AGENT_MESSAGE_FILE:-}" ]; then
  if [ -r "$AGENT_MESSAGE_FILE" ]; then
    message_file="$AGENT_MESSAGE_FILE"
  else
    agent_bus_diag "AGENT_MESSAGE_FILE is not readable ($AGENT_MESSAGE_FILE); using AGENT_MESSAGE fallback."
  fi
fi

raw_session_id="${AGENT_SESSION_ID:-${AGENT_CACHE_KEY:-}}"
session_id="$raw_session_id"
if [ -n "$session_id" ]; then
  session_id="$(printf '%s' "$session_id" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-120)"
  if [ "$session_id" != "$raw_session_id" ]; then
    agent_bus_diag "normalized session id for Hermes compatibility (allowed: A-Za-z0-9_.-, max 120 chars)."
  fi
fi

hermes_root="${HERMES_AGENT_ROOT:-/usr/local/lib/hermes-agent}"
hermes_command="${HERMES_COMMAND:-hermes}"
python_bin="${HERMES_PYTHON:-}"
if [ -z "$python_bin" ] && [ -x "$hermes_root/venv/bin/python3" ]; then
  python_bin="$hermes_root/venv/bin/python3"
fi
python_bin="${python_bin:-python3}"

if [ -z "$session_id" ]; then
  agent_bus_diag "AGENT_SESSION_ID/AGENT_CACHE_KEY is not set; using stateless hermes CLI fallback."
elif [ ! -d "$hermes_root" ]; then
  agent_bus_diag "HERMES_AGENT_ROOT does not exist ($hermes_root); using hermes CLI fallback."
elif [ -n "$session_id" ]; then
  if [ -n "$message_file" ] && [ -r "$message_file" ]; then
    export HERMES_AGENT_BUS_MESSAGE_FILE="$message_file"
    unset HERMES_AGENT_BUS_MESSAGE
  else
    export HERMES_AGENT_BUS_MESSAGE="$message"
    unset HERMES_AGENT_BUS_MESSAGE_FILE
  fi
  export HERMES_AGENT_BUS_SESSION_ID="$session_id"
  export HERMES_SESSION_SOURCE="${HERMES_SESSION_SOURCE:-agent-bus}"
  export PYTHONPATH="$hermes_root${PYTHONPATH:+:$PYTHONPATH}"
  set +e
  child_pid=""
  signal_grace_seconds="${HERMES_AGENT_BUS_SIGNAL_GRACE_SECONDS:-10}"
  case "$signal_grace_seconds" in
    ''|*[!0-9]*) signal_grace_seconds=10 ;;
  esac
  forward_signal() {
    sig="$1"
    code="$2"
    if [ -n "$child_pid" ]; then
      agent_bus_diag "received SIG$sig; forwarding to Hermes child process $child_pid."
      kill -"$sig" "$child_pid" 2>/dev/null || true
      "$python_bin" -c 'import os, signal, sys, time
pid = int(sys.argv[1])
grace = int(sys.argv[2])
sig = sys.argv[3]
time.sleep(grace)
try:
    os.kill(pid, 0)
except OSError:
    raise SystemExit(0)
print(f"Hermes Agent Bus: Hermes child process {pid} did not exit within {grace}s after SIG{sig}; sending SIGKILL.", file=sys.stderr, flush=True)
try:
    os.kill(pid, signal.SIGKILL)
except OSError:
    pass
' "$child_pid" "$signal_grace_seconds" "$sig" &
      signal_watchdog_pid=$!
      wait "$child_pid" 2>/dev/null || true
      kill "$signal_watchdog_pid" 2>/dev/null || true
      wait "$signal_watchdog_pid" 2>/dev/null || true
    else
      agent_bus_diag "received SIG$sig; no active Hermes child process to forward."
    fi
    exit "$code"
  }
  trap 'forward_signal TERM 143' TERM
  trap 'forward_signal INT 130' INT
  "$python_bin" - <<'PY' &
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

required_methods = [
    "_ensure_runtime_credentials",
    "_resolve_turn_agent_config",
    "_init_agent",
]
missing_methods = [name for name in required_methods if not hasattr(HermesCLI, name)]
if missing_methods:
    print(
        "Hermes Agent Bus session bootstrap unavailable: HermesCLI is missing "
        f"{', '.join(missing_methods)}; falling back to the hermes CLI command.",
        file=sys.stderr,
    )
    raise SystemExit(86)

message_file = os.environ.get("HERMES_AGENT_BUS_MESSAGE_FILE", "")
if message_file:
    try:
        with open(message_file, "r", encoding="utf-8") as fh:
            message = fh.read()
    except OSError as exc:
        print(f"Hermes Agent Bus message file unavailable: {exc}", file=sys.stderr)
        raise SystemExit(1)
else:
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
  child_pid=$!
  wait "$child_pid"
  status=$?
  child_pid=""
  trap - TERM INT
  set -e
  if [ "$status" -ne 86 ]; then
    exit "$status"
  fi
fi

fallback_message="$message"
max_arg_bytes="${HERMES_AGENT_BUS_MAX_ARG_BYTES:-20000}"
case "$max_arg_bytes" in
  ''|*[!0-9]*) max_arg_bytes=20000 ;;
esac
if [ -n "$message_file" ] && [ -r "$message_file" ]; then
  message_bytes="$(wc -c < "$message_file" | tr -d ' ')"
  if [ "${message_bytes:-0}" -gt "$max_arg_bytes" ]; then
    fallback_message="Agent Bus request is too large to pass as a CLI argument. Read the full UTF-8 task from: $message_file"
  else
    fallback_message="$(cat "$message_file")"
  fi
else
  message_bytes="$(printf '%s' "$fallback_message" | wc -c | tr -d ' ')"
fi

exec "$hermes_command" chat -q "$fallback_message" -Q
