# Agent Room Operations Checklist

Use this checklist when an Agent Bus room coordinates multiple AI agents on the same repository or deployment. It is model-free and safe to run from a fresh checkout.

## Before Changing Files

1. Confirm the workspace and branch:

```bash
git status --short
git branch --show-current
```

2. Read the room contract, latest blackboard, and recent reports. Treat `BLACKBOARD` as durable shared state and `REPORT` as user-facing progress.
3. Pick a small batch with a visible reliability, observability, onboarding, recovery, or CLI ergonomics outcome.
4. Split ownership before editing. One agent implements; another reviews, writes docs, or runs checks. Avoid concurrent edits to the same files.
5. Do not print, persist, or copy secrets. Use example values, redacted tokens, and public paths only.

## While Working

- Keep room messages concise and actionable.
- Address another agent with a self-contained `@agent-id:` task when delegation is needed.
- Record persistent decisions as `BLACKBOARD: ...` with paths and commands, not long reasoning.
- Record user-facing outcomes as `REPORT: ...`.
- Do not mark `DONE` until the selected batch is complete or blocked with a clear reason.
- Prefer offline checks and fake agents over live model calls for contributor-facing work.

## Recommended Small-Batch Lanes

- Reliability: reconnect behavior, stale run classification, guarded recovery, restart smokes.
- Observability: status summaries, doctor checks, trace/export readability, actionable warnings.
- Onboarding: setup output, good-first tasks, check matrices, quickstart clarity.
- Room recovery: inspect/recover/pause guidance and smoke coverage.
- CLI ergonomics: clearer errors, copy/paste commands, JSON fields for automation.

## Check Selection

Use the smallest useful check for the files touched, then broaden before release work.

```bash
# Syntax only
node --check agent-bus.mjs central-gateway.mjs edge-node.mjs
python3 -m py_compile central_gateway.py edge_node.py sdk/python/agent_bus_sdk.py

# Targeted offline smokes
npm run smoke:offline
npm run doctor:smoke -- --json
npm run smoke:room-stale -- --json
npm run smoke:central-restart -- --json

# Release confidence
npm run release:check
```

Docs-only changes should at least run:

```bash
git diff --check
```

## Handoff Template

```text
BLACKBOARD: Batch=<short name>; owner=<agent>; reviewer=<agent>; files=<paths>; checks=<commands/status>.
REPORT: <one-sentence user-facing result, with no secrets>.
DONE
```
