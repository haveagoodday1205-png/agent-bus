#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-cache-session-"));
const children = [];
const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];

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
  if (!python) throw new Error("cache session smoke requires Python 3.10+.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const adminToken = "sk-cache-session-smoke-token-000000";
  const edgeToken = "abt_edge_cache_session_smoke_000000";
  const webhookSecret = "cache-session-smoke-webhook-secret";
  const chatId = "616161";
  const dataDir = path.join(tempDir, "data");
  const recordsFile = path.join(tempDir, "records.jsonl");
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const recorderScript = path.join(tempDir, "record-agent.mjs");
  const agentIds = ["codex-120", "hermes-hk", "openclaw-hk"];

  writeRecorder(recorderScript, recordsFile);
  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    gatewayUrl: gateway,
    dataDir,
    token: adminToken,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 500
    },
    edgeTokens: [{
      token: edgeToken,
      label: "cache session smoke"
    }],
    plugins: {
      telegramBot: {
        enabled: true,
        dryRun: true,
        events: ["telegram.command", "run.completed", "run.failed"],
        control: {
          enabled: true,
          secretToken: webhookSecret,
          allowedChatIds: [chatId],
          allowRun: true,
          conversation: {
            enabled: true,
            agentId: "codex-120"
          }
        }
      }
    },
    modelRouter: {
      enabled: false,
      agentModels: true,
      backends: []
    }
  }, null, 2)}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "cache-session-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    pollTimeoutMs: 500,
    idleDelayMs: 50,
    defaultTimeoutMs: 10000,
    agents: agentIds.map((id) => ({
      id,
      kind: id.startsWith("codex") ? "codex" : id.startsWith("hermes") ? "hermes" : "openclaw",
      role: id.startsWith("hermes") ? "researcher" : "executor",
      enabled: true,
      adapter: "command",
      capabilities: ["cache-session", "telegram", "no-quota"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(recorderScript)}`
    }))
  }, null, 2)}\n`);

  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: adminToken,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir,
    AGENT_BUS_GATEWAY_URL: gateway
  });
  await waitForJson(`${gateway}/health`, 10000, central);

  const edge = start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig]);
  await waitForAgents(gateway, adminToken, agentIds);

  const first = await telegramWebhook(gateway, webhookSecret, chatId, "Cache smoke process start.");
  assert(first.command === "chat", "first Telegram message did not create a chat process");
  const threadId = first.thread?.id;
  assert(threadId, "first Telegram chat did not return a thread id");
  await waitForRecords(recordsFile, 1);

  const setAgents = await telegramWebhook(gateway, webhookSecret, chatId, `/agent ${agentIds.join(" ")}`);
  assert(setAgents.command === "agent", "/agent command failed");

  const second = await telegramWebhook(gateway, webhookSecret, chatId, "Cache smoke turn two for all agents.");
  assert(second.thread?.id === threadId, "second Telegram chat did not reuse the active process thread");
  await waitForRecords(recordsFile, 4);

  const third = await telegramWebhook(gateway, webhookSecret, chatId, "Cache smoke turn three for all agents.");
  assert(third.thread?.id === threadId, "third Telegram chat did not reuse the active process thread");
  await waitForRecords(recordsFile, 7);

  const longText = `Cache smoke long-context guard. ${"large-history-marker ".repeat(8000)}`;
  const fourth = await telegramWebhook(gateway, webhookSecret, chatId, longText);
  assert(fourth.thread?.id === threadId, "long Telegram chat did not reuse the active process thread");
  const records = await waitForRecords(recordsFile, 10);

  const grouped = Object.fromEntries(agentIds.map((id) => [id, records.filter((item) => item.agent_id === id)]));
  for (const id of agentIds) {
    assert(grouped[id].length >= 3, `${id} did not receive at least three runs`);
    assert(new Set(grouped[id].map((item) => item.thread_id)).size === 1, `${id} did not keep one thread id`);
    assert(grouped[id].every((item) => item.thread_id === threadId), `${id} used a different thread id`);
    assert(new Set(grouped[id].map((item) => item.session_id)).size === 1, `${id} did not keep a stable session id`);
    assert(grouped[id].every((item) => item.cache_key === item.session_id), `${id} session id did not match cache key`);
    assert(grouped[id].every((item) => item.message_bytes > 0), `${id} recorded an empty prompt`);
    assert(grouped[id].at(-1).message_bytes <= 22000, `${id} long-context prompt was not compacted`);
  }
  const sessionIds = agentIds.map((id) => grouped[id][0].session_id);
  assert(new Set(sessionIds).size === agentIds.length, "agent session ids should be distinct per agent");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  const result = {
    ok: true,
    quota: "no_model_calls",
    gateway,
    thread_id: threadId,
    agents: agentIds.map((id) => ({
      id,
      runs: grouped[id].length,
      session_id: grouped[id][0].session_id,
      cache_key: grouped[id][0].cache_key,
      explicit_cache_scope: grouped[id][0].cache_scope || "",
      message_bytes: grouped[id].map((item) => item.message_bytes)
    }))
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Agent Bus cache/session smoke passed");
    console.log(`Thread: ${threadId}`);
    for (const agent of result.agents) {
      console.log(`${agent.id}: runs=${agent.runs} session=${agent.session_id}`);
    }
  }
}

function writeRecorder(file, recordsFile) {
  fs.writeFileSync(file, `import fs from "node:fs";\nconst messageFile = process.env.AGENT_MESSAGE_FILE || "";\nconst message = messageFile && fs.existsSync(messageFile) ? fs.readFileSync(messageFile, "utf8") : process.env.AGENT_MESSAGE || "";\nconst record = {\n  agent_id: process.env.AGENT_ID || "",\n  run_id: process.env.AGENT_RUN_ID || "",\n  thread_id: process.env.AGENT_THREAD_ID || "",\n  room_id: process.env.AGENT_ROOM_ID || "",\n  trace_id: process.env.AGENT_TRACE_ID || "",\n  cache_scope: process.env.AGENT_CACHE_SCOPE || "",\n  cache_key: process.env.AGENT_CACHE_KEY || "",\n  session_id: process.env.AGENT_SESSION_ID || "",\n  message_bytes: Buffer.byteLength(message, "utf8")\n};\nfs.appendFileSync(${JSON.stringify(recordsFile)}, JSON.stringify(record) + "\\n");\nconsole.log(\`REPORT: \${record.agent_id} cache_key=\${record.cache_key} thread=\${record.thread_id} bytes=\${record.message_bytes}\`);\n`);
}

function telegramWebhook(gateway, secret, chatId, text) {
  return requestJson(`${gateway}/v1/agent-bus/plugins/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret
    },
    body: JSON.stringify({
      update_id: Date.now(),
      message: {
        message_id: Date.now(),
        chat: { id: chatId, type: "private" },
        text
      }
    })
  });
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child._agentBusOutput = "";
  child.stdout.on("data", (chunk) => {
    child._agentBusOutput += chunk.toString("utf8");
    if (!jsonOut && /listening|connected/.test(chunk.toString())) process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    child._agentBusOutput += chunk.toString("utf8");
    if (!jsonOut) process.stderr.write(chunk);
  });
  children.push(child);
  return child;
}

function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

async function waitForAgents(gateway, token, agentIds, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      const online = new Set(agents.filter((agent) => agent.status === "online").map((agent) => agent.id));
      if (agentIds.every((id) => online.has(id))) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForRecords(file, count, timeoutMs = 10000) {
  const started = Date.now();
  let records = [];
  while (Date.now() - started < timeoutMs) {
    records = readJsonl(file);
    if (records.length >= count) return records;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${count} cache records, got ${records.length}`);
}

async function waitForJson(url, timeoutMs = 10000, child = null) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child && child.exitCode !== null) throw new Error(`Process exited before ${url} became ready`);
    try {
      return await requestJson(url);
    } catch {
      await delay(200);
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

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
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
  const candidates = [...new Set([
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean))];
  for (const command of candidates) {
    const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore"
    });
    if (!result.error && result.status === 0) return command;
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

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
