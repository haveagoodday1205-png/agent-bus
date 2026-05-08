# Agent Bus Protocol Fixtures

These fixtures are public, no-secret, no-quota compatibility artifacts for SDKs, CLIs, and support tools.

## Room Event Replay

- `no-quota-room-events.v1.json` is a stable `agent_bus.room_event_bundle`.
- `no-quota-room-replay.v1.json` is the expected SDK replay summary for that bundle.

Run the fixture gate from a checkout:

```bash
npm run fixture:room-replay
```

The check validates event ordering metadata, verifies event types against `docs/protocol-v1.schema.json`, exercises the JS/Python SDK bundle validators, replays the bundle through the JS SDK, Python SDK, and CLI `--strict` path, and confirms the Markdown replay path still renders the key report/run details. It does not start a gateway and does not call a model provider.
