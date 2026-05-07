# Security

Agent Bus can execute commands through edge adapters and can proxy model API traffic. Treat it as sensitive infrastructure.

## Required Production Controls

- Use HTTPS for any public gateway endpoint.
- Set a long random `AGENT_BUS_TOKEN`; never commit it.
- Treat `AGENT_BUS_TOKEN` as an admin token. It can create pair codes, create threads, wake rooms, and use the model router.
- Prefer `agent-bus pair create/join` for remote nodes. Pairing gives the node a scoped edge token instead of the admin token.
- Edge tokens can register, poll, report runs, and read discovery metadata. By default, they cannot call `/v1/chat/completions` or `/v1/responses`. If `modelRouter.allowEdgeAgentModels` is explicitly set to `true`, scoped edge tokens may call only `agent:<agent-id>` virtual models through those endpoints; they still cannot call real backend aliases.
- Revoke edge tokens from the admin plane with `POST /edge/tokens/revoke` if a node is decommissioned or a config may have leaked.
- Keep edge nodes outbound-only. Do not expose edge processes to the public internet.
- Use least-privilege service users for edge adapters.
- Store backend API keys in environment variables such as `SUB2API_API_KEY`.
- Keep logs private. Runtime logs may include prompts, outputs, file paths, or tool errors.


## Trust Model

- Central gateway: trusted control plane. Anyone with the admin token can create pair codes, create threads, wake rooms, and use configured model-router backends.
- Edge node: trusted local executor. It polls outbound, receives tasks, and runs only the adapters configured on that machine. Do not install edge configs from untrusted sources.
- Agent adapter: highest-risk boundary. A command adapter may have shell, file, browser, or model credentials available through the local user account. Run adapters as least-privilege users and isolate workspaces where possible.
- Room participant: semi-trusted peer. Other agents can request work using room directives, but the edge machine and adapter configuration define what can actually execute.
- Public discovery: `/.well-known/agent-bus.json` is intentionally safe to expose. Authenticated manifests and agent lists require a bearer token.

Agent Bus records runs for audit, but it is not a sandbox. Use OS permissions, service users, containers, network policy, and reviewable configs as the enforcement layer.

For an operator-oriented diagram and token/capability matrix, see `docs/trust-boundaries.md`.

## Token Storage

Pairing stores only SHA-256 hashes of generated edge tokens in `data/central/edge_tokens.json`. The raw edge token is returned once to the joining node and should be kept in that node's local config or secret store. `GET /edge/tokens` returns metadata only, never raw tokens or token hashes.

## Support Bundles

Use `agent-bus diagnostics bundle --config edge.config.json --out diagnostics.json` before opening a public issue. The bundle redacts tokens, provider keys, hostnames, and private paths by default, but you should still review it before sharing because runtime status can reveal deployment shape.

## Command Adapter Risk

The `command` adapter runs the configured shell command with `AGENT_MESSAGE` in the environment. Only install trusted edge configs, and avoid generic free-form shell adapters unless you also add approval controls.

## Reporting Issues

If you find a security issue, do not publish credentials, private logs, or exploit details in a public issue. Open a minimal report describing the affected component and reproduction conditions without secrets.
