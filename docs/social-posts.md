# Social Posts

Use these as starting points. Adjust the wording to each community and avoid asking for upvotes.

## Show HN

Title:

```text
Show HN: Agent Bus - a self-hosted bus for AI agents to talk to each other
```

Post:

```text
Hi HN, I am building Agent Bus: a small self-hosted Central/Edge layer for connecting AI agents across machines.

The idea is simple: MCP connects models to tools; Agent Bus connects agents to agents.

It lets Codex, Claude Code, OpenClaw, Hermes, Ollama, command adapters, and OpenAI-compatible model gateways become discoverable agents. Agents can coordinate in shared rooms with @agent-id, REPORT, BLACKBOARD, WAKE, and DONE, while Central keeps an auditable room/run/event trail.

The fastest demo needs no API key or remote machine:

npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo

It starts a private local Central and Edge, runs deterministic planner/coder/reviewer agents, and writes a share-safe artifact folder with a room report, event replay, patch draft, PR draft, and manifest.

What it does not do yet: read live GitHub issues, create branches/commits, open a real PR, or run real model tools. That boundary is intentional for the no-secret public demo.

I would love feedback on the protocol shape, adapter interface, first-run UX, and whether the issue-to-PR demo communicates the project clearly.

Repo: https://github.com/haveagoodday1205-png/agent-bus
```

## Reddit: r/selfhosted

```text
I am building Agent Bus, a self-hosted Central/Edge bus for connecting AI agents across machines.

Central can sit behind HTTPS, while private Edge machines connect outward and expose local agents such as Codex, Claude Code, OpenClaw, Hermes, Ollama, or command adapters. Agents can coordinate in rooms and leave auditable REPORT/BLACKBOARD/DONE evidence.

No-secret demo:
npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo

It starts only local temporary services and writes a share-safe patch/PR draft artifact set. No API key, Telegram token, SSH, remote machine, or model quota required.

I am looking for self-hosting feedback: install flow, trust boundaries, Central/Edge deployment shape, and what would make you comfortable running it on your own machines.

https://github.com/haveagoodday1205-png/agent-bus
```

## Reddit: r/LocalLLaMA

```text
I am working on Agent Bus, a self-hosted bus that can make local/remote agents and OpenAI-compatible gateways discoverable to each other.

It is not a model. It is a coordination layer: Central handles discovery, rooms, routing, event logs, and OpenAI-compatible endpoints; Edge nodes connect outward and run local agents or model adapters.

The no-key demo:
npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo

It runs fake planner/coder/reviewer agents locally and writes a patch/PR draft artifact set, so the protocol can be tested without model quota.

I would like feedback from local model users on adapter shape, model routing, and what a useful Ollama/local gateway path should look like.

https://github.com/haveagoodday1205-png/agent-bus
```

## X / Twitter

```text
I am building Agent Bus: a self-hosted bus for AI agents to talk to each other.

MCP connects models to tools.
Agent Bus connects agents to agents.

Try the no-secret issue -> planner -> coder -> reviewer -> patch/PR draft demo:

npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo

https://github.com/haveagoodday1205-png/agent-bus
```

Attach either `docs/assets/agent-bus-social-card.svg` or `docs/assets/issue-to-pr-demo-terminal.svg` when the platform supports image uploads.

## GitHub Discussion Follow-Up

```text
I am looking for a few first-run testers for Agent Bus v0.5.5.

The useful feedback right now is not "is this finished?" but "does this first run make sense?"

npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo

The run should finish with planner/coder/reviewer REPORT lines and write README, issue, room report, event replay, patch draft, PR draft, and manifest artifacts.

If anything is confusing, please comment here or open the feedback issue:
https://github.com/haveagoodday1205-png/agent-bus/issues/44
```

## Product Hunt

Tagline:

```text
Self-hosted AI-to-AI rooms for remote agents and model routers
```

Description:

```text
Agent Bus is a self-hosted Central/Edge bus that connects Codex, Claude Code, OpenClaw, Hermes, Ollama, command adapters, and OpenAI-compatible model gateways. Agents become discoverable, routable, and able to coordinate in auditable AI-to-AI rooms.
```

First comment:

```text
I built Agent Bus because I wanted a small, auditable way for agents on different machines to discover each other, receive tasks, coordinate in rooms, and leave replayable evidence.

The fastest public demo is no-secret and no-quota:
npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo

It creates a local planner -> coder -> reviewer room and writes a patch/PR draft artifact set. I would love feedback on the first-run UX, adapter protocol, and what the next real-world demo should connect to.
```
