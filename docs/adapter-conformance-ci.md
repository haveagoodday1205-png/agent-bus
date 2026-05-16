# Adapter Conformance CI

Agent Bus adapters can publish proof that they speak the Agent Bus v1 contract. The conformance runner starts a temporary local Central gateway and edge node, registers your adapter command, routes `agent:<id>` Chat Completions and Responses through it, creates a room, validates `REPORT`/`BLACKBOARD`/`DONE`, exports an event bundle, and replays it.

## Local Certification

For a no-quota reference check:

```bash
npm run protocol:certify
```

For your own adapter command:

```bash
agent-bus protocol conformance \
  --profile adapter-command \
  --agent-command "./my-agent-bus-adapter" \
  --agent-id my-agent \
  --artifact-dir conformance-artifacts \
  --json
agent-bus protocol validate-result --artifact-dir conformance-artifacts
```

Artifacts:

- `conformance-artifacts/agent-bus-conformance.json`
- `conformance-artifacts/agent-bus-conformance.md`
- `conformance-artifacts/agent-bus-conformance-badge.json`

The result JSON follows `docs/protocol-conformance-result.schema.json`. Use `agent-bus protocol validate-result --artifact-dir conformance-artifacts` to check the generated JSON, Markdown report, and Shields badge before publishing them.

The default reference profile makes no model calls. The `adapter-command` profile may spend quota if your command calls a model.

## GitHub Actions Template

Copy this into `.github/workflows/agent-bus-conformance.yml` in an adapter project:

```yaml
name: agent-bus-conformance

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install Agent Bus
        run: npm install -g agent-bus-cli
      - name: Run adapter conformance
        env:
          AGENT_BUS_ADAPTER_COMMAND: ./my-agent-bus-adapter
        run: |
          agent-bus protocol conformance \
            --profile adapter-command \
            --agent-command "$AGENT_BUS_ADAPTER_COMMAND" \
            --agent-id my-agent \
            --artifact-dir conformance-artifacts \
            --json
      - name: Validate conformance result
        run: agent-bus protocol validate-result --artifact-dir conformance-artifacts
      - name: Publish job summary
        run: cat conformance-artifacts/agent-bus-conformance.md >> "$GITHUB_STEP_SUMMARY"
      - uses: actions/upload-artifact@v4
        with:
          name: agent-bus-conformance
          path: conformance-artifacts/
          if-no-files-found: error
```

## Badge

`agent-bus-conformance-badge.json` uses the Shields endpoint schema. Publish it from your repo, Pages site, or release assets, then embed it with a Shields endpoint URL.

For private CI, keep the badge artifact private and paste the Markdown report into a release note or PR comment instead.
