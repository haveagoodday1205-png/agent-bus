# Agent Bus Project Handoff

Last updated: 2026-05-18

This handoff is for future maintainers, remote agents, and open-source contributors. It only records information that is safe to keep in the public repository. Server IPs, SSH key paths, Telegram tokens, npm tokens, model API keys, real Central admin tokens, and private deployment details belong in a private operations note or secret store, never in this repository.

## One-Sentence Goal

Agent Bus is a self-hosted remote-assistant and AI-to-AI connection layer:

```text
MCP connects models to tools.
Agent Bus connects agents to agents.
```

Its core value is making Codex, Hermes, OpenClaw, Claude Code, Ollama, custom command adapters, and OpenAI-compatible model gateways discoverable, routable, and collaborative. A user deploys one public Central, then private Edge machines connect outward and expose local AI tools to the same bus without opening inbound ports.

## Current Project State

The main branch is now ready for public trial and outside contribution:

- npm CLI package: `agent-bus-cli`; the installed command is `agent-bus`.
- Central/Edge architecture: Central handles auth, rooms, run queues, events, model routing, and pairing; Edge nodes long-poll Central and execute local agents.
- Node and Python runtimes: `central-gateway.mjs` / `edge-node.mjs`, plus the more complete `central_gateway.py` / `edge_node.py`.
- AI-to-AI rooms: agents coordinate with `@agent-id`, `REPORT`, `BLACKBOARD`, `WAKE`, and `DONE`.
- OpenAI-compatible model router: `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.
- Edge-to-edge model replacement: online agents are exposed as `agent:<agent-id>` virtual models so one machine can call another agent through Central.
- Telegram operator bot: status, agent selection, process/thread controls, room drafts, multi-agent selection, inline buttons, poller, and webhook support.
- Local room memory cache: extractive, book-style compressed context with source locations, without vector databases, databases, or model calls.
- Conformance/certification: JSON, Markdown, and Shields badge artifacts can be generated and validated.
- SDKs: `sdk/js/` and `sdk/python/` cover discovery, rooms, agent-backed model calls, and room replay.
- No-quota demos and smokes: many checks run without real model keys or private servers.
- README, `agent-bus --help`, and `docs/try-agent-bus.md` promote `agent-bus demo zero-token` as the public first-run path.
- `agent-bus demo zero-token` writes a share-safe Markdown report that users can attach to GitHub feedback issues.
- `agent-bus demo issue` is the current no-secret flagship demo for issue -> planner -> coder -> reviewer -> patch/PR draft.
- GitHub issue templates cover zero-token demo feedback, issue-to-PR demo feedback, adapter compatibility, first remote node feedback, and good first tasks.
- GitHub release, beta tester guide, launch kit, social post drafts, and visual preview assets are available for public sharing.

Recent mainline milestones:

```text
32ccf75 Add issue demo visual preview
52600bb Add beta tester entrypoint and social preview
3bc0ff9 Add public launch kit
2064f73 Strengthen first-run issue demo path
0c5eb19 Clarify room wake scope in console
f8105de Write shareable zero-token demo reports
53a70cf Surface first-run demo in help
3617819 Improve public trial feedback path
c4710e3 Expose permission observations and Telegram goal shortcut
aec60bb Reference private deployment handoff
d2505ac Add project handoff document
8184870 Add conformance artifact validation
b231d66 Add conformance CI workflow
c5a3ad9 Add conformance certification artifacts
57bb66a Add adapter command conformance profile
2aba0cd Add protocol conformance runner
bcacb44 Add room event log timeline
bd50997 Add zero-token local demo
43e6dc4 Persist Python edge completions
```

## Public UX Decisions

- The top-level `agent-bus goal` shortcut and Telegram `/goal` shortcut were removed from the public entry path. The goal experience should not overpromise autonomous execution before room operations, recovery, and the flagship demo are mature enough.
- Public entry points should emphasize `agent-bus demo zero-token`, `agent-bus demo issue`, `agent-bus room create --goal ...`, the conformance runner, adapter compatibility reports, and no-quota smokes.
- The public story should focus on the real core: self-hosted Central/Edge, agent discovery, agent-to-agent rooms, model router, auditable reports, event export, and replay.
- The Web Console should default to English for public visitors. Chinese remains available through the language selector.

## Public Runtime Snapshot

This section is a public-safe snapshot for the next maintainer or agent. Real IPs, SSH key paths, Central admin tokens, edge tokens, and model API keys are intentionally omitted. Private deployment details are stored locally in `LOCAL_DEPLOYMENT.md`, which must stay ignored.

Private Central validation host summary:

```text
nickname: private Central validation host
repo: /root/agent-bus-public
central service: agent-bus-central.service
central env: private env file, do not print
central config: private Central config path, do not print
local gateway on that host: http://127.0.0.1:8788
latest full verification command: node scripts/release-check.mjs --json -> ok: true
```

Last public-safe status summary:

```text
Central health: ok
online nodes: 2
online agents: 4
registered nodes: 10
registered agents: 5
queued runs: 0
active rooms: 0
active runs: 0
duplicate agent ids: 0
readiness: ready
```

Currently expected online agents:

```text
cn-120
  codex-120
    ping_status: reachable
    activity: idle
    last_run_status: completed

hk-202
  openclaw-hk
    ping_status: reachable
    activity: idle
    last_run_status: completed

  hermes-hk
    ping_status: reachable
    activity: idle
    last_run_status: completed

  claudecode-hk
    ping_status: not_configured
    activity: idle
    last_run_status: completed
```

Historical stale test nodes may still appear in status output. Do not schedule work to stale nodes unless a fresh status check says they are online.

Current Central model router summary:

```text
modelRouter.enabled: true
modelRouter.agentModels: true
modelRouter.allowEdgeAgentModels: true

backend ids:
  sub2api-178
  cliproxyapi-178

agent-backed virtual models:
  agent:codex-120
  agent:openclaw-hk
  agent:hermes-hk
  agent:claudecode-hk
```

Telegram plugin public state:

```text
plugins.telegramBot.enabled: false
plugins.telegramBot.control: false
```

Useful historical rooms:

```text
room_9490391c-5c81-4f4a-bc83-c308d6619ba7
  status: paused
  agents: claudecode-hk, hermes-hk, openclaw-hk
  reports: 5
  purpose: prior multi-agent development discussion; useful as context, not necessarily a room to resume.

room_b0d93f77-70d1-4319-bbe8-fdc330d927be
  status: completed
  agents: hermes-hk, openclaw-hk
  reports: 30
  purpose: long Hermes/OpenClaw project discussion; review with room event-log/reports if needed.
```

Public-safe remote handoff command template:

```bash
cd /root/agent-bus-public
git pull --ff-only origin main
node scripts/release-check.mjs --json

set -a && . /etc/agent-bus/central.env && set +a
node agent-bus.mjs status \
  --gateway http://127.0.0.1:8788 \
  --token "$AGENT_BUS_TOKEN" \
  --json \
  --room-detail-limit 10
```

Multi-agent discussion room template:

```bash
cd /root/agent-bus-public
set -a && . /etc/agent-bus/central.env && set +a

node agent-bus.mjs room create \
  --gateway http://127.0.0.1:8788 \
  --token "$AGENT_BUS_TOKEN" \
  --title "agentbus-next-development" \
  --goal "Continue Agent Bus development. Hermes, OpenClaw, and Claude Code should analyze the most important next product, reliability, and open-source ecosystem work. Return concrete recommendations. Do not commit code; only write REPORT and BLACKBOARD, then DONE." \
  --agents hermes-hk,openclaw-hk,claudecode-hk \
  --wake-agents hermes-hk,openclaw-hk,claudecode-hk \
  --max-steps 6 \
  --no-auto-rotate
```

To include the Codex agent as well, use:

```text
codex-120,hermes-hk,openclaw-hk,claudecode-hk
```

## Deployment Shape

Recommended deployment has two component types:

1. Central: a public HTTPS-facing control plane, room state store, run queue, event log, pairing endpoint, and model router.
2. Edge: a private machine that connects outward with a scoped edge token and runs local agents.

Typical topology:

```text
public HTTPS gateway
  /agent-bus/ -> Central gateway on localhost

private edge A -> outbound HTTPS poll -> Central
private edge B -> outbound HTTPS poll -> Central
private edge C -> outbound HTTPS poll -> Central
```

Single Central currently does not need a database. It persists JSONL logs and snapshots under `AGENT_BUS_DATA_DIR`; production deployments must use persistent disk or a Docker volume. Consider SQLite/Postgres only when multi-instance writes, large trace queries, or hosted multi-tenant operation become necessary.

## Quickstart Paths

No-key local trial:

```bash
npm install -g agent-bus-cli
agent-bus --help
agent-bus smoke --offline
agent-bus demo zero-token
agent-bus demo issue --out-dir agent-bus-issue-demo
agent-bus demo starter
agent-bus demo agent-model
```

Source contributor path:

```bash
git clone https://github.com/haveagoodday1205-png/agent-bus.git
cd agent-bus
npm install -g .
npm run release:check
```

If local npm is unavailable, run checks that do not require package verification:

```bash
node scripts/verify-protocol-v1.mjs
node scripts/verify-conformance-result-schema.mjs --json
node scripts/conformance-ci-smoke.mjs --json
node scripts/protocol-conformance.mjs --json --artifact-dir conformance-artifacts
node scripts/verify-conformance-result-schema.mjs --artifact-dir conformance-artifacts
```

Central + Edge recommended setup flow:

```bash
agent-bus setup central --gateway https://YOUR-DOMAIN/agent-bus --out central.config.json --service auto
agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN --preset codex
agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --auto --service auto --out edge.config.json
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
```

## Current Verification Status

The latest public validation on the private Linux host completed:

```bash
cd /root/agent-bus-public
git pull --ff-only origin main
node scripts/release-check.mjs --json
```

Result: `ok: true`.

Local Windows may not have npm in the bundled runtime, so full package verification should run on Linux, CI, or the remote validation host.

## Conformance Handoff

Agent Bus v1 conformance is a key public ecosystem entry point. It lets adapter authors prove compatibility instead of relying on claims.

Generate certification artifacts:

```bash
agent-bus protocol certify
```

This writes:

```text
conformance-artifacts/agent-bus-conformance.json
conformance-artifacts/agent-bus-conformance.md
conformance-artifacts/agent-bus-conformance-badge.json
```

Validate certification artifacts:

```bash
agent-bus protocol validate-result --artifact-dir conformance-artifacts
```

External adapters can run:

```bash
agent-bus protocol conformance \
  --profile adapter-command \
  --agent-command "./my-agent-bus-adapter" \
  --agent-id my-agent \
  --artifact-dir conformance-artifacts \
  --json
agent-bus protocol validate-result --artifact-dir conformance-artifacts
```

Related files:

- `scripts/protocol-conformance.mjs`
- `scripts/verify-conformance-result-schema.mjs`
- `docs/protocol-v1.md`
- `docs/protocol-v1.schema.json`
- `docs/protocol-conformance-result.schema.json`
- `docs/adapter-conformance-ci.md`
- `.github/workflows/conformance.yml`

## Main Module Map

Core CLI:

- `agent-bus.mjs`: user entry point for setup, doctor, room, trace, plugin, protocol, demo, and service commands.

Central:

- `central_gateway.py`: most complete Central implementation; covers rooms, pairing, traces, Telegram, agent-backed models, and memory cache.
- `central-gateway.mjs`: lightweight Node Central.

Edge:

- `edge-node.mjs`: Node Edge.
- `edge_node.py`: Python Edge.
- `scripts/codex-agent-bus.sh`
- `scripts/hermes-agent-bus.sh`
- `scripts/openclaw-agent-bus.sh`
- `scripts/claudecode-agent-bus.sh`

SDK and examples:

- `sdk/js/agent-bus-sdk.mjs`
- `sdk/python/agent_bus_sdk.py`
- `examples/hello-agent/`
- `examples/room-agent-python/`
- `examples/python-agent-model/`
- `examples/no-quota-room-replay/`

Web Console:

- `console/index.html`
- `console/app.js`
- `console/styles.css`
- `docs/console.md`

Telegram:

- `scripts/telegram-poller.mjs`
- `scripts/telegram-commands.mjs`
- `scripts/telegram-plugin-smoke.mjs`
- `agent-bus plugin telegram ...`

Release / CI:

- `scripts/release-check.mjs`
- `scripts/verify-package.mjs`
- `scripts/verify-portable-release.mjs`
- `scripts/release-notes.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

## Working Protocol For Future Agents

If Hermes, OpenClaw, Claude Code, Codex, or another agent continues this project, follow these rules:

- Never commit real tokens, SSH keys, server allowlists, private deployment files, or model API keys.
- Prefer no-quota, offline, CI-verifiable changes.
- After each change, run the matching smoke. After larger changes, run `node scripts/release-check.mjs --json`.
- Public docs should contain reusable methods only; private deployment steps belong in local private notes.
- Do not treat room chat as a permission boundary; dangerous operations must be controlled in the Edge runtime or sandbox.
- Adapter changes should update conformance or bridge smokes first.
- Telegram changes must update `telegram-plugin-smoke`, especially inline buttons, callback query behavior, process/thread switching, and room drafts.
- Room/retry/reconnect changes must run room supervisor, stale room, edge poll disconnect, and completion outbox smokes.

## Known Constraints

- Agent Bus is not a model provider and does not package Codex, Hermes, OpenClaw, Claude Code, or other agent runtimes. It connects, routes, schedules, and adapts tools that users install on Edge machines.
- URL ping checks only prove endpoint reachability. They do not prove provider key validity, quota, or real completion success.
- Edge tokens are intentionally narrow by default. Central must explicitly enable `modelRouter.allowEdgeAgentModels` before scoped edge tokens may call `agent:<id>` virtual models.
- Single Central currently uses JSONL/snapshot persistence. This is appropriate for self-hosted and lightweight deployments, not a hosted large-scale multi-tenant service.
- Windows local verification may lack npm; package verification should run on Linux, CI, or the remote validation host.

## Next Priorities

Recommended order:

1. Setup/status polish: improve `setup central`, `setup edge`, `status`, success messages, failure explanations, doctor hints, and copyable commands.
2. Web Console polish: make Central status, agent health, room chat, room timeline, traces, and recovery hints easier to scan.
3. Telegram room/process UX: improve `/room new`, multi-agent selection, process/thread switching, room wake/pause/retry buttons, and room draft flow.
4. Permission profiles: continue adding observation fields such as `permission_profile`, `allowed_wake_targets`, `allowed_rooms`, owner, runtime, cost, and latency before enforcing hard blocks.
5. Flagship demo: keep strengthening `agent-bus demo issue` as the public issue -> planner -> coder -> reviewer -> patch/PR draft proof, without rushing into real GitHub PR creation.
6. Adapter ecosystem: encourage adapter projects to reuse `docs/adapter-conformance-ci.md`, publish Agent Bus compatible badges, and use compatibility issue templates.
7. Durable event storage: evolve from snapshot-derived event bundles toward true append-only event sourcing, while keeping a future database migration path open.
8. Installer/packaging: improve portable bundles and Windows/macOS/Linux service templates.

## Open-Source Growth Suggestions

To help people notice and contribute:

- Keep the README first viewport focused on "Agent Bus connects agents to agents".
- Keep no-quota demos green.
- Keep the zero-token and issue-to-PR reports easy to attach to public feedback issues.
- Split tasks from `docs/good-first-issues.md` into GitHub issues.
- Highlight conformance badges, the Telegram operator bot, and edge-to-edge model replacement in release notes.
- Give adapter authors a clear entry point: `examples/hello-agent/` plus `docs/adapter-conformance-ci.md`.
- Pair every new feature with a smoke script so contributors can prove they did not break the main path without private servers.

## Private Operations Reminder

Do not move these details into the public repository:

- Public domain, reverse-proxy path, systemd service names, env file paths, and private config paths.
- Edge node inventory, agent IDs, runtime working directories, and service names if they reveal private infrastructure.
- SSH connection methods and key management details.
- Central admin token, scoped edge tokens, Telegram bot token, model API keys, npm tokens, and GitHub release credentials.
- Account 2FA and token rotation procedures.

If any token appears in chat, logs, screenshots, or public issue comments, treat it as leaked and rotate it.

## Current Conclusion

Agent Bus is no longer just a gateway script. It now has a CLI, Central/Edge runtime, rooms, agent-backed model calls, Telegram operator bot, SDKs, conformance certification, release gates, public demos, and a beta tester loop.

The next phase should not be about adding more agent names. It should make the path smooth for any AI tool to connect, prove compatibility, be called remotely, collaborate in rooms, and leave auditable results. That is how Agent Bus can grow from a personal project into a practical AI-to-AI open-source protocol surface.
