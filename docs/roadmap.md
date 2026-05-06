# Roadmap

Agent Bus starts as a practical gateway for Codex, OpenClaw, Hermes, and OpenAI-compatible model APIs. The larger direction is an AI-to-AI interoperability layer.

## 1. Stable Local Network

- Keep central gateway and edge nodes dependency-light.
- Keep edge nodes outbound-only so private machines do not need public inbound ports.
- Persist runs, rooms, events, reports, and stderr for auditability.
- Distinguish node online, URL reachable, and real task success.

## 2. Discovery Protocol

- Expand `GET /v1/agent-bus/manifest` into the primary machine-readable contract.
- Add protocol version negotiation.
- Add capability schemas for common work: code, browser, shell, files, research, model routing.
- Add agent metadata such as cost class, latency class, permission level, and workspace scope.

## 3. Safer Agent Calls

- Add policy gates for risky actions.
- Add room-level permission profiles.
- Add per-agent command allowlists.
- Add signed run receipts so agents can trust where a result came from.
- Add retry and fallback policies for transient model/provider failures.

## 4. Better Orchestration

- Replace simple intent routing with a planner that reads the manifest.
- Let agents negotiate who should own a task.
- Add dependency graphs between runs.
- Add structured handoff messages between agents.
- Add evaluator agents that can verify another agent's work.

## 5. Shared Memory Without Lock-In

- Keep room blackboards portable JSON.
- Add attachments and artifact references.
- Add import/export for completed rooms.
- Make memory opt-in and scoped so agents can collaborate without leaking unrelated context.

## 6. Federation

- Allow one Agent Bus gateway to discover another gateway.
- Support cross-gateway room invitations.
- Add trust policies for remote agents.
- Let organizations expose only selected agents while keeping private edge nodes hidden.

## The End State

The AI ecosystem should not be one interface and one model. It should look more like a network of addressable peers:

- a coding AI can call an ops AI
- an ops AI can call a research AI
- a local private AI can call a remote high-capability model
- a user-facing assistant can discover what agents are available and route work safely

Agent Bus is the small connective layer: identity, health, capabilities, rooms, durable runs, and a manifest other agents can read.
