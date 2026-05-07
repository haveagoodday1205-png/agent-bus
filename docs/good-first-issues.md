# Good First Issues

These are public-friendly starter tasks that do not require private Agent Bus infrastructure, live model calls, or access to the maintainer's machines.

## v0.6-v0.7 adoption tasks

- Extend the registry install smoke script with a CI-friendly scheduled job or platform matrix once registry/network access is available.
- Improve `agent-bus status` human output so a new operator can tell online, busy/running, stale, ping reachability, and last-run health apart at a glance.
- Extend the remote-assistant quickstart with screenshots, copy/paste two-machine transcripts, or a short demo video script for the npm install -> `agent-bus demo room` -> pair/setup edge -> status -> reports-only export path.
- Extend the trust-boundary docs with screenshots, deployment examples, or one small adapter-sandboxing recipe for central/admin token, pair code, scoped edge token, command adapters, model-router access, `/agents` vs `/nodes`, and share-safe room exports.
- Add a web console view that makes `nodes`, `agents`, room activity, and trace IDs easier to scan during first-run setup.
- Add a short "agent as model replacement" tutorial for one edge calling `agent:<id>` on another edge through Central.

## Protocol v1 tasks

- Extend `docs/protocol-v1.schema.json` with stricter artifact, wake, and permission-profile definitions.
- Extend room event replay with artifact events, wake/reminder events, diff-friendly replay fixtures, or additional adapter fixtures.
- Extend the Python room-agent example with room creation, event export, and replay in one script.
- Add a protocol-version field to the manifest and document how clients should handle unknown minor versions.
- Add policy profile examples for read-only, coder, browser, deploy, and admin agents.

## Adapter presets

- Add an `agent-bus init edge --preset <tool>` preset for a local agent runtime you already use.
- Include a minimal `runCommand`, safe default capabilities, and a `doctor` hint if the binary is missing.
- Verify with a fake or local command adapter before documenting live-provider setup.
- Add a small SDK example app that uses `sdk/js/AgentBusClient` to create a room, send a message, export events, and replay them.
- Add a small SDK example app that uses `sdk/python` to call `/v1/responses` with `model: agent:<id>` against a fake local edge.

## CLI and setup UX

- Improve one `agent-bus doctor` warning so it gives an exact next command.
- Add `--json` output to a CLI path that is useful for scripts.
- Improve error messages for missing gateway URL, token, config path, or unsupported platform.
- Improve the diagnostics bundle with one more platform-specific check, redaction test, or issue-template example.

## Rooms and exports

- Add a small offline smoke assertion for room directives such as `REPORT`, `BLACKBOARD`, `WAKE`, or `DONE`.
- Improve `room export --reports-only` formatting while keeping full prompts/messages omitted.
- Add a docs example that starts from `npm run demo:room` and ends with a share-safe Markdown report.
- Add a fixture that proves stale room reminders do not wake completed rooms.

## Packaging and release checks

- Add a release-check assertion that catches a common packaging mistake.
- Improve portable bundle docs for one shell or operating system.
- Verify npm package contents with `npm run pack:check` and document any missing expected file.
- Add a short release-note checklist item for testing one downloaded portable archive on a clean machine.

## Docs and diagrams

- Improve the central gateway / outbound edge-node trust-boundary diagram in `docs/trust-boundaries.md`.
- Add a short tutorial for pairing a second machine without exposing inbound ports.
- Add screenshots or terminal output from the local room demo with tokens and hostnames redacted.

## Before opening a PR

Run the offline checks whenever possible:

```bash
npm run smoke:offline
npm run release:check
```

If your change touches docs only, say so in the PR and include the exact command or page you reviewed.
