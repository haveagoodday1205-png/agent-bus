# Agent Bus Python SDK

Tiny standard-library helpers for connecting Python tools and tests to an Agent Bus gateway.

```python
from sdk.python.agent_bus_sdk import AgentBusClient

bus = AgentBusClient(
    gateway_url="https://YOUR-DOMAIN/agent-bus",
    token="..."
)

agents = bus.agents()
room = bus.create_room({
    "title": "release check",
    "goal": "Check the release and report blockers.",
    "agents": ["hermes-hk", "openclaw-hk"],
    "wakeAgents": ["hermes-hk", "openclaw-hk"],
})

response = bus.agent_response(
    "hermes-hk",
    "Summarize the latest room status.",
    metadata={"agent_bus_cache_scope": "release-check-room"},
)
```

The SDK intentionally stays small:

- discovery: `health()`, `well_known()`, `manifest()`
- presence: `agents()`, `nodes()`
- rooms: `rooms()`, `room(id)`, `create_room()`, `message_room()`, `wake_room()`
- OpenAI-compatible agent calls: `agent_chat()`, `agent_response()`
- replay fixtures: `export_room_events()`, `room_event_bundle()`, `replay_room_events()`

Room event bundles include stable event `sequence` numbers and `export_metadata` so examples and support tools can verify replay order without depending only on array position.

It has no runtime dependencies beyond Python 3.10+.

## Examples

- **[Agent Model Example](../../examples/python-agent-model/)** - Demonstrates using `agent:<id>` as model replacements through `/v1/responses` calls
