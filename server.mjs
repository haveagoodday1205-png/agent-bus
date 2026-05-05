import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] || "help";
const configPath = optionValue("--config") || path.join(__dirname, "config.json");

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});

async function main() {
  if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  if (!fs.existsSync(configPath)) {
    const example = path.join(__dirname, "config.example.json");
    throw new Error(`Missing config: ${configPath}\nCreate it from ${example}`);
  }

  const config = loadConfig(configPath);
  ensureDataDir(config);

  if (command === "serve") {
    await serve(config);
    return;
  }
  if (command === "agents") {
    console.log(JSON.stringify(publicAgents(config), null, 2));
    return;
  }
  if (command === "route") {
    const message = positionalAfter("route").join(" ").trim() || optionValue("--message");
    if (!message) throw new Error("Missing message. Example: node server.mjs route \"fix tests\"");
    const selection = selectAgentsForThread(config, {
      message,
      agentSelector: optionValue("--agents"),
      mode: optionValue("--mode") || "orchestrate"
    });
    console.log(JSON.stringify(publicSelection(selection), null, 2));
    return;
  }
  if (command === "health") {
    const agents = selectAgents(config, optionValue("--agents"));
    const results = await runForAgents(config, agents, { type: "health" });
    for (const run of results) appendJsonl(config, "runs.jsonl", sanitizeRun(run));
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (command === "run") {
    const message = positionalAfter("run").join(" ").trim() || optionValue("--message");
    if (!message) throw new Error("Missing message. Example: node server.mjs run \"check status\"");
    const result = await createThreadRun(config, {
      message,
      agentSelector: optionValue("--agents"),
      mode: optionValue("--mode") || config.defaults.mode || "broadcast",
      source: "cli"
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`distributed-agent-bus

Usage:
  node server.mjs serve [--config config.json]
  node server.mjs agents [--config config.json]
  node server.mjs route "task text" [--mode orchestrate] [--agents openclaw-hk]
  node server.mjs health [--agents openclaw-hk,hermes-hk]
  node server.mjs run "task text" [--agents openclaw-hk,codex-120] [--mode broadcast|orchestrate]

HTTP API:
  GET  /health
  GET  /agents
  POST /route          {"message":"...", "mode":"orchestrate"}
  POST /threads        {"message":"...", "agents":["openclaw-hk"], "mode":"orchestrate"}
  GET  /threads/:id
`);
}

function loadConfig(file) {
  const raw = fs.readFileSync(file, "utf8");
  const config = JSON.parse(raw);
  config.dataDir = resolvePath(config.dataDir || "./data", path.dirname(file));
  config.host ||= "127.0.0.1";
  config.port ||= 8787;
  config.defaults ||= {};
  config.agents ||= [];
  return config;
}

function ensureDataDir(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

function publicAgents(config) {
  return config.agents.map((agent) => ({
    id: agent.id,
    kind: agent.kind,
    role: agent.role,
    enabled: agent.enabled !== false,
    transport: agent.transport,
    host: agent.host,
    capabilities: agent.capabilities || []
  }));
}

function publicSelection(selection) {
  return {
    mode: selection.mode,
    reason: selection.reason,
    matched: selection.matched,
    agents: selection.agents.map((agent) => ({
      id: agent.id,
      kind: agent.kind,
      role: agent.role,
      host: agent.host,
      capabilities: agent.capabilities || []
    }))
  };
}

async function serve(config) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${config.host}:${config.port}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, { ok: true, agents: config.agents.filter((a) => a.enabled !== false).length });
      }
      if (req.method === "GET" && url.pathname === "/agents") {
        return sendJson(res, publicAgents(config));
      }
      if (req.method === "POST" && url.pathname === "/route") {
        const body = await readJson(req);
        if (!body.message || typeof body.message !== "string") {
          return sendJson(res, { error: "message is required" }, 400);
        }
        const requested = Array.isArray(body.agents) ? body.agents.join(",") : undefined;
        const selection = selectAgentsForThread(config, {
          message: body.message,
          agentSelector: requested,
          mode: body.mode || "orchestrate"
        });
        return sendJson(res, publicSelection(selection));
      }
      if (req.method === "POST" && url.pathname === "/threads") {
        const body = await readJson(req);
        if (!body.message || typeof body.message !== "string") {
          return sendJson(res, { error: "message is required" }, 400);
        }
        const requested = Array.isArray(body.agents) ? body.agents.join(",") : undefined;
        const result = await createThreadRun(config, {
          message: body.message,
          agentSelector: requested,
          mode: body.mode || config.defaults.mode || "broadcast",
          source: "http"
        });
        return sendJson(res, result, 201);
      }
      if (req.method === "GET" && url.pathname.startsWith("/threads/")) {
        const id = url.pathname.split("/").filter(Boolean)[1];
        const thread = readThread(config, id);
        if (!thread) return sendJson(res, { error: "not_found" }, 404);
        return sendJson(res, thread);
      }
      return sendJson(res, { error: "not_found" }, 404);
    } catch (err) {
      return sendJson(res, { error: err.message || "internal_error" }, err.statusCode || 500);
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`distributed-agent-bus listening on http://${config.host}:${config.port}`);
  });
}

async function createThreadRun(config, input) {
  const threadId = `thread_${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const selection = selectAgentsForThread(config, input);
  const agents = selection.agents;
  const thread = {
    id: threadId,
    created_at: createdAt,
    source: input.source,
    mode: selection.mode,
    message: input.message,
    selection: {
      reason: selection.reason,
      matched: selection.matched,
      agents: agents.map((a) => a.id)
    },
    requested_agents: agents.map((a) => a.id),
    runs: []
  };
  appendJsonl(config, "threads.jsonl", thread);

  const runs = await runForAgents(config, agents, { type: "run", threadId, message: input.message });
  for (const run of runs) appendJsonl(config, "runs.jsonl", sanitizeRun(run));
  thread.runs = runs;
  writeThreadSnapshot(config, thread);
  return thread;
}

async function runForAgents(config, agents, task) {
  const maxParallel = Number(config.defaults.maxParallelAgents || 3);
  const hostPacingMs = Number(config.defaults.sameHostDelayMs || 0);
  const queue = [...agents];
  const results = [];
  const hostLocks = new Map();

  async function worker() {
    while (queue.length) {
      const agent = queue.shift();
      results.push(await runWithHostPacing(config, agent, task, hostLocks, hostPacingMs));
    }
  }

  await Promise.all(Array.from({ length: Math.min(maxParallel, queue.length) }, worker));
  return results.sort((a, b) => a.agent_id.localeCompare(b.agent_id));
}

async function runWithHostPacing(config, agent, task, hostLocks, hostPacingMs) {
  const key = `${agent.user || "root"}@${agent.host}`;
  const previous = hostLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  hostLocks.set(key, previous.then(() => current));

  await previous;
  try {
    return await runAgent(config, agent, task);
  } finally {
    if (hostPacingMs > 0) await delay(hostPacingMs);
    release();
  }
}

async function runAgent(config, agent, task) {
  const startedAt = new Date().toISOString();
  const runId = `run_${crypto.randomUUID()}`;
  try {
    const commandText = task.type === "health" ? agent.healthCommand : agent.runCommand;
    if (!commandText) throw new Error(`Agent ${agent.id} has no ${task.type} command`);
    const output = await runSshCommand(config, agent, commandText, task.message || "", task.type);
    return {
      id: runId,
      thread_id: task.threadId || null,
      agent_id: agent.id,
      kind: agent.kind,
      type: task.type,
      status: output.exitCode === 0 ? "completed" : "failed",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      exit_code: output.exitCode,
      stdout: trimOutput(redactSensitive(output.stdout)),
      stderr: trimOutput(redactSensitive(output.stderr)),
      attempts: output.attempts || 1,
      retried: Boolean(output.retried)
    };
  } catch (err) {
    return {
      id: runId,
      thread_id: task.threadId || null,
      agent_id: agent.id,
      kind: agent.kind,
      type: task.type,
      status: "error",
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      exit_code: null,
      stdout: "",
      stderr: trimOutput(redactSensitive(err.stack || err.message || String(err))),
      attempts: 1,
      retried: false
    };
  }
}

function runSshCommand(config, agent, commandText, message, taskType = "run") {
  if (agent.transport !== "ssh-command") {
    throw new Error(`Unsupported transport for ${agent.id}: ${agent.transport}`);
  }
  const keyPath = normalizePath(agent.keyPath);
  const timeoutMs = Number(agent.timeoutMs || config.defaults.timeoutMs || 600000);
  const messageB64 = Buffer.from(message || "", "utf8").toString("base64");
  const remoteScript = message
    ? [
        "set -e",
        `AGENT_MESSAGE="$(printf '%s' '${messageB64}' | base64 -d)"`,
        "export AGENT_MESSAGE",
        commandText
      ].join("\n")
    : commandText;

  const args = [
    "-i", keyPath,
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=no",
    "-o", "IdentitiesOnly=yes",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "ConnectionAttempts=2",
    "-o", "ConnectTimeout=12",
    ...sshOptionArgs(config.defaults.sshOptions),
    ...sshOptionArgs(agent.sshOptions),
    `${agent.user || "root"}@${agent.host}`,
    remoteScript
  ];

  const sshPath = resolveSshPath(config);
  if (process.platform === "win32" && config.sshViaPowerShell !== false) {
    return spawnPowerShellSshWithRetry(sshPath, args, {
      timeoutMs,
      retries: Number(agent.sshRetries ?? config.defaults.sshRetries ?? 0),
      retryDelayMs: Number(agent.sshRetryDelayMs ?? config.defaults.sshRetryDelayMs ?? 1000),
      retryBackoff: Number(agent.sshRetryBackoff ?? config.defaults.sshRetryBackoff ?? 1.5),
      retryExitCodes: agent.sshRetryExitCodes ?? config.defaults.sshRetryExitCodes,
      retryEmptyFailure: taskType === "health" || Boolean(agent.sshRetryOnEmptyFailure ?? config.defaults.sshRetryOnEmptyFailure)
    });
  }
  return spawnCaptureWithRetry(sshPath, args, {
    timeoutMs,
    retries: Number(agent.sshRetries ?? config.defaults.sshRetries ?? 0),
    retryDelayMs: Number(agent.sshRetryDelayMs ?? config.defaults.sshRetryDelayMs ?? 1000),
    retryBackoff: Number(agent.sshRetryBackoff ?? config.defaults.sshRetryBackoff ?? 1.5),
    retryExitCodes: agent.sshRetryExitCodes ?? config.defaults.sshRetryExitCodes,
    retryEmptyFailure: taskType === "health" || Boolean(agent.sshRetryOnEmptyFailure ?? config.defaults.sshRetryOnEmptyFailure)
  });
}

async function spawnPowerShellSshWithRetry(sshPath, args, options = {}) {
  const ps = resolvePowerShellPath();
  const commandText = `& ${psQuote(sshPath)} ${args.map(psQuote).join(" ")}`;
  return spawnCaptureWithRetry(ps, ["-NoProfile", "-NonInteractive", "-Command", commandText], options);
}

async function spawnCaptureWithRetry(cmd, args, options = {}) {
  let last = null;
  const attempts = Math.max(1, Number(options.retries || 0) + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await spawnCapture(cmd, args, options);
    last.attempts = attempt;
    last.retried = attempt > 1;
    if (!shouldRetrySsh(last, options) || attempt === attempts) return last;
    const baseDelay = Number(options.retryDelayMs || 1000);
    const backoff = Number(options.retryBackoff || 1);
    await delay(Math.round(baseDelay * Math.max(1, backoff ** (attempt - 1))));
  }
  return last;
}

function shouldRetrySsh(result, options = {}) {
  if (!result) return false;
  const retryExitCodes = new Set([1, 255, 4294967295, -1, ...(Array.isArray(options.retryExitCodes) ? options.retryExitCodes : [])]);
  if (options.retryEmptyFailure && result.exitCode === 1 && !result.stdout && !result.stderr) return true;
  if (!retryExitCodes.has(result.exitCode)) return false;
  const stderr = result.stderr || "";
  return /Connection closed|closed by remote host|kex_exchange_identification|Error reading SSH protocol banner|Connection reset|Connection timed out|No route to host|broken pipe|ssh_exchange_identification/i.test(stderr);
}

function spawnCapture(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\nTimed out after ${options.timeoutMs}ms`.trim() });
    }, options.timeoutMs || 600000);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: err.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectAgents(config, selector) {
  const enabled = config.agents.filter((agent) => agent.enabled !== false);
  if (!selector) return enabled;
  const wanted = new Set(String(selector).split(",").map((v) => v.trim()).filter(Boolean));
  const selected = enabled.filter((agent) => wanted.has(agent.id));
  const missing = [...wanted].filter((id) => !selected.some((agent) => agent.id === id));
  if (missing.length) throw new Error(`Unknown or disabled agents: ${missing.join(", ")}`);
  return selected;
}

function selectAgentsForThread(config, input) {
  if (input.agentSelector) {
    const agents = selectAgents(config, input.agentSelector);
    return {
      agents,
      mode: "explicit",
      reason: "Explicit agent selector was provided.",
      matched: ["--agents"]
    };
  }

  const mode = input.mode || "broadcast";
  if (mode !== "orchestrate") {
    const agents = selectAgents(config);
    return {
      agents,
      mode: "broadcast",
      reason: "No selector was provided, so all enabled agents were selected.",
      matched: ["all-enabled"]
    };
  }

  return orchestrateAgents(config, input.message || "");
}

function orchestrateAgents(config, message) {
  const text = String(message || "").toLowerCase();
  const rules = [
    {
      token: "code",
      pattern: /(code|repo|bug|test|patch|commit|review|typescript|javascript|node|python|实现|代码|修复|测试|仓库|重构)/i,
      predicate: (agent) => hasAny(agent, ["code", "review"]) || agent.kind === "codex" || agent.role === "coder"
    },
    {
      token: "ops",
      pattern: /(shell|terminal|file|deploy|browser|cron|ssh|server|机器|服务器|终端|命令|文件|部署|浏览器|定时)/i,
      predicate: (agent) => agent.role === "executor" || agent.kind === "openclaw"
    },
    {
      token: "research",
      pattern: /(research|plan|design|compare|investigate|web|browser|调研|研究|设计|方案|浏览器|搜索|资料)/i,
      predicate: (agent) => agent.kind === "hermes" || agent.role === "researcher" || (/web|browser|浏览器|搜索/i.test(text) && hasAny(agent, ["browser"]))
    },
    {
      token: "gateway",
      pattern: /(model|api|gateway|proxy|sub2api|cliproxyapi|token|key|openai|模型|网关|代理|接口|密钥)/i,
      predicate: (agent) => hasAny(agent, ["models", "sub2api", "cliproxyapi"]) || agent.role === "model-gateway"
    }
  ];

  const matchedRules = rules.filter((rule) => rule.pattern.test(text));
  const enabled = selectAgents(config);
  const selected = new Map();
  for (const rule of matchedRules) {
    for (const agent of enabled.filter(rule.predicate)) selected.set(agent.id, agent);
  }

  if (!selected.size) {
    for (const agent of enabled.filter((agent) => ["coder", "executor"].includes(agent.role))) selected.set(agent.id, agent);
  }

  const agents = [...selected.values()];
  return {
    agents: agents.length ? agents : enabled,
    mode: "orchestrate",
    reason: matchedRules.length
      ? `Selected agents by message intent: ${matchedRules.map((rule) => rule.token).join(", ")}.`
      : "No strong intent matched, so executor/coder agents were selected as a conservative default.",
    matched: matchedRules.length ? matchedRules.map((rule) => rule.token) : ["default-executor-coder"]
  };
}

function hasAny(agent, capabilities) {
  const values = new Set(agent.capabilities || []);
  return capabilities.some((capability) => values.has(capability));
}

function appendJsonl(config, fileName, value) {
  fs.appendFileSync(path.join(config.dataDir, fileName), `${JSON.stringify(redactObject(value))}\n`);
}

function writeThreadSnapshot(config, thread) {
  const dir = path.join(config.dataDir, "threads");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${thread.id}.json`), `${JSON.stringify(redactObject(thread), null, 2)}\n`);
}

function readThread(config, id) {
  const file = path.join(config.dataDir, "threads", `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function trimOutput(value) {
  const text = String(value || "");
  const limit = 120000;
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
}

function sanitizeRun(run) {
  return redactObject(run);
}

function redactObject(value) {
  if (typeof value === "string") return redactSensitive(value);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redactObject);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactObject(item)]));
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\b(org|proj)_[A-Za-z0-9_-]{12,}\b/g, "$1_[REDACTED]")
    .replace(/\b(?:api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"'\s]+/gi, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.split(separator)[0]}${separator}[REDACTED]`;
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch (err) {
        err.statusCode = 400;
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, value, status = 200) {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function optionValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function positionalAfter(name) {
  const index = argv.indexOf(name);
  if (index === -1) return [];
  const out = [];
  for (let i = index + 1; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

function resolvePath(value, baseDir) {
  if (!value) return value;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return value;
  return path.resolve(baseDir, value);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function sshOptionArgs(values) {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => ["-o", String(value)]);
}

function resolveSshPath(config) {
  if (config.sshPath) return normalizePath(config.sshPath);
  if (process.platform === "win32") {
    const systemSsh = "C:/Windows/System32/OpenSSH/ssh.exe";
    if (fs.existsSync(systemSsh)) return systemSsh;
  }
  return "ssh";
}

function resolvePowerShellPath() {
  const pwsh = "C:/Program Files/PowerShell/7/pwsh.exe";
  if (fs.existsSync(pwsh)) return pwsh;
  return "powershell.exe";
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
