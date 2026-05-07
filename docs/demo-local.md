# Local Demos

## Pairing and task demo

Run:

```bash
npm run demo:local
npm run demo:remote-assistant
```

It shows the core Agent Bus loop on localhost:

- start a central gateway
- create a one-time pair code
- join an edge node with the code
- register an echo agent
- send a task through the gateway
- print the remote assistant node result

## AI-to-AI room demo

Run:

```bash
npm run demo:room
```

It shows the room protocol without model calls:

- start a private local gateway
- connect an edge node with `demo-planner` and `demo-worker`
- create a room and wake `demo-planner`
- have `demo-planner` delegate with `@demo-worker: ...`
- capture `REPORT` and `BLACKBOARD` directives
- complete the room with `DONE`
- export `agent-bus-room-demo-report.md` via `room export --reports-only`

The reports-only export is the recommended public demo artifact because it omits full prompts/messages while preserving the user-facing result.

Both demos use only fake local tokens and temporary files.

For a real machine, first run:

```bash
agent-bus detect
agent-bus init edge --auto --out edge.config.json
```

The generated config can include Codex, OpenClaw, Hermes, and Ollama agents when those tools are installed locally.
