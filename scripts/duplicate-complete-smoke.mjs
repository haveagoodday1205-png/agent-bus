import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const jsonOut = process.argv.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-duplicate-complete-"));
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
}).finally(async () => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
    await waitForExit(child);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-duplicate-complete-smoke-token-000000";
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

  step("Starting Node central");
  const central = start(node, [path.join(root, "central-gateway.mjs"), "serve", "--config", configPath]);
  await waitForJson(`${gateway}/health`, 15000, central);

  step("Registering a fake edge node");
  await requestJson(`${gateway}/edge/register`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "duplicate-edge",
      hostname: "duplicate-complete-smoke",
      agents: [{
        id: "duplicate-agent",
        kind: "smoke",
        role: "worker",
        capabilities: ["thread", "no-quota", "duplicate-complete"]
      }]
    })
  });

  step("Creating a queued thread run");
  const thread = await requestJson(`${gateway}/threads`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      message: "Verify duplicate /edge/complete idempotency without model quota.",
      mode: "orchestrate",
      agents: ["duplicate-agent"],
      source: "duplicate-complete-smoke"
    })
  });
  const runId = thread.runs?.[0]?.id;
  assert(runId, "thread did not create a run");
  const traceId = thread.trace_id;
  assert(traceId, "thread did not record a trace_id");
  const runJsonlPath = path.join(dataDir, "runs.jsonl");
  const runEntriesBeforeComplete = runJsonlCount(runJsonlPath, runId);
  assert(runEntriesBeforeComplete === 1, `queued run should have exactly one runs.jsonl entry, found ${runEntriesBeforeComplete}`);

  step("Polling the queued run");
  const polled = await requestJson(`${gateway}/edge/poll`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ node_id: "duplicate-edge", timeout_ms: 10 })
  });
  assert(polled.type === "task", `edge poll did not return a task: ${JSON.stringify(polled)}`);
  assert(polled.task?.run_id === runId, "edge poll returned the wrong run");

  step("Marking the run started");
  await requestJson(`${gateway}/edge/events`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "duplicate-edge",
      run_id: runId,
      trace_id: traceId,
      event: { type: "run.started" }
    })
  });
  const startedRun = await requestJson(`${gateway}/runs/${encodeURIComponent(runId)}`, {
    headers: authHeaders(token)
  });
  assert(startedRun.status === "running", `run did not enter running state after run.started: ${startedRun.status}`);
  assert(startedRun.started_at, "run.started did not persist started_at");
  const traceBeforeComplete = await requestJson(`${gateway}/traces/${encodeURIComponent(traceId)}`, {
    headers: authHeaders(token)
  });
  assert(traceBeforeComplete.summary?.events === 1, `expected exactly one trace event before completion, found ${traceBeforeComplete.summary?.events}`);

  const completionBody = {
    node_id: "duplicate-edge",
    run_id: runId,
    trace_id: traceId,
    result: {
      status: "completed",
      exit_code: 0,
      stdout: "REPORT: duplicate complete smoke accepted the first terminal result.\nBLACKBOARD: duplicate /edge/complete is idempotent for exact replays.\nDONE\n",
      summary: "duplicate completion smoke"
    }
  };

  step("Submitting the first terminal result");
  const completedRun = await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify(completionBody)
  });
  assert(completedRun.status === "completed", "first completion did not persist completed status");
  assert(completedRun.completed_at, "first completion did not persist completed_at");
  assert(completedRun.stdout === completionBody.result.stdout, "first completion did not persist stdout");
  const runEntriesAfterComplete = runJsonlCount(runJsonlPath, runId);
  assert(runEntriesAfterComplete === runEntriesBeforeComplete + 1, "first completion did not append exactly one runs.jsonl entry");
  const traceAfterComplete = await requestJson(`${gateway}/traces/${encodeURIComponent(traceId)}`, {
    headers: authHeaders(token)
  });
  assert(traceAfterComplete.summary?.events === traceBeforeComplete.summary?.events, "first completion unexpectedly changed trace event count");

  await delay(1100);

  step("Replaying the exact same terminal result");
  const duplicateRun = await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify(completionBody)
  });
  assert(duplicateRun.completed_at === completedRun.completed_at, "duplicate completion changed completed_at");
  assert(duplicateRun.stdout === completedRun.stdout, "duplicate completion changed stdout");
  assert(runJsonlCount(runJsonlPath, runId) === runEntriesAfterComplete, "duplicate completion appended an extra runs.jsonl entry");
  const traceAfterDuplicate = await requestJson(`${gateway}/traces/${encodeURIComponent(traceId)}`, {
    headers: authHeaders(token)
  });
  assert(traceAfterDuplicate.summary?.events === traceAfterComplete.summary?.events, "duplicate completion appended an extra trace event");

  step("Rejecting a conflicting duplicate terminal result");
  const conflict = await fetch(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      ...completionBody,
      result: {
        ...completionBody.result,
        stdout: "REPORT: conflicting duplicate completion should be rejected.\n",
        summary: "conflicting duplicate completion"
      }
    })
  });
  const conflictText = await conflict.text();
  assert(conflict.status === 409, `conflicting duplicate completion returned ${conflict.status}: ${conflictText}`);

  const finalRun = await requestJson(`${gateway}/runs/${encodeURIComponent(runId)}`, {
    headers: authHeaders(token)
  });
  assert(finalRun.status === "completed", "conflicting duplicate completion changed the stored terminal status");
  assert(finalRun.completed_at === completedRun.completed_at, "conflicting duplicate completion changed completed_at");
  assert(finalRun.stdout === completionBody.result.stdout, "conflicting duplicate completion overwrote stdout");
  assert(runJsonlCount(runJsonlPath, runId) === runEntriesAfterComplete, "conflicting duplicate completion appended another runs.jsonl entry");
  const traceAfterConflict = await requestJson(`${gateway}/traces/${encodeURIComponent(traceId)}`, {
    headers: authHeaders(token)
  });
  assert(traceAfterConflict.summary?.events === traceAfterComplete.summary?.events, "conflicting duplicate completion appended an extra trace event");

  const finalThread = await requestJson(`${gateway}/threads/${encodeURIComponent(thread.id)}`, {
    headers: authHeaders(token)
  });
  const threadRun = finalThread.runs?.find((run) => run.id === runId);
  assert(threadRun?.status === "completed", "thread snapshot lost the terminal run status");
  assert(threadRun?.stdout === completionBody.result.stdout, "thread snapshot stored the wrong terminal stdout");

  await stopChild(central);

  const result = {
    ok: true,
    quota: "no_model_calls",
    gateway_runtime: "node",
    thread_id: thread.id,
    run_id: runId,
    trace_id: traceId,
    duplicate_complete_preserved_terminal_result: true
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("duplicate complete smoke ok");
    console.log(`Thread: ${thread.id}`);
    console.log(`Run: ${runId}`);
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

function redactDiagnostics(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
}
