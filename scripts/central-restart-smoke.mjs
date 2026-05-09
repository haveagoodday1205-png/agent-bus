import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-central-restart-"));
const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
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
  if (!python) throw new Error("central restart smoke requires Python 3.10+.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-central-restart-smoke-token-000000";
  const traceId = `trace_restart_${Date.now().toString(36)}`;
  const configPath = path.join(tempDir, "central.config.json");
  const dataDir = path.join(tempDir, "data");

  fs.writeFileSync(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir,
    token,
    defaults: { mode: "orchestrate", pollTimeoutMs: 500 },
    modelRouter: { enabled: false, backends: [] }
  }, null, 2)}\n`);

  step("Starting central");
  let central = startCentral(python, configPath, token, port, dataDir);
  await waitForJson(`${gateway}/health`, 15000, central);

  step("Registering node and creating a queued room run");
  await requestJson(`${gateway}/edge/register`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "restart-edge",
      hostname: "restart-smoke",
      agents: [{
        id: "restart-agent",
        kind: "smoke",
        role: "worker",
        capabilities: ["restart", "room", "no-quota"]
      }]
    })
  });
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Central restart recovery smoke",
      goal: "Verify central restart keeps room, trace, node inventory, and queued run recovery.",
      trace_id: traceId,
      agents: ["restart-agent"],
      wakeAgents: ["restart-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const runId = room.runs?.[0]?.id;
  assert(runId, "room did not create an initial run");

  step("Restarting central");
  await stopChild(central);
  central = startCentral(python, configPath, token, port, dataDir);
  await waitForJson(`${gateway}/health`, 15000, central);

  step("Verifying recovered state");
  const health = await requestJson(`${gateway}/health`);
  assert(health.registered_nodes === 1, "restart did not restore registered node inventory");
  assert(health.registered_agents === 1, "restart did not restore registered agent inventory");
  assert(health.queued === 1, "restart did not recover queued run");
  const rooms = await requestJson(`${gateway}/rooms`, { headers: authHeaders(token) });
  assert(rooms.some((item) => item.id === room.id && item.status === "active"), "restart did not restore room listing");
  const trace = await requestJson(`${gateway}/traces/${encodeURIComponent(traceId)}`, { headers: authHeaders(token) });
  assert(trace.summary.rooms === 1, "restart trace lookup did not include room");
  assert(trace.summary.runs === 1, "restart trace lookup did not include queued run");

  step("Polling recovered task and completing it");
  const polled = await requestJson(`${gateway}/edge/poll`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ node_id: "restart-edge", timeout_ms: 1 })
  });
  assert(polled?.task?.run_id === runId, "edge poll did not return the recovered queued run");
  await requestJson(`${gateway}/edge/events`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "restart-edge",
      run_id: runId,
      trace_id: traceId,
      event: { type: "run.started" }
    })
  });
  const runJsonlPath = path.join(dataDir, "runs.jsonl");
  const runEntriesBeforeComplete = runJsonlCount(runJsonlPath, runId);
  const completionBody = {
    node_id: "restart-edge",
    run_id: runId,
    trace_id: traceId,
    result: {
      status: "completed",
      exit_code: 0,
      stdout: "REPORT: recovered queued run completed after central restart.\nBLACKBOARD: restart recovery ok.\nDONE\n"
    }
  };
  const completedRun = await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify(completionBody)
  });
  assert(completedRun.status === "completed", "completed run did not persist after recovery");
  assert(completedRun.completed_at, "completed run did not record completed_at");
  const finalRoom = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}`, { headers: authHeaders(token) });
  assert(finalRoom.status === "completed", "room did not complete after recovered run completion");
  assert(finalRoom.reports?.some((report) => /recovered queued run/.test(report.content || "")), "room did not process recovered run report");
  const runEntriesAfterComplete = runJsonlCount(runJsonlPath, runId);
  assert(runEntriesAfterComplete === runEntriesBeforeComplete + 1, "first completion did not append exactly one runs.jsonl entry");
  await delay(1100);
  const duplicateRun = await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify(completionBody)
  });
  assert(duplicateRun.completed_at === completedRun.completed_at, "duplicate completion changed completed_at");
  assert(runJsonlCount(runJsonlPath, runId) === runEntriesAfterComplete, "duplicate completion appended a second runs.jsonl entry");
  const duplicateRoom = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}`, { headers: authHeaders(token) });
  const restartReports = (duplicateRoom.reports || []).filter((report) => /recovered queued run/.test(report.content || ""));
  assert(restartReports.length === 1, "duplicate completion replayed the room report");
  const conflict = await fetch(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      ...completionBody,
      result: {
        ...completionBody.result,
        stdout: "REPORT: conflicting duplicate completion should be rejected.\n"
      }
    })
  });
  const conflictText = await conflict.text();
  assert(conflict.status === 409, `conflicting duplicate completion returned ${conflict.status}: ${conflictText}`);
  const finalHealth = await requestJson(`${gateway}/health`);
  assert(finalHealth.queued === 0, "gateway queue was not drained after recovered task");

  await stopChild(central);

  const result = {
    ok: true,
    quota: "no_model_calls",
    mode: "restart_recovery",
    room_id: room.id,
    run_id: runId,
    trace_id: traceId,
    recovered_queue: true
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("central restart smoke ok");
    console.log(`Room: ${room.id}`);
    console.log(`Run: ${runId}`);
    console.log("Quota: no model calls");
  }
}

function startCentral(python, configPath, token, port, dataDir) {
  return start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir
  });
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
  child.stdout.on("data", (chunk) => appendLog(logs, "stdout", chunk));
  child.stderr.on("data", (chunk) => appendLog(logs, "stderr", chunk));
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

async function stopChild(child) {
  if (child.killed || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await waitForExit(child);
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

function runJsonlCount(file, runId) {
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.id === runId)
    .length;
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
