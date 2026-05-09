import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-offline-smoke-"));

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
  if (!python) {
    throw new Error("agent-bus smoke --offline requires Python 3.10+ because the Python gateway currently owns room support.");
  }

  const gatewayPort = await freePort();
  const token = "sk-offline-smoke-token-000000";
  const edgeToken = "abt_edge_offline_smoke_token_000000";
  const base = `http://127.0.0.1:${gatewayPort}`;
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "offline-agent.mjs");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port: gatewayPort,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 1000
    },
    edgeTokens: [edgeToken],
    modelRouter: {
      enabled: true,
      agentModels: true,
      allowEdgeAgentModels: true,
      backends: []
    }
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, `const room = process.env.AGENT_ROOM_ID || "";\nconst cache = process.env.AGENT_CACHE_KEY || "";\nconsole.log("REPORT: offline smoke run completed for " + room);\nconsole.log("BLACKBOARD: cache key " + cache);\nconsole.log("BLACKBOARD: fake token=sk-test-secret-000000000000000000");\nconsole.log("DONE");\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "offline-smoke-node",
    gatewayUrl: base,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "offline-agent",
      kind: "offline",
      role: "executor",
      enabled: true,
      adapter: "command",
      capabilities: ["test", "room", "offline"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(agentScript)}`
    }]
  }, null, 2)}\n`);

  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(gatewayPort),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${base}/health`);

  const edge = start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  const agent = await waitForAgent(base, token, "offline-agent");
  assert(agent.status === "online", "agent discovery did not expose online status");
  assert(agent.node_status === "online", "agent discovery did not expose online node status");
  assert(Boolean(agent.last_seen_at), "agent discovery did not expose last_seen_at");
  assert(agent.ping_status === "not_configured", "offline agent should report ping_status=not_configured");
  const models = await requestJson(`${base}/v1/models`, { headers: authHeaders(token) });
  assert(models.data?.some((item) => item.id === "agent:offline-agent"), "admin model list did not include the offline agent model");
  const edgeModels = await requestJson(`${base}/v1/models`, { headers: authHeaders(edgeToken) });
  assert(edgeModels.data?.some((item) => item.id === "agent:offline-agent"), "edge model list did not include the offline agent model");
  const agentChat = await requestJson(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent:offline-agent",
      messages: [{ role: "user", content: "agent model replacement smoke" }],
      timeout_seconds: 10
    })
  });
  assert(agentChat.model === "agent:offline-agent", "agent-backed chat completion returned the wrong model");
  assert(agentChat.agent_bus?.agent_id === "offline-agent", "agent-backed chat completion did not include Agent Bus run metadata");
  assert(/offline smoke run completed/.test(agentChat.choices?.[0]?.message?.content || ""), "agent-backed chat completion did not return agent stdout");
  const agentResponse = await requestJson(`${base}/v1/responses`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent:offline-agent",
      input: "agent responses replacement smoke",
      timeout_seconds: 10
    })
  });
  assert(agentResponse.model === "agent:offline-agent", "agent-backed response returned the wrong model");
  assert(agentResponse.agent_bus?.agent_id === "offline-agent", "agent-backed response did not include Agent Bus run metadata");
  assert(/offline smoke run completed/.test(agentResponse.output_text || ""), "agent-backed response did not return agent output_text");
  assert(agentResponse.output?.[0]?.content?.[0]?.type === "output_text", "agent-backed response did not return Responses-style output content");

  const room = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline smoke room",
      goal: "Verify Agent Bus room dispatch, command adapter env, directive parsing, blackboard persistence, and completion without model quota.",
      agents: ["offline-agent"],
      wakeAgents: ["offline-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });

  const finalRoom = await waitForRoomComplete(base, token, room.id);
  const run = finalRoom.runs?.find((item) => item.agent_id === "offline-agent");
  assert(run?.status === "completed", "offline room run did not complete");
  assert(finalRoom.status === "completed", "offline room did not complete after DONE");
  assert(finalRoom.reports?.some((item) => /offline smoke run completed/.test(item.content || "")), "REPORT directive was not captured");
  assert(finalRoom.blackboard?.notes?.some((item) => /cache key agent-bus-offline-agent/.test(item.content || "")), "BLACKBOARD directive was not captured");
  assert((run.stdout || "").includes("DONE"), "agent stdout did not include DONE");

  const cliRoom = await runCliJson(["room", "show", finalRoom.id, "--gateway", base, "--token", token]);
  assert(cliRoom.id === finalRoom.id, "CLI room show did not return the expected room");
  const cliRooms = await runCliJson(["room", "list", "--gateway", base, "--token", token]);
  assert(Array.isArray(cliRooms) && cliRooms.some((item) => item.id === finalRoom.id), "CLI room list did not include the smoke room");
  const cliNodes = await runCliJson(["nodes", "--gateway", base, "--token", token]);
  assert(Array.isArray(cliNodes) && cliNodes.some((item) => item.node_id === "offline-smoke-node"), "CLI nodes did not include the smoke node");
  const cliStatus = await runCliJson(["status", "--json", "--gateway", base, "--token", token]);
  assert(cliStatus.ok === true, "CLI status did not report ok=true");
  assert(cliStatus.summary?.online_agents === 1, "CLI status did not count the online smoke agent");
  assert(cliStatus.nodes?.some((item) => item.id === "offline-smoke-node" && item.freshness?.startsWith("online/fresh")), "CLI status did not include node freshness");
  assert(cliStatus.rooms?.some((item) => item.id === finalRoom.id), "CLI status did not include the smoke room");
  const statusAgent = cliStatus.agents?.find((item) => item.id === "offline-agent");
  assert(statusAgent?.freshness?.startsWith("online/fresh"), "CLI status JSON did not include derived freshness label");
  assert(statusAgent?.activity === "idle", "CLI status JSON did not include derived idle activity label");
  assert(Array.isArray(statusAgent?.active_runs) && statusAgent.active_runs.length === 0, "CLI status JSON should expose no active runs after completion");
  assert(statusAgent?.current_run === null, "CLI status JSON should expose current_run=null after completion");
  assert(statusAgent?.ping_label === "not configured", "CLI status JSON did not include derived ping label");
  assert(statusAgent?.last_run_health === "ok", "CLI status JSON did not include derived last-run health");
  const cliStatusText = await runCliText(["status", "--gateway", base, "--token", token]);
  assert(cliStatusText.includes("node=online/fresh"), "CLI status human output did not include node freshness");
  assert(cliStatusText.includes("activity=idle"), "CLI status human output did not include activity label");
  assert(cliStatusText.includes("ping=not configured"), "CLI status human output did not include ping label");
  assert(cliStatusText.includes("last_run=ok"), "CLI status human output did not include last-run health");
  const cliExport = await runCliText(["room", "export", finalRoom.id, "--gateway", base, "--token", token]);
  assert(cliExport.includes(`# Agent Bus Room: ${finalRoom.title}`), "CLI room export did not render markdown title");
  assert(cliExport.includes("offline smoke run completed"), "CLI room export did not include report content");
  assert(!cliExport.includes("sk-test-secret-000000000000000000"), "CLI room export did not redact token-like content");
  assert(cliExport.includes("token=[REDACTED]"), "CLI room export did not include a redaction marker");
  const summaryExport = await runCliText(["room", "export", finalRoom.id, "--reports-only", "--gateway", base, "--token", token]);
  assert(summaryExport.includes("## Reports"), "CLI room export --reports-only did not include reports");
  assert(summaryExport.includes("reports-only:"), "CLI room export --reports-only did not mark the sharing boundary");
  assert(!summaryExport.includes("## Goal"), "CLI room export --reports-only included the room goal");
  assert(!summaryExport.includes("## Messages"), "CLI room export --reports-only included full messages");
  const exportJson = path.join(tempDir, "room-export.json");
  await runCliText(["room", "export", finalRoom.id, "--format", "json", "--out", exportJson, "--gateway", base, "--token", token]);
  const exportJsonText = fs.readFileSync(exportJson, "utf8");
  assert(!exportJsonText.includes("sk-test-secret-000000000000000000"), "CLI room export --format json did not redact token-like content");
  const exportedRoom = JSON.parse(exportJsonText);
  assert(exportedRoom.id === finalRoom.id, "CLI room export --format json wrote the wrong room");
  const summaryJson = await runCliJson(["room", "export", finalRoom.id, "--format", "json", "--reports-only", "--gateway", base, "--token", token]);
  assert(summaryJson.id === finalRoom.id, "CLI room export --reports-only json wrote the wrong room");
  assert(summaryJson.object === "agent_bus.room_reports_summary", "CLI room export --reports-only json omitted the summary object type");
  assert(!Object.hasOwn(summaryJson, "goal"), "CLI room export --reports-only json included the room goal");
  assert(!Object.hasOwn(summaryJson, "messages"), "CLI room export --reports-only json included full messages");
  const eventBundle = await runCliJson(["room", "export", finalRoom.id, "--format", "events", "--gateway", base, "--token", token]);
  assert(eventBundle.object === "agent_bus.room_event_bundle", "CLI room export --format events did not return an event bundle");
  assert(eventBundle.room?.id === finalRoom.id, "event bundle has the wrong room id");
  assert(eventBundle.export_metadata?.format === "events", "event bundle did not include export metadata");
  assert(eventBundle.export_metadata?.event_count === eventBundle.events?.length, "event bundle export metadata has the wrong event count");
  assert(eventBundle.events?.every((event, index) => event.sequence === index + 1), "event bundle events did not include contiguous sequence numbers");
  assert(eventBundle.events?.some((event) => event.type === "room.created"), "event bundle did not include room.created");
  assert(eventBundle.events?.some((event) => event.type === "run.completed"), "event bundle did not include run.completed");
  assert(eventBundle.events?.some((event) => event.type === "room.report.added"), "event bundle did not include room.report.added");
  assert(!JSON.stringify(eventBundle).includes("sk-test-secret-000000000000000000"), "event bundle did not redact token-like content");
  const reportsOnlyBundle = await runCliJson(["room", "export", finalRoom.id, "--format", "events", "--reports-only", "--gateway", base, "--token", token]);
  assert(reportsOnlyBundle.reports_only === true, "reports-only event bundle did not mark reports_only=true");
  assert(reportsOnlyBundle.events?.some((event) => event.type === "room.created" && event.payload?.goal_omitted === true), "reports-only event bundle did not omit the room goal");
  assert(!JSON.stringify(reportsOnlyBundle).includes("Verify Agent Bus room dispatch"), "reports-only event bundle leaked the room goal text");
  const eventBundlePath = path.join(tempDir, "room-events.json");
  await runCliText(["room", "export", finalRoom.id, "--format", "events", "--out", eventBundlePath, "--gateway", base, "--token", token]);
  const replayJson = await runCliJson(["room", "replay", "--in", eventBundlePath]);
  assert(replayJson.object === "agent_bus.room_replay", "CLI room replay did not return a replay summary");
  assert(replayJson.room?.id === finalRoom.id, "CLI room replay returned the wrong room id");
  assert(replayJson.export_metadata?.format === "events", "CLI room replay did not preserve export metadata");
  assert(replayJson.counts?.completed_runs >= 1, "CLI room replay did not count completed runs");
  assert(replayJson.counts?.reports >= 1, "CLI room replay did not count reports");
  const replayMarkdown = await runCliText(["room", "replay", "--in", eventBundlePath, "--format", "markdown"]);
  assert(replayMarkdown.includes("# Agent Bus Room Replay:"), "CLI room replay --format markdown did not render a title");
  assert(replayMarkdown.includes("offline smoke run completed"), "CLI room replay markdown did not include report content");

  if (!edge.killed) edge.kill("SIGTERM");
  await waitForExit(edge);
  await delay(1200);
  const pauseRoom = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline pause recovery room",
      goal: "Verify room pause cancels queued work without deleting history.",
      agents: ["offline-agent"],
      wakeAgents: ["offline-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const queuedBeforePause = await requestJson(`${base}/health`);
  assert(queuedBeforePause.queued >= 1, "pause recovery room did not leave queued work in the gateway");
  assert(pauseRoom.status === "active", "pause recovery room was not active before pause");
  assert(pauseRoom.runs?.length === 1 && pauseRoom.runs[0].status === "queued", "pause recovery room did not have one queued run before pause");
  const pausedRoom = await runCliJson(["room", "pause", pauseRoom.id, "--reason", "offline smoke recovery", "--gateway", base, "--token", token]);
  assert(pausedRoom.status === "paused", "CLI room pause did not return a paused room");
  assert(pausedRoom.runs?.length === 1 && pausedRoom.runs[0].status === "cancelled", "CLI room pause did not cancel the queued room run");
  const queuedAfterPause = await requestJson(`${base}/health`);
  assert(queuedAfterPause.queued <= queuedBeforePause.queued - 1, "CLI room pause did not remove the queued room task");
  assert(pausedRoom.reports?.some((item) => /Paused by operator: offline smoke recovery/.test(item.content || "")), "CLI room pause did not add an operator report");
  const pausedStatus = await runCliJson(["status", "--json", "--gateway", base, "--token", token]);
  assert(!pausedStatus.rooms?.some((item) => item.id === pauseRoom.id && ["active", "running", "finishing"].includes(item.status)), "CLI status should not report the paused room as active");
  assert(pausedStatus.summary?.active_rooms === 0, "CLI status should not count the paused room as active");
  const pausedAfterWake = await runCliJson(["room", "wake", pauseRoom.id, "--agent", "offline-agent", "--gateway", base, "--token", token]);
  assert(pausedAfterWake.status === "paused", "CLI room wake should leave a paused room paused");
  assert((pausedAfterWake.runs || []).length === 1, "CLI room wake should not create a new run for a paused room");

  const result = {
    ok: true,
    mode: "offline",
    quota: "no_model_calls",
    gateway: base,
    agent_status: agent.status,
    ping_status: agent.ping_status,
    room_id: finalRoom.id,
    room_status: finalRoom.status,
    paused_room_id: pausedRoom.id,
    paused_cancelled_runs: pausedRoom.pause?.cancelled_queued_runs?.length || 0,
    run_id: run.id,
    reports: finalRoom.reports?.length || 0,
    blackboard_notes: finalRoom.blackboard?.notes?.length || 0,
    event_count: eventBundle.events?.length || 0,
    export_bytes: Buffer.byteLength(cliExport)
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Agent Bus offline smoke passed");
    console.log(`Room: ${result.room_id}`);
    console.log(`Run: ${result.run_id}`);
    console.log("Quota: no model calls");
  }

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!jsonOut) {
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  child.on("exit", (code, signal) => {
    if (code && !child.killed && !jsonOut) {
      console.error(`${path.basename(command)} exited with ${code || signal}`);
    }
  });
  procs.push(child);
  return child;
}


function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

function runCliJson(commandArgs, timeoutMs = 10000) {
  return runCliText(commandArgs, timeoutMs).then((stdout) => {
    try {
      return JSON.parse(stdout);
    } catch (err) {
      throw new Error(`CLI did not return JSON: ${stdout || err.message}`);
    }
  });
}

function runCliText(commandArgs, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "agent-bus.mjs"), ...commandArgs], {
      cwd: root,
      env: smokeChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: agent-bus ${commandArgs.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];

function findPython() {
  const candidates = [...new Set([
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean))];
  for (const candidate of candidates) {
    const version = pythonVersion(candidate);
    if (version && (version.major > 3 || (version.major === 3 && version.minor >= 10))) return candidate;
  }
  return "";
}

function pythonVersion(candidate) {
  const result = spawnSync(candidate, ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) return null;
  const match = String(result.stdout || "").trim().match(/^(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10)
  };
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForAgent(base, token, agentId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const agents = await requestJson(`${base}/agents`, { headers: authHeaders(token) });
    const agent = agents.find((item) => item.id === agentId);
    if (agent) return agent;
    await delay(250);
  }
  throw new Error(`Timed out waiting for agent ${agentId}`);
}

async function waitForRoomComplete(base, token, roomId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${base}/rooms/${roomId}`, { headers: authHeaders(token) });
    const terminalRuns = (room.runs || []).filter((run) => ["completed", "failed", "error"].includes(run.status));
    if (room.status === "completed" && terminalRuns.length) return room;
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId}`);
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

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}
