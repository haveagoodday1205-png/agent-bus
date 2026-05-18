# Promotion Playbook

This playbook keeps Agent Bus promotion concrete, repeatable, and safe. It avoids private infrastructure details and focuses on public demos that anyone can run without secrets.

## Current Baseline

As of 2026-05-18:

- GitHub stars: 1
- GitHub forks: 2
- GitHub views in the last 14 days: 55 total, 12 unique
- GitHub clones in the last 14 days: 3819 total, 923 unique
- npm downloads in the last week: 15
- Current public demo command: `npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo`

Interpretation: people are cloning more than they are starring, commenting, or filing feedback. The first promotion goal is not broad hype; it is converting curious visitors into one of three actions:

1. Run the no-secret issue-to-PR demo.
2. Comment on the beta tester discussion or issue.
3. Open a focused adapter/runtime/first-run feedback issue.

## Positioning

Lead with the contrast:

```text
MCP connects models to tools.
Agent Bus connects agents to agents.
```

Use this one-liner:

```text
Agent Bus is a self-hosted Central/Edge bus for AI-to-AI rooms, remote agents, and OpenAI-compatible model routing.
```

Use `agent-bus-cli` and the concrete demo command in posts. The project name "Agent Bus" has search collisions, so repeated references to `agent-bus-cli`, "self-hosted Central/Edge", and "AI-to-AI rooms" help people understand and find it.

## Primary Call To Action

Ask for one small action:

```bash
npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo
```

Then ask the tester to open `agent-bus-issue-demo/README.md` and answer:

- Did the command finish?
- Did the generated README explain what happened?
- Was the issue -> planner -> coder -> reviewer -> patch/PR draft flow clear?
- Was the "what this proves / does not prove" boundary clear?

Feedback links:

- Beta tester issue: https://github.com/haveagoodday1205-png/agent-bus/issues/44
- Beta tester discussion: https://github.com/haveagoodday1205-png/agent-bus/discussions/48
- Issue-to-PR feedback form: https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=issue_demo_feedback.yml

## Best Channels

Start with communities where the Central/Edge shape is already legible:

- Hacker News: use a Show HN post once the README first screen, release page, demo image, and beta issue are ready.
- Reddit `r/selfhosted`: emphasize outbound Edge connections, trust boundaries, and no-secret demo.
- Reddit `r/LocalLLaMA`: emphasize local agents, Ollama/local gateways, model routing, and adapter conformance.
- GitHub: keep beta issue, discussion, good-first-issues, release notes, and topics fresh.
- AI engineering Discords or Telegram groups: use the short pitch plus demo command; ask for first-run feedback rather than stars.
- Chinese developer communities: use the same demo, but show one practical topology and one screenshot or terminal preview.
- Product Hunt: wait until there is a 60-second demo video/GIF and a clearer one-click install or hosted preview path.

## 7-Day Launch Loop

Day 1:

- Verify `npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo` on a clean Linux or CI-like machine.
- Share the GitHub release, beta tester issue, and demo terminal preview.
- Post to one high-signal community, not everywhere at once.

Day 2:

- Reply to every comment.
- Convert repeated confusion into README or docs changes.
- Open one good-first issue for each concrete request that does not need private infrastructure.

Day 3:

- Post a shorter angle to a second community.
- Highlight the exact feedback already received and what changed because of it.

Day 4:

- Publish or update a 60-second terminal recording/GIF.
- Put the GIF or screenshot near the top of README and the release page.

Day 5:

- Invite adapter authors: "Can your CLI runtime pass Agent Bus adapter-command conformance?"
- Point to `examples/hello-agent/` and `docs/adapter-conformance-ci.md`.

Day 6:

- Share a self-hosting focused post: Central behind HTTPS, Edges connect outward, no inbound SSH required.
- Ask for trust-boundary and setup feedback.

Day 7:

- Publish a short "What we learned from first testers" update in the GitHub discussion.
- Pick the next demo milestone: Ollama/local model walkthrough, real GitHub PR design, or 60-second video.

## What To Measure

Track these once per day during launch week:

```bash
gh repo view haveagoodday1205-png/agent-bus --json stargazerCount,forkCount,watchers,repositoryTopics
gh api repos/haveagoodday1205-png/agent-bus/traffic/views
gh api repos/haveagoodday1205-png/agent-bus/traffic/clones
```

npm downloads:

```bash
curl -s https://api.npmjs.org/downloads/point/last-week/agent-bus-cli
curl -s https://api.npmjs.org/downloads/range/last-month/agent-bus-cli
```

More important than stars:

- Did anyone run the demo?
- Did anyone open a feedback issue?
- Did anyone ask for an adapter/runtime?
- Did anyone say what was confusing?

## Assets To Use

- Social card: `docs/assets/agent-bus-social-card.svg`
- Demo terminal preview: `docs/assets/issue-to-pr-demo-terminal.svg`
- Launch kit: `docs/launch.md`
- Social drafts: `docs/social-posts.md`
- Beta tester page: `docs/beta-testers.md`

## Safety Rules

- Do not share Central admin tokens, edge tokens, Telegram bot tokens, npm tokens, model keys, SSH commands, private IPs, or screenshots containing real private deployment details.
- Do not ask for upvotes.
- Do not claim Agent Bus opens real GitHub PRs yet. The public issue-to-PR demo currently writes a PR draft and patch artifact without contacting GitHub.
- Do not frame silence as rejection. Treat it as a signal to improve distribution, demo clarity, and the next action.

## Immediate Next Promotion Improvements

- Add a 60-second demo GIF or terminal recording for issue #47.
- Write the Ollama/local-model walkthrough tracked by issue #46.
- Add one short landing-page-style section to README that explains who should try it first.
- Keep the first-run command stable across README, release notes, discussion, social posts, and beta issue.
- Ask for "first-run feedback" instead of generic feedback.
