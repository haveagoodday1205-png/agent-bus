# Hello Agent

This is the smallest Agent Bus v1-compatible adapter example. It does not call a model, read secrets, or need network access. It only proves the adapter contract:

- read the task from `AGENT_MESSAGE_FILE`
- use Agent Bus run metadata from environment variables
- write stable room directives to stdout
- exit successfully

## Try It Locally

From the repository root:

```bash
AGENT_ID=hello-agent \
AGENT_RUN_ID=local-demo \
AGENT_MESSAGE="Hello from Agent Bus" \
node examples/hello-agent/hello-agent.mjs
```

Expected output:

```text
REPORT: hello-agent received 20 bytes for run local-demo.
BLACKBOARD: hello-agent last_message_preview=Hello from Agent Bus
DONE
```

## Use It As An Edge Agent

Copy the example config and fill in `gatewayUrl` plus a token:

```bash
cp examples/hello-agent/edge.config.example.json edge.hello.config.json
agent-bus connect --config edge.hello.config.json
```

Then create a room or thread targeting `hello-agent`. The agent should produce a `REPORT`, a `BLACKBOARD` note, and `DONE`.

## Adapter Contract

Agent Bus command adapters receive:

| Variable | Meaning |
| --- | --- |
| `AGENT_MESSAGE_FILE` | Path to the full task text. Prefer this over `AGENT_MESSAGE`. |
| `AGENT_MESSAGE` | Small task text copied into the environment when it fits OS limits. |
| `AGENT_RUN_ID` | Current run id. |
| `AGENT_THREAD_ID` | Thread id or room id. |
| `AGENT_ROOM_ID` | Room id for room runs. Empty for normal threads. |
| `AGENT_ID` | Agent id from edge config. |
| `EDGE_NODE_ID` | Node id from edge config. |

Stable room directives:

```text
REPORT: concise user-facing result
BLACKBOARD: durable state for future turns
DONE
```

This example is intentionally boring. It is the reference shape for wrapping a real CLI agent, local model, CI bot, browser worker, or deployment helper.
