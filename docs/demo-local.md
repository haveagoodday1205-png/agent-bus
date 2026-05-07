# Local Demos

## Pairing and task demo

Run from the installed CLI or from a checkout:

```bash
agent-bus demo local
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

Run from the installed CLI or from a checkout:

```bash
agent-bus demo room
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

## Issue-to-PR flagship demo

Run from the installed CLI or from a checkout:

```bash
agent-bus demo issue
npm run demo:issue
```

It shows the public north-star workflow without GitHub credentials, model calls, or external services:

- start a private local gateway
- connect an edge node with `demo-planner`, `demo-coder`, and `demo-reviewer`
- create a room from a GitHub-style issue
- have planner delegate to coder, then coder delegate to reviewer
- capture `REPORT`, `BLACKBOARD`, and `DONE`
- export a reports-only room summary
- export a redacted event bundle and replay it offline
- write a patch artifact and PR draft artifact

The default output directory is `agent-bus-issue-demo/`. Pass `--out-dir PATH` to choose a different directory, `--issue-file issue.md` to use your own issue text, or `--issue "..." --title "..."` for a one-line issue.

All local demos use only fake local tokens and temporary files.

For a real machine, first run:

```bash
agent-bus detect
agent-bus init edge --auto --out edge.config.json
```

The generated config can include Codex, OpenClaw, Hermes, and Ollama agents when those tools are installed locally.
