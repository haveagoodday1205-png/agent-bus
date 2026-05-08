# Changelog

## Unreleased

### Protocol direction

- Adds a v1 protocol draft that captures the emerging Agent Bus contract for agent identity, rooms, directives, append-only events, permissions, compatibility tests, and the flagship multi-runtime PR demo.
- Adds a machine-readable protocol v1 JSON Schema plus a no-model `examples/hello-agent` adapter template.
- Adds `npm run protocol:check` to verify the schema and hello-agent contract without live model calls.
- Adds `npm run compat:check` to start a temporary gateway and hello-agent edge, verify `agent:<id>` Chat Completions/Responses routing, and confirm room `REPORT`/`BLACKBOARD` parsing without model quota.
- Runs the compatibility smoke in CI across Ubuntu, Windows, and macOS so public PRs can prove adapter compatibility without private infrastructure.
- Tightens `examples/hello-agent` so compatibility tests prove command adapters receive tasks through `AGENT_MESSAGE_FILE`.
- Adds `agent-bus room export --format events` and `agent-bus room replay --in` for redacted room event bundles and deterministic offline replay summaries.
- Adds a zero-dependency JS/TS SDK under `sdk/js/` and uses it inside compatibility smoke coverage.
- Adds `agent-bus demo issue` / `npm run demo:issue`, a no-quota issue-to-PR flagship skeleton that writes report, event, replay, patch, and PR draft artifacts.
- Updates the roadmap and starter issues around the "MCP connects models to tools; Agent Bus connects agents to agents" direction.

### Edge-to-edge model replacement

- Adds `agent:<agent-id>` virtual models to the OpenAI-compatible `/v1/models` and `/v1/chat/completions` endpoints.
- Routes agent-backed chat completions through normal Agent Bus runs, waits for the target edge agent, and returns an OpenAI-style assistant message with run metadata.
- Adds `/v1/responses` for agent-backed Responses API calls and best-effort forwarding to backend `/responses` endpoints.
- Adds `modelRouter.allowEdgeAgentModels` so scoped edge tokens can be explicitly allowed to dispatch only agent-backed model calls without gaining access to real backend model routers.
- Adds explicit cache scopes for direct `agent:<id>` model calls plus console controls for Chat Completions, Responses, timeout, model suggestions, and stable cache/session reuse.
- Adds `agent-bus demo agent-model` / `npm run demo:agent-model`, a no-quota demo that exposes a command edge as `agent:model-agent` and proves Chat Completions and Responses can reuse one derived Agent Bus session key.

### Diagnostics hardening

- Redacts temporary and common private absolute paths such as `/tmp/...` and Windows home-directory paths from `agent-bus diagnostics bundle` by default, including doctor check details like `Read edge config`.
- Adds `npm run diagnostics:redaction:smoke` and runs it inside `npm run release:check` so host/path toggle regressions stay covered without live model calls.

### Deployment hardening

- Adds a Central Telegram Bot plugin skeleton for startup, edge registration, run completion, and room completion notifications, with a dry-run smoke test that makes no external calls.
- Adds admin plugin discovery plus `agent-bus plugin telegram test` so operators can verify Telegram wiring before relying on alerts.
- Adds an opt-in Telegram control webhook for `/status`, `/agents`, and `/run agent-id task`, guarded by Telegram secret tokens and chat allowlists.
- Adds opt-in Telegram conversational mode so plain webhook messages can route to configured Agent Bus agents and return agent output to the same Telegram chat.
- Adds `agent-bus plugin telegram poll` as a Central-side polling bridge for deployments where public Telegram webhooks are blocked by Cloudflare, NAT, or local-only networking.
- Makes Telegram conversation mode process-oriented: plain messages stay on the active thread until `/new`, `/resume` can switch processes, `/agent` manages process agents, and `@agent-id` can add or target agents mid-process.
- Adds contextual Telegram inline keyboards for status, multi-select agent selection, new/resume process controls, room controls, callback query handling, and dry-run `reply_markup` smoke coverage.
- Makes the Telegram polling bridge request and forward `callback_query` updates so inline buttons work when public webhooks are disabled.
- Makes `agent-bus setup central` generate and print a first scoped edge token plus a copy/paste `setup edge --token ...` command, while still supporting pair-code onboarding.
- Adds a Web Console Edge Join panel that creates, lists, and revokes scoped edge tokens while copying a ready-to-run `agent-bus setup edge --gateway ... --token ...` command.
- Adds Web Console pair-code onboarding so operators can create short-lived codes and copy `agent-bus setup edge --gateway ... --code ...` commands without exposing admin tokens.
- Makes the bundled `compose.yaml` fail fast when `AGENT_BUS_TOKEN` is unset instead of silently starting a public central gateway with a placeholder token.
- Adds `npm run compose:smoke` plus Docker preflight docs so the single-service Python central deployment, persistent-volume story, and "database optional later" guidance stay aligned.
- Shows room-specific recovery recommendations in `agent-bus room inspect` human output so stale/orphan run recovery can be copy/pasted without substituting `ROOM_ID`.
- Carries a tuned `--queued-run-stale-seconds` threshold into `agent-bus status` recovery hints so copy/pasted inspect/recover commands evaluate the same stale window.
- Expands `agent-bus room inspect` with node-aware live, queued, stale queued, and orphaned running buckets while keeping guarded `room recover --yes` compatibility.
- Adds structured `operator_hints` and trace inspection hints to `agent-bus room inspect` JSON so scripts can consume the same operator actions shown in human output.
- Adds contiguous event `sequence` numbers and `export_metadata` to room event bundles across the CLI, JS SDK, and Python SDK.
- Adds a no-quota JS room replay example that exports SDK event bundles, replays them offline, and renders a Markdown support summary.
- Adds a no-quota room replay golden-path demo that starts local central/edge services, runs deterministic agents, inspects the room, exports events, and replays them offline.
- Adds a stable public room event fixture plus `npm run fixture:room-replay`, checking CLI, JS SDK, and Python SDK replay compatibility without a gateway or model quota.
- Adds JS/Python SDK event bundle validators and CLI `agent-bus room replay --strict` so shared room archives can fail fast on bad sequence metadata before replay.
- Brings JS and Python SDK replay output accounting into parity with the CLI for `run.output` events, started timestamps, exit codes, and stable run ordering.
- Documents a live-update impact matrix for central Python service changes, edge bridge scripts, edge config changes, and operator-only CLI/docs updates.

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
