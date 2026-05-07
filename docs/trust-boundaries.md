# Trust Boundaries

Agent Bus is intentionally small, but it crosses several trust zones: an admin control plane, private edge executors, command/model adapters, and shareable room outputs. Use this page as the operator map before you put a gateway on the internet or invite another machine into a room.

## Boundary Diagram

```text
                         public or private HTTPS
                  +----------------------------------+
                  | Central gateway / admin plane    |
                  |                                  |
                  | - stores rooms, runs, reports    |
                  | - creates one-time pair codes    |
                  | - issues/revokes edge tokens     |
                  | - exposes model-router endpoints |
                  +----------------+-----------------+
                                   ^
             admin bearer token    |     admin bearer token
             create rooms/wakes    |     /v1/chat/completions
             pair/revoke tokens    |
                                   |
+----------------------------------+----------------------------------+
| Admin/operator machine                                              |
| Keep central/admin token here. Do not paste it into chats, room      |
| prompts, GitHub issues, edge setup instructions, or public demos.    |
+----------------------------------+----------------------------------+
                                   |
                                   | short-lived pair code only
                                   v
+----------------------------------+----------------------------------+
| Edge machine / local executor                                       |
| Redeems pair code once, stores scoped edge token locally, then polls |
| outbound. No public inbound port is required.                        |
|                                                                      |
|   edge token can: register, poll, send events, complete runs, read    |
|   discovery metadata. It cannot create pair codes, create rooms,      |
|   wake agents, revoke tokens, or call real model backends. With an    |
|   explicit Central policy, it can call agent:<id> virtual models.     |
+------------------+--------------------------+------------------------+
                   |                          |
                   v                          v
       +-----------------------+    +--------------------------+
       | Command adapter scope |    | Optional ping/model URL  |
       | runCommand executes  |    | pingUrl is reachability, |
       | as the edge OS user. |    | not an inference test.   |
       +-----------------------+    +--------------------------+
                   |
                   v
       +-----------------------+
       | Local files/tools/API |
       | keys available to the|
       | edge service user.   |
       +-----------------------+

Room exports are a separate sharing boundary:

full room messages/logs/private stderr  -> keep private
REPORT / BLACKBOARD summaries only      -> use room export --reports-only
```

## Token And Capability Matrix

| Credential or code | Where it belongs | What it can do | What it must not be used for |
| --- | --- | --- | --- |
| Central/admin token (`AGENT_BUS_TOKEN` or config `token`) | Admin/operator machine, gateway secret store, CI secrets for private deploys | Create pair codes, create threads/rooms, wake rooms, query status/nodes/agents, revoke edge tokens, call configured model-router endpoints | Do not paste into chats, room goals, edge setup messages, public issues, demo transcripts, or logs |
| Pair code | Short-lived message from admin operator to edge operator | Redeem once with `agent-bus setup edge --code ...` or `pair join` to obtain a scoped edge token | Do not treat it as a standing credential; keep TTL short and create a new code if it leaks |
| Scoped edge token | Edge config or local secret store on one edge machine | Register/poll outbound, receive tasks, send events/completions, read discovery metadata; optionally call `agent:<id>` virtual models when `modelRouter.allowEdgeAgentModels` is enabled | Cannot administer the gateway, create/wake rooms, create pair codes, revoke tokens, or call real model-router backends |
| Command adapter permissions | The OS user and workspace that run `runCommand` on the edge machine | Access local tools/files/network/API keys available to that account | Do not run broad shell adapters as privileged users; do not install configs from untrusted sources |
| Model-router backend keys | Gateway environment or backend-specific secret store | Let the central gateway call configured OpenAI-compatible backends | Do not put provider keys in room prompts, edge pair instructions, reports, or public demo artifacts |
| Reports-only export | Public-friendly artifact after review | Shares `REPORT` and useful summary text while omitting full room message history by default | Do not assume generated reports are automatically scrubbed; review before publishing |

## `/agents` Vs `/nodes`

Use the two views for different decisions:

- `agent-bus agents` and `GET /agents`: routable agent inventory. Stale node agents are intentionally removed from this view so new tasks are not sent to nodes that are no longer polling.
- `agent-bus nodes` and `GET /nodes`: registered node inventory. This is the operator view for fresh, stale, or offline edge machines and their last known agent membership.
- `agent-bus status`: combined view. It joins node freshness, agent activity, shallow ping reachability, and last-run health without turning `pingUrl` into a real model-call check.

## Safe Bootstrap Path

1. Install and verify without secrets: `npm install -g agent-bus-cli`, `agent-bus --help`, `agent-bus smoke --offline`.
2. Keep the admin token on the central/operator machine.
3. Create a short-lived pair code with `agent-bus pair create --ttl 600 ...`.
4. Redeem the code on the edge with `agent-bus setup edge --code ... --auto --out edge.config.json`.
5. Review `edge.config.json`, especially `runCommand`, `pingUrl`, `timeoutMs`, and the service user that will execute the adapter.
6. Start the edge with `agent-bus connect --config edge.config.json` or the generated service.
7. Verify with `agent-bus nodes`, `agent-bus status`, and then a low-risk fake/echo task before enabling powerful adapters.
8. Keep `modelRouter.allowEdgeAgentModels` disabled until you intentionally want edge-to-edge dispatch through `model: "agent:<id>"`.
9. Share only reviewed artifacts, preferably `agent-bus room export ROOM_ID --reports-only`.

## Adapter Execution Scope Checklist

Before enabling a command adapter, answer these questions:

- Which OS user runs the edge service, and what files can it read or write?
- Which environment variables and API keys are visible to `runCommand`?
- Is the workspace disposable or separated from private repos and home directories?
- Does the adapter need shell access, browser access, network access, or model-provider credentials?
- Is `pingUrl` a shallow reachability endpoint such as `/v1/models`, not a completion/inference endpoint?
- Is there a rollback plan: stop the service, revoke the edge token, rotate any local secrets the adapter could read?

Agent Bus records runs for auditability, but it is not a sandbox. The hard boundary is still your operating-system user, container, network policy, and secret-management setup.
