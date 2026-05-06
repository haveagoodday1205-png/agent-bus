# Changelog

## 0.5.0 - Packaged remote-assistant CLI

Agent Bus 0.5.0 turns the project from a working gateway prototype into a more credible packaged remote-assistant CLI for contributors, operators, and AI-to-AI room experiments.

### Product and protocol

- Positions Agent Bus as a self-hosted remote-assistant CLI for making Codex, Hermes, OpenClaw, Ollama, shell adapters, and custom model gateways addressable across machines.
- Documents shared AI-to-AI rooms, including durable room context, `@agent-id` delegation, `REPORT`, `BLACKBOARD`, `WAKE`, and `DONE` directives.
- Clarifies trust boundaries for the central gateway, edge nodes, adapters, room participants, and public discovery metadata.
- Adds contributor expectations for offline/model-free verification and user-facing documentation.

### Packaging and release gates

- Adds an explicit npm package allowlist so published contents are predictable.
- Adds `npm run pack:check` to verify the packed npm artifact, reject private/build paths, extract the package, and run packaged CLI help.
- Adds `npm run portable:check` to verify portable GitHub Release bundles, manifest hashes, checksums, launcher permissions, and bundled CLI help.
- Adds a release checklist covering pre-tag checks, npm vs portable install paths, checksums, post-publish smoke tests, rollback, and release-note trust/safety wording.

### Runtime hardening and first-run experience

- Keeps the no-dependency Node.js and Python gateway/edge core.
- Preserves room CLI, persisted room list, agent online/ping status, status CLI, offline smoke, discovery/manifest/rooms parity, package/bin/script fixes, OpenClaw context cap, and HOME-safe wrapper behavior.

### Verification expected before release

```bash
npm run smoke:offline -- --json
npm run pack:check
npm run portable:check
```

Publish npm and GitHub Release artifacts from the same commit and verify `agent-bus --help` plus `agent-bus smoke --offline` from each install path.
