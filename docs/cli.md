# CLI

`agent-bus` is the portable command-line entrypoint for running Agent Bus as a local service, an edge node, or a query client.

Install from a checkout:

```bash
npm install -g .
agent-bus --help
```

## Remote Assistant Node

On any machine that should receive work:

```bash
agent-bus init edge --preset codex --out edge.config.json
```

Edit:

- `gatewayUrl`: central gateway URL
- `token`: central gateway bearer token
- `pingUrl`: shallow model/service reachability URL
- `runCommand`: command that runs the local AI tool

Then connect:

```bash
agent-bus doctor --config edge.config.json
agent-bus connect --config edge.config.json
```

The machine now polls the central gateway and can receive tasks. It does not need an inbound public port.

## Central Gateway

```bash
agent-bus init central --out central.config.json
agent-bus serve --config central.config.json
```

Edit the generated config to set:

- a long random `token`
- model router `baseUrl`
- model router API key environment variable
- model aliases exposed to clients

## Query Commands

```bash
agent-bus well-known --gateway https://YOUR-DOMAIN/agent-bus
agent-bus manifest --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus agents --gateway https://YOUR-DOMAIN/agent-bus --token ...
agent-bus health --gateway https://YOUR-DOMAIN/agent-bus
```

You can also use environment variables:

```bash
export AGENT_BUS_GATEWAY_URL=https://YOUR-DOMAIN/agent-bus
export AGENT_BUS_TOKEN=...
agent-bus agents
```

## Local Probe

```bash
agent-bus probe --config edge.config.json
```

This runs the edge health checks locally. URL ping checks do not run model inference.

## Doctor

```bash
agent-bus doctor --config edge.config.json
```

`doctor` checks:

- Node.js runtime
- config file readability
- missing or placeholder gateway URL
- missing or placeholder token
- enabled agents
- missing command adapters
- ping URL placeholders
- gateway well-known endpoint
- gateway public health endpoint
- authenticated manifest, when a token is configured
- local edge health probe

It exits non-zero only on hard failures. Warnings are meant to guide setup without blocking local experimentation.

## Docker

Run a central gateway in a container:

```bash
agent-bus init central --out central.config.json
docker compose up --build
```

The image uses the same CLI entrypoint:

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

For a standalone binary, package `agent-bus.mjs` together with:

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
