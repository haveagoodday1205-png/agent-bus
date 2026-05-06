import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] || "serve";
const configPath = optionValue("--config") || path.join(__dirname, "central.config.json");

const state = {
  nodes: new Map(),
  queues: new Map(),
  waiters: new Map(),
  runs: new Map(),
  threads: new Map()
};

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
    const example = path.join(__dirname, "central.config.example.json");
    throw new Error(`Missing config: ${configPath}\nCreate it from ${example}`);
  }
  const config = loadConfig(configPath);
  ensureDataDirs(config);

  if (command === "serve") {
    await serve(config);
    return;
  }
  if (command === "agents") {
    console.log(JSON.stringify(publicAgents(), null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`central-gateway

Usage:
  node central-gateway.mjs serve [--config central.config.json]

HTTP API:
  GET  /health
  GET  /agents
  POST /route              {"message":"...", "mode":"orchestrate"}
  POST /threads            {"message":"...", "agents":["codex-120"], "mode":"orchestrate"}
  GET  /threads/:id
  GET  /runs/:id

Edge API:
  POST /edge/register      {"node_id":"hk", "agents":[...]}
  POST /edge/poll          {"node_id":"hk", "timeout_ms":25000}
  POST /edge/events        {"node_id":"hk", "run_id":"...", "event":{...}}
  POST /edge/complete      {"node_id":"hk", "run_id":"...", "result":{...}}
`);
}

function loadConfig(file) {
  const raw = fs.readFileSync(file, "utf8");
  const config = JSON.parse(raw);
  config.host ||= "127.0.0.1";
  config.port ||= 8788;
  config.host = process.env.AGENT_BUS_HOST || config.host;
  config.port = Number(process.env.AGENT_BUS_PORT || config.port);
  config.token = process.env.AGENT_BUS_TOKEN || config.token;
  config.dataDir = process.env.AGENT_BUS_DATA_DIR || resolvePath(config.dataDir || "./data/central", path.dirname(file));
  config.defaults ||= {};
  config.modelRouter ||= {};
  config.modelRouter.enabled ??= true;
  config.modelRouter.backends ||= [];
  return config;
}

function ensureDataDirs(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "threads"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "runs"), { recursive: true });
}

async function serve(config) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${config.host}:${config.port}`);
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, {
          ok: true,
          nodes: state.nodes.size,
          agents: publicAgents().length,
          queued: [...state.queues.values()].reduce((sum, queue) => sum + queue.length, 0)
        });
      }
      if (req.method === "GET" && url.pathname === "/.well-known/agent-bus.json") {
        return sendJson(res, agentBusWellKnown());
      }
      if (req.method === "GET" && (url.pathname === "/console" || url.pathname.startsWith("/console/"))) {
        return sendConsoleAsset(res, url.pathname);
      }
      requireAuth(req, config);
      if (req.method === "GET" && url.pathname === "/agents") {
        return sendJson(res, publicAgents());
      }
      if (req.method === "GET" && (url.pathname === "/manifest" || url.pathname === "/v1/agent-bus/manifest")) {
        return sendJson(res, agentBusManifest(config));
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, openAiModels(config));
      }
      if (req.method === "POST" && url.pathname === "/route") {
        const body = await readJson(req);
        if (!body.message || typeof body.message !== "string") {
          return sendJson(res, { error: "message is required" }, 400);
        }
        const selection = selectAgentsForMessage(body.message, {
          mode: body.mode || "orchestrate",
          agents: body.agents
        });
        return sendJson(res, publicSelection(selection));
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJson(req);
        return proxyChatCompletions(config, req, res, body);
      }
      if (req.method === "POST" && url.pathname === "/threads") {
        const body = await readJson(req);
        if (!body.message || typeof body.message !== "string") {
          return sendJson(res, { error: "message is required" }, 400);
        }
        const thread = createThread(config, body);
        return sendJson(res, thread, 201);
      }
      if (req.method === "GET" && url.pathname.startsWith("/threads/")) {
        const id = url.pathname.split("/").filter(Boolean)[1];
        const thread = readSnapshot(config, "threads", id);
        if (!thread) return sendJson(res, { error: "not_found" }, 404);
        return sendJson(res, thread);
      }
      if (req.method === "GET" && url.pathname.startsWith("/runs/")) {
        const id = url.pathname.split("/").filter(Boolean)[1];
        const run = readSnapshot(config, "runs", id);
        if (!run) return sendJson(res, { error: "not_found" }, 404);
        return sendJson(res, run);
      }

      if (req.method === "POST" && url.pathname === "/edge/register") {
        const body = await readJson(req);
        const node = registerNode(config, body);
        return sendJson(res, node);
      }
      if (req.method === "POST" && url.pathname === "/edge/poll") {
        const body = await readJson(req);
        const payload = await pollNode(body.node_id, Number(body.timeout_ms || config.defaults.pollTimeoutMs || 25000));
        return sendJson(res, payload);
      }
      if (req.method === "POST" && url.pathname === "/edge/events") {
        const body = await readJson(req);
        recordRunEvent(config, body);
        return sendJson(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/edge/complete") {
        const body = await readJson(req);
        const run = completeRun(config, body);
        return sendJson(res, run);
      }

      return sendJson(res, { error: "not_found" }, 404);
    } catch (err) {
      return sendJson(res, { error: err.message || "internal_error" }, err.statusCode || 500);
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`central-gateway listening on http://${config.host}:${config.port}`);
  });
}

function requireAuth(req, config) {
  if (!config.token) return;
  const auth = req.headers.authorization || "";
  const headerToken = req.headers["x-agent-bus-token"];
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : headerToken;
  if (token !== config.token) {
    const err = new Error("unauthorized");
    err.statusCode = 401;
    throw err;
  }
}

function registerNode(config, body) {
  if (!body.node_id || typeof body.node_id !== "string") {
    const err = new Error("node_id is required");
    err.statusCode = 400;
    throw err;
  }
  const agents = Array.isArray(body.agents) ? body.agents.filter((agent) => agent && agent.id) : [];
  const node = {
    node_id: body.node_id,
    hostname: body.hostname || null,
    version: body.version || null,
    status: "online",
    registered_at: state.nodes.get(body.node_id)?.registered_at || new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    agents: agents.map((agent) => ({
      id: agent.id,
      node_id: body.node_id,
      kind: agent.kind || "agent",
      role: agent.role || "worker",
      enabled: agent.enabled !== false,
      capabilities: agent.capabilities || []
    }))
  };
  state.nodes.set(body.node_id, node);
  state.queues.set(body.node_id, state.queues.get(body.node_id) || []);
  appendJsonl(config, "nodes.jsonl", node);
  return publicNode(node);
}

function publicNode(node) {
  return {
    node_id: node.node_id,
    hostname: node.hostname,
    status: node.status,
    last_seen_at: node.last_seen_at,
    agents: node.agents
  };
}

function publicAgents() {
  return [...state.nodes.values()]
    .flatMap((node) => node.agents.map((agent) => ({
      ...agent,
      node_status: node.status,
      node_last_seen_at: node.last_seen_at
    })))
    .filter((agent) => agent.enabled !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function agentBusManifest(config) {
  return {
    name: "agent-bus",
    protocol: "agent-bus.v1",
    description: "A lightweight AI-to-AI bus for discovering agents, routing tasks, and coordinating shared work.",
    auth: {
      type: "bearer",
      health_public: true
    },
    endpoints: {
      health: "GET /health",
      manifest: "GET /v1/agent-bus/manifest",
      agents: "GET /agents",
      route: "POST /route",
      threads: "POST /threads",
      models: "GET /v1/models",
      chat_completions: "POST /v1/chat/completions"
    },
    agent_contract: {
      identity: ["id", "node_id", "kind", "role"],
      capabilities: "Free-form strings that describe what the agent can do.",
      health: {
        node_status: "Edge process is polling the central gateway.",
        ping_status: "Optional shallow URL reachability check; it does not run model inference.",
        last_run_status: "Most recent real task outcome, when available."
      }
    },
    agents: publicAgents(),
    model_router: {
      enabled: config.modelRouter?.enabled !== false,
      models: openAiModels(config).data.map((item) => item.id)
    }
  };
}

function agentBusWellKnown() {
  return {
    name: "agent-bus",
    protocol: "agent-bus.v1",
    manifest: "/v1/agent-bus/manifest",
    health: "/health",
    auth: {
      type: "bearer",
      manifest_required: true
    }
  };
}

function openAiModels(config) {
  const seen = new Map();
  for (const backend of modelBackends(config)) {
    for (const model of backend.models || []) {
      seen.set(model, {
        id: model,
        object: "model",
        created: 0,
        owned_by: backend.id || "agent-bus"
      });
    }
    for (const alias of Object.keys(backend.modelAliases || {})) {
      seen.set(alias, {
        id: alias,
        object: "model",
        created: 0,
        owned_by: backend.id || "agent-bus"
      });
    }
  }
  return { object: "list", data: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

async function proxyChatCompletions(config, req, res, body) {
  const { backend, routedModel } = selectModelBackend(config, body.model);
  const proxied = { ...body, model: routedModel };
  const headers = {
    "content-type": "application/json",
    "accept": body.stream ? "text/event-stream" : "application/json"
  };
  const apiKey = backendApiKey(backend);
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  } else if (backend.passClientAuthorization && req.headers.authorization) {
    headers.authorization = req.headers.authorization;
  }

  let upstream;
  try {
    upstream = await fetch(joinUrl(backend.baseUrl, "/chat/completions"), {
      method: "POST",
      headers,
      body: JSON.stringify(proxied),
      signal: AbortSignal.timeout(Number(backend.timeoutSeconds || 600) * 1000)
    });
  } catch (err) {
    return sendJson(res, {
      error: {
        message: err.message || String(err),
        type: "agent_bus_upstream_error",
        backend: backend.id || "backend"
      }
    }, 502);
  }

  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
    "x-agent-bus-backend": backend.id || "backend"
  });
  if (!upstream.body) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
  }
  res.end();
}

function selectModelBackend(config, requestedModel) {
  const backends = modelBackends(config);
  if (!backends.length) {
    const err = new Error("no model backends configured");
    err.statusCode = 503;
    throw err;
  }
  const requested = requestedModel || config.modelRouter.defaultModel;
  for (const backend of backends) {
    if (backend.modelAliases && requested in backend.modelAliases) {
      return { backend, routedModel: backend.modelAliases[requested] };
    }
    if ((backend.models || []).includes(requested)) {
      return { backend, routedModel: requested };
    }
  }
  const fallback = backends.find((backend) => backend.id === config.modelRouter.defaultBackend) || backends[0];
  return {
    backend: fallback,
    routedModel: fallback.modelAliases?.[requested] || requested || fallback.defaultModel || fallback.models?.[0] || ""
  };
}

function modelBackends(config) {
  if (config.modelRouter?.enabled === false) return [];
  return (config.modelRouter?.backends || [])
    .filter((backend) => backend.enabled !== false && backend.baseUrl)
    .map((backend) => ({ ...backend, baseUrl: String(backend.baseUrl).replace(/\/$/, "") }));
}

function backendApiKey(backend) {
  if (backend.apiKeyEnv && process.env[backend.apiKeyEnv]) return process.env[backend.apiKeyEnv];
  return backend.apiKey;
}

function joinUrl(baseUrl, suffix) {
  return `${String(baseUrl).replace(/\/$/, "")}/${String(suffix).replace(/^\//, "")}`;
}

function selectAgentsForMessage(message, input = {}) {
  const all = publicAgents();
  if (!all.length) {
    const err = new Error("no registered edge agents");
    err.statusCode = 409;
    throw err;
  }

  if (Array.isArray(input.agents) && input.agents.length) {
    const wanted = new Set(input.agents);
    const agents = all.filter((agent) => wanted.has(agent.id));
    const missing = [...wanted].filter((id) => !agents.some((agent) => agent.id === id));
    if (missing.length) {
      const err = new Error(`unknown registered agents: ${missing.join(", ")}`);
      err.statusCode = 400;
      throw err;
    }
    return { mode: "explicit", reason: "Explicit agent selector was provided.", matched: ["agents"], agents };
  }

  if (input.mode !== "orchestrate") {
    return { mode: "broadcast", reason: "Broadcast selected all registered agents.", matched: ["all"], agents: all };
  }

  const text = String(message || "").toLowerCase();
  const rules = [
    {
      token: "code",
      pattern: /(code|repo|bug|test|patch|commit|review|typescript|javascript|node|python|实现|代码|修复|测试|仓库|重构)/i,
      predicate: (agent) => agent.kind === "codex" || agent.role === "coder" || hasAny(agent, ["code", "review"])
    },
    {
      token: "ops",
      pattern: /(shell|terminal|file|deploy|browser|cron|ssh|server|机器|服务器|终端|命令|文件|部署|浏览器|定时)/i,
      predicate: (agent) => agent.kind === "openclaw" || agent.role === "executor"
    },
    {
      token: "research",
      pattern: /(research|plan|design|compare|investigate|web|browser|调研|研究|设计|方案|浏览器|搜索|资料)/i,
      predicate: (agent) => agent.kind === "hermes" || agent.role === "researcher" || (/web|browser|浏览器|搜索/i.test(text) && hasAny(agent, ["browser"]))
    },
    {
      token: "gateway",
      pattern: /(model|api|gateway|proxy|sub2api|cliproxyapi|token|key|openai|模型|网关|代理|接口|密钥)/i,
      predicate: (agent) => agent.kind === "gateway" || agent.role === "model-gateway" || hasAny(agent, ["models", "sub2api", "cliproxyapi"])
    }
  ];
  const matchedRules = rules.filter((rule) => rule.pattern.test(text));
  const selected = new Map();
  for (const rule of matchedRules) {
    for (const agent of all.filter(rule.predicate)) selected.set(agent.id, agent);
  }
  if (!selected.size) {
    for (const agent of all.filter((agent) => ["coder", "executor"].includes(agent.role))) selected.set(agent.id, agent);
  }
  return {
    mode: "orchestrate",
    reason: matchedRules.length
      ? `Selected agents by message intent: ${matchedRules.map((rule) => rule.token).join(", ")}.`
      : "No strong intent matched, so executor/coder agents were selected.",
    matched: matchedRules.length ? matchedRules.map((rule) => rule.token) : ["default-executor-coder"],
    agents: selected.size ? [...selected.values()] : all
  };
}

function publicSelection(selection) {
  return {
    mode: selection.mode,
    reason: selection.reason,
    matched: selection.matched,
    agents: selection.agents.map((agent) => ({
      id: agent.id,
      node_id: agent.node_id,
      kind: agent.kind,
      role: agent.role,
      capabilities: agent.capabilities || []
    }))
  };
}

function createThread(config, body) {
  const selection = selectAgentsForMessage(body.message, {
    mode: body.mode || config.defaults.mode || "broadcast",
    agents: body.agents
  });
  const thread = {
    id: `thread_${crypto.randomUUID()}`,
    created_at: new Date().toISOString(),
    source: body.source || "http",
    mode: selection.mode,
    message: body.message,
    selection: {
      reason: selection.reason,
      matched: selection.matched,
      agents: selection.agents.map((agent) => agent.id)
    },
    runs: []
  };

  for (const agent of selection.agents) {
    const run = {
      id: `run_${crypto.randomUUID()}`,
      thread_id: thread.id,
      agent_id: agent.id,
      node_id: agent.node_id,
      kind: agent.kind,
      role: agent.role,
      status: "queued",
      created_at: new Date().toISOString(),
      started_at: null,
      completed_at: null,
      message: body.message,
      stdout: "",
      stderr: "",
      events: []
    };
    thread.runs.push(run);
    state.runs.set(run.id, run);
    writeSnapshot(config, "runs", run.id, run);
    appendJsonl(config, "runs.jsonl", run);
    enqueueTask(agent.node_id, {
      type: "task.run",
      run_id: run.id,
      thread_id: thread.id,
      agent_id: agent.id,
      message: body.message,
      created_at: run.created_at
    });
  }

  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
  appendJsonl(config, "threads.jsonl", thread);
  return thread;
}

function enqueueTask(nodeId, task) {
  const waiterQueue = state.waiters.get(nodeId) || [];
  const waiter = waiterQueue.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve({ type: "task", task });
    return;
  }
  const queue = state.queues.get(nodeId) || [];
  queue.push(task);
  state.queues.set(nodeId, queue);
}

function pollNode(nodeId, timeoutMs) {
  if (!nodeId || !state.nodes.has(nodeId)) {
    const err = new Error("unknown node_id");
    err.statusCode = 404;
    throw err;
  }
  const node = state.nodes.get(nodeId);
  node.last_seen_at = new Date().toISOString();
  node.status = "online";

  const queue = state.queues.get(nodeId) || [];
  const task = queue.shift();
  if (task) return Promise.resolve({ type: "task", task });

  return new Promise((resolve) => {
    const waiter = {
      resolve,
      timer: setTimeout(() => {
        const waiters = state.waiters.get(nodeId) || [];
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        resolve({ type: "idle" });
      }, Math.min(Math.max(timeoutMs || 25000, 1000), 60000))
    };
    const waiters = state.waiters.get(nodeId) || [];
    waiters.push(waiter);
    state.waiters.set(nodeId, waiters);
  });
}

function recordRunEvent(config, body) {
  const run = state.runs.get(body.run_id) || readSnapshot(config, "runs", body.run_id);
  if (!run) return;
  const event = {
    at: new Date().toISOString(),
    node_id: body.node_id || run.node_id,
    ...(body.event || {})
  };
  if (event.type === "run.started") {
    run.status = "running";
    run.started_at ||= event.at;
  }
  if (event.stream === "stdout" && event.text) run.stdout += event.text;
  if (event.stream === "stderr" && event.text) run.stderr += event.text;
  run.events ||= [];
  run.events.push(event);
  state.runs.set(run.id, run);
  writeSnapshot(config, "runs", run.id, run);
  updateThreadRun(config, run);
  appendJsonl(config, "events.jsonl", { run_id: run.id, ...event });
}

function completeRun(config, body) {
  const run = state.runs.get(body.run_id) || readSnapshot(config, "runs", body.run_id);
  if (!run) {
    const err = new Error("unknown run_id");
    err.statusCode = 404;
    throw err;
  }
  const result = body.result || {};
  run.status = result.status || (Number(result.exit_code || 0) === 0 ? "completed" : "failed");
  run.completed_at = new Date().toISOString();
  run.exit_code = result.exit_code ?? null;
  run.stdout = trimOutput(redactSensitive(result.stdout ?? run.stdout ?? ""));
  run.stderr = trimOutput(redactSensitive(result.stderr ?? run.stderr ?? ""));
  run.summary = trimOutput(redactSensitive(result.summary || ""));
  state.runs.set(run.id, run);
  writeSnapshot(config, "runs", run.id, run);
  updateThreadRun(config, run);
  appendJsonl(config, "runs.jsonl", run);
  return run;
}

function updateThreadRun(config, run) {
  const thread = state.threads.get(run.thread_id) || readSnapshot(config, "threads", run.thread_id);
  if (!thread) return;
  thread.runs = (thread.runs || []).map((item) => (item.id === run.id ? run : item));
  thread.updated_at = new Date().toISOString();
  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
}

function hasAny(agent, capabilities) {
  const values = new Set(agent.capabilities || []);
  return capabilities.some((capability) => values.has(capability));
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
  const body = `${JSON.stringify(redactObject(value), null, 2)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function sendConsoleAsset(res, pathname) {
  const consoleDir = path.join(__dirname, "console");
  const relative = pathname === "/console" || pathname === "/console/" ? "index.html" : pathname.replace(/^\/console\//, "");
  const file = path.resolve(consoleDir, relative);
  if (!file.startsWith(path.resolve(consoleDir))) {
    return sendJson(res, { error: "not_found" }, 404);
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return sendJson(res, { error: "not_found" }, 404);
  }
  const ext = path.extname(file).toLowerCase();
  const contentType = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": ext === ".html" ? "no-store" : "public, max-age=60"
  });
  fs.createReadStream(file).pipe(res);
}

function appendJsonl(config, fileName, value) {
  fs.appendFileSync(path.join(config.dataDir, fileName), `${JSON.stringify(redactObject(value))}\n`);
}

function writeSnapshot(config, folder, id, value) {
  fs.writeFileSync(path.join(config.dataDir, folder, `${id}.json`), `${JSON.stringify(redactObject(value), null, 2)}\n`);
}

function readSnapshot(config, folder, id) {
  if (!id) return null;
  const file = path.join(config.dataDir, folder, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function trimOutput(value) {
  const text = String(value || "");
  const limit = 120000;
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]` : text;
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
