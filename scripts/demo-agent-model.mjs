import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-agent-model-demo-"));

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
  if (!python) throw new Error("agent-model demo requires Python 3.10+ because the Python gateway owns room/model parity.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const adminToken = "sk-agent-model-demo-token-000000";
  const edgeToken = "abt_edge_agent_model_demo_token_000000";
  const cacheScope = "agent-bus-demo-agent-model";
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "model-agent.mjs");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token: adminToken,
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

  fs.writeFileSync(agentScript, `import fs from "node:fs";\nconst messageFile = process.env.AGENT_MESSAGE_FILE || "";\nconst message = messageFile && fs.existsSync(messageFile) ? fs.readFileSync(messageFile, "utf8") : process.env.AGENT_MESSAGE || "";\nconst endpoint = message.includes("Responses API model") ? "responses" : message.includes("chat completion model") ? "chat.completions" : "task";\nconst payload = {\n  ok: true,\n  endpoint,\n  agent_id: process.env.AGENT_ID || "",\n  run_id: process.env.AGENT_RUN_ID || "",\n  thread_id: process.env.AGENT_THREAD_ID || "",\n  room_id: process.env.AGENT_ROOM_ID || "",\n  cache_scope: process.env.AGENT_CACHE_SCOPE || "",\n  cache_key: process.env.AGENT_CACHE_KEY || "",\n  session_id: process.env.AGENT_SESSION_ID || "",\n  message_source: messageFile ? "file" : "env",\n  prompt_preview: message.replace(/\\s+/g, " ").trim().slice(0, 160)\n};\nconsole.log(JSON.stringify(payload, null, 2));\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "agent-model-demo-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "model-agent",
      kind: "demo",
      role: "worker",
      enabled: true,
      adapter: "command",
      capabilities: ["agent-model", "responses", "chat.completions", "cache-scope"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(agentScript)}`
    }]
  }, null, 2)}\n`);

  if (!jsonOut) {
    console.log("Agent Bus agent-backed model demo");
    console.log("1. Starting a private local gateway with agent:<id> models enabled");
  }
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: adminToken,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`);

  if (!jsonOut) console.log("2. Starting a local edge with one command-backed model agent");
  const edge = start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  await waitForAgent(gateway, adminToken, "model-agent");

  const models = await requestJson(`${gateway}/v1/models`, { headers: authHeaders(edgeToken) });
  assert(models.data?.some((model) => model.id === "agent:model-agent"), "model list did not expose agent:model-agent to the edge token");
  if (!jsonOut) console.log("3. /v1/models exposes agent:model-agent");

  const chat = await requestJson(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent:model-agent",
      messages: [{ role: "user", content: "Return your Agent Bus runtime proof for Chat Completions." }],
      prompt_cache_key: cacheScope,
      timeout_seconds: 10
    })
  });
  const chatProof = parseJsonPayload(chat.choices?.[0]?.message?.content, "chat completion proof");

  const response = await requestJson(`${gateway}/v1/responses`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent:model-agent",
      input: "Return your Agent Bus runtime proof for Responses.",
      metadata: { agent_bus_cache_scope: cacheScope },
      timeout_seconds: 10
    })
  });
  const responseProof = parseJsonPayload(response.output_text, "Responses proof");

  assert(chatProof.endpoint === "chat.completions", "chat call did not reach the chat prompt path");
  assert(responseProof.endpoint === "responses", "Responses call did not reach the Responses prompt path");
  assert(chatProof.cache_scope, "chat call did not receive an explicit cache scope");
  assert(responseProof.cache_scope === chatProof.cache_scope, "Responses call did not reuse the explicit cache scope");
  assert(responseProof.cache_key === chatProof.cache_key, "Chat and Responses calls did not reuse the same Agent Bus cache key");
  assert(responseProof.session_id === chatProof.session_id, "Chat and Responses calls did not reuse the same Agent Bus session id");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  const result = {
    ok: true,
    quota: "no_model_calls",
    gateway,
    model: "agent:model-agent",
    cache_scope: chatProof.cache_scope,
    cache_key: chatProof.cache_key,
    session_id: chatProof.session_id,
    chat_run_id: chat.agent_bus?.run_id,
    response_run_id: response.agent_bus?.run_id,
    chat_endpoint: chatProof.endpoint,
    response_endpoint: responseProof.endpoint
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`4. Chat Completions routed to ${result.model}: ${result.chat_run_id}`);
  console.log(`5. Responses routed to ${result.model}: ${result.response_run_id}`);
  console.log(`6. Stable cache/session key reused: ${result.cache_key}`);
  console.log("Demo complete. This used a fake local command agent, so it spent no model quota.");
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!jsonOut) {
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (/listening|connected/.test(text)) process.stdout.write(`   ${text}`);
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  procs.push(child);
  return child;
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
    try {
      const agents = await requestJson(`${base}/agents`, { headers: authHeaders(token) });
      const agent = agents.find((item) => item.id === agentId);
      if (agent?.status === "online") return agent;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for agent ${agentId}`);
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

function parseJsonPayload(value, label) {
  try {
    return JSON.parse(String(value || ""));
  } catch (err) {
    throw new Error(`Could not parse ${label} as JSON: ${err.message}`);
  }
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
