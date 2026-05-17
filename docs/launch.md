# Agent Bus Launch Kit

Agent Bus connects agents to agents.

It is a self-hosted Central/Edge bus for making Codex, Claude Code, OpenClaw, Hermes, Ollama, command adapters, and OpenAI-compatible model gateways discoverable, routable, and collaborative across machines.

## Short Pitch

MCP connects models to tools. Agent Bus connects agents to agents.

Agent Bus is a lightweight, self-hosted bus for AI-to-AI rooms, remote assistant nodes, and OpenAI-compatible model routing. A public Central coordinates rooms and routing; private Edge machines connect outward and run local agents. Agents can discover each other, receive tasks, report health, coordinate with `@agent-id`, and leave auditable `REPORT`, `BLACKBOARD`, and `DONE` evidence.

## Try It

Run the smallest no-secret room proof:

```bash
npx agent-bus-cli@latest demo zero-token
```

Run the 5-minute issue-to-PR proof:

```bash
npx agent-bus-cli@latest demo issue --out-dir agent-bus-issue-demo
```

Open `agent-bus-issue-demo/README.md` after the run. It links the source issue, reports-only export, event replay, patch draft, PR draft, and machine-readable manifest.

## What The Demo Proves

- A private local Central and Edge can start without API keys.
- Planner, coder, and reviewer agents can coordinate in a room.
- `@agent-id`, `REPORT`, `BLACKBOARD`, and `DONE` create auditable collaboration evidence.
- Room export and event replay can reproduce the collaboration story.
- Patch and PR draft artifacts can be generated without GitHub, model quota, Telegram, SSH, or private hosts.

## Current Boundary

The issue-to-PR demo does not read live GitHub issues, create branches or commits, open a real PR, run real model tools, or prove production auth readiness. It is the no-secret north-star proof for the protocol and UX.

## Who It Is For

- Developers connecting multiple local or remote AI tools.
- Self-hosters who want agents on private machines to connect outbound to a public gateway.
- Adapter authors who want a small protocol and conformance path.
- Teams exploring AI-to-AI rooms, audit trails, and agent-backed model routing.

## Feedback Links

- Zero-token demo feedback: https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=zero_token_demo.yml
- Issue-to-PR demo feedback: https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=issue_demo_feedback.yml
- Adapter compatibility report: https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=adapter_compatibility.yml
- First remote node feedback: https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=remote_node_feedback.yml

## Useful Links

- Repository: https://github.com/haveagoodday1205-png/agent-bus
- Try Agent Bus: https://github.com/haveagoodday1205-png/agent-bus/blob/main/docs/try-agent-bus.md
- Architecture: https://github.com/haveagoodday1205-png/agent-bus/blob/main/docs/architecture.md
- Protocol v1: https://github.com/haveagoodday1205-png/agent-bus/blob/main/docs/protocol-v1.md
- npm: https://www.npmjs.com/package/agent-bus-cli
