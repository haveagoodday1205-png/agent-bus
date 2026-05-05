# Windows Client

Many OpenAI-compatible Windows clients can talk directly to:

```text
base_url = https://YOUR-GATEWAY-DOMAIN/agent-bus/v1
api_key  = <agent-bus bearer token>
```

If the client has TLS or proxy issues, run the local proxy:

```powershell
.\start-windows-openai-proxy.ps1 -Upstream "https://YOUR-GATEWAY-DOMAIN/agent-bus" -Token "<agent-bus bearer token>"
```

Then configure the client:

```text
base_url = http://127.0.0.1:8789/v1
api_key  = anything
```

The local proxy injects the gateway bearer token and forwards requests to the public gateway.
