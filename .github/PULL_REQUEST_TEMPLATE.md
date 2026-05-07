## Summary

-

## Area

- [ ] Gateway / model router
- [ ] Edge node / adapter
- [ ] Rooms / orchestration
- [ ] SDK / examples
- [ ] CLI / packaging
- [ ] Docs only

## Checks

- [ ] `node --check agent-bus.mjs`
- [ ] `node --check central-gateway.mjs`
- [ ] `node --check edge-node.mjs`
- [ ] `python3 -m py_compile central_gateway.py edge_node.py sdk/python/agent_bus_sdk.py examples/room-agent-python/room_agent.py`
- [ ] `npm run protocol:check`
- [ ] `npm run compat:check`
- [ ] `npm run smoke:offline`
- [ ] `npm run smoke:python-room-agent`
- [ ] `npm run release:check`
- [ ] `node smoke-test.mjs`
- [ ] Docs-only change: I reviewed the rendered Markdown instead of running the full smoke matrix.

## Security

- [ ] I did not include real tokens, API keys, IP addresses, domains, SSH paths, private prompts, or runtime logs.
- [ ] New logs or command output do not print bearer tokens.
- [ ] New adapter or model-router behavior keeps the trust boundary documented in `SECURITY.md` and `docs/trust-boundaries.md`.
