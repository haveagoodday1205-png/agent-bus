# CLI

`agent-bus` is the portable command-line entrypoint for running Agent Bus as a local service, an edge node, or a query client.

Install from a checkout:

```bash
npm install -g .
agent-bus --help
```

For a first two-machine setup, start with `docs/remote-assistant-quickstart.md`.

Portable release bundles are published on GitHub Releases. Unpack one and run `./agent-bus --help` on Linux/macOS or `.\agent-bus.cmd --help` on Windows. Each release includes `SHA256SUMS` and a release manifest so users can verify what they downloaded. See `docs/release.md` for the npm-vs-portable install matrix and release verification checklist.

## Remote Assistant Node

On any machine that should receive work:

```bash
agent-bus detect
agent-bus init edge --auto --out edge.config.json
```

`detect` looks for supported local tools:

- Codex: `codex`
- OpenClaw: `openclaw` or `OPENCLAW_AGENT_COMMAND`
- Hermes: `hermes`
- Ollama: `ollama` plus the local `/api/tags` endpoint when available

If you want a specific preset instead of auto-detection:

```bash
agent-bus init edge --preset codex --out edge.config.json
```

For OpenClaw nodes, create an isolated Agent Bus OpenClaw agent/workspace once:

```bash
agent-bus openclaw prepare \
  --config ~/.openclaw/openclaw.json \
  --agent-id agent-bus \
  --workspace /opt/agent-bus/openclaw-workspace
```

Use `OPENCLAW_AGENT_ID=agent-bus ./scripts/openclaw-agent-bus.sh` for the OpenClaw `runCommand`. The prepare command writes minimal Agent Bus workspace files, marks the workspace setup complete, archives `BOOTSTRAP.md` in that target workspace if one exists, and seeds the dedicated agent with a stable Agent Bus system prompt, empty inherited skills list, and `cacheRetention: "long"` unless those fields were already customized.

For Hermes nodes on Linux, prefer the bundled bridge script when it is available:

```bash
HERMES_COMMAND=/root/.local/bin/hermes ./scripts/hermes-agent-bus.sh
```

The bridge reads `AGENT_MESSAGE_FILE`/`AGENT_MESSAGE` and sets Hermes' internal session id from `AGENT_SESSION_ID` without resuming old conversation history. For OpenAI Responses-compatible gateways such as sub2api, that stable id becomes the `prompt_cache_key`, so repeated wakes in the same room or thread reuse the provider-side prefix cache more consistently. A first request for a new room, thread, or newly changed prompt prefix can still show `cache_read_tokens = 0`; that is a normal cache warm-up. Investigate only when subsequent turns in the same room/session keep returning zero cached tokens.

Edit:

- `gatewayUrl`: central gateway URL
- `token`: scoped edge token from pairing, or an admin token for trusted manual deployments
- `pingUrl`: shallow model/service reachability URL
- `runCommand`: command that runs the local AI tool

Then connect:

```bash
agent-bus doctor --config edge.config.json
agent-bus connect --config edge.config.json
```

The machine now polls the central gateway and can receive tasks. It does not need an inbound public port.

For the shortest first-run path, use `setup edge` to combine config creation, zero-quota doctor checks, and optional service template generation:

```bash
agent-bus setup edge \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --code ABCD-2345 \
  --auto \
  --service auto \
  --out edge.config.json
```

Without `--code`, pass `--token` or `AGENT_BUS_TOKEN` for a trusted manual config. `--service auto` chooses systemd on Linux, launchd on macOS, and Windows Service Control commands on Windows. It writes a template only; review and install it using your normal OS service workflow.

Run a zero-quota offline smoke test:

```bash
agent-bus smoke --offline
```

This starts a temporary local Python gateway and edge node, creates a room, runs a fake command agent, and verifies `REPORT`, `BLACKBOARD`, and `DONE` directive handling without calling any model provider. Python 3.10+ is required for this command while room support lives in the Python gateway.

Check gateway and room visibility with status:

```bash
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ***
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token *** --json
```

Human output includes operator labels for node freshness (`online/fresh`, `stale`, or `unknown`), node agent membership from the authenticated `/nodes` inventory, agent activity (`running`, `queued`, `busy/room-active`, or `idle`), ping reachability (`reachable`, `unreachable`, `unhealthy`, `not configured`, or `unknown`), and last-run health (`ok`, `failed`, `running`, or `unknown`). Unlike `/agents`, which lists currently usable agents, `/nodes` and the status Nodes section keep registered nodes visible after they become stale so operators can tell "known but offline/stale" apart from "never registered". By default, status hydrates up to 25 active room details so an agent is marked `running` or `queued` only when it has an actual non-terminal run; pass `--room-detail-limit N` to tune that, or `--no-room-details` for the older lightweight summary-only behavior. The CLI labels nodes stale after 180 seconds by default; pass `--stale-seconds N` or set `AGENT_BUS_STATUS_STALE_SECONDS` to match a test gateway or custom heartbeat policy. JSON output preserves the raw fields and also includes derived node `freshness`, agent `freshness`, `activity`, `active_runs`, `current_run`, `ping_label`, and `last_run_health` fields.

Edge commands receive task metadata in environment variables:

- `AGENT_MESSAGE`
- `AGENT_MESSAGE_FILE`
- `AGENT_MESSAGE_BYTES`
- `AGENT_RUN_ID`
- `AGENT_THREAD_ID`
- `AGENT_ROOM_ID`
- `AGENT_CACHE_KEY`
- `AGENT_SESSION_ID`
- `AGENT_ID`
- `EDGE_NODE_ID`

`AGENT_CACHE_KEY` and `AGENT_SESSION_ID` are stable for the same agent inside the same room or thread, which lets adapters such as OpenClaw pass a durable session id to model gateways that support prompt caching.

Adapters should prefer `AGENT_MESSAGE_FILE` when it is set. Very large tasks may leave `AGENT_MESSAGE` empty so the edge process can avoid OS environment-size limits.

## Pairing

Pairing is the faster onboarding path for a new remote assistant node. The central/admin side creates a short one-time code:

```bash
agent-bus pair create \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ... \
  --preset codex \
  --ttl 600
```

On the new machine, redeem the code into a local edge config:

```bash
agent-bus pair join \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --code ABCD-2345 \
  --out edge.config.json \
  --auto
```

Then run:

```bash
agent-bus doctor --config edge.config.json
agent-bus connect --config edge.config.json
```

The join command writes the gateway URL and a scoped edge token into the local config file, but it does not print the token. Codes are single-use and expire automatically. With `--auto`, it also detects local AI tools and registers each one as an agent.

The scoped edge token can register, poll, report run events, and read discovery metadata. It cannot create pair codes, create threads, wake rooms, or call the OpenAI-compatible model router.

## Central Gateway

```bash
agent-bus init central --out central.config.json
agent-bus serve --config central.config.json
```

Edit the generated config to set:

- a long random `token`
- optional `edgeTokens` for pre-provisioned edge nodes; pairing usually creates these automatically and stores token hashes under the gateway data directory
- model router `baseUrl`
- model router API key environment variable
- model aliases exposed to clients

The admin API can list, create, and revoke scoped edge tokens with `GET /edge/tokens`, `POST /edge/tokens`, and `POST /edge/tokens/revoke`.

## Query Commands

```bash
agent-bus well-known --gateway https://YOUR-DOMAIN/agent-bus
agent-bus manifest --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus nodes --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus agents --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus health --gateway https://YOUR-DOMAIN/agent-bus
```

You can also use environment variables:

```bash
export AGENT_BUS_GATEWAY_URL=https://YOUR-DOMAIN/agent-bus
export AGENT_BUS_TOKEN=...
agent-bus agents
```

## Rooms

Rooms are durable AI-to-AI workspaces. Use them to wake several agents, keep a shared blackboard, and export the transcript for demos or debugging.

```bash
agent-bus room create \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ... \
  --title release-check \
  --goal "Inspect the release and report blockers." \
  --agents codex-120,hermes-hk,openclaw-hk \
  --wake-agents codex-120,hermes-hk,openclaw-hk

agent-bus room show room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format markdown --out room.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --reports-only --out room-summary.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format json --out room.json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format json --no-redact --out room-private.json --gateway https://YOUR-DOMAIN/agent-bus --token ...
```

Room exports include the room goal, reports, blackboard notes, runs, and messages. Add `--reports-only` to omit full messages for public demos or issue summaries. Gateway responses are already redacted, and the CLI adds another pass over common token-like strings by default. Use `--no-redact` only to disable that extra client-side pass for private archives, and review any export before sharing it for private prompts, logs, domains, and internal machine names.

## Local Probe

```bash
agent-bus probe --config edge.config.json
```

This runs the edge health checks locally. URL ping checks do not run model inference.

## Doctor

```bash
agent-bus doctor --config edge.config.json
agent-bus doctor --config edge.config.json --json
```

Use `--json` for automation/CI. It prints `{ ok, counts, checks }` and keeps the same exit-code behavior as the human output.

`doctor` checks:

- Node.js runtime
- config file readability
- local tool availability for command adapters
- missing or placeholder gateway URL
- missing or placeholder token
- enabled agents
- missing command adapters
- ping URL placeholders
- gateway well-known endpoint
- gateway public health endpoint
- authenticated manifest, when a token is configured
- local edge health probe

It exits non-zero only on hard failures. Warnings are meant to guide setup without blocking local experimentation.

## Docker

Run a central gateway in a container:

```bash
agent-bus init central --out central.config.json
docker compose up --build
```

The image uses the same CLI entrypoint:

```bash
docker run --rm agent-bus:local --help
```

## Services

Generate a Linux systemd unit:

```bash
agent-bus service systemd \
  --mode edge \
  --config /opt/agent-bus/edge.config.json \
  --cwd /opt/agent-bus \
  --agent-bus-path /usr/bin/agent-bus \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --out agent-bus-edge.service
```

Generate a macOS launchd plist:

```bash
agent-bus service launchd \
  --mode edge \
  --config /opt/agent-bus/edge.config.json \
  --cwd /opt/agent-bus \
  --agent-bus-path /usr/local/bin/agent-bus \
  --out com.agent-bus.edge.plist
```

Generate Windows Service Control commands:

```powershell
agent-bus service windows --mode edge --config C:\agent-bus\edge.config.json --cwd C:\agent-bus --agent-bus-path C:\agent-bus\agent-bus.exe
```

The generated templates do not print or store your bearer token. Put `AGENT_BUS_TOKEN` in an environment file, system secret store, service account environment, or another deployment-specific secret mechanism.

## Cross-Platform Packaging

The current CLI runs anywhere Node.js 20+ runs:

- Windows
- Linux and Ubuntu
- macOS Intel
- macOS Apple Silicon

Verify and build a portable release locally:

```bash
npm run portable:check
npm run bundle -- --archive
```

`portable:check` builds into a temporary directory, verifies the manifest/checksums, rejects private/build paths, extracts the tarball, and runs the bundled launcher without model calls.

A release build writes:

- `dist/agent-bus-vX.Y.Z-portable/`
- `dist/agent-bus-vX.Y.Z-portable.tar.gz`
- `dist/agent-bus-vX.Y.Z-portable.zip`
- `dist/agent-bus-vX.Y.Z-portable.manifest.json`
- `dist/SHA256SUMS`

For a future standalone binary, package `agent-bus.mjs` together with:

- `central-gateway.mjs`
- `edge-node.mjs`
- `package.json`
- optional `console/` assets for the web console

The CLI is intentionally dependency-free so it can be wrapped by tools such as Node SEA, pkg-style packagers, app installers, Docker images, or OS service managers.

Target product shape:

```text
download agent-bus
agent-bus init edge
edit model URL/key and agent command
agent-bus connect
```

At that point the machine becomes an addressable remote assistant node.
