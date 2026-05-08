import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-python-room-agent-"));

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
  if (!python) throw new Error("Python room-agent smoke requires Python 3.10+.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-python-room-agent-smoke-token-000000";
  const edgeToken = "abt_edge_python_room_agent_smoke_000000";
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(root, "examples", "room-agent-python", "room_agent.py");
  const eventsPath = path.join(tempDir, "python-room-events.json");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: { mode: "orchestrate", pollTimeoutMs: 1000 },
    edgeTokens: [edgeToken],
    modelRouter: { enabled: false, backends: [] }
  }, null, 2)}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "python-room-agent-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    tokenScope: "edge",
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "python-room-agent",
      kind: "python",
      role: "worker",
      enabled: true,
      adapter: "command",
      capabilities: ["room", "report", "blackboard", "no-quota"],
      runCommand: `${quoteCommandArg(python)} ${quoteCommandArg(agentScript)}`
    }]
  }, null, 2)}\n`);

  step("Starting Python central");
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`, 15000, central);

  step("Starting Node edge with Python room agent");
  const edge = start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig]);
  const agent = await waitForAgent(gateway, token, "python-room-agent", 10000, edge);
  assert(agent.status === "online", "Python room agent did not register online");
  assert(agent.kind === "python", "Python room agent did not expose kind=python");
  assert(agent.ping_status === "not_configured", "Python room agent should not require a pingUrl");

  step("Creating room");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Python room-agent smoke",
      goal: "Verify a Python command agent can join an Agent Bus room and emit REPORT, BLACKBOARD, and DONE.",
      agents: ["python-room-agent"],
      wakeAgents: ["python-room-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });

  const finalRoom = await waitForRoomComplete(gateway, token, room.id);
  const run = finalRoom.runs?.find((item) => item.agent_id === "python-room-agent");
  assert(finalRoom.status === "completed", "Python room-agent room did not complete");
  assert(run?.status === "completed", "Python room-agent run did not complete");
  assert(/python-room-agent received room=/.test(run?.stdout || ""), "Python room agent stdout did not include REPORT");
  assert(finalRoom.reports?.some((item) => /python-room-agent received room=/.test(item.content || "")), "REPORT directive was not captured");
  assert(finalRoom.blackboard?.notes?.some((item) => /AGENT_MESSAGE_FILE/.test(item.content || "")), "BLACKBOARD directive was not captured");
  assert((run?.stdout || "").includes("DONE"), "Python room agent did not emit DONE");

  step("Verifying room export and replay");
  await runCli(["room", "export", finalRoom.id, "--format", "events", "--out", eventsPath, "--gateway", gateway, "--token", token]);
  const bundle = JSON.parse(fs.readFileSync(eventsPath, "utf8"));
  assert(bundle.events?.some((event) => event.type === "run.completed"), "event bundle did not include run.completed");
  assert(bundle.events?.some((event) => event.type === "room.report.added"), "event bundle did not include room.report.added");
  const replay = JSON.parse(await runCli(["room", "replay", "--in", eventsPath]));
  assert(replay.counts?.completed_runs === 1, "event replay did not count the completed Python run");
  assert(replay.counts?.reports === 1, "event replay did not count the Python report");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");

  const result = {
    ok: true,
    quota: "no_model_calls",
    mode: "python_room_agent",
    gateway,
    room_id: finalRoom.id,
    run_id: run.id,
    reports: finalRoom.reports?.length || 0,
    blackboard_notes: finalRoom.blackboard?.notes?.length || 0,
    event_count: bundle.events?.length || 0
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("python room-agent smoke ok");
    console.log(`Room: ${result.room_id}`);
    console.log(`Run: ${result.run_id}`);
    console.log("Quota: no model calls");
  }
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
    if (!jsonOut) {
      const text = chunk.toString("utf8");
      if (/listening|connected/.test(text)) process.stdout.write(text);
    }
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

function runCli(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      env: smokeChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus ${args.join(" ")} timed out`));
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
      reject(new Error(`agent-bus ${args.join(" ")} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

async function waitForAgent(gateway, token, agentId, timeoutMs = 10000, child = null) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) {
      throw new Error(`Process exited before ${agentId} became ready.\n${formatChildDiagnostics(child)}`);
    }
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      const agent = agents.find((item) => item.id === agentId && item.status === "online");
      if (agent) return agent;
    } catch (err) {
      lastError = err;
      // Retry until the edge registers.
    }
    await delay(250);
  }
  const cause = lastError ? `: ${lastError.message || String(lastError)}` : "";
  const diagnostics = child ? `\n${formatChildDiagnostics(child)}` : "";
  throw new Error(`Timed out waiting for ${agentId}${cause}${diagnostics}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId}`);
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
  const diagnostics = child ? `\n${formatChildDiagnostics(child)}` : "";
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "no response"}${diagnostics}`);
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
    const result = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
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
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
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

function appendLog(logs, key, chunk) {
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

function unique(values) {
  return [...new Set(values)];
}

function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
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

function redactDiagnostics(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\babt_edge_[A-Za-z0-9_-]{12,}\b/g, "abt_edge_[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
}
