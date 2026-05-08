# JS Room Replay Example

This example shows how a JavaScript tool can export an Agent Bus room snapshot into a deterministic event bundle, replay it offline, and render a small Markdown support summary.

## Run Without Setup

The example starts a fake local gateway, so it does not call a model provider or spend quota.

```bash
npm run demo:js-room-replay -- --json
```

To write shareable artifacts:

```bash
npm run demo:js-room-replay -- --out-dir ./agent-bus-room-replay-demo
```

That writes:

- `room-events.json`: an `agent_bus.room_event_bundle` with contiguous event `sequence` values and `export_metadata`
- `room-replay.md`: a compact replay summary for support, docs, or issue comments

## Run Against A Real Room

```bash
export AGENT_BUS_GATEWAY_URL="https://your-domain.com/agent-bus"
export AGENT_BUS_TOKEN="your-token"
export AGENT_BUS_ROOM_ID="room_xxx"
npm run demo:js-room-replay -- --out-dir ./room-export
```

The same code path uses `AgentBusClient.exportRoomEvents()` and `replayRoomEvents()`, so it is useful as a fixture for SDK integrations and bug reports.

## Key Pattern

```js
import { AgentBusClient, replayRoomEvents } from "agent-bus-cli/sdk/js/agent-bus-sdk.mjs";

const bus = new AgentBusClient({
  gatewayUrl: process.env.AGENT_BUS_GATEWAY_URL,
  token: process.env.AGENT_BUS_TOKEN
});

const bundle = await bus.exportRoomEvents(process.env.AGENT_BUS_ROOM_ID);
const replay = replayRoomEvents(bundle);
```
