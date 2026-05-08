#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AgentBusClient, replayRoomEvents } from "../../sdk/js/agent-bus-sdk.mjs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");

main().catch((err) => {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
});

async function main() {
  const envGateway = process.env.AGENT_BUS_GATEWAY_URL;
  const envToken = process.env.AGENT_BUS_TOKEN;
  const envRoomId = process.env.AGENT_BUS_ROOM_ID;
  let server = null;
  let gatewayUrl = envGateway;
  let token = envToken;
  let roomId = envRoomId;
  let mode = "real";

  if (!gatewayUrl || !token || !roomId) {
    const fake = await startFakeGateway();
    server = fake.server;
    gatewayUrl = fake.gatewayUrl;
    token = fake.token;
    roomId = fake.roomId;
    mode = "fake";
  }

  try {
    const client = new AgentBusClient({ gatewayUrl, token });
    const health = await client.health();
    const bundle = await client.exportRoomEvents(roomId);
    assert(bundle.object === "agent_bus.room_event_bundle", "exportRoomEvents did not return an event bundle");
    assert(bundle.room?.id === roomId, "event bundle room id does not match");
    assert(bundle.export_metadata?.event_count === bundle.events.length, "event metadata count does not match events");
    assert(bundle.events.every((event, index) => event.sequence === index + 1), "event sequences are not contiguous");

    const replay = replayRoomEvents(bundle);
    assert(replay.object === "agent_bus.room_replay", "replayRoomEvents did not return a replay summary");
    assert(replay.export_metadata?.format === "events", "replay did not preserve export metadata");
    assert(replay.counts.completed_runs >= 1, "replay did not count completed runs");
    assert(replay.counts.reports >= 1, "replay did not count reports");

    const reportsOnlyBundle = await client.exportRoomEvents(roomId, { reportsOnly: true });
    assert(!reportsOnlyBundle.events.some((event) => event.type === "room.message.added"), "reports-only bundle included messages");
    assert(reportsOnlyBundle.export_metadata?.reports_only === true, "reports-only metadata was not set");

    const markdown = renderReplayMarkdown(replay);
    const outDir = optionValue("--out-dir");
    const written = outDir ? writeArtifacts(outDir, bundle, markdown) : null;
    const result = {
      ok: true,
      mode,
      quota: mode === "fake" ? "no_model_calls" : "gateway_dependent",
      gateway: gatewayUrl,
      health_ok: health?.ok === true,
      room_id: roomId,
      event_count: bundle.events.length,
      reports_only_event_count: reportsOnlyBundle.events.length,
      sequence_start: bundle.export_metadata.sequence_start,
      sequence_end: bundle.export_metadata.sequence_end,
      replay_counts: replay.counts,
      markdown_preview: markdown.split("\n").slice(0, 8),
      written
    };

    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log("Agent Bus JS room export and replay example");
    console.log(`Gateway: ${gatewayUrl}`);
    console.log(`Room: ${roomId}`);
    console.log(`Events: ${result.event_count} (${result.sequence_start}..${result.sequence_end})`);
    console.log(`Replay: ${result.replay_counts.completed_runs} completed run(s), ${result.replay_counts.reports} report(s)`);
    if (written) {
      console.log(`Wrote ${written.bundle}`);
      console.log(`Wrote ${written.markdown}`);
    }
    console.log(markdown);
  } finally {
    if (server) await closeServer(server);
  }
}

async function startFakeGateway() {
  const token = "js-room-replay-demo-token";
  const roomId = "room_js_replay_demo";
  const room = demoRoom(roomId);
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return sendJson(res, { ok: true, nodes: 1, agents: 2, queued: 0 });
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        return sendJson(res, { error: "unauthorized" }, 401);
      }
      if (req.method === "GET" && req.url === "/rooms") {
        return sendJson(res, [room]);
      }
      if (req.method === "GET" && req.url === `/rooms/${encodeURIComponent(roomId)}`) {
        return sendJson(res, room);
      }
      return sendJson(res, { error: "not_found" }, 404);
    } catch (err) {
      return sendJson(res, { error: err.message || String(err) }, 500);
    }
  });
  await listen(server);
  return {
    server,
    token,
    roomId,
    gatewayUrl: `http://127.0.0.1:${server.address().port}`
  };
}

function demoRoom(roomId) {
  return {
    id: roomId,
    title: "JS SDK room replay demo",
    goal: "Export a room snapshot into an event bundle, replay it offline, and render a support-friendly Markdown summary.",
    status: "completed",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:05.000Z",
    completed_at: "2026-01-01T00:00:05.000Z",
    agents: ["demo-planner", "demo-worker"],
    messages: [
      {
        speaker: "user",
        role: "user",
        content: "Show how JS tools can export and replay an Agent Bus room without calling a model.",
        at: "2026-01-01T00:00:00.000Z"
      },
      {
        speaker: "demo-planner",
        role: "assistant",
        content: "@demo-worker: verify the bundle sequence and write the report.",
        at: "2026-01-01T00:00:01.000Z"
      }
    ],
    runs: [
      {
        id: "run_js_planner",
        agent_id: "demo-planner",
        node_id: "demo-edge",
        kind: "demo",
        role: "planner",
        status: "completed",
        created_at: "2026-01-01T00:00:01.000Z",
        started_at: "2026-01-01T00:00:02.000Z",
        completed_at: "2026-01-01T00:00:03.000Z",
        exit_code: 0,
        stdout: "REPORT: Planner delegated the replay check.",
        stderr: ""
      },
      {
        id: "run_js_worker",
        agent_id: "demo-worker",
        node_id: "demo-edge",
        kind: "demo",
        role: "worker",
        status: "completed",
        created_at: "2026-01-01T00:00:03.000Z",
        started_at: "2026-01-01T00:00:04.000Z",
        completed_at: "2026-01-01T00:00:05.000Z",
        exit_code: 0,
        stdout: "REPORT: Worker verified contiguous event sequence metadata and offline replay.",
        stderr: ""
      }
    ],
    reports: [
      {
        speaker: "demo-planner",
        content: "Planner delegated the replay check.",
        at: "2026-01-01T00:00:03.000Z"
      },
      {
        speaker: "demo-worker",
        content: "Worker verified contiguous event sequence metadata and offline replay.",
        at: "2026-01-01T00:00:05.000Z"
      }
    ],
    blackboard: {
      notes: [
        {
          speaker: "demo-worker",
          content: "The exported bundle can be shared as a deterministic support fixture.",
          at: "2026-01-01T00:00:05.000Z"
        }
      ]
    }
  };
}

function renderReplayMarkdown(replay) {
  const lines = [
    `# ${replay.room.title || replay.room.id || "Agent Bus Room Replay"}`,
    "",
    `- Room: ${replay.room.id || "unknown"}`,
    `- Status: ${replay.room.status || "unknown"}`,
    `- Agents: ${(replay.room.agents || []).join(", ") || "none"}`,
    `- Events: ${replay.counts.events}`,
    `- Runs: ${replay.counts.runs} (${replay.counts.completed_runs} completed, ${replay.counts.failed_runs} failed)`,
    `- Reports: ${replay.counts.reports}`,
    ""
  ];
  if (replay.reports.length) {
    lines.push("## Reports", "");
    for (const report of replay.reports) {
      lines.push(`- ${report.speaker || "agent"}: ${singleLine(report.content)}`);
    }
    lines.push("");
  }
  if (replay.blackboard.length) {
    lines.push("## Blackboard", "");
    for (const note of replay.blackboard) {
      lines.push(`- ${note.speaker || "agent"}: ${singleLine(note.content)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

function writeArtifacts(outDir, bundle, markdown) {
  const target = path.resolve(outDir);
  fs.mkdirSync(target, { recursive: true });
  const bundlePath = path.join(target, "room-events.json");
  const markdownPath = path.join(target, "room-replay.md");
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`);
  fs.writeFileSync(markdownPath, markdown);
  return { bundle: bundlePath, markdown: markdownPath };
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function sendJson(res, value, status = 200) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(body.length)
  });
  res.end(body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function singleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
