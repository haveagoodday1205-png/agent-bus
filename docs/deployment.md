# Deployment

## Central Gateway

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

Docker:

```bash
agent-bus init central --out central.config.json
docker compose up --build
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

Use `edge_node.py` on machines without Node.js.

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
