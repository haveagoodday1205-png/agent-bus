# Agent Bus Local Zero-Token Playground

This is the first-run demo for contributors and evaluators. It uses only temporary local services, fake tokens, and two deterministic command agents.

```bash
npm run demo:zero-token

# Equivalent from an installed CLI:
agent-bus demo zero-token
```

What it starts:

- a private Python central gateway on `127.0.0.1`
- one local Node edge
- two fake agents: `fake-hermes` and `fake-openclaw`
- one room where `fake-hermes` delegates to `fake-openclaw`

What it proves:

- no API key is required
- no Telegram bot or remote machine is required
- no model provider is called
- `/agents` shows both fake agents online
- the room captures `REPORT`, `BLACKBOARD`, `@agent-id`, and `DONE`
- non-JSON mode writes a reports-only Markdown export you can share

For CI or release checks:

```bash
npm run demo:zero-token -- --json
```

Expected JSON includes `ok: true`, `quota: "no_model_calls"`, `agents.online: 2`, and `room_status: "completed"`.
