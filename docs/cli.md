# CLI

`agent-bus` is the portable command-line entrypoint for running Agent Bus as a local service, an edge node, or a query client.

Install from a checkout:

```bash
npm install -g .
agent-bus --help
```

Install from npm:

```bash
npm install -g agent-bus-cli
agent-bus --help
agent-bus smoke --offline
agent-bus demo room
agent-bus demo agent-model
agent-bus demo issue
```

`agent-bus demo room` is the fastest no-secret/no-model-call public demo: it starts temporary local services, wakes two fake room agents, and writes a reports-only Markdown export in the current directory. For a first two-machine setup, start with `docs/remote-assistant-quickstart.md`.

`agent-bus demo agent-model` is the fastest demo for the model-replacement path: it starts a temporary gateway plus command edge, exposes `agent:model-agent`, calls Chat Completions and Responses with one cache scope, and proves both calls reuse the same derived Agent Bus session key without contacting a model provider.

`agent-bus demo issue` is the local flagship demo skeleton: it starts planner/coder/reviewer fake agents, turns a GitHub-style issue into a room, and writes shareable report, event replay, patch, and PR draft artifacts without contacting GitHub or a model provider.

Maturity note: the demo proves the no-quota room workflow, agent handoff directives, reports-only export, event replay, patch artifact, and PR draft artifact. It does not yet prove live GitHub issue ingestion, branch creation, commits, opening a real PR, real model/tool execution, or maintainer approval flow.

Portable release bundles are published on GitHub Releases. Unpack one and run `./agent-bus --help` on Linux/macOS or `.\agent-bus.cmd --help` on Windows. Each release includes `SHA256SUMS` and a release manifest so users can verify what they downloaded. See `docs/release.md` for the npm-vs-portable install matrix and release verification checklist.

## JS/TS SDK

The npm package includes a zero-dependency ESM SDK for tools and demos that should call Agent Bus directly:

```js
import { AgentBusClient } from "agent-bus-cli/sdk/js/agent-bus-sdk.mjs";

const bus = new AgentBusClient({
  gatewayUrl: "https://YOUR-DOMAIN/agent-bus",
  token: process.env.AGENT_BUS_TOKEN
});

await bus.createRoom({
  title: "release check",
  goal: "Check the release and report blockers.",
  agents: ["hermes-hk", "openclaw-hk"],
  wakeAgents: ["hermes-hk", "openclaw-hk"]
});
```

See `sdk/js/README.md` for discovery, room, agent-backed model, and replay helpers.

## Remote Assistant Node

On any machine that should receive work:

```bash
agent-bus detect
agent-bus init edge --auto --out edge.config.json
```

`detect` looks for supported local tools:

- Codex: `codex`
- OpenClaw: `openclaw` or `OPENCLAW_AGENT_COMMAND`
- Hermes: `hermes`
- Claude Code: `claude`, exposed as the `claudecode` preset because it is a local CLI adapter, not an OpenAI-compatible backend
- Ollama: `ollama` plus the local `/api/tags` endpoint when available

If you want a specific preset instead of auto-detection:

```bash
agent-bus init edge --preset codex --out edge.config.json
```

For OpenClaw nodes, create an isolated Agent Bus OpenClaw agent/workspace once:

```bash
agent-bus openclaw prepare \
  --config ~/.openclaw/openclaw.json \
  --agent-id agent-bus \
  --workspace /opt/agent-bus/openclaw-workspace
```

Use `OPENCLAW_AGENT_ID=agent-bus ./scripts/openclaw-agent-bus.sh` for the OpenClaw `runCommand`. Set `OPENCLAW_BIN=/path/to/openclaw` when the executable is not on `PATH`. The prepare command writes minimal Agent Bus workspace files, marks the workspace setup complete, archives `BOOTSTRAP.md` in that target workspace if one exists, and seeds the dedicated agent with a stable Agent Bus system prompt, empty inherited skills list, and `cacheRetention: "long"` unless those fields were already customized.

For Codex nodes on Linux, prefer the bundled bridge script too:

```bash
CODEX_COMMAND=codex bash ./scripts/codex-agent-bus.sh
```

It reads `AGENT_MESSAGE_FILE` before falling back to `AGENT_MESSAGE`, which prevents long room turns from becoming empty Codex prompts.

For Hermes nodes on Linux, prefer the bundled bridge script when it is available:

```bash
HERMES_COMMAND=/root/.local/bin/hermes ./scripts/hermes-agent-bus.sh
```

The Hermes bridge reads `AGENT_MESSAGE_FILE`/`AGENT_MESSAGE` and sets Hermes' internal session id from `AGENT_SESSION_ID` without resuming old conversation history. It passes the file path into its Python bootstrap instead of exporting the whole prompt, so long room turns avoid OS environment-size limits. For OpenAI Responses-compatible gateways such as sub2api, that stable id becomes the `prompt_cache_key`, so repeated wakes in the same room or thread reuse the provider-side prefix cache more consistently. A first request for a new room, thread, or newly changed prompt prefix can still show `cache_read_tokens = 0`; that is a normal cache warm-up. Investigate only when subsequent turns in the same room/session keep returning zero cached tokens.

For Claude Code nodes on Linux, prefer the bundled bridge script:

```bash
CLAUDECODE_COMMAND=claude ./scripts/claudecode-agent-bus.sh
```

The Claude Code bridge uses `claude --print` as a command adapter. It reads `AGENT_MESSAGE_FILE` first, derives a UUID-shaped Claude session id from `AGENT_SESSION_ID`/`AGENT_CACHE_KEY`, and defaults to `--permission-mode acceptEdits` so noninteractive edge runs can modify files without using Claude Code's root-blocked `bypassPermissions` mode. Set `CLAUDECODE_CWD` when Claude Code should execute from a specific checkout, and set `CLAUDECODE_PERMISSION_MODE`, `CLAUDECODE_MODEL`, `CLAUDECODE_EFFORT`, or `CLAUDECODE_MAX_BUDGET_USD` in the edge service environment when you need a different policy or a specific Claude model. Because this is not an OpenAI-compatible backend, do not configure it under `modelRouter.backends`; register it as an edge agent with `kind: "claudecode"` or `agent-bus init edge --preset claudecode`.

Edit:

- `gatewayUrl`: central gateway URL
- `token`: scoped edge token from pairing, or an admin token for trusted manual deployments
- `pingUrl`: shallow model/service reachability URL
- `runCommand`: command that runs the local AI tool

Then connect:

```bash
agent-bus doctor --config edge.config.json
agent-bus connect --config edge.config.json
agent-bus status --config edge.config.json
```

The machine now polls the central gateway and can receive tasks. It does not need an inbound public port.

`agent-bus status --config edge.config.json` reuses `gatewayUrl` and `token` from the local config, so it is the fastest no-secret way to confirm that a new edge can see Central and that its agents are online. When that config only has an edge-scoped token, status still shows node and agent inventory but warns that room history and recovery details remain admin-only.

For the shortest first-run path, use `setup edge` to combine config creation, zero-quota doctor checks, and optional service template generation:

```bash
agent-bus setup edge \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --code ABCD-2345 \
  --auto \
  --service auto \
  --out edge.config.json
```

Without `--code`, pass `--token` or `AGENT_BUS_TOKEN` for a trusted manual config. `--service auto` chooses systemd on Linux, launchd on macOS, and Windows Service Control commands on Windows. It writes a template only; review and install it using your normal OS service workflow.

On the central/operator machine, use `setup central` to write a central config, generate an optional service template, and print the first edge join command plus an operator checklist:

```bash
agent-bus setup central \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --out central.config.json \
  --service auto
agent-bus serve --runtime python --config central.config.json
```

The command generates a long admin token plus one scoped edge token when `--token`/`AGENT_BUS_TOKEN` is not supplied. It prints both once, stores them in `central.config.json`, and prints a copy/paste command like:

```bash
agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --token abt_edge_... --auto --service auto --out edge.config.json
```

After the gateway is running, the Web Console at `/console/` can create additional scoped edge tokens and copy the same join command for another machine. Raw edge tokens are shown once; the token list keeps only metadata for later audit or revocation.

Use `--no-first-edge-token` if you prefer the stricter pair-code path only. Pair codes remain useful when the edge operator should never see or paste a standing token.

Use `setup telegram` on the Central host when you want the Telegram control bot path generated as an operator artifact instead of hand-copying environment variables:

```bash
agent-bus setup telegram \
  --gateway http://127.0.0.1:8788 \
  --bot-token 123456:telegram-bot-token \
  --chat-id 123456789 \
  --transport poller \
  --set-commands \
  --service auto \
  --out /etc/agent-bus/telegram.env
```

The command writes an env file with `AGENT_BUS_TELEGRAM_ENABLED`, control, conversation, bot token, chat id, webhook secret, gateway, and poller settings. With `--service auto`, it also writes a poller service template so local-only Centrals can receive Telegram updates without exposing a public webhook. Pass `--transport webhook` if you plan to configure Telegram's webhook directly instead.

Because Telegram control can queue real Agent Bus tasks, `setup telegram` requires `--chat-id` or `AGENT_BUS_TELEGRAM_CHAT_ID` by default. Use `--allow-unrestricted-control` only for isolated local tests.

Run a zero-quota offline smoke test:

```bash
agent-bus smoke --offline
```

This starts a temporary local Python gateway and edge node, creates a room, runs a fake command agent, and verifies `REPORT`, `BLACKBOARD`, and `DONE` directive handling without calling any model provider. Python 3.10+ is required for this command while room support lives in the Python gateway.

Check gateway and room visibility with status:

```bash
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ***
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token *** --json
agent-bus status --config edge.config.json
```

Human output includes a `Readiness` line and `Next actions` list before the detailed inventory, then operator labels for node freshness (`online/fresh`, `stale`, or `unknown`), node agent membership from the authenticated `/nodes` inventory, agent activity (`running`, `queued`, `busy/room-active`, or `idle`), ping reachability (`reachable`, `unreachable`, `unhealthy`, `not configured`, or `unknown`), and last-run health (`ok`, `failed`, `running`, or `unknown`). Unlike `/agents`, which lists currently usable agents, `/nodes` and the status Nodes section keep registered nodes visible after they become stale so operators can tell "known but offline/stale" apart from "never registered". By default, status hydrates up to 25 active room details concurrently so an agent is marked `running` or `queued` only when it has live non-terminal room work; pass `--room-detail-limit N` to tune the detail count, `--room-detail-concurrency N` to tune parallel detail requests, or `--no-room-details` for the older lightweight summary-only behavior. When active-room detail coverage is skipped, truncated by the limit, or partially fails, status now emits an explicit warning plus a follow-up action because busy/stale queued analysis is only as complete as the hydrated room set. JSON output includes `status_meta.room_details` with `coverage`, `active_total`, `requested`, `hydrated`, `failed`, `omitted`, and `skipped` so scripts can see whether room analysis was full, partial, skipped, or not needed. All gateway CLI calls accept `--gateway-timeout-ms N` or `AGENT_BUS_GATEWAY_TIMEOUT_MS` when testing slow or filtered Central URLs; failures include a Central reachability hint instead of a raw fetch error. Old queued room snapshots are treated as stale/orphan candidates after 21600 seconds by default: they are labeled as `stale_queued_runs` in JSON/human output, surfaced in `recovery_hints` with copyable `room inspect`, guarded `room recover --yes`, and explicit `room pause` commands, and ignored for `busy_agents` and agent `activity` so an empty gateway queue is not confused with live queued work. Tune that adoption/ops threshold with `--queued-run-stale-seconds N` or `AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS`; when you tune it, status includes the same threshold flag in copyable inspect/recover commands so a follow-up command evaluates the same window. Running room runs are not marked stale by this threshold. The CLI labels nodes stale after 180 seconds by default; pass `--stale-seconds N` or set `AGENT_BUS_STATUS_STALE_SECONDS` to match a test gateway or custom heartbeat policy. JSON output preserves the raw fields and also includes derived `readiness`, `next_actions`, node `freshness`, agent `freshness`, `activity`, `active_runs`, `stale_queued_runs`, `current_run`, `ping_label`, `last_run_health`, and `recovery_hints` fields.

For other read-only gateway queries such as `agent-bus agents`, `agent-bus nodes`, or `agent-bus manifest`, pass `--config edge.config.json` to reuse the same local gateway/token settings instead of retyping them.

Edge commands receive task metadata in environment variables:

- `AGENT_MESSAGE`
- `AGENT_MESSAGE_FILE`
- `AGENT_MESSAGE_BYTES`
- `AGENT_RUN_ID`
- `AGENT_THREAD_ID`
- `AGENT_ROOM_ID`
- `AGENT_WAKE_REASON`
- `AGENT_CACHE_SCOPE`
- `AGENT_CACHE_KEY`
- `AGENT_SESSION_ID`
- `AGENT_ID`
- `EDGE_NODE_ID`
- `EDGE_SESSION_ID`

`AGENT_CACHE_KEY` and `AGENT_SESSION_ID` are stable for the same agent inside the same room or thread, which lets adapters such as OpenClaw pass a durable session id to model gateways that support prompt caching. For direct `agent:<id>` model calls, pass `prompt_cache_key`, `metadata.agent_bus_cache_scope`, or `agent_bus.cache_scope` when separate requests should share a cache/session scope; otherwise each one-off request uses its generated thread id.

Adapters should prefer `AGENT_MESSAGE_FILE` when it is set. Very large tasks may leave `AGENT_MESSAGE` empty so the edge process can avoid OS environment-size limits.

## Pairing

Pairing is the faster onboarding path for a new remote assistant node. The central/admin side creates a short one-time code:

```bash
agent-bus pair create \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ... \
  --preset codex \
  --ttl 600
```

On the new machine, redeem the code into a local edge config:

```bash
agent-bus pair join \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --code ABCD-2345 \
  --out edge.config.json \
  --auto
```

Then run:

```bash
agent-bus doctor --config edge.config.json
agent-bus connect --config edge.config.json
```

For offline troubleshooting before Central is reachable, run `agent-bus doctor --config edge.config.json --local-only`; it still validates the local config and adapter probes, skips gateway checks, and prints a final `Doctor: OK|WARN|FAIL pass=N warn=N fail=N` summary line.

The join command writes the gateway URL and a scoped edge token into the local config file, but it does not print the token. Codes are single-use and expire automatically. With `--auto`, it also detects local AI tools and registers each one as an agent.

The scoped edge token can register, poll, report run events, and read discovery metadata. It cannot create pair codes, create threads, wake rooms, or call real OpenAI-compatible model backends. If Central has `modelRouter.allowEdgeAgentModels` enabled, an edge token can call only `agent:<agent-id>` virtual models through `/v1/chat/completions` or `/v1/responses` so one edge can dispatch work to another edge through Central.

## Central Gateway

```bash
agent-bus init central --out central.config.json
agent-bus serve --config central.config.json
```

Edit the generated config to set:

- a long random `token`
- optional `edgeTokens` for pre-provisioned edge nodes; pairing usually creates these automatically and stores token hashes under the gateway data directory
- model router `baseUrl`
- model router API key environment variable
- model aliases exposed to clients
- whether online agents should appear as virtual `agent:<agent-id>` models
- whether scoped edge tokens may call those agent-backed models

The admin API can list, create, and revoke scoped edge tokens with `GET /edge/tokens`, `POST /edge/tokens`, and `POST /edge/tokens/revoke`.

## Central Plugins

Central supports optional notification plugins under `plugins` in `central.config.json`. The first plugin is `telegramBot`:

```json
{
  "plugins": {
    "telegramBot": {
      "enabled": true,
      "botTokenEnv": "AGENT_BUS_TELEGRAM_BOT_TOKEN",
      "chatIdEnv": "AGENT_BUS_TELEGRAM_CHAT_ID",
      "events": ["central.started", "edge.registered", "run.completed", "run.failed", "room.completed", "telegram.test", "telegram.command"],
      "control": {
        "enabled": false,
        "secretTokenEnv": "AGENT_BUS_TELEGRAM_WEBHOOK_SECRET",
        "allowedChatIds": [],
        "allowRun": true,
        "conversation": {
          "enabled": false,
          "agentId": "",
          "agents": [],
          "mode": "orchestrate"
        }
      }
    }
  }
}
```

Keep the bot token in the central service environment, not in room prompts or edge configs. Use `dryRun: true`, `npm run plugin:telegram:smoke -- --json`, or the admin CLI self-test to verify notification routing without contacting Telegram:

```bash
agent-bus plugin status --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
agent-bus plugin telegram test \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ADMIN_TOKEN \
  --message "Agent Bus is wired to Telegram" \
  --dry-run
```

Telegram control is intentionally disabled by default. After setting `control.enabled: true`, register Telegram's webhook URL as `https://YOUR-DOMAIN/agent-bus/v1/agent-bus/plugins/telegram/webhook` and set `AGENT_BUS_TELEGRAM_WEBHOOK_SECRET` as Telegram's secret token. Register the native Telegram slash-command menu so typing `/` shows the available Agent Bus commands:

```bash
AGENT_BUS_TELEGRAM_BOT_TOKEN=... agent-bus plugin telegram commands set
agent-bus plugin telegram commands list
agent-bus plugin telegram commands delete
```

Run the Telegram-specific doctor when the bot appears connected but buttons, command suggestions, or poller/webhook delivery are suspect:

```bash
agent-bus plugin telegram doctor \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ADMIN_TOKEN \
  --bot-token 123456:telegram-bot-token \
  --chat-id 123456789 \
  --transport poller
```

The doctor checks Central plugin wiring, local env presence, a diagnostic dry-run POST to Central's Telegram webhook, Telegram `getMe`, installed slash commands, webhook status, and pending updates. It does not call any model provider. The local webhook probe uses `X-Agent-Bus-Telegram-Dry-Run: true` so current Centrals validate the secret, chat allowlist, command handler, and reply buttons without sending a live Telegram message. Use `--local-only` to skip Telegram Bot API calls, `--no-webhook-probe` to skip the Central webhook probe, `--transport poller` when a local poller should own updates, or `--transport webhook` when Telegram should deliver directly to the Central webhook URL.

The registered command menu includes:

```text
/start
/help
/status
/agents
/new
/resume
/agent
/rooms
/room
/run agent-id task
```

Telegram buttons are contextual instead of being attached to every reply. `/status` and `/help` show a compact menu, `/new`, `/agents`, and `/agent` show multi-select agent buttons for the active process, `/resume` shows process/thread buttons, and `/rooms` shows room buttons. `/room new` starts a room draft with multi-select agent buttons plus step presets; send the room goal as the next plain message, or use `/room start <goal>`, to create the room. Telegram callback queries go through the same webhook handler as typed commands; dry-run mode records the `reply_markup` in `notifications.jsonl` so deployments can test the UX without contacting Telegram.

Set `control.conversation.enabled: true` or `AGENT_BUS_TELEGRAM_CONVERSATION_ENABLED=true` when plain Telegram messages should behave like a chat with Agent Bus. Use `control.conversation.agentId`, `control.conversation.agents`, `AGENT_BUS_TELEGRAM_CONVERSATION_AGENT`, or `AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS` to pin the chat to Hermes, OpenClaw, Codex, or another agent; otherwise Central uses normal Agent Bus routing.

Telegram conversation mode is process-oriented. A chat keeps one active Agent Bus thread and appends new runs to it until the operator starts a new process:

```text
/new
/new investigate the deployment failure
/resume
/resume deployment failure
/agent
/agent hermes-hk
/agent add openclaw-hk
/agent toggle openclaw-hk
/agent clear
@codex-120 review the latest code path
```

Room creation is separate from the active Telegram process/thread. Use `/room new`, choose participants with the room agent buttons, choose autonomous steps with the step buttons or `/room steps 12`, then send the goal:

```text
/room new
/room agent toggle hermes-hk
/room agent toggle openclaw-hk
/room steps 10
/room start investigate the onboarding bug and report a fix plan
```

The first plain message names the process, `/resume` lists or switches prior Telegram processes, `/agent` sets or adds process agents, and a leading `@agent-id` targets that message while adding the agent to the active process. Agent replies are prefixed with `[agent-id]` so multi-agent Telegram replies stay attributable.

Conversation prompts are compacted before dispatch so long Telegram threads do not explode every selected agent's context window. Tune `AGENT_BUS_TELEGRAM_PROMPT_MAX_BYTES`, `AGENT_BUS_TELEGRAM_PROMPT_MESSAGE_COUNT`, `AGENT_BUS_TELEGRAM_PROMPT_MESSAGE_CHARS`, and `AGENT_BUS_TELEGRAM_PROMPT_LATEST_CHARS` if a central needs more or less retained context.

When Telegram cannot reach the public webhook because the Central is local-only, behind NAT, or protected by a WAF such as Cloudflare, run the polling bridge on the Central host instead:

```bash
AGENT_BUS_TELEGRAM_BOT_TOKEN=... \
AGENT_BUS_TELEGRAM_WEBHOOK_SECRET=... \
agent-bus plugin telegram poll \
  --gateway http://127.0.0.1:8788 \
  --delete-webhook \
  --set-commands \
  --offset-file /var/lib/agent-bus/telegram-poller.offset
```

The poller calls Telegram `getUpdates`, asks for `message`, `edited_message`, and `callback_query` updates, forwards each update into the same local `/v1/agent-bus/plugins/telegram/webhook` handler, and stores the next update offset so it can run under systemd without reprocessing old messages. Pass `--set-commands` or set `AGENT_BUS_TELEGRAM_SET_COMMANDS=true` to refresh the `/` command menu whenever the poller starts.

Keep `allowedChatIds` or `AGENT_BUS_TELEGRAM_CHAT_ID` scoped to operator chats, because `/run` and conversation mode queue real Agent Bus tasks for edge machines.

Agent-backed model replacement uses the same OpenAI-compatible endpoint:

```bash
curl -s https://YOUR-DOMAIN/agent-bus/v1/chat/completions \
  -H "authorization: Bearer $AGENT_BUS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"agent:openclaw-hk","messages":[{"role":"user","content":"Run a quick status check and report back."}]}'

curl -s https://YOUR-DOMAIN/agent-bus/v1/responses \
  -H "authorization: Bearer $AGENT_BUS_TOKEN" \
  -H "content-type: application/json" \
  -d '{"model":"agent:hermes-hk","input":"Check the room state and return the next action."}'
```

Central creates a normal Agent Bus run for the target edge agent and returns the completed stdout as an OpenAI-style assistant message or Responses `output_text`.

## Query Commands

```bash
agent-bus well-known --gateway https://YOUR-DOMAIN/agent-bus
agent-bus manifest --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus nodes --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus agents --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus health --gateway https://YOUR-DOMAIN/agent-bus
```

You can also use environment variables:

```bash
export AGENT_BUS_GATEWAY_URL=https://YOUR-DOMAIN/agent-bus
export AGENT_BUS_TOKEN=...
agent-bus agents
```

## Rooms

Rooms are durable AI-to-AI workspaces. Use them to wake several agents, keep a shared blackboard, and export the transcript for demos or debugging.

```bash
agent-bus room create \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --token ... \
  --title release-check \
  --goal "Inspect the release and report blockers." \
  --agents codex-120,hermes-hk,openclaw-hk \
  --wake-agents codex-120,hermes-hk,openclaw-hk

agent-bus room show room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room memory room_xxx --query "cache decision" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room expand room_xxx 'messages[7]' --around 1 --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room health room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room health room_xxx --json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room inspect room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room inspect room_xxx --json --stale-seconds 180 --queued-run-stale-seconds 3600 --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room retry-failed room_xxx --yes --reason "retry failed upstream agent" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room recover room_xxx --yes --reason "old orphan queued run recovery" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room resolve-duplicates room_xxx --yes --reason "cancel duplicate queued work" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room pause room_xxx --reason "operator pause" --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format markdown --out room.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --reports-only --out room-summary.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format json --out room.json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format json --no-redact --out room-private.json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room export room_xxx --format events --out room-events.json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus room replay --in room-events.json --format markdown
agent-bus trace show trace_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus trace export trace_xxx --format markdown --out trace.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
```

Room exports include the room goal, reports, blackboard notes, runs, and messages. Add `--reports-only` to omit the room goal, full messages, and run output for public demos or issue summaries. Gateway responses are already redacted, and the CLI adds another pass over common token-like strings by default. Use `--no-redact` only to disable that extra client-side pass for private archives, and review any export before sharing it for private prompts, logs, domains, and internal machine names.

`--format events` writes a room event bundle (`agent_bus.room_event_bundle`) derived from the room snapshot. Events include contiguous `sequence` numbers and the bundle includes `export_metadata` with source, generated time, reports-only mode, event count, and sequence range. It is designed for durable demos, bug reports, and SDK compatibility fixtures: `agent-bus room replay --in room-events.json` can rebuild a deterministic summary without contacting a gateway or model provider.

`agent-bus room memory ROOM_ID` prints the local compressed memory index for a long-running room: source count, keywords, table-of-contents entries, and a few relevant snippets. Pass `--query "..."` to rank the prompt-facing view around a topic, `--preview` to include short previews under each directory entry, or `--json` for automation. Use `agent-bus room expand ROOM_ID 'messages[7]' --around 1` to fetch the exact source item plus neighboring room history when an index entry needs more context.

Use `agent-bus room health ROOM_ID` for the first operator view of a live or overnight room. It combines the room snapshot and `/nodes` inventory into per-agent status, latest run id, edge session, lease state, attempt number, failure class, retryability, duplicate active runs, REPORT/DONE contract state, last wake reason, stale state, recovery actions, and safe operator hints. Add `--json` when a monitoring script or Telegram control surface should consume the same object. Runs also carry the same structured attempt ledger in `attempt`/`attempts` and the gateway appends lifecycle snapshots to `run_attempts.jsonl`, so scripts can tell an upstream transient error from auth/config failure without parsing raw stderr.

Use `agent-bus room inspect ROOM_ID` before recovering a stale/orphan room. It reads the room plus the authenticated `/nodes` inventory, then separates live running runs, live queued runs, stale queued runs, and running runs whose node is stale or missing. Human and JSON output include attempt/failure metadata when present. `--json` returns the same `analysis.summary`, counts, run buckets, recommendations, and top-level `operator_hints` for scripts or runbooks. When you pass a tuned `--queued-run-stale-seconds`, inspect and recover dry-run hints carry that threshold into copyable recovery commands.

`agent-bus room retry-failed ROOM_ID` is a dry run by default. Add `--yes` to re-open the room and wake only failed online agents with the latest failure context. It does not retry queued/running agents, agents whose latest run already completed, or agents that are currently offline/unknown. If the original room hit `max_steps`, the retry command expands that room's step budget just enough for the confirmed retry runs.

`agent-bus room recover ROOM_ID` is a dry run by default; add `--yes` to apply the guarded recovery action only when inspect found stale queued orphan runs: pause the old room and cancel queued runs in that room. If inspect does not find stale queued runs, `room recover --yes` refuses to pause the room unless you add `--force` after separately verifying that an intentional operator pause is safe. `agent-bus room pause ROOM_ID --reason "..."` remains the direct operator stop. Pause/recover preserves the transcript, reports, blackboard, and run history; stops future manual wakes and auto-rotation; cancels queued runs in that room; and removes those queued tasks from the gateway queue. It does not kill already-running OS processes or delete snapshots, so let running work finish or handle it outside Agent Bus before sharing an export. If work should continue, export the paused room and create a fresh follow-up room with the still-relevant goal/context.

`agent-bus room resolve-duplicates ROOM_ID` is also a dry run by default. Add `--yes` to cancel only duplicate queued runs for agents that have multiple active runs in the same room. It keeps running processes untouched; when every duplicate is queued, it keeps the oldest queued run and cancels the later queued duplicates.

`agent-bus room supervisor ROOM_ID` includes that duplicate-run inspection. With `--yes`, it will choose the safe duplicate queued-run cleanup before considering heavier stale queued-room recovery.

## Traces

```bash
agent-bus trace show trace_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus trace show trace_xxx --json --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus trace export trace_xxx --format markdown --out trace.md --gateway https://YOUR-DOMAIN/agent-bus --token ...
```

Trace ids connect rooms, direct threads, agent-backed Chat Completions/Responses, runs, edge events, and agent process environments. Clients can set one with `trace_id`, `traceId`, `metadata.agent_bus_trace_id`, `agent_bus.trace_id`, or the `x-agent-bus-trace-id` header. If omitted, the gateway creates a `trace_...` id for new work.

Edge command adapters receive `AGENT_TRACE_ID`. Events and completion reports include the same id, so `agent-bus trace show` can answer what ran, which agent handled it, which node executed it, and which room or thread it belonged to.

## Local Probe

```bash
agent-bus probe --config edge.config.json
```

This runs the edge health checks locally. URL ping checks do not run model inference.

## Doctor

```bash
agent-bus doctor --config edge.config.json
agent-bus doctor --config edge.config.json --json
agent-bus doctor --mode central --config central.config.json --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
agent-bus doctor --mode central --production --config central.config.json --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
agent-bus doctor --config edge.config.json --bundle diagnostics.json
agent-bus diagnostics bundle --config edge.config.json --out diagnostics.json
```

Use `--json` for automation/CI. It prints `{ ok, counts, checks }` and keeps the same exit-code behavior as the human output.

Doctor is intentionally shallow and quota-safe: URL pings use cheap reachability checks, gateway checks are read-only, and it does not create rooms, start runs, or call chat/completions or responses.

`doctor` checks:

- Node.js runtime
- config file readability
- central mode preflight for admin token strength, persistent `dataDir` writability, static and runtime scoped edge token state, model-router backend setup, Telegram plugin environment wiring, and Central readiness endpoints
- local tool availability for command adapters
- missing or placeholder gateway URL
- malformed gateway URL
- missing or placeholder token
- declared token scope (`edge` or `admin`)
- enabled agents
- duplicate agent ids
- unsupported adapters
- missing command adapters
- missing command working directories
- relative command/bridge script resolution against `agent.cwd`, `config.cwd`, or the current launch directory
- ping URL placeholders
- gateway well-known endpoint
- gateway public health endpoint
- authenticated manifest, when a token is configured
- authenticated `/agents` discovery and whether configured agents are online
- authenticated `/nodes` discovery and whether the configured node is registered
- authenticated `/v1/models` discovery without model inference
- authenticated `/rooms` listing without creating a room
- local edge health probe

It exits non-zero only on hard failures. Warnings are meant to guide setup without blocking local experimentation. For example, `/rooms` may warn with an edge token because room listing is an operator/admin endpoint, while `/v1/models` may warn with an edge token unless the gateway has edge agent models enabled. In central mode, placeholder admin tokens, unwritable data directories, malformed ports, duplicate static edge tokens, and invalid backend URLs are hard failures; missing backend key environment variables or Telegram allowlists are warnings. Empty `edgeTokens` in `central.config.json` is healthy when edges were created through pair codes, the Web Console, or the runtime edge-token registry. Add `--production` to fail on short admin tokens, missing live edge connectivity, missing active runtime edge tokens, and incomplete enabled Telegram control wiring.

When a command adapter uses a bundled or local script such as `./scripts/codex-agent-bus.sh`, doctor now checks that path using the same cwd rules as the edge runtime. A pinned `config.cwd` or `agent.cwd` plus a missing script is a hard failure; an unpinned relative path is a warning because it depends on the process launch directory. Pin the cwd in config or generate/start the service with `--cwd` pointing at the repo or portable bundle root that contains the script.

`diagnostics bundle` writes a redacted support artifact for GitHub issues or maintainer triage. By default it redacts bearer tokens, provider keys, scoped edge tokens, hostnames, and private paths. Use `--include-hosts` or `--include-paths` only in private support channels where those details are safe to share.

## Docker

Run a central gateway in a container:

```bash
cp .env.example .env
# replace AGENT_BUS_TOKEN in .env before continuing
agent-bus init central --out central.config.json
docker compose config >/tmp/agent-bus-compose.rendered.yaml
docker compose run --rm --no-deps agent-bus-central --help
docker compose up -d --build
```

The Compose service runs the full Python central gateway by default and stores central data in the `agent-bus-data` Docker volume. The checked-in stack intentionally does not include a database container; JSONL plus redacted snapshots are the first deployment path. `docker compose config` is the fail-fast preflight for missing tokens or mounts, and `docker compose run --rm --no-deps agent-bus-central --help` is a no-model smoke that proves the container entrypoint boots.

The image still uses the same CLI entrypoint:

```bash
docker run --rm agent-bus:local --help
```

## Services

Generate a Linux systemd unit:

```bash
agent-bus service systemd \
  --mode edge \
  --config /opt/agent-bus/edge.config.json \
  --cwd /opt/agent-bus \
  --agent-bus-path /usr/bin/agent-bus \
  --gateway https://YOUR-DOMAIN/agent-bus \
  --out agent-bus-edge.service
```

Generate a macOS launchd plist:

```bash
agent-bus service launchd \
  --mode edge \
  --config /opt/agent-bus/edge.config.json \
  --cwd /opt/agent-bus \
  --agent-bus-path /usr/local/bin/agent-bus \
  --out com.agent-bus.edge.plist
```

Generate Windows Service Control commands:

```powershell
agent-bus service windows --mode edge --config C:\agent-bus\edge.config.json --cwd C:\agent-bus --agent-bus-path C:\agent-bus\agent-bus.exe
```

The generated templates do not print or store your bearer token. Put `AGENT_BUS_TOKEN` in an environment file, system secret store, service account environment, or another deployment-specific secret mechanism.

## Cross-Platform Packaging

The current CLI runs anywhere Node.js 20+ runs:

- Windows
- Linux and Ubuntu
- macOS Intel
- macOS Apple Silicon

Verify and build a portable release locally:

```bash
npm run portable:check
npm run bundle -- --archive
```

`portable:check` builds into a temporary directory, verifies the manifest/checksums, rejects private/build paths, extracts the tarball, and runs the bundled launcher without model calls.

A release build writes:

- `dist/agent-bus-vX.Y.Z-portable/`
- `dist/agent-bus-vX.Y.Z-portable.tar.gz`
- `dist/agent-bus-vX.Y.Z-portable.zip`
- `dist/agent-bus-vX.Y.Z-portable.manifest.json`
- `dist/SHA256SUMS`

For a future standalone binary, package `agent-bus.mjs` together with:

- `central-gateway.mjs`
- `edge-node.mjs`
- `package.json`
- optional `console/` assets for the web console

The CLI is intentionally dependency-free so it can be wrapped by tools such as Node SEA, pkg-style packagers, app installers, Docker images, or OS service managers.

Target product shape:

```text
download agent-bus
agent-bus init edge
edit model URL/key and agent command
agent-bus connect
```

At that point the machine becomes an addressable remote assistant node.
