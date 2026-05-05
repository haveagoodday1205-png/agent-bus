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
    const results = await Promise.all(publicAgents(config).map((agent) => runLocalHealth(config, agent)));
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
  config.agents ||= [];
  return config;
}

function publicAgents(config) {
  return config.agents
    .filter((agent) => agent.enabled !== false)
    .map((agent) => ({
      id: agent.id,
      kind: agent.kind || "agent",
      role: agent.role || "worker",
      enabled: agent.enabled !== false,
      adapter: agent.adapter || "command",
      capabilities: agent.capabilities || []
    }));
}

async function connectLoop(config, options = {}) {
  await register(config);
  console.log(`edge-node ${config.nodeId} connected to ${config.gatewayUrl}`);

  while (true) {
    const payload = await postJson(config, "/edge/poll", {
      node_id: config.nodeId,
      timeout_ms: config.pollTimeoutMs
    });

    if (payload.type === "task" && payload.task) {
      await handleTask(config, payload.task);
      if (options.once) return;
      continue;
    }

    if (options.once) return;
    await delay(config.idleDelayMs);
  }
}

async function register(config) {
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
  }
  result.duration_ms = Date.now() - started;
  await complete(config, task, result);
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

function spawnCommand(config, agent, task, commandText, options = {}) {
  return new Promise((resolve) => {
    const timeoutMs = Number(agent.timeoutMs || config.defaultTimeoutMs || 600000);
    const child = spawn(commandText, {
      shell: true,
      windowsHide: true,
      cwd: resolvePath(agent.cwd || config.cwd || process.cwd(), path.dirname(configPath)),
      env: {
        ...process.env,
        AGENT_MESSAGE: task.message || "",
        AGENT_RUN_ID: task.run_id || "",
        AGENT_ID: agent.id,
        EDGE_NODE_ID: config.nodeId
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({
        status: "failed",
        exit_code: 124,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms`.trim()
      });
    }, timeoutMs);

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
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: "error", exit_code: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
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
    event: payload
  });
}

async function complete(config, task, result) {
  return postJson(config, "/edge/complete", {
    node_id: config.nodeId,
    run_id: task.run_id,
    result
  });
}

async function postJson(config, pathname, body) {
  const res = await fetch(gatewayEndpoint(config.gatewayUrl, pathname), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {})
    },
    body: JSON.stringify(body)
  });
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
