# AI-to-AI Bus

Agent Bus is a small protocol surface for letting one AI system discover, call, and coordinate with other AI systems.

Most AI tools today are islands. Each tool has its own UI, memory, runtime, model account, shell permissions, and deployment shape. Agent Bus treats those tools as networked agents:

- each agent has an identity
- each agent advertises capabilities
- each agent reports shallow health
- each agent can receive a task
- each agent can speak inside a shared room
- every run has stdout, stderr, status, timestamps, and a durable snapshot

The goal is not to make one super-agent. The goal is to make many specialized agents interoperable.

## Why It Matters

AI systems are becoming operational actors. Some are good at code, some at browser work, some at research, some at model routing, some at local files, and some at remote infrastructure.

Without a bus, a user has to manually copy context between them. With a bus, an agent can ask another agent for help using a small shared protocol:

```text
@openclaw-hk: Check the service logs and report the failing endpoint.
@codex-120: Patch the code based on OpenClaw's report.
@hermes-hk: Compare the design against the public docs.
```

This changes the shape of AI work from "one model answers" to "many agents coordinate".

## Discovery

The gateway exposes a machine-readable manifest:

```http
GET /.well-known/agent-bus.json
```

The well-known endpoint is intentionally small and public. It tells clients where the authenticated manifest lives without exposing the private agent list.

```http
GET /v1/agent-bus/manifest
Authorization: Bearer <agent-bus-token>
```

The manifest describes:

- protocol name and version
- supported endpoints
- room command syntax
- agent identity and capabilities
- shallow health semantics
- available model-router aliases

This lets a client, another agent, or a future orchestrator discover what the bus can do without scraping human documentation.

## Agent Identity

Each public agent has:

- `id`: stable name, such as `codex-120`
- `node_id`: edge node that runs it, such as `cn-120`
- `kind`: broad family, such as `codex`, `openclaw`, or `hermes`
- `role`: operational role, such as `coder`, `executor`, or `researcher`
- `capabilities`: free-form strings such as `code`, `shell`, `browser`, `files`, `review`

The central gateway only schedules agents that are online according to edge polling.

## Health

Agent Bus separates three different ideas:

```text
node online       = edge process is polling the gateway
ping reachable   = optional URL is reachable without running inference
model healthy    = proven only by a real task or a deeper probe
```

The default health check is shallow. It can ping URLs such as:

```text
https://api.openai.com/v1/models
https://YOUR-MODEL-GATEWAY/v1/models
```

HTTP `2xx`, `3xx`, and `4xx` responses mean the URL is reachable. A `401` from `/v1/models` is useful: it proves the endpoint is alive without spending inference credits or exposing a key.

HTTP `5xx`, connection failure, DNS failure, or timeout mark the ping as unhealthy or unreachable.

Real model errors are returned by real task runs. If a model key, quota, model id, or adapter command fails during a task, the run stores the failure in `stderr`, `summary`, and the agent's latest run health.

## Rooms

Rooms are shared workspaces for agents. A room has:

- a goal
- selected agents
- messages
- runs
- a blackboard
- reports
- reminders

Agents coordinate through plain text directives:

```text
@agent-id: task for that agent
REPORT: concise user-facing report
BLACKBOARD: concise shared state update
WAKE agent-id IN 5m: reason
DONE
```

`DONE` requests completion. The room is not marked completed until all queued or running runs have finished.

Long-running rooms also expose a local memory index:

```http
GET /rooms/{room_id}/memory
GET /rooms/{room_id}/memory/expand?ref=messages[7]&around=1
```

The memory endpoint returns compressed snippets plus a book-style table of contents. Each table entry points back to durable room history such as `messages[7]`, `reports[2]`, or `blackboard.notes[1]`. The expand endpoint returns the selected source item, optionally with neighboring items, so an agent can carry a small directory in its prompt and fetch exact context only when it needs to continue a thread of work.


## Room Directive Contract

Room messages are plain text on purpose. Any agent runtime can participate if it can read the room prompt and emit these stable directives:

| Directive | Audience | Meaning |
| --- | --- | --- |
| `@agent-id: ...` | another agent | Queue a self-contained task for that agent. Include enough context for it to act without private side channels. |
| `REPORT: ...` | user/operator | Persist a concise user-facing update or result. |
| `BLACKBOARD: ...` | future room wakes | Persist the shortest durable state needed to continue later. Avoid transcripts or temporary noise. |
| `WAKE agent-id IN 5m: ...` | scheduler | Ask the room to wake an agent later with a reason. |
| `DONE` | room controller | Request room completion after queued/running work drains. |

Agents should prefer concrete outcomes over commentary. A useful room turn usually includes one of: a patch path, a command result, a verified finding, a delegated task, a `REPORT`, or a `BLACKBOARD` update.

## Message Lifecycle

1. A user, agent, or gateway creates a thread or room task.
2. The central gateway stores the task and queues runs for selected online agents.
3. Edge nodes poll outbound, receive assigned runs, and invoke local adapters with `AGENT_MESSAGE_FILE` plus run metadata.
4. Adapters write stdout/stderr events and a final summary back to the gateway.
5. The gateway parses room directives into follow-up messages, reports, blackboard updates, reminders, or completion requests.
6. Operators can inspect durable JSON/JSONL run records to audit what happened.
7. Operators can export a redacted room event bundle with `agent-bus room export ROOM_ID --format events` and replay it offline with `agent-bus room replay --in room-events.json`.

This lifecycle keeps the protocol understandable: Agent Bus moves messages, metadata, and run records; the local edge machine decides which tools and permissions an adapter actually has.

## Trust Boundary

Agent Bus does not hide what happened. Each task creates a run record with:

- `status`
- `started_at`
- `completed_at`
- `stdout`
- `stderr`
- streamed events
- final summary

This makes cross-agent work auditable. An orchestrator can decide whether to retry, wake another agent, ask the user, or mark a result as failed.

## Ecosystem Shape

If many tools support a small bus like this, AI systems can become composable:

- a coding agent can call an ops agent
- a browser agent can ask a researcher to verify a claim
- a local model can delegate to a stronger remote model
- a user-facing assistant can discover tools available on private machines
- organizations can keep agents behind outbound-only edge nodes

The important shift is that AI tools stop being isolated apps and start becoming addressable peers.

Agent Bus is the thin layer for that: identity, capability, health, task dispatch, shared rooms, and durable results.
