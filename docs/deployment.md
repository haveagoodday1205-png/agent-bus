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

### Container Deployment

For a public central station, prefer Docker Compose plus a reverse proxy. The bundled container now runs the full Python central gateway by default, because that runtime includes rooms, reminders, traces, pairing, and agent-backed models.

```bash
cp .env.example .env
agent-bus init central --out central.config.json
# Edit .env and central.config.json before exposing the service.
docker compose up -d --build
docker compose logs -f agent-bus-central
```

Important settings:

- Put a long random `AGENT_BUS_TOKEN` in `.env`.
- Keep `AGENT_BUS_DATA_DIR=/data/central` in the container.
- Mount `/data` as a persistent volume.
- Put HTTPS in front of port `8788`; do not expose plain HTTP directly to the public internet.
- Back up the `agent-bus-data` volume.

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

## Edge Node

Preferred path: create a pairing code from the central/admin machine, then redeem it on the new edge node:

```bash
agent-bus pair create --gateway https://YOUR-GATEWAY-DOMAIN/agent-bus --token ... --preset codex
agent-bus pair join --gateway https://YOUR-GATEWAY-DOMAIN/agent-bus --code ABCD-2345 --out edge.config.json
```

Pairing writes a scoped edge token into `edge.config.json`. That token is enough for the node to register, poll, report run events, and read discovery metadata, but it cannot create pair codes, create threads, wake rooms, or call the model router.

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
