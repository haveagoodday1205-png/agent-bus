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
          allowRun: true,
          conversation: {
            enabled: true,
            agentId: "telegram-smoke-agent"
          }
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
      }, {
        id: "telegram-smoke-helper",
        kind: "echo",
        role: "assistant",
        enabled: true,
        capabilities: ["smoke", "telegram", "helper"]
      }]
    })
  });

  const statusWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/status");
  assert(statusWebhook.ok === true && statusWebhook.command === "status", "telegram /status webhook failed");
  assertInlineButton(statusWebhook.reply_markup, "/agents", "telegram /status did not include Agents inline button");
  const statusNotification = await waitForNotification(dataDir, (item) => item.event === "telegram.command" && item.payload?.command === "status");
  assertInlineButton(statusNotification.reply_markup, "/status", "telegram dry-run notification did not persist inline buttons");
  const callbackAgentsWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/agents");
  assert(callbackAgentsWebhook.ok === true && callbackAgentsWebhook.command === "agents", "telegram /agents callback failed");
  assert(callbackAgentsWebhook.callback_answer?.status === "dry_run", "telegram callback answer did not stay in dry-run mode");
  assertInlineButton(callbackAgentsWebhook.reply_markup, "/agent telegram-smoke-agent", "telegram /agents callback did not include agent selection button");
  const agentsWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/agents");
  assert(agentsWebhook.ok === true && agentsWebhook.command === "agents", "telegram /agents webhook failed");
  const runWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/run telegram-smoke-agent Run webhook command smoke.");
  assert(runWebhook.ok === true && runWebhook.command === "run", "telegram /run webhook failed");
  assert(runWebhook.thread?.runs?.length === 1, "telegram /run webhook did not queue a thread run");
  const webhookTask = await pollTask(gateway, edgeToken);
  assert(webhookTask.task?.run_id === runWebhook.thread.runs[0], "telegram /run task run_id mismatch");
  await completeRun(gateway, edgeToken, webhookTask.task.run_id, "REPORT: Telegram webhook run dry-run ok.\n");

  const chatWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Please answer like a Telegram conversational assistant.");
  assert(chatWebhook.ok === true && chatWebhook.command === "chat", "telegram conversational webhook failed");
  assert(chatWebhook.thread?.runs?.length === 1, "telegram conversational webhook did not queue a thread run");
  const chatTask = await pollTask(gateway, edgeToken);
  assert(chatTask.task?.run_id === chatWebhook.thread.runs[0], "telegram conversational task run_id mismatch");
  assert(chatTask.task?.agent_id === "telegram-smoke-agent", "telegram conversational task did not target configured agent");
  await completeRun(gateway, edgeToken, chatTask.task.run_id, "Telegram conversational reply ok.\n");
  await waitForNotificationMessage(dataDir, /Telegram conversational reply ok/);

  const continuedWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Continue the same Telegram process.");
  assert(continuedWebhook.command === "chat", "telegram continued process command mismatch");
  assert(continuedWebhook.thread?.id === chatWebhook.thread.id, "telegram conversational process did not stay on the same thread");
  assert(continuedWebhook.thread?.runs?.length === 1, "telegram continued process did not queue one run");
  const continuedTask = await pollTask(gateway, edgeToken);
  assert(continuedTask.task?.run_id === continuedWebhook.thread.runs[0], "telegram continued task run_id mismatch");
  await completeRun(gateway, edgeToken, continuedTask.task.run_id, "Telegram continued process reply ok.\n");
  await waitForNotificationMessage(dataDir, /\[telegram-smoke-agent\][\s\S]*Telegram continued process reply ok/);

  const helperWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "@telegram-smoke-helper Join this active process.");
  assert(helperWebhook.thread?.id === chatWebhook.thread.id, "telegram @agent message did not reuse active thread");
  assert(helperWebhook.thread?.agents?.includes("telegram-smoke-helper"), "telegram @agent did not add helper agent");
  const helperTask = await pollTask(gateway, edgeToken);
  assert(helperTask.task?.agent_id === "telegram-smoke-helper", "telegram @agent task did not target helper agent");
  await completeRun(gateway, edgeToken, helperTask.task.run_id, "Telegram helper joined the process.\n");
  await waitForNotificationMessage(dataDir, /\[telegram-smoke-helper\][\s\S]*Telegram helper joined/);

  const resumeWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/resume");
  assert(resumeWebhook.ok === true && resumeWebhook.command === "resume", "telegram /resume webhook failed");
  assert(/Recent Agent Bus processes/.test(resumeWebhook.reply || ""), "telegram /resume did not list processes");
  assertInlineButton(resumeWebhook.reply_markup, `/resume ${chatWebhook.thread.id}`, "telegram /resume did not include process resume button");
  const resumeCallbackWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, `/resume ${chatWebhook.thread.id}`);
  assert(resumeCallbackWebhook.command === "resume" && resumeCallbackWebhook.thread?.id === chatWebhook.thread.id, "telegram resume callback did not switch process");
  const newWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/new");
  assert(newWebhook.ok === true && newWebhook.command === "new", "telegram /new webhook failed");
  const newChatWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Start a fresh Telegram process.");
  assert(newChatWebhook.thread?.id && newChatWebhook.thread.id !== chatWebhook.thread.id, "telegram /new did not start a fresh thread");
  const newChatTask = await pollTask(gateway, edgeToken);
  await completeRun(gateway, edgeToken, newChatTask.task.run_id, "Telegram fresh process reply ok.\n");

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
    webhook_commands: [statusWebhook.command, callbackAgentsWebhook.command, agentsWebhook.command, runWebhook.command, chatWebhook.command, continuedWebhook.command, helperWebhook.command, resumeWebhook.command, resumeCallbackWebhook.command, newWebhook.command, newChatWebhook.command],
    webhook_thread_id: runWebhook.thread.id,
    conversational_thread_id: chatWebhook.thread.id,
    fresh_conversational_thread_id: newChatWebhook.thread.id,
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
          allowRun: true,
          conversation: {
            enabled: true,
            agentId
          }
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
      }, {
        id: "telegram-node-helper-agent",
        kind: "echo",
        role: "assistant",
        enabled: true,
        capabilities: ["smoke", "telegram", "node", "helper"]
      }]
    })
  });

  const statusWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/status");
  assert(statusWebhook.ok === true && statusWebhook.command === "status", "node telegram /status webhook failed");
  assertInlineButton(statusWebhook.reply_markup, "/agents", "node telegram /status did not include Agents inline button");
  const statusNotification = await waitForNotification(dataDir, (item) => item.event === "telegram.command" && item.payload?.command === "status");
  assertInlineButton(statusNotification.reply_markup, "/status", "node telegram dry-run notification did not persist inline buttons");
  const callbackAgentsWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/agents");
  assert(callbackAgentsWebhook.command === "agents", "node telegram /agents callback failed");
  assert(callbackAgentsWebhook.callback_answer?.status === "dry_run", "node telegram callback answer did not stay in dry-run mode");
  assertInlineButton(callbackAgentsWebhook.reply_markup, `/agent ${agentId}`, "node telegram /agents callback did not include agent selection button");
  const runWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/run telegram-node-smoke-agent Run node webhook command smoke.");
  assert(runWebhook.thread?.runs?.length === 1, "node telegram /run webhook did not queue a thread run");
  const webhookTask = await pollTask(gateway, edgeToken, nodeId);
  assert(webhookTask.task?.run_id === runWebhook.thread.runs[0], "node telegram /run task run_id mismatch");
  await completeRun(gateway, edgeToken, webhookTask.task.run_id, "REPORT: Node Telegram webhook run dry-run ok.\n", nodeId);

  const chatWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Please answer through node central conversational mode.");
  assert(chatWebhook.ok === true && chatWebhook.command === "chat", "node telegram conversational webhook failed");
  assert(chatWebhook.thread?.runs?.length === 1, "node telegram conversational webhook did not queue a thread run");
  const chatTask = await pollTask(gateway, edgeToken, nodeId);
  assert(chatTask.task?.run_id === chatWebhook.thread.runs[0], "node telegram conversational task run_id mismatch");
  assert(chatTask.task?.agent_id === agentId, "node telegram conversational task did not target configured agent");
  await completeRun(gateway, edgeToken, chatTask.task.run_id, "Node Telegram conversational reply ok.\n", nodeId);
  await waitForNotificationMessage(dataDir, /Node Telegram conversational reply ok/);

  const continuedWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Continue the node central Telegram process.");
  assert(continuedWebhook.thread?.id === chatWebhook.thread.id, "node telegram conversational process did not stay on same thread");
  const continuedTask = await pollTask(gateway, edgeToken, nodeId);
  assert(continuedTask.task?.run_id === continuedWebhook.thread.runs[0], "node telegram continued task run_id mismatch");
  await completeRun(gateway, edgeToken, continuedTask.task.run_id, "Node Telegram continued process reply ok.\n", nodeId);
  await waitForNotificationMessage(dataDir, /\[telegram-node-smoke-agent\][\s\S]*Node Telegram continued process reply ok/);

  const helperWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "@telegram-node-helper-agent Join the node active process.");
  assert(helperWebhook.thread?.id === chatWebhook.thread.id, "node telegram @agent message did not reuse active thread");
  assert(helperWebhook.thread?.agents?.includes("telegram-node-helper-agent"), "node telegram @agent did not add helper agent");
  const helperTask = await pollTask(gateway, edgeToken, nodeId);
  assert(helperTask.task?.agent_id === "telegram-node-helper-agent", "node telegram @agent task did not target helper agent");
  await completeRun(gateway, edgeToken, helperTask.task.run_id, "Node Telegram helper joined the process.\n", nodeId);
  await waitForNotificationMessage(dataDir, /\[telegram-node-helper-agent\][\s\S]*Node Telegram helper joined/);

  const resumeWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/resume");
  assert(resumeWebhook.command === "resume" && /Recent Agent Bus processes/.test(resumeWebhook.reply || ""), "node telegram /resume did not list processes");
  assertInlineButton(resumeWebhook.reply_markup, `/resume ${chatWebhook.thread.id}`, "node telegram /resume did not include process resume button");
  const resumeCallbackWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, `/resume ${chatWebhook.thread.id}`);
  assert(resumeCallbackWebhook.command === "resume" && resumeCallbackWebhook.thread?.id === chatWebhook.thread.id, "node telegram resume callback did not switch process");
  const newWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/new");
  assert(newWebhook.command === "new", "node telegram /new webhook failed");
  const newChatWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Start a fresh node Telegram process.");
  assert(newChatWebhook.thread?.id && newChatWebhook.thread.id !== chatWebhook.thread.id, "node telegram /new did not start a fresh thread");
  const newChatTask = await pollTask(gateway, edgeToken, nodeId);
  await completeRun(gateway, edgeToken, newChatTask.task.run_id, "Node Telegram fresh process reply ok.\n", nodeId);

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
    webhook_commands: [statusWebhook.command, callbackAgentsWebhook.command, runWebhook.command, chatWebhook.command, continuedWebhook.command, helperWebhook.command, resumeWebhook.command, resumeCallbackWebhook.command, newWebhook.command, newChatWebhook.command],
    conversational_thread_id: chatWebhook.thread.id,
    fresh_conversational_thread_id: newChatWebhook.thread.id,
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

function telegramCallbackWebhook(gateway, secret, chatId, data) {
  return requestJson(`${gateway}/v1/agent-bus/plugins/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret
    },
    body: JSON.stringify({
      update_id: 1001,
      callback_query: {
        id: `callback-${Date.now()}`,
        data,
        message: {
          message_id: 2,
          chat: { id: chatId, type: "private" },
          text: "button"
        }
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

async function waitForNotificationMessage(dataDir, pattern, timeoutMs = 10000) {
  const started = Date.now();
  const file = path.join(dataDir, "notifications.jsonl");
  while (Date.now() - started < timeoutMs) {
    const events = readJsonl(file);
    const match = events.find((item) => pattern.test(String(item.message || "")));
    if (match) return match;
    await delay(100);
  }
  throw new Error(`Timed out waiting for notification message: ${pattern}`);
}

async function waitForNotification(dataDir, predicate, timeoutMs = 10000) {
  const started = Date.now();
  const file = path.join(dataDir, "notifications.jsonl");
  while (Date.now() - started < timeoutMs) {
    const events = readJsonl(file);
    const match = events.find(predicate);
    if (match) return match;
    await delay(100);
  }
  throw new Error("Timed out waiting for matching notification");
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

function assertInlineButton(replyMarkup, callbackData, message) {
  const buttons = (replyMarkup?.inline_keyboard || []).flat();
  assert(buttons.some((button) => button?.callback_data === callbackData), message);
}
