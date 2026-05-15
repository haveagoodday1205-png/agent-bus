#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const node = process.execPath;
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-no-quota-room-replay-"));

main().catch((err) => {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}).finally(() => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const python = findPython();
  if (!python) throw new Error("The no-quota room replay demo requires Python 3.10+ for the local room gateway.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const adminToken = "sk-no-quota-room-replay-token-000000";
  const edgeToken = "abt_edge_no_quota_room_replay_token_000000";
  const outDir = optionValue("--out-dir");
  const artifactDir = outDir ? path.resolve(outDir) : path.join(tempDir, "artifacts");
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "deterministic-room-agent.mjs");

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token: adminToken,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 1000
    },
    edgeTokens: [
      {
        token: edgeToken,
        nodeId: "no-quota-demo-edge",
        label: "no quota room replay demo"
      }
    ],
    modelRouter: {
      enabled: false,
      backends: []
    }
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, `const id = process.env.AGENT_ID || "demo-agent";\nconst room = process.env.AGENT_ROOM_ID || "";\nconst run = process.env.AGENT_RUN_ID || "";\nif (id === "demo-planner") {\n  console.log("REPORT: Planner created a deterministic room plan for " + room + ".");\n  console.log("BLACKBOARD: Worker must verify export metadata, replay, and inspect output for " + room + ".");\n  console.log("@demo-worker: Verify the no-quota golden path, write a REPORT, update BLACKBOARD, and mark DONE.");\n} else {\n  console.log("REPORT: Worker verified central relay, edge dispatch, room directives, event export, replay, and inspect without model quota. run=" + run);\n  console.log("BLACKBOARD: No-quota room replay demo completed with deterministic command agents.");\n  console.log("DONE");\n}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "no-quota-demo-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [
      {
        id: "demo-planner",
        kind: "demo",
        role: "planner",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "planning", "no-quota", "replay"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      },
      {
        id: "demo-worker",
        kind: "demo",
        role: "executor",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "verification", "no-quota", "replay"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      }
    ]
  }, null, 2)}\n`);

  if (!jsonOut) {
    console.log("Agent Bus no-quota room replay golden path");
    console.log("1. Starting a private local central gateway");
  }
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: adminToken,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`);

  if (!jsonOut) console.log("2. Connecting one edge with two deterministic command agents");
  const edge = start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  await waitForAgents(gateway, adminToken, ["demo-planner", "demo-worker"]);

  if (!jsonOut) console.log("3. Creating a room and waking demo-planner");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({
      title: "No-quota room replay golden path",
      goal: "Prove Agent Bus central, edge, room directives, event export, replay, and inspect without model quota.",
      agents: ["demo-planner", "demo-worker"],
      wakeAgents: ["demo-planner"],
      auto_rotate: false,
      max_steps: 4
    })
  });

  const completed = await waitForRoomComplete(gateway, adminToken, room.id);
  const reports = completed.reports || [];
  const notes = completed.blackboard?.notes || [];
  const runs = completed.runs || [];
  assert(completed.status === "completed", "room did not complete");
  assert(reports.length >= 2, "room did not capture both agent reports");
  assert(notes.length >= 2, "room did not capture both blackboard notes");
  assert(runs.filter((run) => run.status === "completed").length >= 2, "room did not complete both agent runs");
  assert(reports.some((report) => /Planner created/.test(report.content || "")), "planner report was not captured");
  assert(reports.some((report) => /Worker verified/.test(report.content || "")), "worker report was not captured");

  if (!jsonOut) console.log("4. Inspecting room operator/debug state");
  const inspection = await runCliJson(["room", "inspect", completed.id, "--json", "--gateway", gateway, "--token", adminToken]);
  assert(inspection.room?.id === completed.id, "room inspect returned the wrong room");
  assert(inspection.analysis?.counts?.terminal_runs >= 2, "room inspect did not count terminal runs");
  assert(Array.isArray(inspection.operator_hints), "room inspect did not expose operator_hints");
  assert(inspection.analysis?.summary, "room inspect did not include a summary");

  if (!jsonOut) console.log("5. Exporting event bundle and replaying it offline");
  const bundlePath = path.join(artifactDir, "room-events.json");
  const replayPath = path.join(artifactDir, "room-replay.json");
  const replayMarkdownPath = path.join(artifactDir, "room-replay.md");
  const inspectPath = path.join(artifactDir, "room-inspect.json");
  await runCliText(["room", "export", completed.id, "--format", "events", "--out", bundlePath, "--gateway", gateway, "--token", adminToken]);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  assert(bundle.object === "agent_bus.room_event_bundle", "room export did not write an event bundle");
  assert(bundle.room?.id === completed.id, "event bundle room id did not match");
  assert(bundle.export_metadata?.format === "events", "event bundle missing export_metadata.format");
  assert(bundle.export_metadata?.event_count === bundle.events.length, "event bundle metadata count mismatch");
  assert(bundle.events.every((event, index) => event.sequence === index + 1), "event sequence is not contiguous");
  assert(bundle.events.some((event) => event.type === "room.created"), "event bundle missing room.created");
  assert(bundle.events.some((event) => event.type === "run.completed"), "event bundle missing run.completed");
  assert(bundle.events.some((event) => event.type === "room.report.added"), "event bundle missing room.report.added");

  const replay = await runCliJson(["room", "replay", "--in", bundlePath]);
  assert(replay.object === "agent_bus.room_replay", "room replay did not return a replay summary");
  assert(replay.room?.id === completed.id, "room replay returned the wrong room id");
  assert(replay.export_metadata?.format === "events", "room replay did not preserve export metadata");
  assert(replay.counts?.completed_runs >= 2, "room replay did not count completed runs");
  assert(replay.counts?.reports >= 2, "room replay did not count reports");
  const replayMarkdown = await runCliText(["room", "replay", "--in", bundlePath, "--format", "markdown"]);
  assert(replayMarkdown.includes("# Agent Bus Room Replay:"), "room replay markdown did not render a title");
  assert(replayMarkdown.includes("Worker verified"), "room replay markdown did not include the worker report");
  const eventLog = await runCliJson(["room", "event-log", completed.id, "--json", "--gateway", gateway, "--token", adminToken]);
  assert(eventLog.object === "agent_bus.room_event_log", "room event-log did not return an event log object");
  assert(eventLog.room?.id === completed.id, "room event-log returned the wrong room id");
  assert(eventLog.entries?.length === bundle.events.length, "room event-log should show all events by default");
  assert(eventLog.entries?.some((entry) => entry.type === "room.report.added" && /Worker verified/.test(entry.summary || "")), "room event-log did not include the worker report");
  const eventLogText = await runCliText(["room", "event-log", completed.id, "--tail", "6", "--gateway", gateway, "--token", adminToken]);
  assert(eventLogText.includes("Agent Bus room event log:"), "room event-log text did not render a title");
  assert(eventLogText.includes("run.completed"), "room event-log text did not include run completion");

  fs.writeFileSync(replayPath, `${JSON.stringify(replay, null, 2)}\n`);
  fs.writeFileSync(replayMarkdownPath, replayMarkdown);
  fs.writeFileSync(inspectPath, `${JSON.stringify(inspection, null, 2)}\n`);

  const result = {
    ok: true,
    mode: "no_quota_room_replay",
    quota: "no_model_calls",
    gateway,
    room_id: completed.id,
    room_status: completed.status,
    agents: ["demo-planner", "demo-worker"],
    reports: reports.length,
    blackboard_notes: notes.length,
    runs: runs.length,
    event_count: bundle.events.length,
    sequence_start: bundle.export_metadata.sequence_start,
    sequence_end: bundle.export_metadata.sequence_end,
    replay_counts: replay.counts,
    inspect_summary: inspection.analysis.summary,
    event_log_entries: eventLog.entries.length,
    artifacts: outDir ? {
      event_bundle: bundlePath,
      replay_json: replayPath,
      replay_markdown: replayMarkdownPath,
      inspect_json: inspectPath
    } : null
  };

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Room: ${result.room_id}`);
  console.log(`Reports: ${result.reports}; blackboard notes: ${result.blackboard_notes}`);
  console.log(`Events: ${result.event_count} (${result.sequence_start}..${result.sequence_end})`);
  console.log(`Replay: ${result.replay_counts.completed_runs} completed run(s), ${result.replay_counts.reports} report(s)`);
  console.log(`Inspect: ${result.inspect_summary}`);
  if (result.artifacts) {
    console.log(`Artifacts written to ${artifactDir}`);
  }
  console.log("Demo complete. No model provider was called.");
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: demoChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!jsonOut) {
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (/listening|connected|registered/.test(text)) process.stdout.write(`   ${text}`);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  procs.push(child);
  return child;
}

function runCliJson(cliArgs, timeoutMs = 15000) {
  return runCliText(cliArgs, timeoutMs).then((text) => JSON.parse(text));
}

function runCliText(cliArgs, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...cliArgs], {
      cwd: root,
      env: demoChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus ${cliArgs.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(new Error(`agent-bus ${cliArgs.join(" ")} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

async function waitForAgents(gateway, token, agentIds, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      const online = new Set(agents.filter((agent) => agent.status === "online").map((agent) => agent.id));
      if (agentIds.every((id) => online.has(id))) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 20000) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    latest = room;
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    await delay(250);
  }
  const runs = (latest?.runs || []).map((run) => {
    const detail = run.stderr || run.summary || run.stdout || "";
    return `${run.agent_id}:${run.status}${detail ? `:${String(detail).replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
  }).join(", ");
  throw new Error(`Timed out waiting for room ${roomId}; status=${latest?.status || "unknown"} reports=${latest?.reports?.length || 0} runs=[${runs}]`);
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const command of [...new Set(candidates)]) {
    try {
      const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
        cwd: root,
        windowsHide: true,
        stdio: "ignore"
      });
      if (result.status === 0) return command;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

function commonBundledPythonPaths() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python"),
    path.join(home, ".codex", "runtimes", "codex-primary-runtime", "dependencies", "python")
  ];
  const names = process.platform === "win32"
    ? ["python.exe"]
    : ["bin/python3", "bin/python", "python3", "python"];
  return roots.flatMap((rootDir) => names.map((name) => path.join(rootDir, name)));
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function demoChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_ROOM_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];
