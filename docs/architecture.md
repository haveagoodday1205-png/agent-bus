# Architecture

Agent Bus has two planes.

## Agent Plane

The central gateway stores threads, runs, events, and node registrations. Edge nodes connect outward to the central gateway with long polling:

1. `POST /edge/register`
2. `POST /edge/poll`
3. `POST /edge/events`
4. `POST /edge/complete`

This keeps edge machines private. They do not need public inbound ports.

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
