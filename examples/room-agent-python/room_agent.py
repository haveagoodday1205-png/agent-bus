#!/usr/bin/env python3
"""Minimal command adapter target for an Agent Bus room."""

from __future__ import annotations

import os
from pathlib import Path


def main() -> None:
    agent_id = os.environ.get("AGENT_ID", "python-room-agent")
    room_id = os.environ.get("AGENT_ROOM_ID", "")
    trace_id = os.environ.get("AGENT_TRACE_ID", "")
    message = read_message()
    first_line = next((line.strip() for line in message.splitlines() if line.strip()), "No task text provided.")

    print(f"REPORT: {agent_id} received room={room_id or '-'} trace={trace_id or '-'} task={first_line[:160]}")
    print(f"BLACKBOARD: {agent_id} can read AGENT_MESSAGE_FILE and emit REPORT/BLACKBOARD/DONE directives.")
    print("DONE")


def read_message() -> str:
    file_path = os.environ.get("AGENT_MESSAGE_FILE", "")
    if file_path:
        path = Path(file_path)
        if path.exists():
            return path.read_text(encoding="utf-8", errors="replace")
    return os.environ.get("AGENT_MESSAGE", "")


if __name__ == "__main__":
    main()
