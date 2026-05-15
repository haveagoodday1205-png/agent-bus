# Agent Bus

[![ci](https://github.com/haveagoodday1205-png/agent-bus/actions/workflows/ci.yml/badge.svg)](https://github.com/haveagoodday1205-png/agent-bus/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/haveagoodday1205-png/agent-bus)](https://github.com/haveagoodday1205-png/agent-bus/releases)

A lightweight distributed agent and OpenAI-compatible model router for connecting Codex, Hermes, OpenClaw, Claude Code, and custom model gateways across machines.

Agent Bus is also an early AI-to-AI protocol surface: agents can discover each other, advertise capabilities, report shallow health, receive tasks, and coordinate inside shared rooms.

There are three entrypoint families:

- `server.mjs`: the original SSH-based prototype.
- `central-gateway.mjs` + `edge-node.mjs`: the preferred Node.js gateway/edge architecture where each machine connects outward to the central gateway and runs local adapters.
- `central_gateway.py` + `edge_node.py`: the same gateway/edge protocol for machines without Node.js.

The core entrypoints intentionally have no npm runtime dependencies.

## What Agent Bus Gives You

Agent Bus is a self-hosted remote-assistant CLI for making AI tools addressable across machines. It is designed for contributors and operators who want a small, auditable bus rather than a monolithic agent platform.

- Remote assistant nodes: keep Codex, Hermes, OpenClaw, Claude Code, Ollama, or shell adapters on private machines that connect outbound to a gateway.
- AI-to-AI rooms: let agents coordinate with `@agent-id`, `REPORT`, `BLACKBOARD`, `WAKE`, and `DONE` directives instead of copying context by hand.
- Local room memory cache: keep extractive compressed recall plus book-style source positions for older room context without embeddings, databases, or model calls.
- OpenAI-compatible routing: expose selected model aliases behind one authenticated gateway.
- Central plugins: optional Telegram Bot notifications can report central startup, edge registration, run completion, and room completion.
- Zero-dependency core: the Node.js and Python gateway/edge entrypoints use only standard libraries.
- Zero-token playground: `agent-bus demo zero-token` starts a private local gateway plus two fake room agents so anyone can see Agent Bus coordinate without API keys, Telegram, remote machines, or model quota.
- Offline verification: `agent-bus smoke --offline` validates the packaged room path without model calls or external services.
- Golden-path demo: `npm run demo:no-quota-room-replay -- --json` starts local central/edge services, runs deterministic room agents, exports events, replays them, and inspects the room without model calls.
- Replay fixture gate: `npm run fixture:room-replay` verifies a stable public room event bundle through the CLI, JS SDK, and Python SDK without starting a gateway or spending model quota.
- Compatibility verification: `npm run compat:check` starts a temporary gateway plus `examples/hello-agent` and validates registration, `agent:<id>` chat/responses calls, and room directives without spending model quota.
- Protocol conformance: `agent-bus protocol conformance --json` runs the no-quota v1 contract gate for discovery, scoped edge auth, agent-backed model calls, room directives, event-log, event export, and replay.

Start with `docs/remote-assistant-quickstart.md` for the first remote node, `docs/cli.md` for CLI setup, `docs/ai-to-ai.md` for the room protocol, `docs/protocol-v1.md` for the emerging stable protocol contract, `docs/trust-boundaries.md` plus `SECURITY.md` for trust boundaries, `CONTRIBUTING.md` for contributor workflow, `docs/good-first-issues.md` for starter tasks, and `CHANGELOG.md` for release highlights.

New adapter authors can start with `examples/hello-agent/`; it is a no-model, no-secret reference adapter that reads `AGENT_MESSAGE_FILE` and emits `REPORT`, `BLACKBOARD`, and `DONE`.

JS/TS tool authors can start with `sdk/js/`; it is a zero-dependency ESM client for discovery, rooms, `agent:<id>` Chat Completions/Responses calls, and room event replay fixtures.

Python tool authors can start with `sdk/python/` and `examples/room-agent-python/`; both use only the Python standard library and cover discovery, rooms, agent-backed model calls, and room replay fixtures.

## Contributing

Agent Bus is ready for outside contributors. The easiest path is to pick a task that can run offline and does not require private servers, model keys, or maintainer-only logs.

- Start with `CONTRIBUTING.md` for setup, smoke checks, and pull request expectations.
- Browse `docs/good-first-issues.md` for public-friendly starter tasks.
- Use the "Good first task" issue template if you want to propose or claim a small task.
- Read `SECURITY.md`, `docs/trust-boundaries.md`, `CODE_OF_CONDUCT.md`, and `GOVERNANCE.md` before touching tokens, adapters, pairing, rooms, or the model router.

High-impact contribution lanes right now are adapter presets, SDK examples, web console debugging, portable install polish, protocol fixtures, and smoke tests that keep AI-to-AI rooms safe to change.

## Quick Start

### Choose A Timed Path

Pick the smallest path that proves what you need before adding real models or private machines.

| Time | Goal | Commands | Proves |
| --- | --- | --- | --- |
| 2 minutes | Local no-secret proof | `agent-bus demo zero-token` or `npm run demo:zero-token` | Central/edge registration, two fake agents, room delegation, reports, blackboard, DONE, no model calls |
| 10 minutes | First remote assistant node | `agent-bus setup central --service auto`, `agent-bus pair create`, `agent-bus setup edge --code ... --auto --service auto`, `agent-bus status` | A private machine can connect outbound and become an addressable agent |
| 15 minutes | Telegram operator bot | `agent-bus setup telegram --chat-id ... --service auto --set-commands`, `agent-bus plugin telegram doctor --transport poller` | Mobile control, contextual buttons, process threads, room creation, poller/webhook health |

If a path fails, run the matching doctor before opening an issue:

```bash
agent-bus doctor --config edge.config.json
agent-bus doctor --mode central --production --config central.config.json --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
agent-bus plugin telegram doctor --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN --transport poller
agent-bus diagnostics bundle --config edge.config.json --out diagnostics.json
```

### First no-quota proof

If you are evaluating Agent Bus for the first time, start with the offline checks before configuring real machines, GitHub, Telegram, or model providers:

```bash
npm run demo:zero-token
npm run smoke:offline
npm run demo:no-quota-room-replay -- --json
```

This path starts only temporary local services with fake tokens and deterministic command agents. The zero-token playground is the friendliest first run: it proves central/edge registration, two fake agents, room delegation, `REPORT`, `BLACKBOARD`, `@agent-id`, and `DONE` without API keys or model quota. The deeper smoke and replay checks add room inspection, event export, and offline replay. They do not prove that a real model provider, remote SSH/systemd deployment, or production auth policy is ready for your environment.

Run the local smoke test:

```bash
npm run smoke
```

Run a local demo from the installed CLI or checkout:

```bash
# Run the zero-token playground: central + edge + two fake agents,
# room delegation, REPORT/BLACKBOARD capture, DONE, and no model calls.
agent-bus demo
agent-bus demo zero-token
npm run demo:zero-token

# Run the starter kit: central + edge + two toy agents, room delegation,
# agent:<id> Chat Completions/Responses, and a reports-only export.
agent-bus demo starter
npm run demo:starter

# Show AI-to-AI room delegation and export a share-safe report.
agent-bus demo room
npm run demo:room

# Run the full no-quota room replay golden path with inspect/export/replay assertions.
npm run demo:no-quota-room-replay -- --json

# Show agent:<id> as an OpenAI-compatible model for Chat Completions and Responses.
agent-bus demo agent-model
npm run demo:agent-model

# Show the issue-to-PR flagship demo skeleton and export patch/PR artifacts.
# Proves local room coordination; does not contact GitHub or open a real PR yet.
agent-bus demo issue
npm run demo:issue

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

Or download a portable bundle from [GitHub Releases](https://github.com/haveagoodday1205-png/agent-bus/releases). The bundle includes launchers for Windows and Unix-style shells, docs, SDK examples, a manifest, and SHA-256 checksums. It still only requires Node.js 20+.

Release operators should follow the [release checklist](docs/release.md) for the npm vs portable install matrix, checksum expectations, tag workflow, post-publish smoke tests, and release-note wording. See `CHANGELOG.md` for the current public release highlights.

Contributors can verify package and install paths before publishing or tagging:

```bash
npm run release:check
npm run protocol:conformance
npm run fixture:room-replay
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
agent-bus doctor --config edge.config.json   # zero-quota read-only diagnostics; add --json for CI
agent-bus connect --config edge.config.json
```

For the central machine, run the same zero-quota preflight in central mode before exposing it:

```bash
agent-bus doctor --mode central --config central.config.json --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
```

It checks admin token strength, persistent `dataDir` writability, scoped edge token shape, model-router backend configuration, Telegram plugin environment wiring, and Central readiness endpoints without making model calls.

For the full two-machine path, see [Remote Assistant Quickstart](docs/remote-assistant-quickstart.md).

If setup fails, generate a redacted support bundle before opening an issue:

```bash
agent-bus diagnostics bundle --config edge.config.json --out diagnostics.json
```

It includes versions, config shape, gateway reachability, agents/nodes/models visibility, and local probe status without printing tokens, hosts, or private paths by default.

Check live reachability and room activity from the operator machine:

```bash
agent-bus nodes --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus trace show trace_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
```

`nodes` shows edge-machine presence. `status` combines node freshness, non-inference ping URLs for model/service reachability, and active room runs so `running` and `queued` mean a real Agent Bus run is currently in flight. The central gateway also exposes the shared readiness/next-action summary at `GET /v1/agent-bus/status`, which the Web Console Quickstart panel uses after you save an admin token. `trace show` follows one request across rooms, agent-backed model calls, runs, and edge events.

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
agent-bus setup central --gateway https://YOUR-DOMAIN/agent-bus --out central.config.json --service auto
# setup prints the admin token, the first scoped edge token, a copy/paste edge join command, and an operator checklist.
# edit modelRouter backends and plugins.telegramBot if needed
agent-bus serve --runtime python --config central.config.json
```

The shortest manual edge path uses the first scoped edge token printed by `setup central`:

```bash
agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --token abt_edge_... --auto --service auto --out edge.config.json
agent-bus connect --config edge.config.json
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
```

To enable Telegram notifications, set `plugins.telegramBot.enabled` in `central.config.json`, then provide `AGENT_BUS_TELEGRAM_BOT_TOKEN` and `AGENT_BUS_TELEGRAM_CHAT_ID` in the central service environment. Verify the wiring with `agent-bus plugin telegram test --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN --dry-run`; `npm run plugin:telegram:smoke` covers the same path without contacting Telegram. The optional Telegram control webhook is off by default; when enabled it accepts `/status`, `/agents`, `/rooms`, `/run agent-id task`, and opt-in plain-text conversation mode through `/v1/agent-bus/plugins/telegram/webhook`. Register Telegram's native `/` autocomplete with `agent-bus plugin telegram commands set`, or let the poller do it on startup with `--set-commands` or `AGENT_BUS_TELEGRAM_SET_COMMANDS=true`. Bot replies use contextual inline buttons: agent choices only appear for `/new`, `/agents`, and `/agent`; process choices appear for `/resume`; room choices appear for `/rooms`, `/room`, and `/room new`. `/room new` opens a room draft where the operator can multi-select agents, pick max autonomous steps, then send the room goal or `/room start <goal>`. Plain text stays in the active Telegram process until `/new`; `/resume` switches processes, `/agent` changes process agents, and `@agent-id message` can add or target an agent mid-process. Conversation prompts are compacted with `AGENT_BUS_TELEGRAM_PROMPT_*` limits before dispatch so long chats do not blow up every selected agent's context. If public webhooks are blocked by Cloudflare, NAT, or local-only deployments, run `agent-bus plugin telegram poll --gateway http://127.0.0.1:8788 --delete-webhook --set-commands` on Central instead.

Run with Docker:

```bash
cp .env.example .env
# replace AGENT_BUS_TOKEN in .env before continuing
agent-bus init central --out central.config.json
docker compose config >/tmp/agent-bus-compose.rendered.yaml
docker compose up -d --build
docker compose exec agent-bus-central node /app/agent-bus.mjs health --gateway http://127.0.0.1:8788
```

The bundled Compose stack intentionally starts one `agent-bus-central` service plus the persistent `agent-bus-data` volume. The central station does not need a database to start. It stores append-only JSONL logs and redacted JSON snapshots under `AGENT_BUS_DATA_DIR`; use a persistent disk or Docker volume and regular backups. Add SQLite/Postgres later when you need multi-instance writes, large trace queries, or hosted multi-tenant operations.

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

Use the SDK from a Node.js or TypeScript project:

```js
import { AgentBusClient } from "agent-bus-cli/sdk/js/agent-bus-sdk.mjs";

const bus = new AgentBusClient({
  gatewayUrl: "https://YOUR-DOMAIN/agent-bus",
  token: process.env.AGENT_BUS_TOKEN
});

const agents = await bus.agents();
const response = await bus.agentResponse("hermes-hk", "Summarize current room status.");
```

For a first-run AI-to-AI room walkthrough, run:

```bash
npm run demo:room
```

It starts a local gateway, connects two fake command agents, has one agent delegate to the other with `@demo-worker: ...`, waits for `DONE`, and writes `agent-bus-room-demo-report.md` using `room export --reports-only` so the artifact is safe to share.

For the contributor golden path, run:

```bash
npm run demo:no-quota-room-replay -- --out-dir ./agent-bus-no-quota-demo
```

It starts local central/edge services, registers two deterministic command agents, creates a room, verifies directives, runs `room inspect`, exports `room-events.json`, replays it into JSON and Markdown, and checks event `sequence` plus `export_metadata`. It makes no model-provider calls.

For the model-replacement path, run:

```bash
npm run demo:agent-model
```

It starts a private local gateway plus a fake command edge, exposes `agent:model-agent` from `/v1/models`, calls both `/v1/chat/completions` and `/v1/responses`, and proves the same explicit cache scope becomes one stable Agent Bus session key. It makes no model-provider calls.

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

- Browser/shell machine: use `edge.hk.example.json` as a starting point for OpenClaw, Hermes, and Claude Code.
- Code machine: use `edge.120.example.json` as a starting point for Codex.
- Model gateway machine: use `edge.178.example.json` as a starting point for an OpenAI-compatible backend.

For unstable links, tune `pollTimeoutMs`, `pollRequestGraceMs`, and `requestTimeoutMs` in the edge config. The edge waits for long-poll work, adds a small grace window, and then treats a half-open gateway request as transient so the reconnect loop can continue. Node and Python edges also persist completed run results under `completionOutboxDir` until the central gateway accepts them, so a brief outage does not lose the final answer.

Each edge node sends:

- `AGENT_MESSAGE`: task text
- `AGENT_MESSAGE_FILE`: path to a UTF-8 file containing the full task text
- `AGENT_MESSAGE_BYTES`: UTF-8 byte length of the full task text
- `AGENT_RUN_ID`: run id
- `AGENT_THREAD_ID`: stable thread id when the task belongs to a thread
- `AGENT_ROOM_ID`: stable room id when the task belongs to a room
- `AGENT_WAKE_REASON`: why the room or operator woke this agent
- `AGENT_CACHE_SCOPE`: explicit request cache scope, when supplied by an agent-backed model call
- `AGENT_CACHE_KEY`: stable per-agent cache key based on the room or thread id
- `AGENT_SESSION_ID`: same value as `AGENT_CACHE_KEY`, for CLIs that expose session ids
- `AGENT_ID`: local agent id
- `EDGE_NODE_ID`: edge node id
- `EDGE_SESSION_ID`: edge process session id; changes when that edge process restarts unless explicitly overridden

For large tasks, `AGENT_MESSAGE` may be empty to avoid OS environment-size limits; adapters should read `AGENT_MESSAGE_FILE` when present. The default Codex, OpenClaw, Hermes, and Claude Code bridge scripts do this so long room prompts do not become oversized environment variables. The OpenClaw wrapper also passes `AGENT_SESSION_ID` as `openclaw agent --session-id`, starts the message with a stable Agent Bus envelope, falls back to a prompt file when the final OpenClaw CLI argument would be too large, and backs up oversized Agent Bus session files before a run so stale OpenClaw history does not balloon later room turns. The Claude Code wrapper uses `claude --print` as a local CLI adapter, defaults to noninteractive `acceptEdits` instead of Claude Code's root-blocked bypass mode, and derives a UUID-shaped Claude session id from Agent Bus room/thread session keys; configure it with `agent-bus init edge --preset claudecode` or `CLAUDECODE_COMMAND=claude ./scripts/claudecode-agent-bus.sh`. Agent-backed `/v1/chat/completions` and `/v1/responses` calls can also pass `prompt_cache_key` or `metadata.agent_bus_cache_scope` to reuse the same derived session across otherwise separate requests.

When using OpenClaw, prepare a dedicated Agent Bus agent/workspace before connecting the edge node:

```bash
agent-bus openclaw prepare \
  --config ~/.openclaw/openclaw.json \
  --agent-id agent-bus \
  --workspace /opt/agent-bus/openclaw-workspace \
  --context-tokens 48000
```

Then use `OPENCLAW_AGENT_ID=agent-bus ./scripts/openclaw-agent-bus.sh` as the OpenClaw `runCommand`. This keeps Agent Bus room traffic away from any personal/default OpenClaw workspace, archives `BOOTSTRAP.md` in the target workspace so the first room turn answers the task instead of running onboarding, and gives the dedicated agent a stable Agent Bus system prompt, empty inherited skills list, `cacheRetention: "long"`, and a conservative context cap unless those fields were already customized.

For Codex nodes on Linux, prefer `CODEX_COMMAND=codex bash ./scripts/codex-agent-bus.sh`; it reads `AGENT_MESSAGE_FILE` and keeps long room turns from arriving as an empty prompt after `AGENT_MESSAGE` is intentionally cleared.

The edge node streams stdout/stderr events back to the gateway, then posts a final run result. Node edge completions are written to a local outbox under `dataDir/edge-completions` before `/edge/complete`; if Central is temporarily unavailable, the edge replays those pending completions on reconnect and deletes them only after Central accepts the result.

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
agent-bus room memory room_xxx --query "cache decision" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room expand room_xxx 'messages[7]' --around 1 --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room health room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room inspect room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room doctor room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room follow-up room_xxx --dry-run --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room retry-failed room_xxx --yes --reason "retry failed upstream agent" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room retry-failed room_xxx --force --yes --reason "operator-reviewed forced retry" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room recover room_xxx --yes --reason "stale queued run recovery" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room resolve-duplicates room_xxx --yes --reason "cancel duplicate queued work" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room pause room_xxx --reason "operator pause" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room event-log room_xxx --tail 50 --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format markdown --out room.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --reports-only --out room-summary.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format json --out room.json --no-redact --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format events --out room-events.json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room replay --in room-events.json --format markdown
agent-bus trace show trace_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus trace export trace_xxx --format markdown --out trace.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
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

For demos, debugging, and future SDK compatibility work, `room event-log ROOM_ID` prints a readable redacted timeline directly from the room snapshot, `room export --format events` writes the same data as a portable event bundle, and `room replay --in` rebuilds a deterministic offline summary from that bundle. Use `room event-log ROOM_ID --json` for issue attachments or external tooling, and `--reports-only` when you want to omit full room messages and run output.

For long-running rooms, `agent-bus room memory ROOM_ID` prints the compressed local memory directory, and `agent-bus room expand ROOM_ID 'messages[7]' --around 1` opens an exact source window from the room history. This keeps prompts compact while still letting an operator or agent jump back to the original context.

For old or confusing rooms, start with `agent-bus room health ROOM_ID` for an operator snapshot of per-agent run status, edge session, lease state, attempt number, failure class/category, retryability, recommended action, duplicate active runs, REPORT/DONE contract state, last wake reason, recovery actions, and recovery hints. Use `agent-bus room inspect ROOM_ID` when you need the deeper stale/orphan run analysis, and `agent-bus room doctor ROOM_ID` when you want the central server to summarize the room state plus recommended next commands in one compact diagnosis. Doctor also checks the room contract: if a terminal agent emitted `DONE` without a captured `REPORT`, or an expected agent never ran, it reports `completed_with_contract_gaps` / `contract_gaps` and recommends either a wake for active rooms or a new follow-up room for completed and paused rooms. `agent-bus room follow-up ROOM_ID --dry-run` previews that follow-up request and, without `--dry-run`, creates the new room with inferred contract-gap agents unless you pass `--agents`. Each run now carries a structured attempt ledger in the room/run snapshot and `run_attempts.jsonl`, covering queued, dispatched, running, terminal, cancelled, and replaced states. Use `--run-heartbeat-stale-seconds` to tune heartbeat-loss classification separately from node freshness and ping URL health. For failed upstream agents, `room retry-failed --yes` re-opens the room and wakes only failed online agents whose latest failure class is retry-safe (`upstream_transient`, `rate_limited`, or `timeout`). Auth/config, protocol, local runtime, and unknown failures stay blocked unless an operator explicitly adds `--force`. For abandoned queued work, `room recover --yes` pauses the room with a guard; for duplicate active runs, `room resolve-duplicates --yes` cancels only duplicate queued runs and leaves running processes untouched. `room supervisor --yes` now chooses the conservative duplicate queued-run cleanup before heavier stale queued-room recovery. `room pause` remains the explicit operator stop.

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
