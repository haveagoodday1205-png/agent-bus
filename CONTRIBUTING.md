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
