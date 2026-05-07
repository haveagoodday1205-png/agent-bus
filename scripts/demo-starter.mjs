import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentBusClient } from "../sdk/js/agent-bus-sdk.mjs";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-starter-demo-"));

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
  if (!python) throw new Error("Starter demo requires Python 3.10+ for room support.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-starter-demo-token-000000";
  const edgeToken = "abt_edge_starter_demo_token_000000";
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "starter-agent.mjs");
  const reportPath = jsonOut
    ? path.join(tempDir, "agent-bus-starter-report.md")
    : uniqueOutputPath(path.join(process.cwd(), "agent-bus-starter-report.md"));
  const adminClient = new AgentBusClient({ gatewayUrl: gateway, token });
  const edgeClient = new AgentBusClient({ gatewayUrl: gateway, token: edgeToken });

  writeStarterAgent(agentScript);
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
    nodeId: "starter-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [
      {
        id: "starter-planner",
        kind: "demo",
        role: "planner",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "planning", "agent-model", "demo"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      },
      {
        id: "starter-worker",
        kind: "demo",
        role: "executor",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "verification", "agent-model", "demo"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      }
    ]
  }, null, 2)}\n`);

  step("Starting a private local gateway");
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`, 30000, central);

  step("Starting one edge with two toy agents");
  const edge = start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  await waitForAgents(adminClient, ["starter-planner", "starter-worker"]);

  step("Creating a two-agent room");
  const room = await adminClient.createRoom({
    title: "Agent Bus starter kit demo",
    goal: "Prove a no-quota Agent Bus starter path: room delegation, agent-backed model calls, and reports-only export.",
    agents: ["starter-planner", "starter-worker"],
    wakeAgents: ["starter-planner"],
    auto_rotate: false,
    max_steps: 4
  });
  const finalRoom = await waitForRoomComplete(adminClient, room.id);

  step("Calling the worker as an OpenAI-compatible chat model");
  const models = await edgeClient.models();
  assert(hasModel(models, "agent:starter-planner"), "model list did not expose agent:starter-planner");
  assert(hasModel(models, "agent:starter-worker"), "model list did not expose agent:starter-worker");
  const chat = await edgeClient.agentChat("starter-worker", [
    { role: "user", content: "Reply through the starter worker model." }
  ], {
    metadata: { agent_bus_cache_scope: "starter-kit-demo" }
  });
  const chatContent = chat.choices?.[0]?.message?.content || "";
  assert(/starter-worker/.test(chatContent), "chat completion did not route through starter-worker");

  step("Calling the worker through the Responses API");
  const response = await edgeClient.agentResponse("starter-worker", "Reply through the starter Responses model.", {
    metadata: { agent_bus_cache_scope: "starter-kit-demo" }
  });
  assert(response.status === "completed", "Responses API call did not complete");
  assert(/starter-worker/.test(response.output_text || ""), "Responses API did not route through starter-worker");

  step("Exporting a reports-only Markdown artifact");
  await runCli(["room", "export", finalRoom.id, "--reports-only", "--out", reportPath, "--gateway", gateway, "--token", token]);
  const reportText = fs.readFileSync(reportPath, "utf8");
  assert(/starter-worker/.test(reportText), "reports-only export did not include worker report");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  const result = {
    ok: true,
    mode: "starter",
    quota: "no_model_calls",
    gateway,
    agents: ["starter-planner", "starter-worker"],
    models: ["agent:starter-planner", "agent:starter-worker"],
    room_id: finalRoom.id,
    room_status: finalRoom.status,
    reports: finalRoom.reports?.length || 0,
    chat_run_id: chat.agent_bus?.run_id,
    response_run_id: response.agent_bus?.run_id,
    report_path: reportPath
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("");
    console.log("Agent Bus starter demo passed");
    console.log(`Gateway: ${result.gateway}`);
    console.log(`Room: ${result.room_id} (${result.room_status})`);
    console.log(`Models: ${result.models.join(", ")}`);
    console.log(`Reports-only export: ${result.report_path}`);
  }
}

function writeStarterAgent(file) {
  fs.writeFileSync(file, `import fs from "node:fs";\n\nconst id = process.env.AGENT_ID || "starter-agent";\nconst messageFile = process.env.AGENT_MESSAGE_FILE || "";\nlet message = process.env.AGENT_MESSAGE || "";\nlet source = message ? "env" : "empty";\nif (messageFile && fs.existsSync(messageFile)) {\n  message = fs.readFileSync(messageFile, "utf8");\n  source = "file";\n}\nconst preview = message.replace(/\\s+/g, " ").slice(0, 120);\nconsole.log(\`REPORT: \${id} received starter task through AGENT_MESSAGE_\${source.toUpperCase()}.\`);\nif (id === "starter-planner") {\n  console.log("REPORT: starter-planner created the room plan and delegated verification to starter-worker.");\n  console.log("BLACKBOARD: starter-worker should verify room delegation, agent-backed model routing, and reports-only export.");\n  console.log("@starter-worker: Verify the starter room, summarize what worked, and mark DONE when complete.");\n} else {\n  console.log(\`REPORT: starter-worker verified room delegation and agent-backed model execution. Latest task: \${preview}\`);\n  console.log("BLACKBOARD: Starter kit completed without external model quota or private credentials.");\n  console.log("DONE");\n}\n`);
}

function step(message) {
  if (!jsonOut) console.log(message);
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: { ...process.env, ...env },
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

function runCli(cliArgs, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...cliArgs], {
      cwd: root,
      env: { ...process.env },
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

async function waitForAgents(client, agentIds, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await client.agents();
      const online = new Set(agents.filter((agent) => agent.status === "online").map((agent) => agent.id));
      if (agentIds.every((id) => online.has(id))) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForRoomComplete(client, roomId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await client.room(roomId);
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
    const result = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore"
    });
    if (!result.error && result.status === 0) return candidate;
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
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function hasModel(models, modelId) {
  return models.data?.some((item) => item.id === modelId);
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

function uniqueOutputPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  const parsed = path.parse(basePath);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused report path near ${basePath}`);
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
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
