# Remote Assistant Quickstart

This quickstart turns one machine into an Agent Bus central gateway and another machine into a remote assistant node. The edge machine connects outward to the gateway, so it does not need an inbound public port.

Use this path when you want a real Codex, OpenClaw, Hermes, Claude Code, Ollama, or command adapter to receive work from another machine.

## 1. Install

On both machines:

```bash
npm install -g agent-bus-cli
agent-bus --help
agent-bus smoke --offline
```

`smoke --offline` starts a temporary local gateway and fake command agent. It does not call a model provider.

## 2. Start The Central Gateway

On the central/admin machine:

```bash
agent-bus setup central \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --out central.config.json \
  --service auto
```

This prints the public gateway URL, a generated admin token, a first scoped edge token, and a copy/paste `setup edge --token ...` command. Store the tokens privately. Then start the gateway:

```bash
agent-bus serve --runtime python --config central.config.json
```

Expose the gateway behind HTTPS if the edge machine is not on the same private network.

## 3. Create A Pair Code

On the central/admin machine:

```bash
agent-bus pair create \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ADMIN_TOKEN \
  --preset codex \
  --ttl 600
```

The returned code is single-use and short-lived. It is safe to send the code to the edge operator; do not send the admin token.

If the same trusted operator controls both machines, you can skip pair codes and use the direct edge command printed by `setup central`:

```bash
agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --token abt_edge_... --auto --service auto --out edge.config.json
```

## 4. Join The Edge Machine

On the machine that should receive work:

```bash
agent-bus detect
agent-bus setup edge \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --code ABCD-2345 \
  --auto \
  --service auto \
  --out edge.config.json
```

`setup edge` redeems the pair code, writes a scoped edge token into `edge.config.json`, runs zero-quota doctor checks, and writes a service template for the current operating system.

Review `edge.config.json` before starting it. In particular:

- `runCommand` should point at the local AI tool or bridge script.
- `pingUrl` should be a shallow reachability URL such as `/v1/models`; it should not run inference.
- `timeoutMs` can be raised for long-running AI CLIs.

Start the edge:

```bash
agent-bus connect --config edge.config.json
```

## 5. Check Presence And Activity

From the central/admin machine:

```bash
agent-bus nodes --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
agent-bus agents --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
```

`nodes` answers whether the edge machine is known and fresh. `status` separates node freshness, agent activity, ping reachability, and last-run health:

- `online/fresh`: the edge process is polling recently.
- `running` or `queued`: a real Agent Bus run is in flight.
- `reachable`: the configured `pingUrl` answered; this is not a model completion check.
- `last_run=ok` or `failed`: the last real task outcome.

## 6. Send A Test Task

For a simple direct task:

```bash
curl -s -X POST https://YOUR-DOMAIN/agent-bus/threads \
  -H "authorization: Bearer ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"message":"Say hello from the remote assistant node.","agents":["AGENT_ID"]}'
```

Replace `AGENT_ID` with an agent id from `agent-bus agents`.

For an AI-to-AI room:

```bash
agent-bus room create \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ADMIN_TOKEN \
  --title first-room \
  --goal "Have the remote assistant inspect this setup and report what works." \
  --agents AGENT_ID \
  --wake-agents AGENT_ID \
  --max-steps 4
```

When the room has reports, export a share-safe summary:

```bash
agent-bus room export room_xxx \
  --reports-only \
  --out room-summary.md \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ADMIN_TOKEN
```

Reports-only exports omit the room goal, full messages, and run output by default.

For the full operator trust map before enabling powerful adapters, read `docs/trust-boundaries.md`. It separates the admin token, short-lived pair code, scoped edge token, command adapter execution scope, model-router access, `/agents` versus `/nodes`, and reports-only export boundary.

## Local Demo

The same story can be tested without any external machine or model quota from the installed CLI or a checkout:

```bash
agent-bus demo local
agent-bus demo room
agent-bus demo agent-model
# checkout aliases:
npm run demo:remote-assistant
npm run demo:room
npm run demo:agent-model
```

`agent-bus demo local` starts a local gateway, creates a pair code, joins a local echo edge, sends a task, and prints the remote assistant result. `agent-bus demo room` starts two fake local agents, exercises `@agent-id`, `REPORT`, `BLACKBOARD`, and `DONE`, then writes a reports-only Markdown file. `agent-bus demo agent-model` exposes a fake edge as `agent:model-agent`, calls both Chat Completions and Responses, and proves a stable cache scope becomes one reusable Agent Bus session key.
