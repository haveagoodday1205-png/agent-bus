# Deployment

## Central Gateway

Run the gateway behind HTTPS:

```bash
AGENT_BUS_TOKEN="$(openssl rand -base64 32)" \
AGENT_BUS_HOST=127.0.0.1 \
AGENT_BUS_PORT=8788 \
node central-gateway.mjs serve
```

Use `central_gateway.py` instead on machines without Node.js:

```bash
AGENT_BUS_TOKEN="$(openssl rand -base64 32)" \
AGENT_BUS_HOST=127.0.0.1 \
AGENT_BUS_PORT=8788 \
python3 central_gateway.py
```

## Edge Node

Copy an edge config, set the gateway URL and token, then run:

```bash
AGENT_BUS_GATEWAY_URL="https://YOUR-GATEWAY-DOMAIN/agent-bus" \
AGENT_BUS_TOKEN="..." \
node edge-node.mjs connect --config edge.config.json
```

Use `edge_node.py` on machines without Node.js.

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
