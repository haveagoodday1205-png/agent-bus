# Local Demo

Run the local demo:

```bash
npm run demo:local
```

It shows the core Agent Bus loop on localhost:

- start a central gateway
- create a one-time pair code
- join an edge node with the code
- register an echo agent
- send a task through the gateway
- print the remote assistant node result

The demo uses only fake local tokens and temporary files.

For a real machine, first run:

```bash
agent-bus detect
agent-bus init edge --auto --out edge.config.json
```

The generated config can include Codex, OpenClaw, Hermes, and Ollama agents when those tools are installed locally.
