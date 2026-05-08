# No-Quota Room Replay Golden Path

This example is the shortest full Agent Bus proof:

1. start a private local central gateway
2. connect one local edge node
3. register two deterministic command agents
4. create a room and let one agent delegate to the other
5. inspect the room
6. export an event bundle
7. replay the bundle offline into JSON and Markdown

It does not call any model provider and does not need API keys.

## Run

```bash
npm run demo:no-quota-room-replay -- --json
```

To keep the support artifacts:

```bash
npm run demo:no-quota-room-replay -- --out-dir ./agent-bus-no-quota-demo
```

Artifacts:

- `room-events.json`: redacted `agent_bus.room_event_bundle`
- `room-replay.json`: deterministic replay summary
- `room-replay.md`: human-readable replay report
- `room-inspect.json`: operator/debug inspection output

## What It Proves

- central/edge registration works locally
- command adapters receive room tasks
- `REPORT`, `BLACKBOARD`, `@agent-id`, and `DONE` directives are parsed
- room inspection exposes operator/debug state
- event bundles include contiguous `sequence` values
- event bundles include `export_metadata`
- replay preserves export metadata and counts completed runs/reports

## What It Does Not Prove

- a real model provider is reachable
- remote SSH or systemd deployment is configured
- production auth and trust boundaries are sufficient for your environment

Use this as the first contributor smoke test before touching protocol, room, replay, or adapter code.
