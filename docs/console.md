# Web Console

Agent Bus includes a dependency-free web console served by the central gateway.

```text
http://127.0.0.1:8788/console/
https://YOUR-GATEWAY-DOMAIN/agent-bus/console/
```

The console can:

- Show a quickstart checklist for gateway health, token state, nodes, agents, rooms, and model-router discovery.
- Create, audit, and revoke scoped edge tokens while copying ready-to-run `agent-bus setup edge --gateway ... --token ...` join commands.
- Show gateway health, registered nodes, and agents.
- Select agents and submit tasks.
- Preview routing decisions.
- Poll thread, room, run, report, blackboard, and stdout/stderr results.
- Open a room trace from the room detail view, look up trace ids, and export trace JSON.
- Export a share-safe room summary with reports, blackboard notes, run metadata, and trace id.
- List OpenAI-compatible models and reuse them from the Model field suggestions.
- Send test Chat Completions or Responses requests through the model router.
- Set an optional cache scope for `agent:<id>` tests so repeated direct agent-model calls can share the same derived Agent Bus session/cache key.

The page stores the bearer token in browser session storage only. The token is not written to the gateway.
