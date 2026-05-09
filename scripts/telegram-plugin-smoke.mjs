#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
  assertInlineButton(callbackAgentsWebhook.reply_markup, "/agent toggle telegram-smoke-agent", "telegram /agents callback did not include agent selection button");
  const pollerCallback = await runPollerCallbackSmoke(gateway, webhookSecret, telegramChatId, "/status", dataDir);
  assert(pollerCallback.ok === true && pollerCallback.handled === 1, "telegram poller did not forward callback query");
  assert(pollerCallback.allowedUpdates.includes("callback_query"), "telegram poller did not request callback_query updates");
  assert(pollerCallback.commands.includes("room"), "telegram poller --set-commands did not register /room");
  const commandMenu = await runTelegramCommandMenuSmoke();
  assert(commandMenu.ok === true && commandMenu.commands.includes("room"), "telegram command menu smoke did not register /room");
  const doctorSmoke = await runTelegramDoctorSmoke(gateway, adminToken, telegramChatId, webhookSecret);
  assert(doctorSmoke.ok === true && doctorSmoke.transport === "poller", "telegram doctor smoke did not pass in poller mode");
  assert(doctorSmoke.webhook_probe === "pass", "telegram doctor did not pass the diagnostic webhook probe");
  const setupSmoke = await runTelegramSetupSmoke(gateway, telegramChatId, webhookSecret, dataDir);
  assert(setupSmoke.ok === true && setupSmoke.commands.includes("room"), "telegram setup smoke did not write env/service and register commands");
  const setupRestrictionSmoke = await runTelegramSetupRequiresChatSmoke(gateway, dataDir);
  assert(setupRestrictionSmoke.ok === true, "telegram setup should refuse unrestricted control envs by default");
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
  assertNoInlineKeyboard(chatWebhook.reply_markup, "telegram conversational webhook should not show selection buttons");
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
  assertInlineButton(newWebhook.reply_markup, "/agent toggle telegram-smoke-helper", "telegram /new did not include multi-select agent button");
  const preselectWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/agent toggle telegram-smoke-helper");
  assert(preselectWebhook.command === "agent" && /telegram-smoke-helper/.test(preselectWebhook.reply || ""), "telegram /new agent preselect callback failed");
  const newChatWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Start a fresh Telegram process.");
  assert(newChatWebhook.thread?.id && newChatWebhook.thread.id !== chatWebhook.thread.id, "telegram /new did not start a fresh thread");
  assert(newChatWebhook.thread?.agents?.includes("telegram-smoke-helper"), "telegram preselected agent was not used for fresh process");
  const newChatTask = await pollTask(gateway, edgeToken);
  assert(newChatTask.task?.agent_id === "telegram-smoke-helper", "telegram fresh process did not target preselected helper");
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
  const roomsWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/rooms");
  assert(roomsWebhook.command === "rooms" && /Recent Agent Bus rooms/.test(roomsWebhook.reply || ""), "telegram /rooms did not list rooms");
  assertInlineButton(roomsWebhook.reply_markup, "/room new", "telegram /rooms did not include new room button");
  assertInlineButton(roomsWebhook.reply_markup, `/room ${room.id}`, "telegram /rooms did not include room inspect button");
  const roomWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, `/room ${room.id}`);
  assert(roomWebhook.command === "room" && /Agent Bus room/.test(roomWebhook.reply || ""), "telegram /room callback did not inspect room");
  const roomDraftWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/room new");
  assert(roomDraftWebhook.command === "room_draft", "telegram /room new did not start a room draft");
  assertInlineButton(roomDraftWebhook.reply_markup, "/room agent toggle telegram-smoke-agent", "telegram room draft did not include agent toggle");
  assertInlineButton(roomDraftWebhook.reply_markup, "/room steps 10", "telegram room draft did not include steps button");
  await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/room agent toggle telegram-smoke-helper");
  await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/room agent toggle telegram-smoke-agent");
  const roomStepsWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/room steps 2");
  assert(/Max steps: 2/.test(roomStepsWebhook.reply || ""), "telegram room draft did not update max steps");
  const roomStartWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/room start Build a Telegram-created smoke room.");
  assert(roomStartWebhook.command === "room" && /Created room/.test(roomStartWebhook.reply || ""), "telegram /room start did not create a room");
  assert(roomStartWebhook.room?.agents?.includes("telegram-smoke-helper") && roomStartWebhook.room?.agents?.includes("telegram-smoke-agent"), `telegram-created room did not keep selected agents: ${JSON.stringify(roomStartWebhook.room)}`);
  assert(roomStartWebhook.room?.max_steps === 2, "telegram-created room did not keep selected max steps");
  const draftRoomTask = await pollTask(gateway, edgeToken);
  assert(draftRoomTask.task?.agent_id === "telegram-smoke-helper", "telegram-created room did not wake the first selected agent");
  await completeRun(gateway, edgeToken, draftRoomTask.task.run_id, "REPORT: Telegram-created room dry-run ok.\nDONE\n");
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
    doctor_checks: doctorSmoke.checks,
    setup_files: setupSmoke.files,
    setup_restriction: setupRestrictionSmoke.error,
    webhook_commands: [statusWebhook.command, callbackAgentsWebhook.command, agentsWebhook.command, runWebhook.command, chatWebhook.command, continuedWebhook.command, helperWebhook.command, resumeWebhook.command, resumeCallbackWebhook.command, newWebhook.command, preselectWebhook.command, newChatWebhook.command, roomsWebhook.command, roomWebhook.command, roomDraftWebhook.command, roomStepsWebhook.command, roomStartWebhook.command],
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
  assertInlineButton(callbackAgentsWebhook.reply_markup, `/agent toggle ${agentId}`, "node telegram /agents callback did not include agent selection button");
  const runWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "/run telegram-node-smoke-agent Run node webhook command smoke.");
  assert(runWebhook.thread?.runs?.length === 1, "node telegram /run webhook did not queue a thread run");
  const webhookTask = await pollTask(gateway, edgeToken, nodeId);
  assert(webhookTask.task?.run_id === runWebhook.thread.runs[0], "node telegram /run task run_id mismatch");
  await completeRun(gateway, edgeToken, webhookTask.task.run_id, "REPORT: Node Telegram webhook run dry-run ok.\n", nodeId);

  const chatWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Please answer through node central conversational mode.");
  assert(chatWebhook.ok === true && chatWebhook.command === "chat", "node telegram conversational webhook failed");
  assert(chatWebhook.thread?.runs?.length === 1, "node telegram conversational webhook did not queue a thread run");
  assertNoInlineKeyboard(chatWebhook.reply_markup, "node telegram conversational webhook should not show selection buttons");
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
  assertInlineButton(newWebhook.reply_markup, "/agent toggle telegram-node-helper-agent", "node telegram /new did not include multi-select agent button");
  const preselectWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/agent toggle telegram-node-helper-agent");
  assert(preselectWebhook.command === "agent" && /telegram-node-helper-agent/.test(preselectWebhook.reply || ""), "node telegram /new agent preselect callback failed");
  const newChatWebhook = await telegramWebhook(gateway, webhookSecret, telegramChatId, "Start a fresh node Telegram process.");
  assert(newChatWebhook.thread?.id && newChatWebhook.thread.id !== chatWebhook.thread.id, "node telegram /new did not start a fresh thread");
  assert(newChatWebhook.thread?.agents?.includes("telegram-node-helper-agent"), "node telegram preselected agent was not used for fresh process");
  const newChatTask = await pollTask(gateway, edgeToken, nodeId);
  assert(newChatTask.task?.agent_id === "telegram-node-helper-agent", "node telegram fresh process did not target preselected helper");
  await completeRun(gateway, edgeToken, newChatTask.task.run_id, "Node Telegram fresh process reply ok.\n", nodeId);
  const roomDraftWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/room new");
  assert(roomDraftWebhook.command === "room_draft", "node telegram /room new did not start a room draft");
  assertInlineButton(roomDraftWebhook.reply_markup, `/room agent toggle ${agentId}`, "node telegram room draft did not include agent toggle");
  const roomStepsWebhook = await telegramCallbackWebhook(gateway, webhookSecret, telegramChatId, "/room steps 10");
  assert(/Max steps: 10/.test(roomStepsWebhook.reply || ""), "node telegram room draft did not update max steps");

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
    webhook_commands: [statusWebhook.command, callbackAgentsWebhook.command, runWebhook.command, chatWebhook.command, continuedWebhook.command, helperWebhook.command, resumeWebhook.command, resumeCallbackWebhook.command, newWebhook.command, preselectWebhook.command, newChatWebhook.command, roomDraftWebhook.command, roomStepsWebhook.command],
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

async function runPollerCallbackSmoke(gateway, secret, chatId, data, dataDir) {
  const update = {
    update_id: 5000,
    callback_query: {
      id: `poller-callback-${Date.now()}`,
      data,
      message: {
        message_id: 3,
        chat: { id: chatId, type: "private" },
        text: "button"
      }
    }
  };
  const mock = await startTelegramApiMock([update]);
  try {
    const result = await runNodeJson([
      path.join(root, "scripts", "telegram-poller.mjs"),
      "--gateway",
      gateway,
      "--api-base-url",
      mock.url,
      "--offset-file",
      path.join(dataDir, "telegram-poller-smoke.offset"),
      "--set-commands",
      "--once",
      "--json"
    ], {
      AGENT_BUS_TELEGRAM_BOT_TOKEN: "telegram-poller-smoke-token",
      AGENT_BUS_TELEGRAM_WEBHOOK_SECRET: secret
    });
    await waitForNotification(dataDir, (item) => (
      item.event === "telegram.callback_answer"
      && item.callback_query_id === update.callback_query.id
      && item.status === "dry_run"
    ));
    return { ...result, allowedUpdates: mock.allowedUpdates, commands: mock.commands.map((item) => item.command) };
  } finally {
    await mock.close();
  }
}

async function runTelegramCommandMenuSmoke() {
  const mock = await startTelegramApiMock([]);
  try {
    const result = await runNodeJson([
      path.join(root, "scripts", "telegram-commands.mjs"),
      "set",
      "--api-base-url",
      mock.url,
      "--bot-token",
      "telegram-command-menu-smoke-token",
      "--json"
    ]);
    return {
      ok: result.ok === true,
      commands: mock.commands.map((item) => item.command)
    };
  } finally {
    await mock.close();
  }
}

async function runTelegramDoctorSmoke(gateway, adminToken, chatId, secret) {
  const mock = await startTelegramApiMock([], { commands: smokeTelegramCommands() });
  try {
    const result = await runAgentBusJsonAsync([
      "plugin",
      "telegram",
      "doctor",
      "--gateway",
      gateway,
      "--token",
      adminToken,
      "--api-base-url",
      mock.url,
      "--bot-token",
      "telegram-doctor-smoke-token",
      "--chat-id",
      chatId,
      "--secret-token",
      secret,
      "--transport",
      "poller",
      "--json"
    ]);
    return {
      ok: result.ok === true,
      transport: result.checks.find((item) => item.name === "telegram doctor")?.detail,
      webhook_probe: result.checks.find((item) => item.name === "telegram webhook probe")?.status,
      checks: result.counts
    };
  } finally {
    await mock.close();
  }
}

async function runTelegramSetupSmoke(gateway, chatId, secret, dataDir) {
  const mock = await startTelegramApiMock([]);
  const envFile = path.join(dataDir, "telegram-setup-smoke.env");
  const serviceFile = path.join(dataDir, "telegram-setup-smoke.service");
  try {
    await runAgentBusTextAsync([
      "setup",
      "telegram",
      "--gateway",
      gateway,
      "--api-base-url",
      mock.url,
      "--bot-token",
      "telegram-setup-smoke-token",
      "--chat-id",
      chatId,
      "--secret-token",
      secret,
      "--set-commands",
      "--service",
      "systemd",
      "--out",
      envFile,
      "--service-out",
      serviceFile,
      "--force"
    ]);
    const envText = fs.readFileSync(envFile, "utf8");
    const serviceText = fs.readFileSync(serviceFile, "utf8");
    assert(/AGENT_BUS_TELEGRAM_ENABLED=true/.test(envText), "telegram setup env did not enable plugin");
    assert(/AGENT_BUS_TELEGRAM_CONTROL_ENABLED=true/.test(envText), "telegram setup env did not enable control");
    assert(/plugin telegram poll/.test(serviceText), "telegram setup service did not run poller");
    const execStart = serviceExecStart(serviceText);
    assert(/agent-bus\.mjs/.test(execStart), "telegram setup service should use the current CLI script when --agent-bus-path is omitted");
    assert(!/[/\\]agent-bus(\s|")/.test(execStart.replace(/agent-bus\.mjs/g, "")), "telegram setup service should not point at a guessed agent-bus executable");
    return {
      ok: true,
      commands: mock.commands.map((item) => item.command),
      calls: mock.calls,
      files: [envFile, serviceFile]
    };
  } finally {
    await mock.close();
  }
}

async function runTelegramSetupRequiresChatSmoke(gateway, dataDir) {
  const envFile = path.join(dataDir, "telegram-unsafe-setup.env");
  const result = await runAgentBusFailureAsync([
    "setup",
    "telegram",
    "--gateway",
    gateway,
    "--out",
    envFile,
    "--force"
  ]);
  assert(/requires --chat-id/.test(result.stderr || result.stdout), "telegram setup missing-chat failure was not actionable");
  assert(!fs.existsSync(envFile), "telegram setup wrote env file before rejecting missing chat id");
  const lines = (result.stderr || result.stdout).trim().split(/\r?\n/);
  return {
    ok: true,
    error: lines.find((line) => /requires --chat-id/.test(line)) || lines[0] || ""
  };
}

function smokeTelegramCommands() {
  return [
    "start",
    "help",
    "status",
    "agents",
    "new",
    "resume",
    "agent",
    "rooms",
    "room",
    "run"
  ].map((command) => ({ command, description: `${command} command` }));
}

async function startTelegramApiMock(updates, options = {}) {
  const state = { updates, calls: [], allowedUpdates: [], commands: options.commands ? [...options.commands] : [] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    state.calls.push(url.pathname);
    if (url.pathname.endsWith("/getMe")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { id: 100200300, is_bot: true, username: "agent_bus_smoke_bot" } }));
      return;
    }
    if (url.pathname.endsWith("/getWebhookInfo")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { url: "", pending_update_count: 0 } }));
      return;
    }
    if (url.pathname.endsWith("/getUpdates")) {
      const allowed = parseJson(url.searchParams.get("allowed_updates") || "[]");
      state.allowedUpdates = Array.isArray(allowed) ? allowed : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: state.updates.splice(0) }));
      return;
    }
    if (url.pathname.endsWith("/deleteWebhook")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (url.pathname.endsWith("/setMyCommands")) {
      const commands = parseJson(url.searchParams.get("commands") || "[]");
      state.commands = Array.isArray(commands) ? commands : [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (url.pathname.endsWith("/getMyCommands")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: state.commands }));
      return;
    }
    if (url.pathname.endsWith("/deleteMyCommands")) {
      state.commands = [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, description: "not_found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    get url() {
      return `http://127.0.0.1:${address.port}`;
    },
    get allowedUpdates() {
      return state.allowedUpdates;
    },
    get commands() {
      return state.commands;
    },
    get calls() {
      return state.calls;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
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

function runAgentBusText(args) {
  const result = spawnSync(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-bus ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function runAgentBusJsonAsync(args) {
  const stdout = await runAgentBusTextAsync(args);
  return JSON.parse(stdout);
}

function runAgentBusTextAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`agent-bus ${args.join(" ")} failed with ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function runAgentBusFailureAsync(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        reject(new Error(`agent-bus ${args.join(" ")} unexpectedly succeeded: ${stdout}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function runNodeJson(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`node ${args.join(" ")} failed with ${code}: ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`failed to parse node JSON output: ${err.message}; output=${stdout}; stderr=${stderr}`));
      }
    });
  });
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

function assertNoInlineKeyboard(replyMarkup, message) {
  const buttons = (replyMarkup?.inline_keyboard || []).flat();
  assert(buttons.length === 0, message);
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function serviceExecStart(text) {
  return String(text || "").split(/\r?\n/).find((line) => line.startsWith("ExecStart=")) || "";
}
