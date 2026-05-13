import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-python-heartbeat-"));
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
  if (!python) throw new Error("python edge heartbeat smoke requires Python 3.6+.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-python-heartbeat-smoke-token-000000";
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const dataDir = path.join(tempDir, "data");
  const agentScript = path.join(tempDir, "python-heartbeat-agent.mjs");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir,
    token,
    defaults: { mode: "orchestrate", pollTimeoutMs: 500 },
    modelRouter: { enabled: false, backends: [] },
    edgeTokens: [{ token, nodeId: "python-heartbeat-edge", label: "python heartbeat smoke" }]
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, [
    "await new Promise((resolve) => setTimeout(resolve, 4500));",
    'console.log("REPORT: python edge heartbeat kept the node fresh during a long run.");',
    'console.log("BLACKBOARD: python edge now emits run heartbeats during long tasks.");',
    'console.log("BLACKBOARD: wake reason " + (process.env.AGENT_WAKE_REASON || ""));',
    'console.log("DONE");'
  ].join("\n"));

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "python-heartbeat-edge",
    gatewayUrl: gateway,
    token,
    pollTimeoutMs: 500,
    idleDelayMs: 50,
    defaultTimeoutMs: 12000,
    runHeartbeatIntervalMs: 300,
    agents: [
      {
        id: "python-heartbeat-worker",
        kind: "smoke",
        role: "worker",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "heartbeat", "no-quota"],
        runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(agentScript)}`
      }
    ]
  }, null, 2)}\n`);

  step("Starting Python central");
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir,
    AGENT_BUS_NODE_STALE_SECONDS: "2"
  });
  await waitForJson(`${gateway}/health`, 15000, central);

  step("Starting Python edge");
  const edge = start(python, [path.join(root, "edge_node.py"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig,
    AGENT_BUS_GATEWAY_URL: gateway,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_NODE_ID: "python-heartbeat-edge"
  });
  await waitForAgents(gateway, token, ["python-heartbeat-worker"], 15000, edge);

  step("Creating a long-running room task");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Python edge heartbeat smoke",
      goal: "Verify long Python-edge runs keep the node fresh via run heartbeats.",
      agents: ["python-heartbeat-worker"],
      wakeAgents: ["python-heartbeat-worker"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const runId = room.runs?.[0]?.id;
  assert(runId, "room did not create a run");
  await waitForRunStatus(gateway, token, room.id, "python-heartbeat-worker", "running", 10000);

  step("Checking mid-run freshness past the stale threshold");
  await delay(3200);
  const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
  assert(agents.some((agent) => agent.id === "python-heartbeat-worker" && agent.status === "online"), "python edge agent went offline during the long run");
  const status = await runCliJson(["status", "--json", "--gateway", gateway, "--token", token, "--stale-seconds", "2"]);
  const statusNode = status.nodes?.find((node) => node.id === "python-heartbeat-edge");
  const statusAgent = status.agents?.find((agent) => agent.id === "python-heartbeat-worker");
  const statusRoom = status.rooms?.find((item) => item.id === room.id);
  assert(status.summary?.busy_agents === 1, "CLI status did not keep the python edge worker marked busy");
  assert(statusNode?.freshness?.startsWith("online/fresh"), `CLI status marked the python edge node stale mid-run: ${statusNode?.freshness || "missing"}`);
  assert(statusAgent?.freshness?.startsWith("online/fresh"), `CLI status marked the python edge agent stale mid-run: ${statusAgent?.freshness || "missing"}`);
  assert(statusAgent?.activity === "running", "CLI status did not keep the python edge agent activity as running");
  assert(statusRoom?.active_runs?.includes(runId), "CLI status lost the long-running room run while the python edge worker was still executing");

  step("Waiting for completion");
  const completed = await waitForRoomComplete(gateway, token, room.id, 15000);
  assert(completed.status === "completed", "room did not complete after the long python edge run");
  assert(completed.reports?.some((report) => /heartbeat kept the node fresh/.test(report.content || "")), "room did not retain the python heartbeat report");
  assert(completed.blackboard?.notes?.some((item) => /wake reason Initial room wake\./.test(item.content || "")), "python edge did not expose AGENT_WAKE_REASON to the command adapter");

  step("Checking duplicate completion idempotency");
  const beforeCounts = roomCounts(completed);
  const completedRun = completed.runs?.find((run) => run.id === runId);
  assert(completedRun, "completed room did not retain the run snapshot");
  await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "python-heartbeat-edge",
      run_id: runId,
      trace_id: completed.trace_id || "",
      result: {
        status: completedRun.status,
        exit_code: completedRun.exit_code,
        stdout: completedRun.stdout || "",
        stderr: completedRun.stderr || "",
        summary: completedRun.summary || ""
      }
    })
  });
  const afterDuplicate = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}`, { headers: authHeaders(token) });
  const afterCounts = roomCounts(afterDuplicate);
  assert(afterCounts.messages === beforeCounts.messages, "duplicate complete added another room message");
  assert(afterCounts.reports === beforeCounts.reports, "duplicate complete added another room report");
  assert(afterCounts.runs === beforeCounts.runs, "duplicate complete changed room run count");

  const result = {
    ok: true,
    quota: "no_model_calls",
    mode: "python_edge_heartbeat",
    room_id: room.id,
    run_id: runId,
    node_freshness: statusNode?.freshness || null,
    agent_freshness: statusAgent?.freshness || null,
    duplicate_complete_idempotent: true
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("python edge heartbeat smoke ok");
    console.log(`Room: ${room.id}`);
    console.log(`Run: ${runId}`);
    console.log("Quota: no model calls");
  }

  edge.kill("SIGTERM");
  central.kill("SIGTERM");
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = { command, args, stdout: "", stderr: "", error: "", exit: null };
  childLogs.set(child, logs);
  child.stdout.on("data", (chunk) => {
    appendLog(logs, "stdout", chunk);
    if (!jsonOut) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    appendLog(logs, "stderr", chunk);
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
      await delay(200);
    }
  }
  const diagnostics = child ? `\n${formatChildDiagnostics(child)}` : "";
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "no response"}${diagnostics}`);
}

async function waitForAgents(gateway, token, agentIds, timeoutMs = 10000, child = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) {
      throw new Error(`Edge exited before registering agents.\n${formatChildDiagnostics(child)}`);
    }
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      const online = new Set(agents.filter((agent) => agent.status === "online").map((agent) => agent.id));
      if (agentIds.every((id) => online.has(id))) return;
    } catch {
      // Keep polling until the edge registers.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForRunStatus(gateway, token, roomId, agentId, status, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.runs?.some((run) => run.agent_id === agentId && run.status === status)) return room;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${agentId} run status ${status}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    await delay(200);
  }
  throw new Error(`Timed out waiting for room ${roomId}`);
}

async function runCliJson(args) {
  const result = spawnSync(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: smokeChildEnv()
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-bus ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || "{}");
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

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const candidate of unique(candidates)) {
    const result = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 6) else 1)"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore"
    });
    if (!result.error && result.status === 0) return candidate;
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

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const free = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(free));
    });
  });
}

function roomCounts(room) {
  return {
    messages: (room.messages || []).length,
    reports: (room.reports || []).length,
    runs: (room.runs || []).length
  };
}

function appendLog(logs, key, chunk) {
  const limit = 20000;
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

function quoteCommandArg(value) {
  const text = String(value || "");
  if (!text) return process.platform === "win32" ? '""' : "''";
  if (process.platform === "win32") return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function step(message) {
  if (!jsonOut) console.log(message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values) {
  return [...new Set(values)];
}

function redactDiagnostics(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
}
