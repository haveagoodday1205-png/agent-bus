import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] || "connect";
const configPath = optionValue("--config") || path.join(__dirname, "edge.config.json");

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});

async function main() {
  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    printHelp();
    return;
  }
  if (!fs.existsSync(configPath)) {
    const example = path.join(__dirname, "edge.config.example.json");
    throw new Error(`Missing config: ${configPath}\nCreate it from ${example}`);
  }
  const config = loadConfig(configPath);

  if (command === "agents") {
    console.log(JSON.stringify(publicAgents(config), null, 2));
    return;
  }
  if (command === "health") {
    const results = await Promise.all(config.agents.filter((agent) => agent.enabled !== false).map((agent) => runLocalHealth(config, agent)));
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (command === "connect") {
    await connectLoop(config, { once: argv.includes("--once") });
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`edge-node

Usage:
  node edge-node.mjs connect [--config edge.config.json] [--once]
  node edge-node.mjs agents [--config edge.config.json]
  node edge-node.mjs health [--config edge.config.json]
`);
}

function loadConfig(file) {
  const raw = fs.readFileSync(file, "utf8");
  const config = JSON.parse(raw);
  config.nodeId ||= os.hostname();
  config.gatewayUrl ||= "http://127.0.0.1:8788";
  config.nodeId = process.env.AGENT_BUS_NODE_ID || config.nodeId;
  config.gatewayUrl = process.env.AGENT_BUS_GATEWAY_URL || config.gatewayUrl;
  config.token = process.env.AGENT_BUS_TOKEN || config.token;
  config.pollTimeoutMs ||= 25000;
  config.idleDelayMs ||= 1000;
  config.defaultTimeoutMs ||= 600000;
  config.healthProbeIntervalMs ||= 60000;
  config.healthProbeTimeoutMs ||= 5000;
  config.runHeartbeatIntervalMs ||= 30000;
  config.completeRetryAttempts ||= 5;
  config.completeRetryBaseDelayMs ||= 2000;
  config.agents ||= [];
  config._agentHealth = {};
  config._nextHealthProbeAt = 0;
  return config;
}

function publicAgents(config) {
  const heartbeatIntervalMs = Number(config.runHeartbeatIntervalMs || 0);
  const runHeartbeatIntervalMs = Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0
    ? Math.round(heartbeatIntervalMs)
    : null;
  return config.agents
    .filter((agent) => agent.enabled !== false)
    .map((agent) => ({
      id: agent.id,
      kind: agent.kind || "agent",
      role: agent.role || "worker",
      enabled: agent.enabled !== false,
      adapter: agent.adapter || "command",
      capabilities: agent.capabilities || [],
      ...(runHeartbeatIntervalMs ? { run_heartbeat_interval_ms: runHeartbeatIntervalMs } : {}),
      health: agentHealth(config, agent)
    }));
}

function agentHealth(config, agent) {
  const cached = config._agentHealth?.[agent.id];
  if (cached) return cached;
  const pingUrl = agentPingUrl(agent);
  return {
    kind: pingUrl ? "url" : "none",
    ping_status: pingUrl ? "unknown" : "not_configured",
    checked_at: null,
    ...(pingUrl ? { ping_target: safeUrlForStatus(pingUrl) } : {})
  };
}

async function connectLoop(config, options = {}) {
  let registered = false;
  let failures = 0;

  while (true) {
    try {
      if (!registered) {
        await register(config);
        registered = true;
        failures = 0;
        console.log(`edge-node ${config.nodeId} connected to ${config.gatewayUrl}`);
      }

      await refreshAgentHealth(config);
      const payload = await postJson(config, "/edge/poll", {
        node_id: config.nodeId,
        timeout_ms: config.pollTimeoutMs,
        agents: publicAgents(config)
      });

      failures = 0;
      if (payload.type === "task" && payload.task) {
        await handleTask(config, payload.task);
        if (options.once) return;
        continue;
      }

      if (options.once) return;
      await delay(config.idleDelayMs);
    } catch (err) {
      if (isAuthError(err) || isPermanentClientError(err)) throw err;
      if (isRegistrationLost(err)) registered = false;
      failures += 1;
      const waitMs = reconnectDelayMs(config, failures);
      console.error(`edge-node ${config.nodeId} transient error: ${err.message || err}; retrying in ${waitMs}ms`);
      if (options.once) throw err;
      await delay(waitMs);
    }
  }
}

async function register(config) {
  await refreshAgentHealth(config, { force: true });
  return postJson(config, "/edge/register", {
    node_id: config.nodeId,
    hostname: os.hostname(),
    version: "0.1.0",
    agents: publicAgents(config)
  });
}

async function handleTask(config, task) {
  const agent = config.agents.find((item) => item.id === task.agent_id && item.enabled !== false);
  if (!agent) {
    await complete(config, task, {
      status: "failed",
      exit_code: 127,
      stdout: "",
      stderr: `Agent not found on node ${config.nodeId}: ${task.agent_id}`
    });
    return;
  }

  await event(config, task, { type: "run.started", agent_id: agent.id });
  const started = Date.now();
  const heartbeat = startRunHeartbeat(config, task, agent);
  let result;
  try {
    result = await runAgent(config, agent, task);
  } catch (err) {
    result = {
      status: "error",
      exit_code: null,
      stdout: "",
      stderr: err.stack || err.message || String(err)
    };
  } finally {
    clearInterval(heartbeat);
  }
  result.duration_ms = Date.now() - started;
  recordRunHealth(config, agent, result);
  await complete(config, task, result);
}

function startRunHeartbeat(config, task, agent) {
  const intervalMs = Number(config.runHeartbeatIntervalMs || 0);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  const timer = setInterval(() => {
    event(config, task, { type: "run.heartbeat", agent_id: agent.id }).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return timer;
}

async function runAgent(config, agent, task) {
  if ((agent.adapter || "command") === "echo") {
    const stdout = `[${agent.id}] ${task.message}\n`;
    await event(config, task, { type: "run.output", stream: "stdout", text: stdout });
    return { status: "completed", exit_code: 0, stdout, stderr: "", summary: stdout.trim() };
  }

  if ((agent.adapter || "command") !== "command") {
    return {
      status: "failed",
      exit_code: 126,
      stdout: "",
      stderr: `Unsupported adapter for ${agent.id}: ${agent.adapter}`
    };
  }

  const commandText = agent.runCommand;
  if (!commandText) {
    return { status: "failed", exit_code: 126, stdout: "", stderr: `Missing runCommand for ${agent.id}` };
  }
  return spawnCommand(config, agent, task, commandText);
}

async function runLocalHealth(config, agent) {
  const pingUrl = agentPingUrl(agent);
  if (pingUrl) {
    return { agent_id: agent.id, ...(await probePingUrl(config, agent, pingUrl)) };
  }
  if (agent.adapter === "echo") {
    return { agent_id: agent.id, status: "completed", exit_code: 0, stdout: "echo adapter ok\n", stderr: "" };
  }
  if (!agent.healthCommand) {
    return { agent_id: agent.id, status: "unknown", exit_code: null, stdout: "", stderr: "No healthCommand configured" };
  }
  const task = { run_id: `local_${crypto.randomUUID()}`, message: "" };
  const result = await spawnCommand(config, agent, task, agent.healthCommand, { emit: false });
  return { agent_id: agent.id, ...result };
}

async function refreshAgentHealth(config, options = {}) {
  const nowMs = Date.now();
  if (!options.force && nowMs < Number(config._nextHealthProbeAt || 0)) return;
  config._nextHealthProbeAt = nowMs + Number(config.healthProbeIntervalMs || 60000);
  const enabledAgents = config.agents.filter((agent) => agent.enabled !== false);
  const results = await Promise.all(enabledAgents.map(async (agent) => [agent.id, await probeAgent(config, agent)]));
  for (const [agentId, health] of results) {
    config._agentHealth[agentId] = mergeHealth(config._agentHealth[agentId], health);
  }
}

async function probeAgent(config, agent) {
  const pingUrl = agentPingUrl(agent);
  if (!pingUrl) return agentHealth(config, agent);
  return probePingUrl(config, agent, pingUrl);
}

async function probePingUrl(config, agent, pingUrl) {
  const started = Date.now();
  const timeoutMs = Number(agent.healthProbeTimeoutMs || config.healthProbeTimeoutMs || 5000);
  try {
    const res = await fetchWithTimeout(pingUrl, { method: "HEAD" }, timeoutMs);
    return pingHealth("HEAD", res.status, started, pingUrl);
  } catch (err) {
    if (err?.statusCode === 405 || /405/.test(err?.message || "")) {
      try {
        const res = await fetchWithTimeout(pingUrl, { method: "GET" }, timeoutMs);
        return pingHealth("GET", res.status, started, pingUrl);
      } catch (getErr) {
        return pingFailure(getErr, started, pingUrl);
      }
    }
    return pingFailure(err, started, pingUrl);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (res.status === 405) {
      const err = new Error("405 Method Not Allowed");
      err.statusCode = 405;
      throw err;
    }
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function pingHealth(method, statusCode, started, pingUrl) {
  return {
    kind: "url",
    ping_status: statusCode >= 500 ? "unhealthy" : "reachable",
    http_status: statusCode,
    method,
    latency_ms: Date.now() - started,
    checked_at: new Date().toISOString(),
    ping_target: safeUrlForStatus(pingUrl)
  };
}

function pingFailure(err, started, pingUrl) {
  return {
    kind: "url",
    ping_status: "unreachable",
    latency_ms: Date.now() - started,
    checked_at: new Date().toISOString(),
    ping_target: safeUrlForStatus(pingUrl),
    error: String(err?.message || err).slice(0, 500)
  };
}

function agentPingUrl(agent) {
  return agent.pingUrl || agent.healthUrl || agent.modelUrl || "";
}

function safeUrlForStatus(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

function recordRunHealth(config, agent, result) {
  const nowText = new Date().toISOString();
  config._agentHealth[agent.id] = mergeHealth(config._agentHealth[agent.id], {
    last_run_status: result.status,
    last_run_at: nowText,
    ...(result.status === "completed"
      ? { last_success_at: nowText }
      : { last_error_at: nowText, last_error: String(result.stderr || result.summary || "run failed").slice(0, 2000) })
  });
}

function mergeHealth(current, next) {
  return { ...(current || {}), ...(next || {}) };
}

const MAX_ENV_MESSAGE_BYTES = 24 * 1024;

function agentRuntimeEnv(config, agent, task, messageFile = "") {
  const threadId = String(task.thread_id || "");
  const roomId = String(task.room_id || "");
  const traceId = String(task.trace_id || "");
  const cacheScope = String(task.cache_scope || "");
  const message = String(task.message || "");
  const cacheKey = agentCacheKey(agent, task, cacheScope || roomId || threadId || task.run_id || "");
  return {
    AGENT_MESSAGE: envSafeMessage(message),
    AGENT_MESSAGE_FILE: messageFile,
    AGENT_MESSAGE_BYTES: String(Buffer.byteLength(message, "utf8")),
    AGENT_RUN_ID: task.run_id || "",
    AGENT_THREAD_ID: threadId,
    AGENT_ROOM_ID: roomId,
    AGENT_TRACE_ID: traceId,
    AGENT_CACHE_SCOPE: cacheScope,
    AGENT_CACHE_KEY: cacheKey,
    AGENT_SESSION_ID: cacheKey,
    AGENT_ID: agent.id,
    EDGE_NODE_ID: config.nodeId
  };
}

function envSafeMessage(message) {
  return Buffer.byteLength(message, "utf8") <= MAX_ENV_MESSAGE_BYTES ? message : "";
}

function writeTaskMessageFile(message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-msg-"));
  const file = path.join(dir, "message.txt");
  fs.writeFileSync(file, message, "utf8");
  return {
    file,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
  };
}

function agentCacheKey(agent, task, scopeId) {
  const agentPart = sanitizeCacheKeyPart(agent.id || task.agent_id || "agent");
  const scopePart = compactCacheScope(scopeId || task.run_id || "local");
  return boundedCacheKey(`agent-bus-${agentPart}-${scopePart}`);
}

function compactCacheScope(value) {
  const raw = String(value || "");
  const cleaned = sanitizeCacheKeyPart(raw);
  if (cleaned.length <= 32 && !/^(?:room|thread|run)[_.-]/i.test(cleaned)) return cleaned;
  const prefix = /^room[_.-]/i.test(cleaned)
    ? "room"
    : /^thread[_.-]/i.test(cleaned)
      ? "thread"
      : /^run[_.-]/i.test(cleaned)
        ? "run"
        : "scope";
  const hash = crypto.createHash("sha256").update(raw || cleaned).digest("hex").slice(0, 16);
  return `${prefix}-${hash}`;
}

function sanitizeCacheKeyPart(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "unknown";
}

function boundedCacheKey(value) {
  const text = String(value || "agent-bus-unknown");
  if (text.length <= 180) return text;
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  return `${text.slice(0, 167)}-${hash}`;
}

function spawnCommand(config, agent, task, commandText, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(agent.timeoutMs || config.defaultTimeoutMs || 600000);
    const timeoutGraceMs = Math.max(0, Number(agent.timeoutGraceMs || config.timeoutGraceMs || 3000));
    const messageFile = writeTaskMessageFile(String(task.message || ""));
    const finish = (result) => {
      messageFile.cleanup();
      resolve(result);
    };
    let child;
    try {
      child = spawn(commandText, {
        shell: true,
        windowsHide: true,
        cwd: resolvePath(agent.cwd || config.cwd || process.cwd(), path.dirname(configPath)),
        env: {
          ...process.env,
          ...agentRuntimeEnv(config, agent, task, messageFile.file)
        }
      });
    } catch (err) {
      finish({ status: "error", exit_code: 1, stdout: "", stderr: err.stack || err.message || String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const finishOnce = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      finish(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGTERM");
      if (timeoutGraceMs > 0) {
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
        }, timeoutGraceMs);
        killTimer.unref?.();
      } else {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (options.emit !== false) void event(config, task, { type: "run.output", stream: "stdout", text });
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      if (options.emit !== false) void event(config, task, { type: "run.output", stream: "stderr", text });
    });
    child.on("error", (err) => {
      finishOnce({ status: "error", exit_code: 1, stdout, stderr: err.message });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finishOnce({
          status: "failed",
          exit_code: 124,
          stdout,
          stderr: `${stderr}\nTimed out after ${timeoutMs}ms${signal ? ` (${signal})` : ""}`.trim()
        });
        return;
      }
      finishOnce({
        status: code === 0 ? "completed" : "failed",
        exit_code: code ?? 1,
        stdout,
        stderr,
        summary: stdout.trim().slice(0, 2000)
      });
    });
  });
}

async function event(config, task, payload) {
  return postJson(config, "/edge/events", {
    node_id: config.nodeId,
    run_id: task.run_id,
    trace_id: task.trace_id || "",
    event: payload
  });
}

async function complete(config, task, result) {
  const body = {
    node_id: config.nodeId,
    run_id: task.run_id,
    trace_id: task.trace_id || "",
    result
  };
  const maxAttempts = Math.max(1, Number(config.completeRetryAttempts || 5));
  const baseDelayMs = Math.max(100, Number(config.completeRetryBaseDelayMs || 2000));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await postJson(config, "/edge/complete", body);
    } catch (err) {
      if (isPermanentClientError(err)) throw err;
      if (attempt === maxAttempts) {
        console.error(`edge-node: failed to submit result for run ${task.run_id} after ${maxAttempts} attempts: ${err.message}`);
        throw err;
      }
      const delayMs = Math.min(30000, baseDelayMs * (2 ** Math.min(attempt - 1, 5)));
      console.error(`edge-node: /edge/complete attempt ${attempt} failed (${err.message}); retrying in ${delayMs}ms`);
      await delay(delayMs);
    }
  }
}

async function postJson(config, pathname, body) {
  let res;
  try {
    res = await fetch(gatewayEndpoint(config.gatewayUrl, pathname), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    err.transient = true;
    throw err;
  }
  const text = await res.text();
  let data = {};
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.statusCode = res.status;
    throw err;
  }
  return data;
}

function isAuthError(err) {
  return err?.statusCode === 401 || err?.statusCode === 403 || /unauthorized|forbidden/i.test(err?.message || "");
}

function isPermanentClientError(err) {
  return err?.statusCode >= 400 && err?.statusCode < 500 && !isRegistrationLost(err);
}

function isRegistrationLost(err) {
  return err?.statusCode === 404 && /unknown node_id/i.test(err?.message || "");
}

function reconnectDelayMs(config, failures) {
  const base = Number(config.reconnectBaseDelayMs || 1000);
  const max = Number(config.reconnectMaxDelayMs || 30000);
  const delayMs = Math.min(max, base * (2 ** Math.min(failures - 1, 5)));
  return Math.round(delayMs + Math.random() * Math.min(1000, delayMs / 2));
}

function gatewayEndpoint(gatewayUrl, pathname) {
  const url = new URL(gatewayUrl);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${pathname}`.replace(/\/{2,}/g, "/");
  return url;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optionValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function resolvePath(value, baseDir) {
  if (!value) return value;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return value;
  return path.resolve(baseDir, value);
}
