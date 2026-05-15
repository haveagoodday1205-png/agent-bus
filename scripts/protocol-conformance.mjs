import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentBusClient, replayRoomEvents, validateRoomEventBundle } from "../sdk/js/agent-bus-sdk.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const node = process.execPath;
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-protocol-conformance-"));
const checks = [];

main().catch((err) => {
  const result = {
    ok: false,
    mode: "protocol_conformance",
    error: err.message || String(err),
    checks
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
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
  if (!python) throw new Error("Protocol conformance requires Python 3.10+ for the local room gateway.");

  const externalCommand = optionValue(args, "--agent-command") || optionValue(args, "--command") || "";
  const profile = normalizeProfile(optionValue(args, "--profile") || optionValue(args, "--mode") || "", externalCommand);
  const referenceAgent = profile === "local-reference-agent";
  if (profile === "adapter-command" && !externalCommand) {
    throw new Error("adapter-command conformance requires --agent-command \"your adapter command\".");
  }

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const adminToken = "sk-protocol-conformance-token-000000";
  const edgeToken = "abt_edge_protocol_conformance_token_000000";
  const agentId = optionValue(args, "--agent-id") || "conformance-agent";
  const nodeId = optionValue(args, "--node-id") || "conformance-node";
  const agentKind = optionValue(args, "--kind") || (referenceAgent ? "example" : "external");
  const agentRole = optionValue(args, "--role") || "worker";
  const capabilities = unique([
    ...(referenceAgent ? ["hello", "protocol-v1", "conformance", "offline"] : ["protocol-v1", "conformance", "adapter-command"]),
    ...csvOption(args, "--capabilities")
  ]);
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const eventBundlePath = path.join(tempDir, "room-events.json");
  const helloAgent = path.join(root, "examples", "hello-agent", "hello-agent.mjs");
  const runCommand = externalCommand || `${quoteCommandArg(node)} ${quoteCommandArg(helloAgent)}`;
  const adminClient = new AgentBusClient({ gatewayUrl: gateway, token: adminToken });
  const edgeClient = new AgentBusClient({ gatewayUrl: gateway, token: edgeToken });

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
        nodeId,
        label: "protocol conformance edge"
      }
    ],
    modelRouter: {
      enabled: true,
      agentModels: true,
      allowEdgeAgentModels: true,
      backends: []
    }
  }, null, 2)}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId,
    gatewayUrl: gateway,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [
      {
        id: agentId,
        kind: agentKind,
        role: agentRole,
        enabled: true,
        adapter: "command",
        capabilities,
        runCommand
      }
    ]
  }, null, 2)}\n`);

  step(`Starting local conformance gateway (${profile})`);
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: adminToken,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  const health = await waitForJson(`${gateway}/health`, 30000, central);
  assert(health.ok === true, "gateway health did not return ok=true");
  pass("gateway.health", "GET /health is reachable");

  const wellKnown = await requestJson(`${gateway}/.well-known/agent-bus.json`);
  assert(wellKnown.protocol === "agent-bus.v1", "well-known did not declare agent-bus.v1");
  pass("gateway.well_known", "well-known discovery declares agent-bus.v1");

  step("Connecting one edge with the reference hello-agent adapter");
  const edge = start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  const agent = await waitForAgent(gateway, adminToken, agentId, 15000, edge);
  assert(agent.status === "online", "conformance agent was not online");
  assert(agent.node_id === nodeId, "conformance agent advertised the wrong node_id");
  assert(agent.capabilities?.includes("protocol-v1"), "conformance agent did not advertise protocol-v1");
  pass("edge.register_agent", "edge registered a stable protocol-v1 agent", {
    agent_id: agent.id,
    node_id: agent.node_id
  });

  const nodes = await adminClient.nodes();
  assert(nodes.some((item) => item.node_id === nodeId && item.status === "online"), "nodes inventory did not include the conformance node");
  pass("gateway.nodes_inventory", "GET /nodes exposes the connected edge node");

  const manifest = await edgeClient.manifest();
  assert(manifest.protocol === "agent-bus.v1", "edge token could not read protocol manifest");
  assert(manifest.agents?.some((item) => item.id === agentId), "manifest did not include the conformance agent");
  pass("gateway.manifest", "edge-scoped token can read protocol manifest");

  const models = await edgeClient.models();
  assert(models.data?.some((item) => item.id === `agent:${agentId}`), "edge token model list did not include the agent virtual model");
  assert(!models.data?.some((item) => item.id === "agent-bus-default"), "edge token exposed backend model aliases");
  pass("model_router.edge_agent_models", "edge token sees only agent:<id> virtual models");

  step("Exercising agent-backed Chat Completions and Responses");
  const chat = await edgeClient.agentChat(agentId, [
    { role: "user", content: "Protocol conformance chat request. Prove AGENT_MESSAGE_FILE delivery." }
  ], {
    metadata: { agent_bus_cache_scope: "protocol-conformance-chat" }
  });
  const chatContent = chat.choices?.[0]?.message?.content || "";
  assert(chat.model === `agent:${agentId}`, "chat completion returned the wrong model");
  assert(chat.agent_bus?.agent_id === agentId, "chat completion omitted agent_bus agent metadata");
  if (referenceAgent) {
    assert(new RegExp(`REPORT: ${escapeRegExp(agentId)} received`).test(chatContent), "chat completion did not route through the agent");
    assert(new RegExp(`BLACKBOARD: ${escapeRegExp(agentId)} message_source=file`).test(chatContent), "chat completion did not prove file-based task delivery");
  } else {
    assertNonEmptyAdapterOutput(chatContent, "chat completion");
  }
  pass("openai.chat_completions_agent_model", "agent:<id> Chat Completions routed through the edge agent", {
    run_id: chat.agent_bus?.run_id
  });

  const response = await edgeClient.agentResponse(
    agentId,
    "Protocol conformance Responses request. Prove AGENT_MESSAGE_FILE delivery.",
    { metadata: { agent_bus_cache_scope: "protocol-conformance-responses" } }
  );
  assert(response.status === "completed", "Responses API call did not complete");
  assert(response.model === `agent:${agentId}`, "Responses API returned the wrong model");
  assert(response.agent_bus?.agent_id === agentId, "Responses API omitted agent_bus agent metadata");
  if (referenceAgent) {
    assert(new RegExp(`REPORT: ${escapeRegExp(agentId)} received`).test(response.output_text || ""), "Responses API did not route through the agent");
    assert(new RegExp(`BLACKBOARD: ${escapeRegExp(agentId)} message_source=file`).test(response.output_text || ""), "Responses API did not prove file-based task delivery");
  } else {
    assertNonEmptyAdapterOutput(response.output_text || "", "Responses API");
  }
  pass("openai.responses_agent_model", "agent:<id> Responses routed through the edge agent", {
    run_id: response.agent_bus?.run_id
  });

  step("Creating a conformance room");
  const room = await adminClient.createRoom({
    title: "Protocol conformance room",
    goal: referenceAgent
      ? "Verify Agent Bus v1 room run delivery, REPORT/BLACKBOARD/DONE directives, event-log, event export, and replay without model calls."
      : "Verify Agent Bus v1 adapter command delivery. Read the task normally and reply with one REPORT line, one BLACKBOARD line, and DONE so the gateway can validate the room directive contract.",
    agents: [agentId],
    wakeAgents: [agentId],
    auto_rotate: false,
    max_steps: 1
  });
  const finalRoom = await waitForRoomComplete(gateway, adminToken, room.id, 30000);
  const run = finalRoom.runs?.find((item) => item.agent_id === agentId);
  assert(finalRoom.status === "completed", "conformance room did not complete");
  assert(run?.status === "completed", "conformance agent room run did not complete");
  if (referenceAgent) {
    assert(new RegExp(`REPORT: ${escapeRegExp(agentId)} received`).test(run.stdout || ""), "room run stdout did not include REPORT");
    assert(new RegExp(`BLACKBOARD: ${escapeRegExp(agentId)} message_source=file`).test(run.stdout || ""), "room run stdout did not prove AGENT_MESSAGE_FILE usage");
  } else {
    assertNonEmptyAdapterOutput(run.stdout || "", "room run");
  }
  assert(/\bDONE\b/.test(run.stdout || ""), "room run stdout did not include DONE");
  assert(finalRoom.reports?.some((item) => referenceAgent ? new RegExp(`${escapeRegExp(agentId)} received`).test(item.content || "") : String(item.content || "").trim()), "gateway did not persist the REPORT directive");
  assert(finalRoom.blackboard?.notes?.some((item) => referenceAgent ? new RegExp(`${escapeRegExp(agentId)} message_source=file`).test(item.content || "") : String(item.content || "").trim()), "gateway did not persist the BLACKBOARD directive");
  pass("room.directive_contract", "room captured REPORT, BLACKBOARD, and DONE from the agent", {
    room_id: finalRoom.id,
    run_id: run.id
  });

  step("Verifying event-log, event bundle export, and replay");
  const eventLog = await runCliJson(["room", "event-log", finalRoom.id, "--json", "--gateway", gateway, "--token", adminToken]);
  assert(eventLog.object === "agent_bus.room_event_log", "room event-log did not return an event log object");
  assert(eventLog.entries?.some((entry) => entry.type === "room.report.added"), "event-log did not include room.report.added");
  assert(eventLog.entries?.some((entry) => entry.type === "run.completed"), "event-log did not include run.completed");
  pass("room.event_log", "CLI renders a structured room event log", {
    entries: eventLog.entries?.length || 0
  });

  await runCliText(["room", "export", finalRoom.id, "--format", "events", "--out", eventBundlePath, "--gateway", gateway, "--token", adminToken]);
  const bundle = JSON.parse(fs.readFileSync(eventBundlePath, "utf8"));
  const validation = validateRoomEventBundle(bundle, { strictTypes: true });
  assert(validation.ok === true, "event bundle validation failed");
  assert(bundle.export_metadata?.event_count === bundle.events.length, "event bundle metadata count mismatch");
  pass("room.event_bundle", "CLI exports a strict v1 room event bundle", {
    events: bundle.events.length
  });

  const replay = replayRoomEvents(bundle);
  assert(replay.object === "agent_bus.room_replay", "SDK replay did not return a room replay object");
  assert(replay.counts.completed_runs >= 1, "SDK replay did not count the completed room run");
  assert(replay.counts.reports >= 1, "SDK replay did not count the room report");
  const cliReplay = await runCliJson(["room", "replay", "--in", eventBundlePath, "--strict"]);
  assert(cliReplay.counts.completed_runs === replay.counts.completed_runs, "CLI replay and SDK replay disagree on completed runs");
  assert(cliReplay.counts.reports === replay.counts.reports, "CLI replay and SDK replay disagree on reports");
  pass("room.event_replay", "CLI and JS SDK replay the event bundle consistently", {
    completed_runs: replay.counts.completed_runs,
    reports: replay.counts.reports
  });

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  const result = {
    ok: true,
    mode: "protocol_conformance",
    protocol: "agent-bus.v1",
    profile,
    quota: referenceAgent ? "no_model_calls" : "depends_on_agent_command",
    gateway,
    node_id: nodeId,
    agent_id: agentId,
    agent_command_provided: Boolean(externalCommand),
    room_id: finalRoom.id,
    room_status: finalRoom.status,
    checks,
    summary: {
      checks: checks.length,
      reports: finalRoom.reports?.length || 0,
      blackboard_notes: finalRoom.blackboard?.notes?.length || 0,
      event_log_entries: eventLog.entries?.length || 0,
      event_bundle_events: bundle.events.length,
      replay_completed_runs: replay.counts.completed_runs
    }
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("");
  console.log("Agent Bus protocol conformance passed");
  console.log(`Protocol: ${result.protocol}`);
  console.log(`Profile: ${result.profile}`);
  console.log(`Agent: ${result.agent_id} on ${result.node_id}`);
  console.log(`Room: ${result.room_id} (${result.room_status})`);
  console.log(`Checks: ${result.summary.checks}`);
  console.log(`Quota: ${result.quota}`);
}

function pass(id, detail, data = {}) {
  checks.push({
    id,
    ok: true,
    detail,
    ...(Object.keys(data).length ? { data } : {})
  });
}

function step(message) {
  if (!jsonOut) console.log(message);
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = { command, args: commandArgs, stdout: "", stderr: "", error: "", exit: null };
  childLogs.set(child, logs);
  child.stdout.on("data", (chunk) => {
    appendChildLog(logs, "stdout", chunk);
    if (!jsonOut && /listening|connected/.test(chunk.toString())) process.stdout.write(`  ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    appendChildLog(logs, "stderr", chunk);
    if (!jsonOut) process.stderr.write(chunk);
  });
  child.on("error", (err) => {
    logs.error = err.message || String(err);
  });
  child.on("exit", (code, signal) => {
    logs.exit = { code, signal };
  });
  procs.push(child);
  return child;
}

function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...setupPythonPaths(),
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const candidate of unique(candidates)) {
    const version = pythonVersion(candidate);
    if (version && isPythonAtLeast(version, 3, 10)) return candidate;
  }
  return "";
}

function setupPythonPaths() {
  const roots = [
    process.env.pythonLocation,
    process.env.Python_ROOT_DIR,
    process.env.Python3_ROOT_DIR,
    process.env.PYTHON_ROOT_DIR,
    process.env.PYTHON3_ROOT_DIR
  ].filter(Boolean);
  const names = process.platform === "win32"
    ? ["python.exe", "bin/python.exe", "bin/python3.exe"]
    : ["bin/python3", "bin/python", "python3", "python"];
  return roots.flatMap((rootDir) => names.map((name) => path.join(rootDir, name)));
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
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForAgent(gateway, token, agentId, timeoutMs = 10000, child = null) {
  const started = Date.now();
  let lastAgents = [];
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) {
      throw new Error(`Process exited before agent became ready.\n${formatChildDiagnostics(child)}`);
    }
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      lastAgents = agents;
      const agent = agents.find((item) => item.id === agentId);
      if (agent) return agent;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for agent ${agentId}; saw ${lastAgents.map((agent) => `${agent.id}:${agent.status}`).join(", ") || "none"}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 20000) {
  const started = Date.now();
  let lastRoom = null;
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    lastRoom = room;
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId}; status=${lastRoom?.status || "unknown"}`);
}

async function waitForJson(url, timeoutMs = 10000, child = null) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) {
      throw new Error(`Process exited before ${url} became ready.\n${formatChildDiagnostics(child)}`);
    }
    try {
      return await requestJson(url);
    } catch (err) {
      lastError = err;
      await delay(250);
    }
  }
  const cause = lastError ? `; last request error: ${lastError.message || String(lastError)}` : "";
  const diagnostics = child ? `\n${formatChildDiagnostics(child)}` : "";
  throw new Error(`Timed out waiting for ${url}${cause}${diagnostics}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

function runCliJson(cliArgs, timeoutMs = 15000) {
  return runCliText(cliArgs, timeoutMs).then((text) => JSON.parse(text));
}

function runCliText(cliArgs, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...cliArgs], {
      cwd: root,
      env: smokeChildEnv(),
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

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNonEmptyAdapterOutput(text, label) {
  assert(String(text || "").trim().length > 0, `${label} returned empty adapter output`);
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

function csvOption(argv, name) {
  const value = optionValue(argv, name);
  return value ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeProfile(value, externalCommand) {
  const profile = String(value || "").trim().toLowerCase();
  if (!profile) return externalCommand ? "adapter-command" : "local-reference-agent";
  if (["full", "reference", "local", "local-reference", "local-reference-agent"].includes(profile)) {
    return "local-reference-agent";
  }
  if (["adapter", "adapter-command", "command", "external", "external-command"].includes(profile)) {
    return "adapter-command";
  }
  throw new Error(`Unknown protocol conformance profile: ${value}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendChildLog(logs, key, chunk) {
  const limit = 24000;
  logs[key] += chunk.toString();
  if (logs[key].length > limit) logs[key] = logs[key].slice(-limit);
}

function childFailed(child) {
  const logs = childLogs.get(child);
  return Boolean(logs?.error || child.exitCode !== null || child.signalCode);
}

function formatChildDiagnostics(child) {
  const logs = childLogs.get(child);
  if (!logs) return "child diagnostics unavailable";
  const exit = logs.exit || { code: child.exitCode, signal: child.signalCode };
  const lines = [
    `child: ${logs.command} ${logs.args.join(" ")}`,
    `exit: code=${exit.code ?? "running"} signal=${exit.signal ?? ""}`
  ];
  if (logs.error) lines.push(`spawn_error: ${logs.error}`);
  if (logs.stdout.trim()) lines.push(`stdout:\n${redactDiagnostics(logs.stdout.trim())}`);
  if (logs.stderr.trim()) lines.push(`stderr:\n${redactDiagnostics(logs.stderr.trim())}`);
  return lines.join("\n");
}

function pythonVersion(candidate) {
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const match = text.match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return {
    command: candidate,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] || 0)
  };
}

function isPythonAtLeast(version, major, minor) {
  return version.major > major || (version.major === major && version.minor >= minor);
}

function unique(values) {
  return [...new Set(values)];
}

function redactDiagnostics(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\babt_edge_[A-Za-z0-9_-]{12,}\b/g, "abt_edge_[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
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
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_ROOM_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR",
  "AGENT_BUS_COMPLETION_OUTBOX_DIR"
];
