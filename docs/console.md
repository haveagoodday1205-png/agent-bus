# Web Console

Agent Bus includes a dependency-free web console served by the central gateway.

```text
http://127.0.0.1:8788/console/
https://YOUR-GATEWAY-DOMAIN/agent-bus/console/
```

The console can:

- Show a quickstart checklist plus central readiness, active-room counts, and next-action guidance from `GET /v1/agent-bus/status`, including copy buttons for command-level next actions.
- When stale queued room work is reported, include copyable `room inspect`, guarded `room recover --yes`, and explicit `room pause` commands in the quickstart command box with the current gateway and redacted token placeholders.
- Create, audit, and revoke scoped edge tokens while copying ready-to-run `agent-bus setup edge --gateway ... --token ...` join commands.
- Create short-lived pair codes and copy safer `agent-bus setup edge --gateway ... --code ...` onboarding commands for another machine.
- Show gateway health, registered nodes, and agents.
- Show advertised agent permission profiles, allowed wake targets, and profile coverage as observation-only readiness hints.
- Select agents and submit tasks.
- Preview routing decisions.
- Poll thread, room, run, report, blackboard, and stdout/stderr results.
- Open a room trace from the room detail view, look up trace ids, and export trace JSON.
- Export a reports-only room summary with reports, blackboard notes, run metadata, and trace id while omitting the room goal, full messages, and run output by default.
- List OpenAI-compatible models and reuse them from the Model field suggestions.
- Send test Chat Completions or Responses requests through the model router.
- Set an optional cache scope for `agent:<id>` tests so repeated direct agent-model calls can share the same derived Agent Bus session/cache key.

The page stores the bearer token in browser session storage only. The token is not written to the gateway.
