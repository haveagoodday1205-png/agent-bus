# Contributing

Thanks for helping improve Agent Bus.

Agent Bus is trying to make AI tools addressable to each other: a coding agent can call an ops agent, a browser agent can ask a research agent, and a private machine can join the network as a remote assistant node without opening inbound ports.

## Good First Contributions

- Add an adapter preset for another agent runtime.
- Improve `agent-bus doctor` checks for a platform or shell.
- Package standalone binaries for Windows, Linux, Ubuntu, or macOS.
- Add examples for systemd, launchd, Windows Service, Docker, and reverse proxies.
- Improve room coordination behavior, reports, reminders, or blackboard state.
- Add security hardening around tokens, pairing codes, per-agent permissions, or audit logs.
- Write short demos, screenshots, diagrams, and setup guides.


## Contributor Workflow

1. Pick a focused change: docs, adapter preset, packaging script, smoke coverage, or one gateway/edge behavior.
2. Keep the core path offline and model-free unless the change explicitly requires a live provider. Prefer fake command agents and `agent-bus smoke --offline` for room work.
3. Run the local checks before opening a PR:

```bash
npm run smoke:offline
node --check agent-bus.mjs central-gateway.mjs edge-node.mjs
python3 -m py_compile central_gateway.py edge_node.py
```

4. If a change affects packaging or first-run setup, also verify:

```bash
npm run pack:check
npm run portable:check
```

For release/tag work, follow `docs/release.md` so npm publishing, portable bundles, checksums, and post-publish smoke tests stay aligned.

5. Document the user-facing path in `README.md`, `docs/cli.md`, or a focused doc under `docs/`. Avoid burying required setup only in PR comments.

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

## Project Areas

- Protocol: manifest, discovery, health, capabilities, rooms, and federation.
- Runtime: central gateway, edge node, reconnect, polling, queues, and run events.
- Adapters: Codex, OpenClaw, Hermes, shell tools, browser tools, model gateways, local models.
- Distribution: CLI, services, containers, standalone binaries, installers.
- Community: examples, docs, demos, issue triage, templates, and release notes.
