# Changelog

## Unreleased

### Protocol direction

- Adds a v1 protocol draft that captures the emerging Agent Bus contract for agent identity, rooms, directives, append-only events, permissions, compatibility tests, and the flagship multi-runtime PR demo.
- Adds a machine-readable protocol v1 JSON Schema plus a no-model `examples/hello-agent` adapter template.
- Adds `npm run protocol:check` to verify the schema and hello-agent contract without live model calls.
- Adds `npm run compat:check` to start a temporary gateway and hello-agent edge, verify `agent:<id>` Chat Completions/Responses routing, and confirm room `REPORT`/`BLACKBOARD` parsing without model quota.
- Updates the roadmap and starter issues around the "MCP connects models to tools; Agent Bus connects agents to agents" direction.

### Edge-to-edge model replacement

- Adds `agent:<agent-id>` virtual models to the OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints.
- Routes agent-backed chat completions through normal Agent Bus runs, waits for the target edge agent, and returns an OpenAI-style assistant message with run metadata.
- Adds `/v1/responses` for agent-backed Responses API calls and best-effort forwarding to backend `/responses` endpoints.
- Adds `modelRouter.allowEdgeAgentModels` so scoped edge tokens can be explicitly allowed to dispatch only agent-backed model calls without gaining access to real backend model routers.

## 0.5.5 - Compact room session keys

Agent Bus 0.5.5 makes room and thread session keys shorter while preserving stable per-agent/per-room cache identity.

### Runtime reliability

- Compacts room/thread/run scope IDs into short hashed labels for `AGENT_CACHE_KEY` and `AGENT_SESSION_ID`.
- Reduces the chance that downstream agent CLIs or model gateways reject long room-derived session IDs while keeping cache reuse deterministic.

## 0.5.4 - Cleaner CLI shutdown

Agent Bus 0.5.4 tightens the installed CLI wrapper so temporary sandboxes and service managers stop child gateway/edge processes cleanly.

### Runtime cleanup

- Forwards `SIGINT` and `SIGTERM` from `agent-bus serve`, `agent-bus connect`, demos, and smoke wrappers to their child Node.js scripts.
- Kills child scripts on wrapper process exit to avoid orphaned temporary edge nodes.

## 0.5.3 - Quickstart demos and room recovery

Agent Bus 0.5.3 brings the published npm CLI back in line with the latest GitHub quickstart and room reliability work.

### First-run experience

- Adds installed CLI demos via `agent-bus demo local` and `agent-bus demo room` so new users can verify Agent Bus without model calls.
- Keeps `agent-bus smoke --offline --json` model-free and suitable for CI, sandboxes, and quota-safe checks.

### Room reliability

- Adds `agent-bus room pause` for recovering old or abandoned rooms while preserving room history, reports, and blackboard context.
- Distinguishes stale queued room runs from live queued work in `agent-bus status`, so idle agents do not look busy because of old orphaned runs.
- Adds stale queued room-run smoke coverage and exposes queued-run freshness controls for operators.

## 0.5.2 - npm package name accepted by registry

Agent Bus 0.5.2 publishes the CLI as `agent-bus-cli` after npm rejected both the unscoped `agent-bus` name and the user-scoped package attempt. The installed executable remains `agent-bus`.

### Packaging

- Renames the npm package to `agent-bus-cli` while keeping the command name `agent-bus`.
- Updates README, release checklist, release notes, and npm verification commands to use `agent-bus-cli`.
- Keeps the GitHub portable release assets and all v0.5 room/release gates unchanged.

## 0.5.1 - Scoped npm package publication

Agent Bus 0.5.1 publishes the CLI under the npm scope `@haveagoodday1205/agent-bus` after the public registry rejected the unscoped `agent-bus` name as too similar to an existing package.

### Packaging

- Renames the npm package to `@haveagoodday1205/agent-bus` while keeping the installed CLI command as `agent-bus`.
- Updates npm install, publish verification, release-note generation, and rollback documentation to use the scoped package name.
- Keeps the v0.5 room demo, stale-room autonomy, preflight, release-note, npm package, and portable bundle gates intact.

## 0.5.0 - Packaged remote-assistant CLI

Agent Bus 0.5.0 turns the project from a working gateway prototype into a more credible packaged remote-assistant CLI for contributors, operators, and AI-to-AI room experiments.

### Product and protocol

- Positions Agent Bus as a self-hosted remote-assistant CLI for making Codex, Hermes, OpenClaw, Ollama, shell adapters, and custom model gateways addressable across machines.
- Documents shared AI-to-AI rooms, including durable room context, `@agent-id` delegation, `REPORT`, `BLACKBOARD`, `WAKE`, and `DONE` directives.
- Adds `npm run demo:room`, a model-free first-run room demo that exports share-safe reports-only Markdown.
- Clarifies trust boundaries for the central gateway, edge nodes, adapters, room participants, and public discovery metadata.
- Adds contributor expectations for offline/model-free verification and user-facing documentation.

### Packaging and release gates

- Adds an explicit npm package allowlist so published contents are predictable.
- Adds `npm run pack:check` to verify the packed npm artifact, reject private/build paths, extract the package, and run packaged CLI help.
- Adds `npm run portable:check` to verify portable GitHub Release bundles, manifest hashes, checksums, launcher permissions, and bundled CLI help.
- Adds a release checklist covering pre-tag checks, npm vs portable install paths, checksums, post-publish smoke tests, rollback, and release-note trust/safety wording.
- Adds `npm run release:notes` and `npm run release:preflight`, and includes release-note generation in `npm run release:check`.

### Runtime hardening and first-run experience

- Keeps the no-dependency Node.js and Python gateway/edge core.
- Preserves room CLI, persisted room list, agent online/ping status, status CLI, offline smoke, discovery/manifest/rooms parity, package/bin/script fixes, OpenClaw context cap, and HOME-safe wrapper behavior.
- Keeps room autonomy alive after long runs and adds stale-room autonomy smoke coverage for busy edge nodes.

### Verification expected before release

```bash
npm run smoke:offline -- --json
npm run pack:check
npm run portable:check
```

Publish npm and GitHub Release artifacts from the same commit and verify `agent-bus --help` plus `agent-bus smoke --offline` from each install path.
