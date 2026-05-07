# Good First Issues

These are public-friendly starter tasks that do not require private Agent Bus infrastructure, live model calls, or access to the maintainer's machines.

## v0.6 adoption tasks

- Add a registry install smoke command/script that installs `agent-bus-cli` into a temporary npm prefix and runs `agent-bus --help` plus `agent-bus smoke --offline`.
- Improve `agent-bus status` human output so a new operator can tell online, busy/running, stale, ping reachability, and last-run health apart at a glance.
- Add a remote-assistant quickstart that starts from `npm install -g agent-bus-cli`, pairs one edge node, sends one fake/local task, and exports only reports.
- Add or update a trust-boundary diagram for central/admin token, scoped edge token, command adapters, model-router access, and share-safe room exports.

## Adapter presets

- Add an `agent-bus init edge --preset <tool>` preset for a local agent runtime you already use.
- Include a minimal `runCommand`, safe default capabilities, and a `doctor` hint if the binary is missing.
- Verify with a fake or local command adapter before documenting live-provider setup.

## CLI and setup UX

- Improve one `agent-bus doctor` warning so it gives an exact next command.
- Add `--json` output to a CLI path that is useful for scripts.
- Improve error messages for missing gateway URL, token, config path, or unsupported platform.

## Rooms and exports

- Add a small offline smoke assertion for room directives such as `REPORT`, `BLACKBOARD`, `WAKE`, or `DONE`.
- Improve `room export --reports-only` formatting while keeping full prompts/messages omitted.
- Add a docs example that starts from `npm run demo:room` and ends with a share-safe Markdown report.

## Packaging and release checks

- Add a release-check assertion that catches a common packaging mistake.
- Improve portable bundle docs for one shell or operating system.
- Verify npm package contents with `npm run pack:check` and document any missing expected file.

## Docs and diagrams

- Draw the central gateway / outbound edge-node trust boundary.
- Add a short tutorial for pairing a second machine without exposing inbound ports.
- Add screenshots or terminal output from the local room demo with tokens and hostnames redacted.

## Before opening a PR

Run the offline checks whenever possible:

```bash
npm run smoke:offline
npm run release:check
```

If your change touches docs only, say so in the PR and include the exact command or page you reviewed.
