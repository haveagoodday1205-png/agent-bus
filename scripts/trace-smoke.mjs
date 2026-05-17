import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const jsonOut = process.argv.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-trace-smoke-"));

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
  if (!python) throw new Error("trace smoke requires Python 3.10+ for room support.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-trace-smoke-token-000000";
  const edgeToken = "abt_edge_trace_smoke_token_000000";
  const traceId = `trace_smoke_${Date.now().toString(36)}`;
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "trace-agent.mjs");
  const traceExport = path.join(tempDir, "trace.md");

  writeTraceAgent(agentScript);
  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
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

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "trace-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    tokenScope: "edge",
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "trace-agent",
      kind: "diagnostic",
      role: "auditor",
      enabled: true,
      adapter: "command",
      capabilities: ["trace", "room", "agent-model", "no-quota"],
      runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
    }]
  }, null, 2)}\n`);

  step("Starting trace gateway");
  const central = start(node, [path.join(root, "agent-bus.mjs"), "serve", "--runtime", "python", "--config", centralConfig], {
    AGENT_BUS_PYTHON: python,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`, 30000, central);

  step("Starting trace edge");
  const edge = start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig]);
  await waitForAgent(gateway, token, "trace-agent");

  step("Creating traced room");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      title: "Trace smoke",
      goal: "Verify trace id propagation through a room run. DONE",
      trace_id: traceId,
      agents: ["trace-agent"],
      wakeAgents: ["trace-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const finalRoom = await waitForRoom(gateway, token, room.id, "completed");
  assert(finalRoom.trace_id === traceId, "room did not keep trace_id");

  step("Calling traced agent-backed chat");
  const chat = await requestJson(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent:trace-agent",
      messages: [{ role: "user", content: "Return a traced no-quota response." }],
      metadata: { agent_bus_trace_id: traceId }
    })
  });
  assert(chat.agent_bus?.trace_id === traceId, "agent-backed chat response did not include trace_id");

  step("Looking up trace");
  const trace = await waitForTrace(gateway, token, traceId, { minRuns: 2, minEvents: 2 });
  assert(trace.summary.rooms >= 1, "trace did not include room");
  assert(trace.summary.threads >= 1, "trace did not include agent-backed thread");
  assert(trace.summary.runs >= 2, "trace did not include both runs");
  assert(trace.summary.events >= 2, "trace did not include run events");
  assert(trace.summary.agents.includes("trace-agent"), "trace did not include trace-agent");
  assert(trace.runs.every((run) => run.trace_id === traceId), "at least one run lost trace_id");

  step("Verifying trace CLI");
  const human = await runCli(["trace", "show", traceId, "--gateway", gateway, "--token", token]);
  assert(human.includes(`Trace ${traceId}`), "trace show did not print human summary");
  await runCli(["trace", "export", traceId, "--format", "markdown", "--out", traceExport, "--gateway", gateway, "--token", token]);
  const markdown = fs.readFileSync(traceExport, "utf8");
  assert(markdown.includes(`# Agent Bus Trace ${traceId}`), "trace export did not write markdown");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  const jsTrace = await runNodeGatewayTrace(agentScript);

  const result = {
    ok: true,
    quota: "no_model_calls",
    gateway,
    trace_id: traceId,
    room_id: room.id,
    chat_run_id: chat.agent_bus?.run_id,
    summary: trace.summary,
    node_gateway_trace_id: jsTrace.trace_id,
    node_gateway_summary: jsTrace.summary
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("trace smoke ok");
    console.log(`Trace: ${traceId}`);
    console.log(`Room: ${room.id}`);
    console.log(`Runs: ${trace.summary.runs}, events: ${trace.summary.events}`);
    console.log(`Node gateway trace: ${jsTrace.trace_id}`);
  }
}

async function runNodeGatewayTrace(agentScript) {
  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-trace-node-token-000000";
  const edgeToken = "abt_edge_trace_node_token_000000";
  const traceId = `trace_node_${Date.now().toString(36)}`;
  const centralConfig = path.join(tempDir, "central-node.config.json");
  const edgeConfig = path.join(tempDir, "edge-node-trace.config.json");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data-node"),
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

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "trace-node-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    tokenScope: "edge",
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "trace-node-agent",
      kind: "diagnostic",
      role: "auditor",
      enabled: true,
      adapter: "command",
      capabilities: ["trace", "thread", "no-quota"],
      runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
    }]
  }, null, 2)}\n`);

  step("Starting Node trace gateway");
  const central = start(node, [path.join(root, "central-gateway.mjs"), "serve", "--config", centralConfig]);
  await waitForJson(`${gateway}/health`, 30000, central);

  step("Starting Node trace edge");
  const edge = start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig]);
  await waitForAgent(gateway, token, "trace-node-agent");

  step("Creating traced direct thread on Node gateway");
  await requestJson(`${gateway}/threads`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      message: "Verify Node gateway trace propagation. DONE",
      trace_id: traceId,
      agents: ["trace-node-agent"]
    })
  });
  const trace = await waitForTrace(gateway, token, traceId, { minRuns: 1, minEvents: 2 });
  assert(trace.summary.agents.includes("trace-node-agent"), "Node gateway trace did not include trace-node-agent");
  assert(trace.runs.every((run) => run.trace_id === traceId), "Node gateway run lost trace_id");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);
  return { trace_id: traceId, summary: trace.summary };
}

function writeTraceAgent(file) {
  fs.writeFileSync(file, `const trace = process.env.AGENT_TRACE_ID || "";\nconst id = process.env.AGENT_ID || "trace-agent";\nif (!trace) {\n  console.error("missing AGENT_TRACE_ID");\n  process.exit(2);\n}\nconsole.log(\`REPORT: \${id} saw trace \${trace}.\`);\nconsole.log(\`BLACKBOARD: trace_id=\${trace}\`);\nconsole.log("DONE");\n`);
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
    appendLog(logs, "stdout", chunk);
    if (!jsonOut && /listening|connected/.test(chunk.toString())) process.stdout.write(`  ${chunk}`);
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

function runCli(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      env: smokeChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus ${args.join(" ")} timed out\n${stderr || stdout}`));
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

async function waitForAgent(gateway, token, agentId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      if (agents.some((agent) => agent.id === agentId && agent.status === "online")) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${agentId}\n${formatChildDiagnostics(procs[procs.length - 1])}`);
}

async function waitForRoom(gateway, token, roomId, status, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.status === status) return room;
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId} to become ${status}`);
}

async function waitForTrace(gateway, token, traceId, { minRuns = 1, minEvents = 1 } = {}, timeoutMs = 15000) {
  const started = Date.now();
  let lastTrace = null;
  while (Date.now() - started < timeoutMs) {
    try {
      lastTrace = await requestJson(`${gateway}/traces/${encodeURIComponent(traceId)}`, { headers: authHeaders(token) });
      if ((lastTrace.summary?.runs || 0) >= minRuns && (lastTrace.summary?.events || 0) >= minEvents) return lastTrace;
    } catch {
      // Retry until the gateway has persisted the trace.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for trace ${traceId}: ${JSON.stringify(lastTrace?.summary || null)}`);
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
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  };
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
