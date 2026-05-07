import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { AgentBusClient } from "../sdk/js/agent-bus-sdk.mjs";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-compat-smoke-"));

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
    throw new Error("compatibility smoke requires Python 3.10+ because the Python gateway currently owns room support.");
  }

  const gatewayPort = await freePort();
  const token = "sk-compat-smoke-token-000000";
  const edgeToken = "abt_edge_compat_smoke_token_000000";
  const base = `http://127.0.0.1:${gatewayPort}`;
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const helloAgent = path.join(root, "examples", "hello-agent", "hello-agent.mjs");
  const adminClient = new AgentBusClient({ gatewayUrl: base, token });
  const edgeClient = new AgentBusClient({ gatewayUrl: base, token: edgeToken });

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

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "compat-hello-node",
    gatewayUrl: base,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "hello-agent",
      kind: "example",
      role: "worker",
      enabled: true,
      adapter: "command",
      capabilities: ["hello", "protocol-v1", "offline"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(helloAgent)}`
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
  const agent = await waitForAgent(base, token, "hello-agent");
  assert(agent.status === "online", "hello-agent was not advertised as online");
  assert(agent.node_id === "compat-hello-node", "hello-agent advertised the wrong node_id");
  assert(agent.capabilities?.includes("protocol-v1"), "hello-agent did not advertise protocol-v1 capability");

  const manifest = await edgeClient.manifest();
  assert(manifest.protocol === "agent-bus.v1", "edge token could not read the manifest");
  assert(manifest.agents?.some((item) => item.id === "hello-agent"), "manifest did not include hello-agent");

  const models = await edgeClient.models();
  assert(models.data?.some((item) => item.id === "agent:hello-agent"), "edge model list did not include agent:hello-agent");
  assert(!models.data?.some((item) => item.id === "agent-bus-default"), "edge model list exposed backend aliases");

  const chat = await edgeClient.agentChat("hello-agent", [
    { role: "user", content: "Compatibility chat request from Agent Bus smoke." }
  ]);
  const chatContent = chat.choices?.[0]?.message?.content || "";
  assert(chat.model === "agent:hello-agent", "agent-backed chat completion returned the wrong model");
  assert(chat.agent_bus?.agent_id === "hello-agent", "agent-backed chat completion omitted agent_bus metadata");
  assert(/REPORT: hello-agent received/.test(chatContent), "agent-backed chat completion did not route through hello-agent");
  assert(/BLACKBOARD: hello-agent message_source=file/.test(chatContent), "agent-backed chat completion did not pass task through AGENT_MESSAGE_FILE");

  const response = await edgeClient.agentResponse(
    "hello-agent",
    "Compatibility Responses request from Agent Bus smoke."
  );
  assert(response.status === "completed", "agent-backed response did not complete");
  assert(response.agent_bus?.agent_id === "hello-agent", "agent-backed response omitted agent_bus metadata");
  assert(/REPORT: hello-agent received/.test(response.output_text || ""), "agent-backed response did not route through hello-agent");
  assert(/BLACKBOARD: hello-agent message_source=file/.test(response.output_text || ""), "agent-backed response did not pass task through AGENT_MESSAGE_FILE");

  const room = await adminClient.createRoom({
    title: "Hello agent compatibility smoke",
    goal: "Verify examples/hello-agent can register, receive a room task, emit REPORT, update BLACKBOARD, and finish with DONE.",
    agents: ["hello-agent"],
    wakeAgents: ["hello-agent"],
    auto_rotate: false,
    max_steps: 1
  });

  const finalRoom = await waitForRoomComplete(base, token, room.id);
  const eventBundle = await adminClient.exportRoomEvents(finalRoom.id);
  const run = finalRoom.runs?.find((item) => item.agent_id === "hello-agent");
  assert(run?.status === "completed", "hello-agent run did not complete");
  assert(finalRoom.status === "completed", "hello-agent room did not complete");
  assert(/REPORT: hello-agent received/.test(run.stdout || ""), "hello-agent stdout did not include REPORT");
  assert(/BLACKBOARD: hello-agent message_source=file/.test(run.stdout || ""), "hello-agent stdout did not prove AGENT_MESSAGE_FILE usage");
  assert(/BLACKBOARD: hello-agent last_message_preview=/.test(run.stdout || ""), "hello-agent stdout did not include BLACKBOARD");
  assert(/\bDONE\b/.test(run.stdout || ""), "hello-agent stdout did not include DONE");
  assert(finalRoom.reports?.some((item) => /hello-agent received/.test(item.content || "")), "gateway did not capture hello-agent REPORT");
  assert(finalRoom.blackboard?.notes?.some((item) => /hello-agent message_source=file/.test(item.content || "")), "gateway did not capture hello-agent message_source BLACKBOARD");
  assert(finalRoom.blackboard?.notes?.some((item) => /hello-agent last_message_preview=/.test(item.content || "")), "gateway did not capture hello-agent BLACKBOARD");
  assert(eventBundle.events?.some((event) => event.type === "run.completed"), "SDK event export did not include run.completed");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  const result = {
    ok: true,
    mode: "compatibility",
    quota: "no_model_calls",
    gateway: base,
    chat_run_id: chat.agent_bus?.run_id,
    response_run_id: response.agent_bus?.run_id,
    room_id: finalRoom.id,
    room_status: finalRoom.status,
    run_id: run.id,
    agent_id: "hello-agent",
    sdk: "js",
    event_count: eventBundle.events?.length || 0,
    openai_compatible: ["chat.completions", "responses"],
    reports: finalRoom.reports?.length || 0,
    blackboard_notes: finalRoom.blackboard?.notes?.length || 0
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Agent Bus compatibility smoke passed");
    console.log(`Room: ${result.room_id}`);
    console.log(`Run: ${result.run_id}`);
    console.log("Quota: no model calls");
  }
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
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
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
