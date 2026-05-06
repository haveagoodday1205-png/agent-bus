# Agent Bus

[![ci](https://github.com/haveagoodday1205-png/agent-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/haveagoodday1205-png/agent-bus/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/haveagoodday1205-png/agent-bus)](https://github.com/haveagoodday1205-png/agent-bus/releases)

A lightweight distributed agent and OpenAI-compatible model router for connecting Codex, Hermes, OpenClaw, and custom model gateways across machines.

Agent Bus is also an early AI-to-AI protocol surface: agents can discover each other, advertise capabilities, report shallow health, receive tasks, and coordinate inside shared rooms.

There are now two modes:

- `server.mjs`: the original SSH-based prototype.
- `central-gateway.mjs` + `edge-node.mjs`: the preferred gateway/edge architecture where each machine connects outward to the central gateway and runs local adapters.
- `central_gateway.py` + `edge_node.py`: the same gateway/edge protocol for machines without Node.js.

Both modes intentionally have no npm dependencies.

## Quick Start

Run the local smoke test:

```bash
npm run smoke
```

Run the local demo:

```bash
npm run demo:local
```

Install the CLI from a checkout:

```bash
npm install -g .
agent-bus --help
```

Or download a portable bundle from [GitHub Releases](https://github.com/haveagoodday1205-png/agent-bus/releases). The bundle includes launchers for Windows and Unix-style shells and still only requires Node.js 20+.

Use a machine as a remote assistant node:

```bash
agent-bus init edge --preset codex --out edge.config.json
# edit gatewayUrl, token, pingUrl, and runCommand
agent-bus doctor --config edge.config.json
agent-bus connect --config edge.config.json
```

Or use a one-time pairing code so the new machine never needs the central token pasted into chat:

```bash
# On the central/admin machine
agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ... --preset codex

# On the machine that should become a remote assistant node
agent-bus pair join --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --out edge.config.json
agent-bus doctor --config edge.config.json
agent-bus connect --config edge.config.json
```

Run a central gateway:

```bash
agent-bus init central --out central.config.json
# edit token and modelRouter backends
agent-bus serve --config central.config.json
```

Run with Docker:

```bash
agent-bus init central --out central.config.json
docker compose up --build
```

Generate a long-running service:

```bash
agent-bus service systemd --mode edge --config /opt/agent-bus/edge.config.json --cwd /opt/agent-bus --agent-bus-path /usr/bin/agent-bus --out agent-bus-edge.service
```

Or start the demo pieces manually:

```bash
cp central.config.example.json central.config.json
node mock-openai-backend.mjs
AGENT_BUS_TOKEN=replace-with-a-long-random-token node central-gateway.mjs serve
```

Then call the OpenAI-compatible router:

```bash
curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H "authorization: Bearer replace-with-a-long-random-token" \
  -H "content-type: application/json" \
  -d '{"model":"agent-bus-default","messages":[{"role":"user","content":"hello"}]}'
```

## Gateway + Edge Mode

Start the central gateway:

```bash
node central-gateway.mjs serve
```

Open the web console:

```text
http://127.0.0.1:8788/console/
```

Start one edge node:

```bash
node edge-node.mjs connect
```

Submit a task to the central gateway:

```bash
curl -s -X POST http://127.0.0.1:8788/threads ^
  -H "content-type: application/json" ^
  -H "authorization: Bearer replace-with-a-long-random-token" ^
  -d "{\"message\":\"hello distributed agents\",\"agents\":[\"local-echo\"]}"
```

The central gateway stores:

- `data/central/threads.jsonl`
- `data/central/runs.jsonl`
- `data/central/events.jsonl`
- `data/central/threads/thread_*.json`
- `data/central/runs/run_*.json`

### Deploy Edge Nodes

Copy one edge config onto each machine and run `edge-node.mjs connect --config ...`.

- Browser/shell machine: use `edge.hk.example.json` as a starting point for OpenClaw and Hermes.
- Code machine: use `edge.120.example.json` as a starting point for Codex.
- Model gateway machine: use `edge.178.example.json` as a starting point for an OpenAI-compatible backend.

Each edge node sends:

- `AGENT_MESSAGE`: task text
- `AGENT_RUN_ID`: run id
- `AGENT_ID`: local agent id
- `EDGE_NODE_ID`: edge node id

The edge node streams stdout/stderr events back to the gateway, then posts a final run result.

### Gateway API

```bash
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8788/agents ^
  -H "authorization: Bearer replace-with-a-long-random-token"
curl -s -X POST http://127.0.0.1:8788/route ^
  -H "content-type: application/json" ^
  -H "authorization: Bearer replace-with-a-long-random-token" ^
  -d "{\"message\":\"Fix Node tests and check the model gateway\",\"mode\":\"orchestrate\"}"
```

Machine-readable discovery:

```bash
curl -s http://127.0.0.1:8788/.well-known/agent-bus.json

curl -s http://127.0.0.1:8788/v1/agent-bus/manifest \
  -H "authorization: Bearer replace-with-a-long-random-token"
```

All gateway endpoints except `GET /health` require the configured bearer token. Edge nodes use the same token for:

- `POST /pair-codes`
- `POST /edge/register`
- `POST /edge/poll`
- `POST /edge/events`
- `POST /edge/complete`

`POST /edge/pair` uses a short, one-time code instead of the bearer token. The code expires and is consumed after one successful join.

### Agent Health

`GET /agents` separates node reachability from model readiness:

- `node_status`: the edge process is online and polling the gateway.
- `health.ping_status`: optional shallow URL reachability from the edge machine. This does not run inference.
- `health.last_run_status`: the latest real task result, when available.

Configure `pingUrl`, `healthUrl`, or `modelUrl` on an edge agent to check a URL without spending model credits:

```json
{
  "id": "openclaw-hk",
  "pingUrl": "https://YOUR-MODEL-GATEWAY/v1/models"
}
```

HTTP `2xx`, `3xx`, and `4xx` responses are treated as reachable. For example, `401` from `/v1/models` proves the endpoint is alive without validating a key or running a completion.

### Rooms

Rooms let agents coordinate with each other:

```bash
curl -s -X POST http://127.0.0.1:8788/rooms \
  -H "content-type: application/json" \
  -H "authorization: Bearer replace-with-a-long-random-token" \
  -d '{
    "title": "deploy-check",
    "goal": "Check the deployment, fix obvious issues, and report status.",
    "agents": ["codex-120", "openclaw-hk", "hermes-hk"],
    "wakeAgents": ["codex-120", "openclaw-hk", "hermes-hk"],
    "autoRotate": false
  }'
```

Inside a room, agents can call each other with plain text:

```text
@agent-id: task for that agent
REPORT: concise user-facing report
BLACKBOARD: concise shared state update
WAKE agent-id IN 5m: reason
DONE
```

`DONE` requests completion; the room waits for all queued and running work to finish before becoming completed.

## OpenAI-Compatible Model Router

The central gateway also exposes OpenAI-compatible model endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`

Configure backends in `central.config.json`:

```json
{
  "modelRouter": {
    "enabled": true,
    "defaultBackend": "sub2api-178",
    "defaultModel": "gpt-4o-mini",
    "backends": [
      {
        "id": "sub2api-178",
        "baseUrl": "http://127.0.0.1:8080/v1",
        "apiKeyEnv": "SUB2API_API_KEY",
        "models": ["gpt-4o-mini", "gpt-4.1", "gpt-5"],
        "modelAliases": {
          "agent-bus-default": "gpt-4o-mini"
        }
      }
    ]
  }
}
```

Windows or OpenAI-compatible clients can use:

```text
base_url = https://YOUR-GATEWAY-DOMAIN/agent-bus/v1
api_key  = <agent-bus bearer token>
model    = agent-bus-default
```

If a Windows client has HTTPS/TLS trouble with the public endpoint, run a local proxy:

```powershell
.\start-windows-openai-proxy.ps1 -Upstream "https://YOUR-GATEWAY-DOMAIN/agent-bus" -Token "<agent-bus bearer token>"
```

Then point the client at:

```text
base_url = http://127.0.0.1:8789/v1
api_key  = anything-or-empty
```

Local model-router test:

```powershell
node .\mock-openai-backend.mjs
node .\central-gateway.mjs serve
curl -s http://127.0.0.1:8788/v1/models -H "authorization: Bearer replace-with-a-long-random-token"
```

## Deployment Shape

A typical deployment looks like:

```text
public HTTPS gateway
  /agent-bus/ -> central gateway on localhost

edge machine A -> outbound HTTPS poll -> central gateway
edge machine B -> outbound HTTPS poll -> central gateway
edge machine C -> outbound HTTPS poll -> central gateway
```

Public health check:

```bash
curl -s https://YOUR-GATEWAY-DOMAIN/agent-bus/health
```

Protected APIs require the bearer token injected into the running gateway and edge processes.

## SSH Prototype

## Setup

```bash
cd distributed-agent-bus
cp config.example.json config.json
node server.mjs agents
```

The sample config uses placeholder hosts:

- `openclaw-edge`
- `hermes-edge`
- `codex-edge`
- `model-gateway-edge`

The config stores SSH key file paths, not private key contents.

On Windows, keep `sshPath` pointed at `C:/Windows/System32/OpenSSH/ssh.exe`. Some bundled runtimes may resolve `ssh` differently.
The prototype also defaults `sshViaPowerShell` to `true`, because the same Windows OpenSSH call is more reliable through PowerShell in this workspace.

The default `maxParallelAgents` is `1` because multiple adapters may share the same remote host and some SSH servers close concurrent handshakes aggressively. Increase it after moving adapters to local HTTPS services.
`sameHostDelayMs` adds a small pause between agents on the same SSH host.

## Route Without Running

Use `route` to preview which machine would handle a task. This does not contact the remote agents.

```bash
node server.mjs route "Fix a Node project test failure and check whether the model gateway is available" --mode orchestrate
```

The current rule-based router is intentionally simple:

- code/review tasks -> Codex-style agents
- ops/browser/server tasks -> OpenClaw-style agents
- research/design tasks -> Hermes-style agents
- model/API gateway tasks -> model gateway agents

## Run One Task

```bash
node server.mjs run "Check your local agent health and summarize it." --agents openclaw-edge,hermes-edge
node server.mjs run "Fix a Node test failure and check gateway health." --mode orchestrate
```

Health check:

```bash
node server.mjs health --agents openclaw-edge,codex-edge
```

Start HTTP API:

```bash
node server.mjs serve
```

Then:

```bash
curl -s http://127.0.0.1:8787/agents
curl -s -X POST http://127.0.0.1:8787/route ^
  -H "content-type: application/json" ^
  -d "{\"message\":\"Fix Node tests and check gateway health\",\"mode\":\"orchestrate\"}"
curl -s -X POST http://127.0.0.1:8787/threads ^
  -H "content-type: application/json" ^
  -d "{\"message\":\"Check status\",\"agents\":[\"openclaw-edge\"]}"
```

## Adapter Contract

Each configured agent needs:

- `id`
- `kind`
- `transport`
- `host`
- `user`
- `keyPath`
- `healthCommand`
- `runCommand`

For `ssh-command` adapters, the bus sends the user message as the remote environment variable `AGENT_MESSAGE`.

Example:

```json
{
  "id": "hermes-edge",
  "transport": "ssh-command",
  "runCommand": "/root/.local/bin/hermes chat -q \"$AGENT_MESSAGE\" -Q"
}
```

## Logs

Runtime data is written under `data/`:

- `threads.jsonl`
- `runs.jsonl`
- `threads/thread_*.json`

Health checks are stored in `runs.jsonl` too. Stored stdout/stderr and snapshots are redacted for common API key, bearer token, password, and secret patterns before writing.

## Next Hardening Steps

- Add systemd unit examples.
- Add approval gates for risky commands.
- Add a real orchestrator model that chooses agents instead of broadcasting.
- Move logs from JSONL to SQLite/PostgreSQL.

## More Docs

- [Architecture](docs/architecture.md)
- [AI-to-AI Bus](docs/ai-to-ai.md)
- [CLI](docs/cli.md)
- [Local Demo](docs/demo-local.md)
- [Roadmap](docs/roadmap.md)
- [Deployment](docs/deployment.md)
- [Community and Growth](docs/community.md)
- [Web Console](docs/console.md)
- [Windows Client](docs/windows-client.md)
- [Security](SECURITY.md)
