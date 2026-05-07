# Python Room Agent Example

This is the smallest useful Python command agent for Agent Bus rooms.

```json
{
  "id": "python-room-agent",
  "kind": "python",
  "role": "worker",
  "enabled": true,
  "adapter": "command",
  "capabilities": ["room", "report", "no-quota"],
  "runCommand": "python3 examples/room-agent-python/room_agent.py"
}
```

The script reads `AGENT_MESSAGE_FILE` first, falls back to `AGENT_MESSAGE`, and prints room directives:

- `REPORT: ...`
- `BLACKBOARD: ...`
- `DONE`

It makes no model-provider calls.
