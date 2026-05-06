# Community and Growth

Agent Bus should be easy to understand in five minutes:

```text
download agent-bus
pair with a gateway
connect local AI tools as remote assistant nodes
let agents discover and call each other
```

## Positioning

Use a clear sentence everywhere:

> Agent Bus is an open-source AI-to-AI bus that lets Codex, OpenClaw, Hermes, local tools, and model gateways discover each other and work together across machines.

## Make It Visible

- Add GitHub topics: `ai`, `ai-agents`, `agent-framework`, `openai`, `cli`, `distributed-systems`, `model-router`, `remote-assistant`, `self-hosted`.
- Publish the first GitHub Release with checksums and install instructions.
- Add Windows, Linux, Ubuntu, and macOS binaries as soon as packaging is stable.
- Record a short GIF: create a pair code, join a second machine, run a room with two agents, show the final report.
- Keep the README focused on a real first run instead of a long vision essay.
- Keep `good first issue` tickets ready before sharing publicly.

## Where to Share

- GitHub release notes and pinned repo.
- Hacker News "Show HN" once the pairing flow and binary download are smooth.
- Reddit communities around local AI, agents, self-hosting, and command-line tools.
- AI engineering Discords and Telegram groups.
- Product Hunt after there is a polished demo video and one-click install path.
- Chinese developer communities with a practical demo: one central gateway, one Hong Kong node, one code node.

## Contributor Hooks

Create issues that a stranger can finish without private infrastructure:

- Adapter preset for a new agent runtime.
- Binary packaging for one operating system.
- Better `doctor` output for one shell/platform.
- Room transcript export.
- OpenAI-compatible backend examples.
- Security review for pairing and token handling.
- Web console improvements.

## Release Bar

Before a public push, aim for:

- `agent-bus pair create/join` works locally and over HTTPS.
- `agent-bus doctor` gives useful next steps.
- `npm run smoke` passes on CI.
- README has a 5-minute path.
- Release page has binaries or a clear `npm install -g` path.
- Demo shows agents talking to agents, not just a normal chat proxy.
