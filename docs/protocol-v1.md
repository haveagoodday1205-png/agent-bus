# Agent Bus Protocol v1 Draft

Agent Bus is an open protocol and self-hostable runtime for agent-to-agent connectivity and remote assistant operations.

Short version:

```text
MCP connects models to tools.
Agent Bus connects agents to agents.
```

This page is the working v1 contract for SDKs, adapters, compatibility tests, and operator trust boundaries. It intentionally describes the smallest stable surface first; richer planning, consensus, federation, and hosted products should build on this contract instead of replacing it.

Machine-readable schema:

```text
docs/protocol-v1.schema.json
docs/protocol-conformance-result.schema.json
```

Minimal adapter example:

```text
examples/hello-agent/
```

Minimal JS/TS client SDK:

```text
sdk/js/
```

Offline verification:

```bash
npm run protocol:check
npm run protocol:conformance
npm run protocol:certify
npm run protocol:certify:check
npm run compat:check
```

`npm run protocol:certify` writes a shareable artifact set into `conformance-artifacts/`:

- `agent-bus-conformance.json`: raw machine-readable result
- `agent-bus-conformance.md`: Markdown certification report
- `agent-bus-conformance-badge.json`: Shields endpoint badge JSON

`agent-bus protocol certify` is the installed-CLI equivalent. `agent-bus protocol validate-result --artifact-dir conformance-artifacts` and `npm run protocol:certify:check` validate the generated JSON result, Markdown report, and Shields badge against the documented result shape; CI/release workflows run the same check before publishing the artifacts.

Third-party command adapters can run the same gateway and edge contract around their own executable:

```bash
agent-bus protocol conformance \
  --profile adapter-command \
  --agent-command "./my-agent-bus-adapter" \
  --agent-id my-agent \
  --json
```

The default profile uses the repository hello-agent and makes no model calls. The `adapter-command` profile still starts temporary local central and edge services, but quota use depends on the supplied adapter command. It verifies registration, scoped discovery, `agent:<id>` Chat Completions and Responses routing, room directive capture, event-log, event export, and replay.

Pass `--artifact-dir DIR`, `--result-out FILE`, `--report-out FILE`, or `--badge-out FILE` to publish conformance evidence from CI or a release job.

See `docs/adapter-conformance-ci.md` for a copy-paste GitHub Actions workflow that adapter projects can use to publish the same evidence.

## Goals

- Let independent agents discover each other, advertise capabilities, delegate work, share durable state, and report outcomes.
- Keep edge nodes outbound-only so private machines do not need public inbound ports.
- Make room coordination replayable through an append-only event model.
- Keep tool authority separate from message authority.
- Make any adapter easy to wrap, test, and audit without depending on Hermes, OpenClaw, Codex, or any single model provider.

## Non-Goals

- Agent Bus is not a generic workflow engine.
- Agent Bus is not a chat transcript as a security boundary.
- Agent Bus is not a model provider and does not include a model.
- Agent Bus is not a promise that room text can authorize shell, browser, deploy, or secret access.

## Core Objects

### Gateway

The central gateway stores identity, rooms, event history, queued runs, reports, blackboard state, and discovery metadata.

Required behavior:

- expose `GET /.well-known/agent-bus.json`
- expose authenticated `GET /v1/agent-bus/manifest`
- accept outbound edge registration and polling
- persist rooms, runs, reports, and events
- preserve enough metadata for replay and audit

### Node

A node is a machine or runtime process that connects outbound to the gateway.

Required fields:

```json
{
  "node_id": "hk-202",
  "status": "online",
  "last_seen_at": "2026-05-07T00:00:00Z",
  "agents": []
}
```

### Agent

An agent is an addressable runtime advertised by a node.

Required fields:

```json
{
  "id": "hermes-hk",
  "node_id": "hk-202",
  "kind": "hermes",
  "role": "researcher",
  "capabilities": ["research", "browser"],
  "enabled": true
}
```

Optional observation fields:

```json
{
  "owner": "team-or-user-id",
  "runtime": "hermes",
  "permission_profile": "research-readonly",
  "allowed_rooms": ["room_*"],
  "allowed_wake_targets": ["openclaw-hk", "codex-120"],
  "cost_class": "medium",
  "latency_class": "interactive"
}
```

Central and the CLI currently preserve these fields for inventory, status, profile coverage summaries, and console visibility only.
For list fields, an advertised empty array is preserved so operators can distinguish "declared none" from "not declared".
They are not hard enforcement yet; local edge runtimes and sandboxes remain the permission boundary.

### Room

A room is a durable multi-agent workspace.

Required fields:

```json
{
  "id": "room_xxx",
  "title": "Fix issue and verify",
  "goal": "Fix the failing login redirect and report a PR URL.",
  "status": "active",
  "agents": ["hermes-hk", "openclaw-hk"],
  "messages": [],
  "runs": [],
  "reports": [],
  "blackboard": {}
}
```

### Run

A run is a scheduled unit of work for exactly one agent.

Required fields:

```json
{
  "id": "run_xxx",
  "thread_id": "room_xxx",
  "agent_id": "openclaw-hk",
  "node_id": "hk-202",
  "status": "queued",
  "message": "Inspect the repo and patch the failing test.",
  "created_at": "2026-05-07T00:00:00Z",
  "started_at": null,
  "completed_at": null,
  "stdout": "",
  "stderr": "",
  "events": []
}
```

Terminal statuses:

```text
completed, failed, error, cancelled, canceled, skipped
```

## Room Directive Contract

Room messages are plain text so any agent runtime can participate.

Stable directives:

| Directive | Meaning |
| --- | --- |
| `@agent-id: task` | Queue a self-contained task for another listed agent. |
| `REPORT: text` | Persist a concise user-facing result or update. |
| `BLACKBOARD: text` | Persist short state needed by future wakes. |
| `WAKE agent-id IN 5m: reason` | Ask the scheduler to wake an agent later. |
| `DONE` | Request room completion after queued/running work drains. |

Rules:

- Directives coordinate work; they do not grant tool authority.
- A useful task should include enough context for the target agent to act without private side channels.
- `BLACKBOARD` should be durable state, not a transcript.
- `DONE` should mean the room goal is genuinely complete, not just that one agent finished its own turn.

## Event Model

The v1 source of truth should be append-only events. Snapshots are allowed as caches, but replayable events are the contract SDKs and auditors should target.

Minimum event types:

```text
room.created
room.message.added
room.blackboard.updated
room.report.added
room.status.changed
run.queued
run.started
run.output
run.completed
run.failed
agent.registered
agent.health.updated
wake.requested
wake.dispatched
wake.cancelled
policy.denied
```

Every event should include:

```json
{
  "id": "event_xxx",
  "type": "run.completed",
  "at": "2026-05-07T00:00:00Z",
  "actor": "openclaw-hk",
  "room_id": "room_xxx",
  "run_id": "run_xxx",
  "payload": {}
}
```

Future hardening:

- authenticated event writes
- tamper-evident event storage
- signed run receipts
- exportable replay bundles

Current implementation note:

```bash
agent-bus room event-log room_xxx --tail 50
agent-bus room export room_xxx --format events --out room-events.json
agent-bus room replay --in room-events.json --format markdown --strict
npm run fixture:room-replay
```

`room event-log` renders the snapshot-derived event bundle as a readable timeline for operators and bug reports. `room export --format events` writes the same redacted `agent_bus.room_event_bundle`, and `room replay --in` replays it offline into a deterministic summary. Snapshot-derived bundles include contiguous event `sequence` numbers plus `export_metadata` (`source`, `generated_at`, `reports_only`, event count, and sequence range) so SDKs and auditors can verify ordering without depending on array position alone. It is a compatibility bridge toward a fully append-only room event store.

The repository also includes a stable public fixture at `docs/fixtures/no-quota-room-events.v1.json` plus the expected replay summary at `docs/fixtures/no-quota-room-replay.v1.json`. `npm run fixture:room-replay` checks the fixture against the protocol schema event enum, exercises SDK bundle validation, and replays it through the CLI, JS SDK, and Python SDK without starting a gateway or calling a model provider.

## Trust And Permissions

Default stance: agents are untrusted.

Separate these authorities:

| Authority | Example |
| --- | --- |
| read room | agent can inspect room history |
| write room | agent can add messages/reports/blackboard notes |
| wake agent | agent can queue work for another agent |
| browse | agent can use browser/network tooling |
| shell | agent can execute commands |
| filesystem | agent can read/write configured paths |
| code | agent can patch repositories |
| deploy | agent can publish or restart services |
| secrets | agent can access configured secret sources |
| admin | agent can manage gateway/node policy |

Required rule:

```text
Room text is never authority by itself.
```

The enforcement point for shell, browser, filesystem, deploy, and secret access is the local runtime adapter or sandbox policy on the edge node. The gateway can route a task; the edge decides what that task is allowed to do.

## Model-Compatible Agent Calls

Agent Bus can expose online agents as OpenAI-compatible virtual models:

```text
agent:hermes-hk
agent:openclaw-hk
agent:codex-120
```

Supported surfaces:

```http
POST /v1/chat/completions
POST /v1/responses
```

For `agent:<id>`, the gateway creates a normal run, waits for terminal status, and returns an OpenAI-style response object. This lets machines without local model credentials call remote agents through Central.

Security note:

- Admin tokens can use `agent:<id>` when agent models are enabled.
- Scoped edge tokens can use `agent:<id>` only when `modelRouter.allowEdgeAgentModels` is explicitly enabled.
- Edge tokens should not gain access to real backend model aliases by default.

## Compatibility Tests

A v1-compatible agent adapter should pass these checks without paid model calls:

- registers with stable `id`, `kind`, `role`, and `capabilities`
- receives a queued run via outbound polling
- reads task text from `AGENT_MESSAGE_FILE`
- can prove file-based task delivery in compatibility tests
- emits stdout/stderr events or final result
- completes with a terminal run status
- can participate in a room by emitting `REPORT` and `BLACKBOARD`
- handles large messages without relying only on environment variables

A v1-compatible gateway should pass:

- discovery endpoints
- node/agent registration
- scoped edge token auth
- room creation and directive parsing
- run queueing and completion
- report/blackboard persistence
- agent-backed `/v1/chat/completions`
- agent-backed `/v1/responses`

The repository includes `agent-bus protocol conformance --json` and `npm run protocol:conformance` for this baseline. The conformance runner starts a temporary local Python gateway and Node edge, registers `examples/hello-agent`, verifies discovery endpoints, confirms scoped edge tokens only see `agent:<id>` virtual models, exercises agent-backed Chat Completions and Responses calls, creates a room, checks `REPORT`, `BLACKBOARD`, and `DONE` parsing, renders `room event-log`, exports a strict v1 event bundle, and replays it through the CLI plus JS SDK. It makes no provider model calls. Use `--profile adapter-command --agent-command "..."` to wrap the same checks around an external adapter command; that profile may consume quota if the command calls a model. `npm run compat:check` remains the smaller compatibility smoke for quick adapter regressions.

## Flagship Demo Target

The public demo should prove interoperability through a real artifact:

```text
Three different agents, three different runtimes, one GitHub PR.
```

Flow:

1. User opens a room from a GitHub issue.
2. Planner/spec agent breaks down the issue.
3. Coding agent patches the repo.
4. QA/browser agent verifies behavior.
5. Reviewer/security agent checks risk.
6. Ops/deploy agent creates a preview only after human approval.
7. Room export shows reports, blackboard decisions, wakeups, tool traces, PR URL, preview URL, and final approval.

The demo should avoid agent chatter as the main artifact. The proof is durable coordination, auditability, and a useful result.

## Roadmap Gate

Before broad public promotion, Agent Bus should have:

- versioned protocol docs
- Python and TypeScript SDKs
- compatibility test suite
- explicit permission profiles
- append-only event log design
- wake scheduler with retries, dedupe, cancellation, and loop prevention
- Docker Compose deployment
- observability UI for room timeline, wake queue, agent liveness, failures, and run traces
