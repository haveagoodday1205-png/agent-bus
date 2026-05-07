# Roadmap

Agent Bus starts as a practical gateway for Codex, OpenClaw, Hermes, and OpenAI-compatible model APIs. The larger direction is an AI-to-AI interoperability layer.

## v0.6 Adoption Spine

The next high-leverage release should make Agent Bus easy to try, safe to trust, and obvious to debug before it adds more orchestration power.

1. First install: make `npm install -g agent-bus-cli` the primary public path, then verify it with `agent-bus --help` and `agent-bus smoke --offline`.
2. Node bootstrap: keep the first remote-assistant setup centered on `pair create` plus `setup edge --code ... --auto`, so users do not paste central/admin tokens into chats or edge machines.
3. Reliability visibility: make status output answer four separate questions: is the edge polling, is it currently busy/running, is its optional ping URL reachable, and did the last real run succeed.
4. Trust boundaries: document the central/admin token, scoped edge token, command adapter, model-router token, and share-safe room exports as separate trust zones.
5. Public demo story: maintain a no-secret, no-model-call room demo that starts from npm or checkout install and ends with a share-safe report artifact.
6. Contributor ramp: keep a public good-first backlog of offline-checkable issues, especially setup UX, status/heartbeat visibility, package verification, and docs diagrams.

Concrete v0.6 release candidates:

- Add `agent-bus install-smoke` or an npm script that installs `agent-bus-cli` from the registry into a temporary prefix and runs `agent-bus --help` plus `agent-bus smoke --offline` without publishing a release.
- Improve `agent-bus status` with human labels for `online`, `busy/running`, `stale`, `ping reachable/unreachable`, and `last run ok/failed/unknown`, while preserving JSON fields for automation.
- Add a remote-assistant quickstart page that starts with npm, creates a central gateway, pairs one edge node, checks status, sends one fake/local task, and exports only reports.
- Add a trust-boundary diagram covering outbound edge polling, scoped edge tokens, central/admin actions, adapter execution scope, and share-safe exports.
- Add issue templates for adapter presets, setup UX, smoke coverage, docs/demo, and trust/safety.

## 1. Stable Local Network

- Keep central gateway and edge nodes dependency-light.
- Keep edge nodes outbound-only so private machines do not need public inbound ports.
- Persist runs, rooms, events, reports, and stderr for auditability.
- Distinguish node online, busy/running, URL reachable, and real task success.
- Keep onboarding under five minutes with `agent-bus pair create/join` or `agent-bus setup edge --code ... --auto`.

## 2. Discovery Protocol

- Expand `GET /v1/agent-bus/manifest` into the primary machine-readable contract.
- Keep `GET /.well-known/agent-bus.json` as the public bootstrap discovery document.
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
