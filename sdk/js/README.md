# Agent Bus JS SDK

Zero-dependency ESM helpers for connecting tools, demos, and tests to an Agent Bus gateway.

```js
import { AgentBusClient } from "agent-bus-cli/sdk/js/agent-bus-sdk.mjs";

const bus = new AgentBusClient({
  gatewayUrl: "https://YOUR-DOMAIN/agent-bus",
  token: process.env.AGENT_BUS_TOKEN
});

const agents = await bus.agents();
const room = await bus.createRoom({
  title: "release check",
  goal: "Check the release and report blockers.",
  agents: ["hermes-hk", "openclaw-hk"],
  wakeAgents: ["hermes-hk", "openclaw-hk"]
});

const response = await bus.agentResponse(
  "hermes-hk",
  "Summarize the latest room status.",
  { metadata: { agent_bus_cache_scope: "release-check-room" } }
);
```

The SDK intentionally stays small:

- gateway discovery: `health()`, `wellKnown()`, `manifest()`
- presence: `agents()`, `nodes()`
- rooms: `rooms()`, `room(id)`, `createRoom()`, `messageRoom()`, `wakeRoom()`
- OpenAI-compatible agent calls: `agentChat()`, `agentResponse()`
- replay fixtures: `exportRoomEvents()`, `roomEventBundle()`, `replayRoomEvents()`

Pass `prompt_cache_key`, `metadata.agent_bus_cache_scope`, or `agent_bus.cache_scope` in `agentChat()`/`agentResponse()` options when otherwise separate model-replacement calls should reuse the same Agent Bus session/cache scope.

It requires Node.js 20+ or any runtime with `fetch`.
