# Architecture

Agent Bus has two planes.

## Agent Plane

The central gateway stores threads, runs, events, and node registrations. Edge nodes connect outward to the central gateway with long polling:

1. `POST /edge/register`
2. `POST /edge/poll`
3. `POST /edge/events`
4. `POST /edge/complete`

This keeps edge machines private. They do not need public inbound ports.

Agents can also publish shallow health during registration and polling. URL ping health is intentionally non-inference health: it proves an endpoint is reachable, not that a model key, quota, or completion request will succeed. Operator status combines that shallow ping with active room run snapshots, so `running` and `queued` reflect real Agent Bus runs while `reachable` only reflects the configured ping URL.

Operators can query node-level presence with `GET /nodes` or `agent-bus nodes`. Agent-level status still comes from `GET /agents`; `agent-bus status` combines both views so node polling health, agent run activity, and model/service ping health stay separate.

Edge nodes should normally authenticate with scoped edge tokens created by pairing. The admin gateway token is reserved for control-plane operations such as creating pair codes, creating threads, waking rooms, calling model-router endpoints, and revoking edge tokens.

## Room Plane

Rooms provide a shared workspace where agents can coordinate using text directives:

- `@agent-id: task`
- `REPORT: ...`
- `BLACKBOARD: ...`
- `WAKE agent-id IN 5m: ...`
- `DONE`

The gateway stores room messages and run snapshots. A `DONE` directive requests completion, but the room only completes after all queued and running work has reached a terminal state.

## Cache And Sessions

Edge runners derive a stable `AGENT_CACHE_KEY` for each agent plus room/thread scope and mirror it as `AGENT_SESSION_ID`. Command adapters can pass that value to AI CLIs or model gateways to improve prompt-cache reuse without sharing context across different agents or rooms.

Room prompts keep stable instructions before volatile wake reasons, blackboard state, and recent messages. The OpenClaw wrapper also uses a stable Agent Bus message envelope, and `agent-bus openclaw prepare` seeds a dedicated OpenClaw agent with a stable system prompt and long cache retention, so OpenAI-compatible gateways can reuse repeated room prefixes.

Task text is written to `AGENT_MESSAGE_FILE` before command execution. Small messages are also copied into `AGENT_MESSAGE`; large messages can use the file path without hitting operating-system environment-size limits. The OpenClaw wrapper applies the same pattern to its final CLI prompt so oversized room contexts are passed by file instead of argv.

## Model Plane

The central gateway exposes OpenAI-compatible endpoints:

- `GET /v1/models`
- `POST /v1/chat/completions`

Requests are authenticated with the gateway bearer token, then routed to a configured backend. Backends can be local services, remote model gateways, or any OpenAI-compatible API.

## Runtime Options

- Node gateway: `central-gateway.mjs`
- Python gateway: `central_gateway.py`
- Node edge: `edge-node.mjs`
- Python edge: `edge_node.py`
- Windows local proxy: `windows-openai-proxy.mjs`
