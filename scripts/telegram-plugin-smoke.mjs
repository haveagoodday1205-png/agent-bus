#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-telegram-plugin-"));
const children = [];

Promise.resolve().then(main).catch((err) => {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}).finally(async () => {
  for (const child of children.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => waitForExit(child)));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const python = findPython();
  if (!python) throw new Error("Python 3.10+ is required for telegram plugin smoke.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const adminToken = "sk-telegram-plugin-smoke-token-000000";
  const edgeToken = "abt_edge_telegram_plugin_smoke_000000";
  const webhookSecret = "telegram-plugin-smoke-webhook-secret";
  const telegramChatId = "424242";
  const dataDir = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "central.config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    gatewayUrl: gateway,
    dataDir,
    token: adminToken,
    defaults: { mode: "orchestrate", pollTimeoutMs: 1000 },
    edgeTokens: [{ token: edgeToken, label: "telegram smoke edge" }],
    plugins: {
      telegramBot: {
        enabled: true,
        dryRun: true,
        events: ["central.started", "edge.registered", "run.completed", "run.failed", "room.completed", "telegram.test", "telegram.command"],
        control: {
          enabled: true,
          secretToken: webhookSecret,
          allowedChatIds: [telegramChatId],
          allowRun: true
        }
      }
    },
    modelRouter: { enabled: false, agentModels: true, backends: [] }
  }, null, 2)}\n`);

  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_TOKEN: adminToken,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir,
    AGENT_BUS_GATEWAY_URL: gateway
  });
  await waitForJson(`${gateway}/health`);
  await waitForOutput(central, "Agent Bus join endpoint");

  const manifest = await requestJson(`${gateway}/v1/agent-bus/manifest`, { headers: authHeaders(adminToken) });
  assert(manifest.plugins?.telegramBot?.enabled === true, "manifest did not expose enabled telegram plugin");
  assert(manifest.plugins?.telegramBot?.dry_run === true, "manifest did not expose telegram dry-run mode");

  const pluginTest = runAgentBus([
    "plugin",
    "telegram",
    "test",
    "--gateway",
    gateway,
    "--token",
    adminToken,
    "--message",
    "Telegram dry-run self test from smoke.",
    "--dry-run"
  ]);
  assert(pluginTest.ok === true, "telegram plugin CLI test did not report ok");
  assert(pluginTest.notification?.event === "telegram.test", "telegram plugin CLI test did not emit telegram.test");
  assert(pluginTest.notification?.status === "dry_run", "telegram plugin CLI test did not stay in dry-run mode");

  await requestJson(`${gateway}/edge/register`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      node_id: "telegram-smoke-edge",
      hostname: "telegram-smoke",
      agents: [{
        id: "telegram-smoke-agent",
        kind: "echo",
        role: "executor",
        enabled: true,
        capabilities: ["smoke", "telegram"]
      }]
    })
  });

  const statusWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/status");
  assert(statusWebhook.ok === true && statusWebhook.command === "status", "telegram /status webhook failed");
  const agentsWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/agents");
  assert(agentsWebhook.ok === true && agentsWebhook.command === "agents", "telegram /agents webhook failed");
  const runWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/run telegram-smoke-agent Run webhook command smoke.");
  assert(runWebhook.ok === true && runWebhook.command === "run", "telegram /run webhook failed");
  assert(runWebhook.thread?.runs?.length === 1, "telegram /run webhook did not queue a thread run");
  const webhookTask = await pollTask(gateway, edgeToken);
  assert(webhookTask.task?.run_id === runWebhook.thread.runs[0], "telegram /run task run_id mismatch");
  await completeRun(gateway, edgeToken, webhookTask.task.run_id, "REPORT: Telegram webhook run dry-run ok.\n");

  const thread = await requestJson(`${gateway}/threads`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({
      message: "Run telegram plugin smoke.",
      agents: ["telegram-smoke-agent"],
      mode: "orchestrate"
    })
  });
  const threadTask = await pollTask(gateway, edgeToken);
  assert(threadTask.task?.run_id === thread.runs?.[0]?.id, "thread task run_id mismatch");
  await completeRun(gateway, edgeToken, threadTask.task.run_id, "REPORT: Telegram plugin thread dry-run ok.\n");

  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({
      title: "Telegram plugin smoke room",
      goal: "Complete a room and emit a dry-run Telegram notification.",
      agents: ["telegram-smoke-agent"],
      wakeAgents: ["telegram-smoke-agent"],
      auto_rotate: false,
      max_steps: 2
    })
  });
  const roomTask = await pollTask(gateway, edgeToken);
  await completeRun(gateway, edgeToken, roomTask.task.run_id, "REPORT: Telegram plugin room dry-run ok.\nDONE\n");

  const notifications = await waitForNotifications(dataDir, ["central.started", "telegram.test", "telegram.command", "edge.registered", "run.completed", "room.completed"]);
  const roomAfter = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}`, { headers: authHeaders(adminToken) });
  assert(roomAfter.status === "completed", "room did not complete");
  const nodeGateway = await nodeGatewayPluginSmoke();

  const result = {
    ok: true,
    quota: "no_model_calls",
    gateway,
    plugin: "telegramBot",
    mode: "dry_run",
    events: notifications.map((item) => item.event),
    notifications: notifications.length,
    plugin_test_status: pluginTest.notification.status,
    webhook_commands: [statusWebhook.command, agentsWebhook.command, runWebhook.command],
    webhook_thread_id: runWebhook.thread.id,
    node_gateway_plugin_test_status: nodeGateway.plugin_test_status,
    thread_run_id: threadTask.task.run_id,
    room_id: room.id
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`telegram plugin smoke ok (${notifications.length} dry-run notification events)`);
  }
}

async function nodeGatewayPluginSmoke() {
  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const adminToken = "sk-telegram-node-plugin-smoke-token-000000";
  const edgeToken = "abt_edge_telegram_node_plugin_smoke_000000";
  const webhookSecret = "telegram-node-plugin-smoke-webhook-secret";
  const telegramChatId = "525252";
  const nodeId = "telegram-node-smoke-edge";
  const agentId = "telegram-node-smoke-agent";
  const dataDir = path.join(tempDir, "node-data");
  const configPath = path.join(tempDir, "node-central.config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    gatewayUrl: gateway,
    dataDir,
    token: adminToken,
    defaults: { mode: "orchestrate", pollTimeoutMs: 1000 },
    edgeTokens: [{ token: edgeToken, label: "telegram node smoke edge" }],
    plugins: {
      telegramBot: {
        enabled: true,
        dryRun: true,
        events: ["central.started", "edge.registered", "run.completed", "run.failed", "telegram.test", "telegram.command"],
        control: {
          enabled: true,
          secretToken: webhookSecret,
          allowedChatIds: [telegramChatId],
          allowRun: true
        }
      }
    },
    modelRouter: { enabled: false, agentModels: true, backends: [] }
  }, null, 2)}\n`);

  const central = start(process.execPath, [path.join(root, "central-gateway.mjs"), "serve", "--config", configPath]);
  await waitForJson(`${gateway}/health`);
  await waitForOutput(central, "Agent Bus join endpoint");

  const manifest = await requestJson(`${gateway}/v1/agent-bus/manifest`, { headers: authHeaders(adminToken) });
  assert(manifest.plugins?.telegramBot?.enabled === true, "node manifest did not expose enabled telegram plugin");

  const pluginTest = runAgentBus([
    "plugin",
    "telegram",
    "test",
    "--gateway",
    gateway,
    "--token",
    adminToken,
    "--message",
    "Node central Telegram dry-run self test.",
    "--dry-run"
  ]);
  assert(pluginTest.notification?.status === "dry_run", "node telegram plugin CLI test did not stay in dry-run mode");

  await requestJson(`${gateway}/edge/register`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      node_id: nodeId,
      hostname: "telegram-node-smoke",
      agents: [{
        id: agentId,
        kind: "echo",
        role: "executor",
        enabled: true,
        capabilities: ["smoke", "telegram", "node"]
      }]
    })
  });

  const statusWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/status");
  assert(statusWebhook.ok === true && statusWebhook.command === "status", "node telegram /status webhook failed");
  const runWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/run telegram-node-smoke-agent Run node webhook command smoke.");
  assert(runWebhook.thread?.runs?.length === 1, "node telegram /run webhook did not queue a thread run");
  const webhookTask = await pollTask(gateway, edgeToken, nodeId);
  assert(webhookTask.task?.run_id === runWebhook.thread.runs[0], "node telegram /run task run_id mismatch");
  await completeRun(gateway, edgeToken, webhookTask.task.run_id, "REPORT: Node Telegram webhook run dry-run ok.\n", nodeId);

  const thread = await requestJson(`${gateway}/threads`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({
      message: "Run node telegram plugin smoke.",
      agents: [agentId],
      mode: "orchestrate"
    })
  });
  const threadTask = await pollTask(gateway, edgeToken, nodeId);
  assert(threadTask.task?.run_id === thread.runs?.[0]?.id, "node thread task run_id mismatch");
  await completeRun(gateway, edgeToken, threadTask.task.run_id, "REPORT: Node Telegram plugin dry-run ok.\n", nodeId);

  const notifications = await waitForNotifications(dataDir, ["central.started", "telegram.test", "telegram.command", "edge.registered", "run.completed"]);
  return {
    ok: true,
    plugin_test_status: pluginTest.notification.status,
    webhook_commands: [statusWebhook.command, runWebhook.command],
    notifications: notifications.length
  };
}

function telegramWebhook(gateway, secret, chatId, text) {
  return requestJson(`${gateway}/v1/agent-bus/plugins/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret
    },
    body: JSON.stringify({
      update_id: 1000,
      message: {
        message_id: 1,
        chat: { id: chatId, type: "private" },
        text
      }
    })
  });
}

async function pollTask(gateway, token, nodeId = "telegram-smoke-edge") {
  const result = await requestJson(`${gateway}/edge/poll`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ node_id: nodeId, timeout_ms: 1000 })
  });
  assert(result.type === "task", `expected edge task, got ${result.type}`);
  return result;
}

function completeRun(gateway, token, runId, stdout, nodeId = "telegram-smoke-edge") {
  return requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: nodeId,
      run_id: runId,
      result: {
        status: "completed",
        exit_code: 0,
        stdout
      }
    })
  });
}

async function waitForNotifications(dataDir, requiredEvents, timeoutMs = 10000) {
  const started = Date.now();
  const file = path.join(dataDir, "notifications.jsonl");
  while (Date.now() - started < timeoutMs) {
    const events = readJsonl(file);
    const names = new Set(events.map((item) => item.event));
    if (requiredEvents.every((event) => names.has(event))) return events;
    await delay(100);
  }
  throw new Error(`Timed out waiting for notifications: ${requiredEvents.join(", ")}`);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child._agentBusOutput = "";
  child.stdout.on("data", (chunk) => { child._agentBusOutput += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { child._agentBusOutput += chunk.toString("utf8"); });
  children.push(child);
  return child;
}

function runAgentBus(args) {
  const result = spawnSync(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-bus ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function waitForOutput(child, pattern, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (String(child._agentBusOutput || "").includes(pattern)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for output: ${pattern}`);
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await delay(100);
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

function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
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

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const command of [...new Set(candidates)]) {
    try {
      const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
        cwd: root,
        windowsHide: true,
        stdio: "ignore"
      });
      if (result.status === 0) return command;
    } catch {
      // Try next candidate.
    }
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
