# Security

Agent Bus can execute commands through edge adapters and can proxy model API traffic. Treat it as sensitive infrastructure.

## Required Production Controls

- Use HTTPS for any public gateway endpoint.
- Set a long random `AGENT_BUS_TOKEN`; never commit it.
- Keep edge nodes outbound-only. Do not expose edge processes to the public internet.
- Use least-privilege service users for edge adapters.
- Store backend API keys in environment variables such as `SUB2API_API_KEY`.
- Keep logs private. Runtime logs may include prompts, outputs, file paths, or tool errors.

## Command Adapter Risk

The `command` adapter runs the configured shell command with `AGENT_MESSAGE` in the environment. Only install trusted edge configs, and avoid generic free-form shell adapters unless you also add approval controls.

## Reporting Issues

If you find a security issue, do not publish credentials, private logs, or exploit details in a public issue. Open a minimal report describing the affected component and reproduction conditions without secrets.
