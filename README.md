# Agent Bus

[![ci](https://github.com/haveagoodday1205-png/agent-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/haveagoodday1205-png/agent-bus/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/haveagoodday1205-png/agent-bus)](https://github.com/haveagoodday1205-png/agent-bus/releases)

A lightweight distributed agent and OpenAI-compatible model router for connecting Codex, Hermes, OpenClaw, and custom model gateways across machines.

Agent Bus is also an early AI-to-AI protocol surface: agents can discover each other, advertise capabilities, report shallow health, receive tasks, and coordinate inside shared rooms.

There are three entrypoint families:

- `server.mjs`: the original SSH-based prototype.
- `central-gateway.mjs` + `edge-node.mjs`: the preferred Node.js gateway/edge architecture where each machine connects outward to the central gateway and runs local adapters.
- `central_gateway.py` + `edge_node.py`: the same gateway/edge protocol for machines without Node.js.

The core entrypoints intentionally have no npm runtime dependencies.

## What Agent Bus Gives You

Agent Bus is a self-hosted remote-assistant CLI for making AI tools addressable across machines. It is designed for contributors and operators who want a small, auditable bus rather than a monolithic agent platform.

- Remote assistant nodes: keep Codex, Hermes, OpenClaw, Ollama, or shell adapters on private machines that connect outbound to a gateway.
- AI-to-AI rooms: let agents coordinate with `@agent-id`, `REPORT`, `BLACKBOARD`, `WAKE`, and `DONE` directives instead of copying context by hand.
- OpenAI-compatible routing: expose selected model aliases behind one authenticated gateway.
- Zero-dependency core: the Node.js and Python gateway/edge entrypoints use only standard libraries.
- Offline verification: `agent-bus smoke --offline` validates the packaged room path without model calls or external services.
- Compatibility verification: `npm run compat:check` starts a temporary gateway plus `examples/hello-agent` and validates registration, `agent:<id>` chat/responses calls, and room directives without spending model quota.

Start with `docs/remote-assistant-quickstart.md` for the first remote node, `docs/cli.md` for CLI setup, `docs/ai-to-ai.md` for the room protocol, `docs/protocol-v1.md` for the emerging stable protocol contract, `docs/trust-boundaries.md` plus `SECURITY.md` for trust boundaries, `CONTRIBUTING.md` for contributor workflow, `docs/good-first-issues.md` for starter tasks, and `CHANGELOG.md` for release highlights.

New adapter authors can start with `examples/hello-agent/`; it is a no-model, no-secret reference adapter that reads `AGENT_MESSAGE_FILE` and emits `REPORT`, `BLACKBOARD`, and `DONE`.

## Quick Start

Run the local smoke test:

```bash
npm run smoke
```

Run a local demo from the installed CLI or checkout:

```bash
# Show AI-to-AI room delegation and export a share-safe report.
agent-bus demo room
npm run demo:room

# Pair a local edge and send a normal task.
agent-bus demo local
npm run demo:remote-assistant
```

Install the CLI from npm or from a checkout:

```bash
npm install -g agent-bus-cli
agent-bus --help
agent-bus smoke --offline

# contributor checkout install
npm install -g .
agent-bus smoke --offline
```

Or download a portable bundle from [GitHub Releases](https://github.com/haveagoodday1205-png/agent-bus/releases). The bundle includes launchers for Windows and Unix-style shells, a manifest, and SHA-256 checksums. It still only requires Node.js 20+.

Release operators should follow the [release checklist](docs/release.md) for the npm vs portable install matrix, checksum expectations, tag workflow, post-publish smoke tests, and release-note wording. See `CHANGELOG.md` for the current public release highlights.

Contributors can verify package and install paths before publishing or tagging:

```bash
npm run release:check
npm run compat:check
npm run pack:check
npm run portable:check
npm run smoke:npm-install -- --package .  # pre-publish checkout install path
npm run smoke:npm-install                 # post-publish registry version from package.json
npm run bundle -- --archive
```

Use a machine as a remote assistant node:

```bash
agent-bus detect
agent-bus init edge --auto --out edge.config.json
# edit gatewayUrl, edge/admin token, pingUrl, and runCommand if needed
agent-bus doctor --config edge.config.json   # add --json for CI/setup automation
agent-bus connect --config edge.config.json
```

For the full two-machine path, see [Remote Assistant Quickstart](docs/remote-assistant-quickstart.md).

Check live reachability and room activity from the operator machine:

```bash
agent-bus nodes --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ...
```

`nodes` shows edge-machine presence. `status` combines node freshness, non-inference ping URLs for model/service reachability, and active room runs so `running` and `queued` mean a real Agent Bus run is currently in flight.

Or use a one-time pairing code so the new machine never needs the central token pasted into chat:

```bash
# On the central/admin machine
agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ... --preset codex

# On the machine that should become a remote assistant node
agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --auto --service auto --out edge.config.json
agent-bus connect --config edge.config.json
```

Pairing returns a scoped edge token for that node. It can register, poll, report runs, and read discovery metadata, but it cannot create pair codes, create threads, wake rooms, or use the model router.

For the full trust-boundary map covering the admin token, pair code, scoped edge token, adapter execution scope, model-router access, `/agents` vs `/nodes`, and reports-only exports, see [Trust Boundaries](docs/trust-boundaries.md).

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

Build release artifacts locally:

```bash
npm run bundle -- --archive
```

Run a zero-quota offline smoke test:

```bash
agent-bus smoke --offline
```

This uses the local Python gateway for room support and makes no model-provider calls.

For a first-run AI-to-AI room walkthrough, run:

```bash
npm run demo:room
```

It starts a local gateway, connects two fake command agents, has one agent delegate to the other with `@demo-worker: ...`, waits for `DONE`, and writes `agent-bus-room-demo-report.md` using `room export --reports-only` so the artifact is safe to share.

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
- `AGENT_MESSAGE_FILE`: path to a UTF-8 file containing the full task text
- `AGENT_MESSAGE_BYTES`: UTF-8 byte length of the full task text
- `AGENT_RUN_ID`: run id
- `AGENT_THREAD_ID`: stable thread id when the task belongs to a thread
- `AGENT_ROOM_ID`: stable room id when the task belongs to a room
- `AGENT_CACHE_KEY`: stable per-agent cache key based on the room or thread id
- `AGENT_SESSION_ID`: same value as `AGENT_CACHE_KEY`, for CLIs that expose session ids
- `AGENT_ID`: local agent id
- `EDGE_NODE_ID`: edge node id

For large tasks, `AGENT_MESSAGE` may be empty to avoid OS environment-size limits; adapters should read `AGENT_MESSAGE_FILE` when present. The default OpenClaw wrapper does this, passes `AGENT_SESSION_ID` as `openclaw agent --session-id`, starts the message with a stable Agent Bus envelope, falls back to a prompt file when the final OpenClaw CLI argument would be too large, and backs up oversized Agent Bus session files before a run so stale OpenClaw history does not balloon later room turns.

When using OpenClaw, prepare a dedicated Agent Bus agent/workspace before connecting the edge node:

```bash
agent-bus openclaw prepare \
  --config ~/.openclaw/openclaw.json \
  --agent-id agent-bus \
  --workspace /opt/agent-bus/openclaw-workspace \
  --context-tokens 48000
```

Then use `OPENCLAW_AGENT_ID=agent-bus ./scripts/openclaw-agent-bus.sh` as the OpenClaw `runCommand`. This keeps Agent Bus room traffic away from any personal/default OpenClaw workspace, archives `BOOTSTRAP.md` in the target workspace so the first room turn answers the task instead of running onboarding, and gives the dedicated agent a stable Agent Bus system prompt, empty inherited skills list, `cacheRetention: "long"`, and a conservative context cap unless those fields were already customized.

The edge node streams stdout/stderr events back to the gateway, then posts a final run result.

### Gateway API

```bash
curl -s http://127.0.0.1:8788/health
curl -s http://127.0.0.1:8788/agents ^
  -H "authorization: Bearer replace-with-a-long-random-token"
agent-bus status --gateway http://127.0.0.1:8788 --token replace-with-a-long-random-token
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

All gateway endpoints except `GET /health` require a bearer token.

- The admin token from `AGENT_BUS_TOKEN` has full gateway, model router, room, thread, and pairing access.
- Scoped edge tokens are generated by pairing or configured in `edgeTokens`. They can call `GET /agents`, `GET /manifest`, `POST /edge/register`, `POST /edge/poll`, `POST /edge/events`, and `POST /edge/complete`.
- Edge tokens cannot call admin endpoints such as `POST /pair-codes`, `POST /threads`, room wakeups, or real model-router backends. If `modelRouter.allowEdgeAgentModels` is true, they may call `/v1/models`, `/v1/chat/completions`, and `/v1/responses` only for `agent:<agent-id>` models.

`POST /edge/pair` uses a short, one-time code instead of a bearer token. The code expires and is consumed after one successful join, then the gateway stores only a hash of the generated edge token in `data/central/edge_tokens.json`.

Admins can also manage edge tokens directly with `GET /edge/tokens`, `POST /edge/tokens`, and `POST /edge/tokens/revoke`. Token list responses never include raw tokens or token hashes; newly created raw tokens are returned once.

### Agent Health

`GET /agents` separates node reachability from model readiness:

- `status` / `last_seen_at`: the agent is advertised by an online edge node.
- `node_status`: the edge process is online and polling the gateway.
- `ping_status`: optional shallow URL reachability from the edge machine, flattened from `health.ping_status` for quick CLI checks.
- `health.last_run_status` / `last_run_status`: the latest real task result, when available.

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
agent-bus room create \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token replace-with-a-long-random-token \
  --title deploy-check \
  --goal "Check the deployment, fix obvious issues, and report status." \
  --agents codex-120,openclaw-hk,hermes-hk \
  --wake-agents codex-120,openclaw-hk,hermes-hk \
  --no-auto-rotate

agent-bus room show room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format markdown --out room.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --reports-only --out room-summary.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format json --out room.json --no-redact --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format events --out room-events.json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room replay --in room-events.json --format markdown
agent-bus room message room_xxx --message "New context" --agents openclaw-hk
agent-bus room wake room_xxx --agents hermes-hk --reason "Continue from the latest report."
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

For demos, debugging, and future SDK compatibility work, `room export --format events` creates a redacted room event bundle from the room snapshot, and `room replay --in` rebuilds a deterministic offline summary from that bundle.

## OpenAI-Compatible Model Router

The central gateway also exposes OpenAI-compatible model endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`

Configure backends in `central.config.json`:

```json
{
  "modelRouter": {
    "enabled": true,
    "agentModels": true,
    "allowEdgeAgentModels": false,
    "agentModelTimeoutSeconds": 600,
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

Online edge agents are also exposed as virtual models:

```bash
curl -s http://127.0.0.1:8788/v1/models \
  -H "authorization: Bearer replace-with-a-long-random-token"

curl -s http://127.0.0.1:8788/v1/chat/completions \
  -H "authorization: Bearer replace-with-a-long-random-token" \
  -H "content-type: application/json" \
  -d '{
    "model": "agent:hermes-hk",
    "messages": [{"role": "user", "content": "Check the room status and summarize the next step."}]
  }'

curl -s http://127.0.0.1:8788/v1/responses \
  -H "authorization: Bearer replace-with-a-long-random-token" \
  -H "content-type: application/json" \
  -d '{
    "model": "agent:openclaw-hk",
    "input": "Run a quick status check and return the next action."
  }'
```

For `agent:<agent-id>`, Central creates a normal Agent Bus run on the target edge, waits for the terminal result, and returns an OpenAI-style chat completion or response object. This lets one edge use another edge as a model replacement without opening inbound ports on either machine. Keep `allowEdgeAgentModels` false unless you want scoped edge tokens to dispatch work to other edges; admin tokens can always use `agent:<id>` while `agentModels` is enabled.

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

- Add signed native installers after the portable bundle format is stable.
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
