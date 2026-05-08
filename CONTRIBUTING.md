# Contributing

Thanks for helping improve Agent Bus.

Agent Bus is trying to make AI tools addressable to each other: a coding agent can call an ops agent, a browser agent can ask a research agent, and a private machine can join the network as a remote assistant node without opening inbound ports.

## Good First Contributions

See `docs/good-first-issues.md` for starter tasks that do not require private infrastructure or live model calls. Good categories include:

- adapter presets for local agent runtimes
- clearer `agent-bus doctor` checks for a platform or shell
- packaging/docs improvements for Windows, Linux, Ubuntu, or macOS
- room coordination, reports-only export, reminders, or blackboard polish
- security hardening around tokens, pairing codes, per-agent permissions, or audit logs
- short demos, screenshots, diagrams, and setup guides

If you are opening your first issue, use the "Good first task" template and describe the smallest visible improvement plus the check that proves it works.

## Contributor Lanes

The project is especially ready for help in these areas:

- Adapter presets for Codex-style tools, OpenClaw, Hermes, Ollama, browser tools, shell tools, and OpenAI-compatible gateways.
- SDK and example apps for JavaScript, TypeScript, Python, and other no-secret local workflows.
- Web console views for node status, room activity, traces, and first-run debugging.
- Packaging for Windows, Linux, Ubuntu, macOS, Docker, and portable bundles.
- Protocol fixtures for rooms, manifests, event replay, `agent:<id>` model calls, and trust-boundary docs.
- Security hardening that keeps the offline path simple while improving tokens, pairing, audit logs, and adapter isolation.

## Contributor Workflow

1. Pick a focused change: docs, adapter preset, packaging script, smoke coverage, or one gateway/edge behavior.
2. Keep the core path offline and model-free unless the change explicitly requires a live provider. Prefer fake command agents and `agent-bus smoke --offline` for room work.
3. Run the local checks before opening a PR:

```bash
npm run smoke:offline
npm run release:check
node --check agent-bus.mjs central-gateway.mjs edge-node.mjs
python3 -m py_compile central_gateway.py edge_node.py sdk/python/agent_bus_sdk.py examples/room-agent-python/room_agent.py
```

4. If a change affects packaging or first-run setup, also verify:

```bash
npm run pack:check
npm run portable:check
```

For release/tag work, follow `docs/release.md` so npm publishing, portable bundles, checksums, and post-publish smoke tests stay aligned.

5. Document the user-facing path in `README.md`, `docs/cli.md`, or a focused doc under `docs/`. Avoid burying required setup only in PR comments.

## Check Matrix

Use the smallest useful check while developing, then run the broader checks before opening a behavior-changing PR.

```bash
npm run smoke:offline                 # room path with no model calls
npm run compat:check -- --json        # local gateway + hello-agent compatibility
npm run doctor:smoke -- --json        # zero-quota diagnostics
npm run diagnostics:redaction:smoke -- --json
npm run compose:smoke -- --json
npm run adapter:preset:smoke -- --json # fake Codex/OpenClaw/Hermes/Ollama preset contracts
npm run trace:smoke -- --json         # trace export/show behavior
npm run fixture:room-replay -- --json # public event replay fixture across CLI/SDKs
npm run smoke:central-restart -- --json
npm run sdk:python:smoke -- --json
npm run smoke:python-room-agent -- --json
npm run smoke:room-stale -- --json
npm run release:check                 # full pre-release matrix
```

Docs-only PRs do not need the full matrix, but they should say which page or command was reviewed.

## Product Principles

- Remote nodes connect outward; users should not need to expose private edge machines.
- Pairing and scoped edge tokens are preferred over sharing the admin token.
- Health checks should distinguish shallow reachability from real model execution.
- Room state should be readable by humans and machines: reports for users, blackboard for durable shared state, runs for audit.
- Good defaults should work without paid model calls, secrets, or local private paths.

## Local Setup

```bash
npm install
npm run smoke
```

Core entrypoints intentionally have no npm runtime dependencies:

- `agent-bus.mjs`
- `central-gateway.mjs`
- `edge-node.mjs`
- `central_gateway.py`
- `edge_node.py`

## Local Checks

```bash
node --check agent-bus.mjs
node --check central-gateway.mjs
node --check edge-node.mjs
python3 -m py_compile central_gateway.py edge_node.py
node smoke-test.mjs
```

## Pull Request Rules

- Do not include real IP addresses, domains, API keys, tokens, SSH key paths, private prompts, or runtime logs.
- Add or update a smoke test when changing gateway, edge, pairing, room, or model-router behavior.
- Keep the no-dependency path working for the core Node and Python entrypoints.
- Prefer example configs over private configs.
- Keep security-sensitive output quiet: do not print bearer tokens unless a command explicitly exists to reveal them.
- Keep PRs small enough that a reviewer can understand the behavior, trust-boundary impact, and test result in one pass.

## Project Areas

- Protocol: manifest, discovery, health, capabilities, rooms, and federation.
- Runtime: central gateway, edge node, reconnect, polling, queues, and run events.
- Adapters: Codex, OpenClaw, Hermes, shell tools, browser tools, model gateways, local models.
- Distribution: CLI, services, containers, standalone binaries, installers.
- Community: examples, docs, demos, issue triage, templates, and release notes.

## Community Norms

See `CODE_OF_CONDUCT.md` for expected behavior and `GOVERNANCE.md` for maintainer decision rules. When in doubt, open a draft PR with a clear problem statement and an offline reproduction.
