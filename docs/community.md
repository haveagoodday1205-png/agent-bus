# Community and Growth

Agent Bus should be easy to understand in five minutes:

```text
download agent-bus
detect local tools
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
- Put one visual proof near the top of the README so visitors can understand the successful demo shape before reading architecture docs.
- Use `docs/promotion-playbook.md` as the launch-week checklist and measurement loop.
- Add Windows, Linux, Ubuntu, and macOS binaries as soon as packaging is stable.
- Record a short GIF: create a pair code, join a second machine, run a room with two agents, show the final report.
- Keep the README focused on a real first run instead of a long vision essay.
- Keep `good first issue` tickets ready before sharing publicly.

## First Feedback Loop

For the first few days after launch, treat silence as a distribution problem before treating it as product rejection:

- Check GitHub traffic, clones, release views, and npm downloads.
- Keep one beta-tester issue open with a concrete command to run.
- Keep one discussion thread open for loose feedback that is not ready to become an issue.
- Reply to every clone/download signal by making the next action more obvious in README, release notes, and issue templates.
- Share the no-secret issue-to-PR demo in communities where self-hosting, CLI agents, local models, or adapter protocols are already discussed.

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
- `agent-bus detect` and `agent-bus init edge --auto` make a useful config on machines with Codex, OpenClaw, Hermes, or Ollama.
- `agent-bus doctor` gives useful next steps.
- `npm run smoke` passes on CI.
- README has a 5-minute path.
- Release page has binaries or a clear `npm install -g` path.
- Demo shows agents talking to agents, not just a normal chat proxy.
