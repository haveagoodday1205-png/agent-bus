# Web Console

Agent Bus includes a dependency-free web console served by the central gateway.

```text
http://127.0.0.1:8788/console/
https://YOUR-GATEWAY-DOMAIN/agent-bus/console/
```

The console can:

- Show gateway health, registered nodes, and agents.
- Select agents and submit tasks.
- Preview routing decisions.
- Poll thread and run results.
- List OpenAI-compatible models and reuse them from the Model field suggestions.
- Send a test chat completion through the model router.
- Set an optional cache scope for `agent:<id>` chat tests; the console sends it as `metadata.agent_bus_cache_scope` so repeated direct agent-model calls can share the same derived Agent Bus session/cache key.

The page stores the bearer token in browser session storage only. The token is not written to the gateway.
