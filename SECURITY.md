# Security

Agent Bus can execute commands through edge adapters and can proxy model API traffic. Treat it as sensitive infrastructure.

## Required Production Controls

- Use HTTPS for any public gateway endpoint.
- Set a long random `AGENT_BUS_TOKEN`; never commit it.
- Treat `AGENT_BUS_TOKEN` as an admin token. It can create pair codes, create threads, wake rooms, and use the model router.
- Prefer `agent-bus pair create/join` for remote nodes. Pairing gives the node a scoped edge token instead of the admin token.
- Edge tokens can register, poll, report runs, and read discovery metadata. They cannot call admin endpoints or `/v1/chat/completions`.
- Keep edge nodes outbound-only. Do not expose edge processes to the public internet.
- Use least-privilege service users for edge adapters.
- Store backend API keys in environment variables such as `SUB2API_API_KEY`.
- Keep logs private. Runtime logs may include prompts, outputs, file paths, or tool errors.

## Token Storage

Pairing stores only SHA-256 hashes of generated edge tokens in `data/central/edge_tokens.json`. The raw edge token is returned once to the joining node and should be kept in that node's local config or secret store.

## Command Adapter Risk

The `command` adapter runs the configured shell command with `AGENT_MESSAGE` in the environment. Only install trusted edge configs, and avoid generic free-form shell adapters unless you also add approval controls.

## Reporting Issues

If you find a security issue, do not publish credentials, private logs, or exploit details in a public issue. Open a minimal report describing the affected component and reproduction conditions without secrets.
