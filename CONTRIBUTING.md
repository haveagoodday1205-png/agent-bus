# Contributing

Thanks for helping improve Agent Bus.

Before opening a PR:

- Do not include real IP addresses, domains, API keys, tokens, SSH key paths, or runtime logs.
- Add or update a smoke test when changing gateway, edge, or model-router behavior.
- Keep the no-dependency path working for the core Node and Python entrypoints.
- Prefer example configs over private configs.

Useful local checks:

```bash
node --check central-gateway.mjs
node --check edge-node.mjs
node smoke-test.mjs
```
