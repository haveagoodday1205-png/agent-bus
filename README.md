# Agent Bus

A lightweight distributed agent and OpenAI-compatible model router for connecting Codex, Hermes, OpenClaw, and custom model gateways across machines.

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
  -d "{\"message\":\"修复 Node 测试并检查模型网关\",\"mode\":\"orchestrate\"}"
```

All gateway endpoints except `GET /health` require the configured bearer token. Edge nodes use the same token for:

- `POST /edge/register`
- `POST /edge/poll`
- `POST /edge/events`
- `POST /edge/complete`

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
node server.mjs route "修复 Node 项目的测试失败，并检查模型网关是否可用" --mode orchestrate
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
- [Deployment](docs/deployment.md)
- [Windows Client](docs/windows-client.md)
- [Security](SECURITY.md)
