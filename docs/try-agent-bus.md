# Try Agent Bus

This page is for first-time users, adapter authors, and contributors who want to try Agent Bus without private infrastructure.

Agent Bus is a self-hosted bus for making agents discoverable, routable, and collaborative across machines. The public trial paths below avoid model keys, Telegram tokens, SSH, private hosts, and maintainer-only logs.

## 2-minute no-secret demo

Run from any machine with Node.js 20+:

```bash
npx agent-bus-cli@latest demo zero-token
```

Or run from a checkout:

```bash
npm run demo:zero-token
```

This proves:

- a local Central can start
- an Edge can register
- two fake agents can join a room
- one agent can delegate to another with `@agent-id`
- `REPORT`, `BLACKBOARD`, and `DONE` directives are captured
- no model provider, API key, Telegram bot, or remote machine is required

If anything feels confusing, open the zero-token feedback form:

[Zero-token demo feedback](https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=zero_token_demo.yml)

## 10-minute remote node trial

After the no-secret demo works, connect a real machine as an outbound Edge:

```bash
agent-bus setup central --service auto
agent-bus pair create
agent-bus setup edge --code YOUR_PAIR_CODE --auto --service auto
agent-bus status
```

Use the remote node feedback form if setup succeeds but the UX is rough, or if a step fails and the doctor output does not explain why:

[First remote node feedback](https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=remote_node_feedback.yml)

Before sharing logs, remove private hosts, paths, tokens, prompts, model keys, SSH details, and deployment-specific names.

## Adapter-author path

Use the reference adapter first:

```bash
agent-bus protocol conformance --profile adapter-command --agent-command "node examples/hello-agent/agent.mjs" --agent-id hello-agent --json
```

For your own adapter, replace `--agent-command` and `--agent-id`. To publish compatibility proof, write artifacts and validate them:

```bash
agent-bus protocol conformance --profile adapter-command --agent-command "./my-agent" --agent-id my-agent --artifact-dir conformance-artifacts
agent-bus protocol validate-result --artifact-dir conformance-artifacts
```

Share results with the adapter compatibility form:

[Adapter compatibility report](https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=adapter_compatibility.yml)

## What to try next

- `agent-bus demo issue` shows the issue -> planner -> coder -> reviewer -> patch/PR draft skeleton without contacting GitHub.
- `agent-bus demo room` exports a reports-only room summary suitable for public demos.
- `agent-bus room replay --in room-events.json` replays exported room events offline.
- `docs/remote-assistant-quickstart.md` walks through the first production-style Central/Edge setup.
