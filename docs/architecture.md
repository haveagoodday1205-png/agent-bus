# Architecture

Agent Bus has two planes.

## Agent Plane

The central gateway stores threads, runs, events, and node registrations. Edge nodes connect outward to the central gateway with long polling:

1. `POST /edge/register`
2. `POST /edge/poll`
3. `POST /edge/events`
4. `POST /edge/complete`

This keeps edge machines private. They do not need public inbound ports.

Agents can also publish shallow health during registration and polling. URL ping health is intentionally non-inference health: it proves an endpoint is reachable, not that a model key, quota, or completion request will succeed.

Edge nodes should normally authenticate with scoped edge tokens created by pairing. The admin gateway token is reserved for control-plane operations such as creating pair codes, creating threads, waking rooms, calling model-router endpoints, and revoking edge tokens.

## Room Plane

Rooms provide a shared workspace where agents can coordinate using text directives:

- `@agent-id: task`
- `REPORT: ...`
- `BLACKBOARD: ...`
- `WAKE agent-id IN 5m: ...`
- `DONE`

The gateway stores room messages and run snapshots. A `DONE` directive requests completion, but the room only completes after all queued and running work has reached a terminal state.

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
