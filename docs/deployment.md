# Deployment

## Central Gateway

### Storage Decision

Agent Bus does not require a database for the first central station. The central gateway is intentionally a single-writer service that stores:

- append-only JSONL audit streams such as `runs.jsonl`, `events.jsonl`, `rooms.jsonl`, and `edge_tokens.jsonl`
- redacted JSON snapshots under `threads/`, `runs/`, and `rooms/`

For a self-hosted central gateway, this is simpler and easier to back up than introducing a database on day one. Use a persistent disk or Docker volume for `AGENT_BUS_DATA_DIR`, back it up regularly, and run only one central gateway process against that directory.

Add a database later when one of these is true:

- you need multiple central gateway replicas writing at the same time
- trace and room queries become too large for file scans
- you need SQL reports, retention policies, or high-volume audit exports
- you need hosted multi-tenant isolation and operational tooling

Recommended path:

1. Now: JSONL + snapshots on a persistent volume.
2. Next: optional SQLite index for traces, rooms, and runs while keeping JSONL as the audit log.
3. Later: Postgres for multi-instance or hosted deployments.

On startup, the Python central gateway rebuilds its in-memory view from the persistent data directory:

- latest node inventory from `nodes.jsonl`
- `threads/`, `rooms/`, and `runs/` snapshots
- scheduled room reminders stored inside room snapshots
- queued runs that had not yet been delivered to an edge node

Only runs still marked `queued` are placed back onto node queues. Runs already marked `running` are kept visible for status, room detail, and trace inspection but are not replayed automatically, which avoids duplicate command execution after a central restart. Operators should inspect or pause old rooms whose running tasks no longer have a live edge process.

Operational recovery checklist for stale/orphan room runs:

1. Check `agent-bus status --gateway ... --token ...` and look for `stale_queued_runs` or stale nodes.
2. Inspect the specific room with `agent-bus room inspect ROOM_ID --gateway ... --token ...`; lower `--queued-run-stale-seconds` or `--stale-seconds` only for tests or confirmed incidents. Inspect separates live running work, live queued work, stale queued snapshots, and running tasks attached to stale or missing nodes.
3. If the gateway queue is empty and the room only has old queued snapshots, run `agent-bus room recover ROOM_ID --yes --reason "stale queued run recovery"`. This pauses the room and cancels queued runs without deleting history. `room recover --yes` now refuses when inspect does not find stale queued orphan runs; use `room pause` for a deliberate operator stop, or `room recover --yes --force` only after separately confirming no live agent process should continue.
4. If any run is actually running, first verify the edge OS process or let it finish; room recovery does not kill local agent processes.
5. Export the paused room and create a new follow-up room if work should continue.

### Container Deployment

For a public central station, prefer Docker Compose plus a reverse proxy. The bundled container now runs the full Python central gateway by default, because that runtime includes rooms, reminders, traces, pairing, and agent-backed models.

```bash
cp .env.example .env
# Replace AGENT_BUS_TOKEN in .env with a long random secret before continuing.
agent-bus init central --out central.config.json
docker compose config >/tmp/agent-bus-compose.rendered.yaml
docker compose run --rm --no-deps agent-bus-central --help
# Edit central.config.json before exposing the service.
docker compose up -d --build
docker compose logs -f agent-bus-central
```

Important settings:

- Put a long random `AGENT_BUS_TOKEN` in `.env`.
- The default Compose stack intentionally has no database service; keep the `agent-bus-data` volume on persistent storage instead.
- Keep `AGENT_BUS_DATA_DIR=/data/central` in the container.
- Mount `/data` as a persistent volume.
- Put HTTPS in front of port `8788`; do not expose plain HTTP directly to the public internet.
- Back up the `agent-bus-data` volume.

Preflight notes:

- `docker compose config` fails fast when `AGENT_BUS_TOKEN` is unset or the checked-in mounts/config cannot render cleanly.
- `docker compose run --rm --no-deps agent-bus-central --help` is a cheap smoke that exercises the image entrypoint and bundled Python runtime without calling a model provider.

Useful container checks:

```bash
docker compose ps
docker compose exec agent-bus-central node /app/agent-bus.mjs health --gateway http://127.0.0.1:8788
docker compose exec agent-bus-central sh -lc 'find /data/central -maxdepth 2 -type f | sort | head'
```

Backup example:

```bash
docker run --rm \
  -v YOUR_COMPOSE_PROJECT_agent-bus-data:/data:ro \
  -v "$PWD/backups:/backup" \
  alpine sh -lc 'tar czf /backup/agent-bus-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .'
```

Use `docker volume ls | grep agent-bus-data` to find the exact volume name. Restore by stopping the gateway, extracting the backup into the volume, and starting the gateway again.

### Local Process Deployment

Run the gateway behind HTTPS:

```bash
AGENT_BUS_TOKEN="$(openssl rand -base64 32)" \
AGENT_BUS_HOST=127.0.0.1 \
AGENT_BUS_PORT=8788 \
AGENT_BUS_DATA_DIR=./data/central \
node central-gateway.mjs serve
```

Use `central_gateway.py` instead on machines without Node.js:

```bash
AGENT_BUS_TOKEN="$(openssl rand -base64 32)" \
AGENT_BUS_HOST=127.0.0.1 \
AGENT_BUS_PORT=8788 \
python3 central_gateway.py
```

The Node gateway is still available for lightweight direct-thread deployments:

```bash
agent-bus serve --runtime node --config central.config.json
```

For full AI-to-AI rooms and traces, use the Python runtime:

```bash
agent-bus serve --runtime python --config central.config.json
```


### Live Update Checklist

For live deployments, roll changes out from central to edges in small reversible steps that avoid secrets and model quota:

1. Pull the public repo on the target host and review `git log --oneline -1` plus `git diff` before restart.
2. Run a zero-quota check first: `agent-bus --help`, `agent-bus health --gateway http://127.0.0.1:8788`, or targeted smokes such as `npm run smoke:room-stale` and `node scripts/central-restart-smoke.mjs --json` on a non-production checkout.
3. Check live room and node state before touching services: `agent-bus status --gateway ... --token ...`, then `agent-bus room inspect ROOM_ID --gateway ... --token ...` for any room flagged with stale queued work or unexpectedly old running work.
4. Restart the central Python service before edge bridge scripts when the change affects room prompts, queue recovery, trace lookup, or model routing. With systemd, use `systemctl restart agent-bus-central` and then check `journalctl -u agent-bus-central -n 100 --no-pager` plus `/health`.
5. Restart edge services one node at a time when bridge scripts or edge config changed. Confirm each node reappears in `agent-bus status` before moving to the next node.
6. For config-only changes, prefer adding new keys while keeping old keys valid until all edges have restarted. Do not rotate tokens and bridge commands in the same step; verify the new token or command with `agent-bus doctor --config edge.config.json` first.
7. Keep secrets out of reports and commits: share service names, commit ids, room ids, and redacted command shapes rather than raw tokens, full private URLs, or model-provider quota details.

Use this impact matrix when deciding what to restart:

| Changed files/settings | Restart | Verify |
| --- | --- | --- |
| `central_gateway.py`, `central.config.json`, central environment variables | Central Python service | `/health`, `agent-bus status`, and room/trace command affected by the change |
| `edge-node.mjs`, `edge.config.json`, `pollTimeoutMs`, `defaultTimeoutMs`, agent `runCommand` | Affected edge node service | `agent-bus doctor --config edge.config.json`, then `agent-bus status` from an admin machine |
| `scripts/codex-agent-bus.sh`, `scripts/openclaw-agent-bus.sh`, `scripts/hermes-agent-bus.sh` | Every edge whose `runCommand` references that script | A one-line no-secret room wake or a local command dry run with fake `AGENT_MESSAGE_FILE` |
| `agent-bus.mjs` operator CLI only | Operator shells/installations using the CLI | `agent-bus --help` plus the specific read-only command, for example `agent-bus room inspect ...` |
| Docs/examples only | No service restart | Link/render review or the relevant no-quota smoke when examples changed |

Central service changes usually require only a central restart. Edge bridge script changes require each edge node to pull the repo and restart its edge service because `runCommand` invokes local scripts from that checkout. If `runCommand` uses an absolute script path, update that deployed file or repoint the config before restarting; pulling the repo alone is not enough.

## Edge Node

Preferred path: create a pairing code from the central/admin machine, then redeem it on the new edge node:

```bash
agent-bus pair create --gateway https://YOUR-GATEWAY-DOMAIN/agent-bus --token ... --preset codex
agent-bus pair join --gateway https://YOUR-GATEWAY-DOMAIN/agent-bus --code ABCD-2345 --out edge.config.json
```

Pairing writes a scoped edge token into `edge.config.json`. That token is enough for the node to register, poll, report run events, and read discovery metadata, but it cannot create pair codes, create threads, wake rooms, or call the model router.

For the shortest trusted bootstrap, `agent-bus setup central --gateway ...` now generates one first scoped edge token and prints a direct edge command:

```bash
agent-bus setup edge --gateway https://YOUR-GATEWAY-DOMAIN/agent-bus --token abt_edge_... --auto --service auto --out edge.config.json
```

Use this only when the same operator controls both machines or a private deployment channel. Use pair codes when you want short-lived one-time onboarding instead of a standing token.

Manual path: copy an edge config, set the gateway URL and an edge/admin token, then run:

```bash
AGENT_BUS_GATEWAY_URL="https://YOUR-GATEWAY-DOMAIN/agent-bus" \
AGENT_BUS_TOKEN="..." \
node edge-node.mjs connect --config edge.config.json
```

For least privilege, use pairing or pre-provision a token hash in `edgeTokens` instead of sharing the admin token with every edge node.

Admin token management endpoints:

- `GET /edge/tokens`: list edge token metadata without raw tokens or hashes.
- `POST /edge/tokens`: create a scoped edge token and return the raw token once.
- `POST /edge/tokens/revoke`: revoke an edge token by id.

Use `edge_node.py` on machines without Node.js.

For OpenClaw edge nodes, keep Agent Bus traffic in a dedicated OpenClaw agent/workspace:

```bash
agent-bus openclaw prepare \
  --config ~/.openclaw/openclaw.json \
  --agent-id agent-bus \
  --workspace /root/agent-bus/openclaw-workspace
```

Set the edge `runCommand` to:

```bash
OPENCLAW_AGENT_ID=agent-bus ./scripts/openclaw-agent-bus.sh
```

This avoids default-workspace `BOOTSTRAP.md` and persona files from affecting room replies while preserving stable `AGENT_SESSION_ID` cache keys. The prepared agent also gets a stable Agent Bus system prompt, `skills: []`, and `params.cacheRetention: "long"` unless those fields already exist.

Add a shallow `pingUrl` when an agent depends on a model gateway or local service:

```json
{
  "id": "openclaw-hk",
  "pingUrl": "https://YOUR-MODEL-GATEWAY/v1/models"
}
```

This check does not send a completion request. It only records whether the URL is reachable from the edge machine. Real model errors are reported by real task runs.

## Systemd

Generate a unit with the CLI:

```bash
agent-bus service systemd --mode edge --config /root/agent-bus/edge.config.json --cwd /root/agent-bus --agent-bus-path /usr/bin/agent-bus --out agent-bus-edge.service
```

Example central unit:

```ini
[Unit]
Description=Agent Bus Central Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/agent-bus
EnvironmentFile=/etc/agent-bus/central.env
ExecStart=/usr/bin/python3 /root/agent-bus/central_gateway.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Example edge unit:

```ini
[Unit]
Description=Agent Bus Edge Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/root/agent-bus
Environment=AGENT_BUS_GATEWAY_URL=https://YOUR-GATEWAY-DOMAIN/agent-bus
ExecStart=/usr/bin/node /root/agent-bus/edge-node.mjs connect --config /root/agent-bus/edge.config.json
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

## Nginx Reverse Proxy

Example location block:

```nginx
location ^~ /agent-bus/ {
    rewrite ^/agent-bus(/.*)$ $1 break;
    proxy_pass http://127.0.0.1:8788;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_buffering off;
}
```
