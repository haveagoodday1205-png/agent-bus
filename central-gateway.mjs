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
const NODE_STALE_SECONDS = intEnv("AGENT_BUS_NODE_STALE_SECONDS", 180);
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "error", "cancelled", "canceled", "skipped"]);

const state = {
  nodes: new Map(),
  queues: new Map(),
  waiters: new Map(),
  runs: new Map(),
  threads: new Map(),
  pairCodes: new Map(),
  edgeTokens: new Map()
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
  loadEdgeTokens(config);

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
  config.modelRouter.agentModels ??= true;
  config.modelRouter.allowEdgeAgentModels ??= false;
  config.modelRouter.agentModelTimeoutSeconds ??= 600;
  config.modelRouter.backends ||= [];
  config.edgeTokens ||= [];
  return config;
}

function ensureDataDirs(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "threads"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "runs"), { recursive: true });
}

function loadEdgeTokens(config) {
  state.edgeTokens.clear();
  for (const item of config.edgeTokens || []) {
    const record = edgeTokenRecordFromConfig(item);
    if (record) state.edgeTokens.set(record.token_hash, record);
  }
  const file = edgeTokensFile(config);
  if (!fs.existsSync(file)) return;
  let data = [];
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = [];
  }
  for (const item of Array.isArray(data) ? data : []) {
    if (item.token_hash) state.edgeTokens.set(item.token_hash, item);
  }
}

function edgeTokenRecordFromConfig(item) {
  if (typeof item === "string") {
    const token = item.trim();
    if (!token) return null;
    return {
      id: `edge_config_${tokenHash(token).slice(0, 12)}`,
      token_hash: tokenHash(token),
      scope: "edge",
      source: "config",
      status: "active",
      created_at: new Date().toISOString()
    };
  }
  if (!item || typeof item !== "object") return null;
  const token = String(item.token || "").trim();
  const hash = String(item.tokenHash || item.token_hash || (token ? tokenHash(token) : "")).trim();
  if (!hash) return null;
  return {
    id: item.id || `edge_config_${hash.slice(0, 12)}`,
    token_hash: hash,
    scope: "edge",
    source: "config",
    status: item.status || "active",
    created_at: item.created_at || item.createdAt || new Date().toISOString(),
    node_id: item.node_id || item.nodeId || "",
    label: item.label || ""
  };
}

function edgeTokensFile(config) {
  return path.join(config.dataDir, "edge_tokens.json");
}

function persistEdgeTokens(config) {
  const records = [...state.edgeTokens.values()].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  fs.writeFileSync(edgeTokensFile(config), `${JSON.stringify(records, null, 2)}\n`);
}

function createEdgeToken(config, { nodeId = "", label = "", source = "pairing" } = {}) {
  const token = `abt_edge_${crypto.randomBytes(32).toString("base64url")}`;
  const record = {
    id: `edge_${crypto.randomUUID().replace(/-/g, "")}`,
    token_hash: tokenHash(token),
    scope: "edge",
    source: cleanPairValue(source) || "pairing",
    status: "active",
    created_at: new Date().toISOString(),
    node_id: cleanPairValue(nodeId),
    label: cleanPairValue(label)
  };
  state.edgeTokens.set(record.token_hash, record);
  persistEdgeTokens(config);
  appendJsonl(config, "edge_tokens.jsonl", {
    event: "created",
    id: record.id,
    scope: "edge",
    source: record.source,
    node_id: record.node_id,
    label: record.label,
    created_at: record.created_at
  });
  return { token, record };
}

function publicEdgeToken(record) {
  return {
    id: record.id,
    scope: record.scope || "edge",
    source: record.source || "",
    status: record.status || "active",
    created_at: record.created_at,
    revoked_at: record.revoked_at,
    node_id: record.node_id || "",
    label: record.label || ""
  };
}

function listEdgeTokens() {
  return [...state.edgeTokens.values()]
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")))
    .map((record) => publicEdgeToken(record));
}

function createManualEdgeToken(config, body) {
  const edge = createEdgeToken(config, {
    nodeId: body.nodeId || body.node_id,
    label: body.label || "manual",
    source: "admin"
  });
  return {
    ok: true,
    token: edge.token,
    tokenScope: "edge",
    edgeToken: publicEdgeToken(edge.record)
  };
}

function revokeEdgeToken(config, body) {
  const tokenId = cleanPairValue(body.id || body.tokenId || body.token_id);
  if (!tokenId) {
    const err = new Error("edge token id is required");
    err.statusCode = 400;
    throw err;
  }
  for (const record of state.edgeTokens.values()) {
    if (record.id === tokenId) {
      record.status = "revoked";
      record.revoked_at = new Date().toISOString();
      persistEdgeTokens(config);
      appendJsonl(config, "edge_tokens.jsonl", {
        event: "revoked",
        id: tokenId,
        revoked_at: record.revoked_at
      });
      return { ok: true, edgeToken: publicEdgeToken(record) };
    }
  }
  const err = new Error("edge token not found");
  err.statusCode = 404;
  throw err;
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
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
      if (req.method === "POST" && url.pathname === "/edge/pair") {
        const body = await readJson(req);
        return sendJson(res, redeemPairCode(config, body), 200, { redact: false });
      }
      if (req.method === "POST" && (url.pathname === "/pair-codes" || url.pathname === "/v1/agent-bus/pair-codes")) {
        requireAuth(req, config, ["admin"]);
        const body = await readJson(req);
        return sendJson(res, createPairCode(config, body, req), 201);
      }
      if (req.method === "GET" && url.pathname === "/agents") {
        requireAuth(req, config, ["admin", "edge"]);
        return sendJson(res, publicAgents());
      }
      if (req.method === "GET" && url.pathname === "/nodes") {
        requireAuth(req, config, ["admin", "edge"]);
        return sendJson(res, publicNodes());
      }
      if (req.method === "GET" && (url.pathname === "/manifest" || url.pathname === "/v1/agent-bus/manifest")) {
        requireAuth(req, config, ["admin", "edge"]);
        return sendJson(res, agentBusManifest(config));
      }
      if (req.method === "GET" && (url.pathname === "/edge/tokens" || url.pathname === "/v1/agent-bus/edge-tokens")) {
        requireAuth(req, config, ["admin"]);
        return sendJson(res, listEdgeTokens());
      }
      if (req.method === "POST" && (url.pathname === "/edge/tokens" || url.pathname === "/v1/agent-bus/edge-tokens")) {
        requireAuth(req, config, ["admin"]);
        const body = await readJson(req);
        return sendJson(res, createManualEdgeToken(config, body), 201, { redact: false });
      }
      if (req.method === "POST" && (url.pathname === "/edge/tokens/revoke" || url.pathname === "/v1/agent-bus/edge-tokens/revoke")) {
        requireAuth(req, config, ["admin"]);
        const body = await readJson(req);
        return sendJson(res, revokeEdgeToken(config, body));
      }
      if (req.method === "POST" && url.pathname === "/edge/register") {
        requireAuth(req, config, ["admin", "edge"]);
        const body = await readJson(req);
        const node = registerNode(config, body);
        return sendJson(res, node);
      }
      if (req.method === "POST" && url.pathname === "/edge/poll") {
        requireAuth(req, config, ["admin", "edge"]);
        const body = await readJson(req);
        const payload = await pollNode(body, Number(body.timeout_ms || config.defaults.pollTimeoutMs || 25000));
        return sendJson(res, payload);
      }
      if (req.method === "POST" && url.pathname === "/edge/events") {
        requireAuth(req, config, ["admin", "edge"]);
        const body = await readJson(req);
        recordRunEvent(config, body);
        return sendJson(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/edge/complete") {
        requireAuth(req, config, ["admin", "edge"]);
        const body = await readJson(req);
        const run = completeRun(config, body);
        return sendJson(res, run);
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const scope = requireAuth(req, config, allowEdgeAgentModels(config) ? ["admin", "edge"] : ["admin"]);
        return sendJson(res, openAiModels(config, { agentOnly: scope === "edge" }));
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readJson(req);
        requireAuth(req, config, chatCompletionScopes(config, body));
        return proxyChatCompletions(config, req, res, body);
      }
      if (req.method === "POST" && url.pathname === "/v1/responses") {
        const body = await readJson(req);
        requireAuth(req, config, responsesScopes(config, body));
        return proxyResponses(config, req, res, body);
      }
      requireAuth(req, config, ["admin"]);
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

      return sendJson(res, { error: "not_found" }, 404);
    } catch (err) {
      return sendJson(res, { error: err.message || "internal_error" }, err.statusCode || 500);
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`central-gateway listening on http://${config.host}:${config.port}`);
  });
}

function requireAuth(req, config, allowedScopes = ["admin"]) {
  if (!config.token && state.edgeTokens.size === 0) return "admin";
  const auth = req.headers.authorization || "";
  const headerToken = req.headers["x-agent-bus-token"];
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : headerToken;
  const scope = tokenScope(config, token);
  if (!allowedScopes.includes(scope)) {
    const err = new Error("unauthorized");
    err.statusCode = 401;
    throw err;
  }
  return scope;
}

function tokenScope(config, token) {
  if (config.token && token === config.token) return "admin";
  const record = state.edgeTokens.get(tokenHash(token));
  if (record && record.status !== "revoked") return "edge";
  return "";
}

const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function createPairCode(config, body, req) {
  purgeExpiredPairCodes();
  const ttlSeconds = parsePairTtl(body.ttlSeconds || body.ttl_seconds || body.ttl || 600);
  let displayCode = "";
  let normalizedCode = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const raw = Array.from({ length: 8 }, () => PAIR_CODE_ALPHABET[crypto.randomInt(PAIR_CODE_ALPHABET.length)]).join("");
    displayCode = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    normalizedCode = normalizePairCode(displayCode);
    if (!state.pairCodes.has(normalizedCode)) break;
  }
  if (!normalizedCode || state.pairCodes.has(normalizedCode)) {
    const err = new Error("could not allocate pair code");
    err.statusCode = 503;
    throw err;
  }
  const gatewayUrl = String(body.gatewayUrl || body.gateway_url || config.publicUrl || inferPublicGateway(req, config)).replace(/\/$/, "");
  const expiresAtMs = Date.now() + ttlSeconds * 1000;
  const record = {
    code: normalizedCode,
    display_code: displayCode,
    gateway_url: gatewayUrl,
    node_id: cleanPairValue(body.nodeId || body.node_id),
    agent_preset: cleanPairValue(body.agentPreset || body.agent_preset || body.preset),
    label: cleanPairValue(body.label),
    created_at: new Date().toISOString(),
    expires_at_ms: expiresAtMs,
    expires_at: new Date(expiresAtMs).toISOString()
  };
  state.pairCodes.set(normalizedCode, record);
  appendJsonl(config, "pair_codes.jsonl", {
    event: "created",
    label: record.label,
    agent_preset: record.agent_preset,
    created_at: record.created_at,
    expires_at: record.expires_at
  });
  let joinHint = `agent-bus pair join --gateway ${gatewayUrl} --code ${displayCode} --out edge.config.json`;
  if (record.agent_preset) joinHint += ` --preset ${record.agent_preset}`;
  return {
    ok: true,
    code: displayCode,
    ttl_seconds: ttlSeconds,
    expires_at: record.expires_at,
    gatewayUrl,
    agentPreset: record.agent_preset || null,
    join_hint: joinHint
  };
}

function redeemPairCode(config, body) {
  purgeExpiredPairCodes();
  const code = normalizePairCode(body.code);
  if (!code) {
    const err = new Error("code is required");
    err.statusCode = 400;
    throw err;
  }
  const record = state.pairCodes.get(code);
  state.pairCodes.delete(code);
  if (!record) {
    const err = new Error("pair code not found or already used");
    err.statusCode = 404;
    throw err;
  }
  if (Number(record.expires_at_ms || 0) < Date.now()) {
    const err = new Error("pair code expired");
    err.statusCode = 410;
    throw err;
  }
  const nodeId = cleanPairValue(body.nodeId || body.node_id || record.node_id);
  const edge = createEdgeToken(config, { nodeId, label: record.label || "pair-code" });
  appendJsonl(config, "pair_codes.jsonl", {
    event: "redeemed",
    label: record.label,
    agent_preset: record.agent_preset,
    edge_token_id: edge.record.id,
    redeemed_at: new Date().toISOString()
  });
  return {
    ok: true,
    gatewayUrl: record.gateway_url,
    token: edge.token,
    tokenScope: "edge",
    nodeId,
    agentPreset: cleanPairValue(body.preset || body.agentPreset || record.agent_preset)
  };
}

function purgeExpiredPairCodes() {
  for (const [code, record] of state.pairCodes.entries()) {
    if (Number(record.expires_at_ms || 0) < Date.now()) {
      state.pairCodes.delete(code);
    }
  }
}

function parsePairTtl(value) {
  const ttl = Number.parseInt(value, 10);
  if (!Number.isFinite(ttl)) return 600;
  return Math.max(30, Math.min(ttl, 86400));
}

function normalizePairCode(value) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function cleanPairValue(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/[^A-Za-z0-9._:@/-]/g, "-").slice(0, 120);
}

function inferPublicGateway(req, config) {
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${config.port || 8788}`;
  const proto = req.headers["x-forwarded-proto"] || (req.headers["x-forwarded-ssl"] === "on" ? "https" : "http");
  const prefix = String(req.headers["x-forwarded-prefix"] || "").replace(/\/$/, "");
  return `${proto}://${host}${prefix}`.replace(/\/$/, "");
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
    agents: agents.map((agent) => normalizeAgent(body.node_id, agent))
  };
  state.nodes.set(body.node_id, node);
  state.queues.set(body.node_id, state.queues.get(body.node_id) || []);
  appendJsonl(config, "nodes.jsonl", node);
  return publicNode(node);
}

function normalizeAgent(nodeId, agent) {
  const item = {
    id: agent.id,
    node_id: nodeId,
    kind: agent.kind || "agent",
    role: agent.role || "worker",
    enabled: agent.enabled !== false,
    capabilities: agent.capabilities || []
  };
  if (agent.adapter) item.adapter = agent.adapter;
  if (agent.health && typeof agent.health === "object" && !Array.isArray(agent.health)) item.health = agent.health;
  return item;
}

function publicNode(node) {
  return {
    node_id: node.node_id,
    hostname: node.hostname,
    status: node.status,
    last_seen_at: node.last_seen_at,
    agents: (node.agents || []).map((agent) => ({
      id: agent.id,
      kind: agent.kind,
      role: agent.role,
      enabled: agent.enabled !== false,
      capabilities: agent.capabilities || []
    }))
  };
}

function publicNodes() {
  return [...state.nodes.values()]
    .map((node) => publicNode(node))
    .sort((a, b) => String(a.node_id || "").localeCompare(String(b.node_id || "")));
}

function publicAgents() {
  return [...state.nodes.values()]
    .filter(nodeIsOnline)
    .flatMap((node) => node.agents.map((agent) => publicAgent(node, agent)))
    .filter((agent) => agent.enabled !== false)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function nodeIsOnline(node) {
  if (node.status !== "online") return false;
  if (!node.last_seen_at) return false;
  const parsed = Date.parse(node.last_seen_at);
  return Number.isFinite(parsed) && Date.now() - parsed <= NODE_STALE_SECONDS * 1000;
}

function publicAgent(node, agent) {
  const health = agent.health && typeof agent.health === "object" && !Array.isArray(agent.health) ? agent.health : {};
  return {
    ...agent,
    status: "online",
    last_seen_at: node.last_seen_at,
    node_status: node.status,
    node_last_seen_at: node.last_seen_at,
    node_online: true,
    ...(health.ping_status ? { ping_status: health.ping_status } : {}),
    ...(health.ping_target ? { ping_target: health.ping_target } : {}),
    ...(health.checked_at ? { ping_checked_at: health.checked_at } : {}),
    ...(health.latency_ms != null ? { ping_latency_ms: health.latency_ms } : {}),
    ...(health.last_run_status ? { last_run_status: health.last_run_status } : {}),
    ...(health.last_run_at ? { last_run_at: health.last_run_at } : {})
  };
}

function agentBusManifest(config) {
  return {
    name: "agent-bus",
    protocol: "agent-bus.v1",
    description: "A lightweight AI-to-AI bus for discovering agents, routing tasks, and coordinating shared work.",
    auth: {
      type: "bearer",
      health_public: true,
      scopes: {
        admin: "Full gateway, model router, room, thread, and pairing access.",
        edge: "Edge registration, polling, run reporting, and read-only discovery."
      }
    },
    endpoints: {
      health: "GET /health",
      manifest: "GET /v1/agent-bus/manifest",
      nodes: "GET /nodes",
      agents: "GET /agents",
      route: "POST /route",
      threads: "POST /threads",
      models: "GET /v1/models",
      chat_completions: "POST /v1/chat/completions",
      responses: "POST /v1/responses",
      pair_create: "POST /pair-codes",
      pair_join: "POST /edge/pair",
      edge_tokens: "GET /edge/tokens, POST /edge/tokens, POST /edge/tokens/revoke"
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
    pair: "/edge/pair",
    auth: {
      type: "bearer",
      manifest_required: true
    }
  };
}

function openAiModels(config, options = {}) {
  const seen = new Map();
  if (!options.agentOnly) {
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
  }
  if (agentModelsEnabled(config)) {
    for (const agent of publicAgents()) {
      seen.set(`agent:${agent.id}`, {
        id: `agent:${agent.id}`,
        object: "model",
        created: 0,
        owned_by: "agent-bus-edge"
      });
    }
  }
  return { object: "list", data: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

async function proxyChatCompletions(config, req, res, body) {
  const agentId = agentModelId(body.model);
  if (agentId) {
    const { payload, status } = await createAgentChatCompletion(config, body, agentId);
    return sendJson(res, payload, status);
  }
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

async function proxyResponses(config, req, res, body) {
  const agentId = agentModelId(body.model);
  if (agentId) {
    const { payload, status } = await createAgentResponse(config, body, agentId);
    return sendJson(res, payload, status);
  }
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
    upstream = await fetch(joinUrl(backend.baseUrl, "/responses"), {
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

function chatCompletionScopes(config, body) {
  return agentModelId(body.model) && allowEdgeAgentModels(config) ? ["admin", "edge"] : ["admin"];
}

function responsesScopes(config, body) {
  return agentModelId(body.model) && allowEdgeAgentModels(config) ? ["admin", "edge"] : ["admin"];
}

function agentModelsEnabled(config) {
  return config.modelRouter?.enabled !== false && config.modelRouter?.agentModels !== false;
}

function allowEdgeAgentModels(config) {
  return agentModelsEnabled(config) && config.modelRouter?.allowEdgeAgentModels === true;
}

function agentModelId(model) {
  const text = String(model || "").trim();
  if (text.startsWith("agent:")) return text.slice(6).trim();
  if (text.startsWith("agent/")) return text.slice(6).trim();
  return "";
}

async function createAgentChatCompletion(config, body, agentId) {
  if (!agentModelsEnabled(config)) {
    return { payload: openAiError("agent-backed models are disabled", "agent_bus_agent_models_disabled", "model"), status: 503 };
  }
  if (body.stream) {
    return { payload: openAiError("agent-backed models do not support stream=true yet", "unsupported_feature", "stream"), status: 400 };
  }
  const agent = publicAgents().find((item) => item.id === agentId);
  if (!agent) {
    return { payload: openAiError(`agent model is not online: agent:${agentId}`, "agent_bus_agent_not_online", "model"), status: 404 };
  }
  if (!chatMessagesHaveContent(body.messages)) {
    return { payload: openAiError("messages are required for agent-backed chat completions", "invalid_request_error", "messages"), status: 400 };
  }
  const prompt = chatMessagesToAgentPrompt(body.messages);
  const cacheScope = agentModelCacheScope(body);

  const thread = {
    id: `thread_${crypto.randomUUID()}`,
    created_at: new Date().toISOString(),
    source: "chat.completions.agent",
    mode: "agent-model",
    message: prompt,
    model: `agent:${agentId}`,
    selection: {
      reason: "OpenAI-compatible chat completion routed to an Agent Bus edge agent.",
      matched: ["agent-model"],
      agents: [agent.id]
    },
    runs: []
  };
  if (cacheScope) thread.cache_scope = cacheScope;
  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
  const run = createAgentRun(config, thread, agent, prompt);
  writeSnapshot(config, "threads", thread.id, thread);
  appendJsonl(config, "threads.jsonl", thread);

  const finalRun = await waitForRunTerminal(config, run.id, agentModelTimeoutSeconds(config, body));
  if (String(finalRun.status || "").toLowerCase() !== "completed") {
    const message = finalRun.stderr || finalRun.summary || finalRun.stdout || "agent model run did not complete";
    const status = TERMINAL_RUN_STATUSES.has(String(finalRun.status || "").toLowerCase()) ? 502 : 504;
    const payload = openAiError(trimOutput(message), "agent_bus_agent_run_failed", "model");
    Object.assign(payload.error, {
      run_id: run.id,
      thread_id: thread.id,
      agent_id: agentId,
      status: finalRun.status || "timeout"
    });
    return { payload, status };
  }

  const content = String(finalRun.stdout || finalRun.summary || "").trim();
  return {
    status: 200,
    payload: {
      id: `chatcmpl-agentbus-${run.id.replace(/^run_/, "")}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: `agent:${agentId}`,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0
      },
      agent_bus: {
        thread_id: thread.id,
        run_id: run.id,
        agent_id: agentId,
        node_id: agent.node_id
      }
    }
  };
}

async function createAgentResponse(config, body, agentId) {
  if (!agentModelsEnabled(config)) {
    return { payload: openAiError("agent-backed models are disabled", "agent_bus_agent_models_disabled", "model"), status: 503 };
  }
  if (body.stream) {
    return { payload: openAiError("agent-backed responses do not support stream=true yet", "unsupported_feature", "stream"), status: 400 };
  }
  const agent = publicAgents().find((item) => item.id === agentId);
  if (!agent) {
    return { payload: openAiError(`agent model is not online: agent:${agentId}`, "agent_bus_agent_not_online", "model"), status: 404 };
  }
  if (!responseInputHasContent(body.input)) {
    return { payload: openAiError("input is required for agent-backed responses", "invalid_request_error", "input"), status: 400 };
  }

  const prompt = responseInputToAgentPrompt(body.input, body.instructions);
  const cacheScope = agentModelCacheScope(body);
  const thread = {
    id: `thread_${crypto.randomUUID()}`,
    created_at: new Date().toISOString(),
    source: "responses.agent",
    mode: "agent-model",
    message: prompt,
    model: `agent:${agentId}`,
    selection: {
      reason: "OpenAI-compatible Responses request routed to an Agent Bus edge agent.",
      matched: ["agent-model", "responses"],
      agents: [agent.id]
    },
    runs: []
  };
  if (cacheScope) thread.cache_scope = cacheScope;
  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
  const run = createAgentRun(config, thread, agent, prompt);
  writeSnapshot(config, "threads", thread.id, thread);
  appendJsonl(config, "threads.jsonl", thread);

  const finalRun = await waitForRunTerminal(config, run.id, agentModelTimeoutSeconds(config, body));
  if (String(finalRun.status || "").toLowerCase() !== "completed") {
    const message = finalRun.stderr || finalRun.summary || finalRun.stdout || "agent response run did not complete";
    const status = TERMINAL_RUN_STATUSES.has(String(finalRun.status || "").toLowerCase()) ? 502 : 504;
    const payload = openAiError(trimOutput(message), "agent_bus_agent_run_failed", "model");
    Object.assign(payload.error, {
      run_id: run.id,
      thread_id: thread.id,
      agent_id: agentId,
      status: finalRun.status || "timeout"
    });
    return { payload, status };
  }

  const content = String(finalRun.stdout || finalRun.summary || "").trim();
  return {
    status: 200,
    payload: agentResponsePayload(agentId, agent, thread, run, content, body)
  };
}

function agentResponsePayload(agentId, agent, thread, run, content, body) {
  const suffix = run.id.replace(/^run_/, "");
  return {
    id: `resp_agentbus_${suffix}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: `agent:${agentId}`,
    output: [{
      id: `msg_agentbus_${suffix}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        text: content,
        annotations: []
      }]
    }],
    output_text: content,
    metadata: body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata) ? body.metadata : {},
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    },
    agent_bus: {
      thread_id: thread.id,
      run_id: run.id,
      agent_id: agentId,
      node_id: agent.node_id
    }
  };
}

function agentModelCacheScope(body = {}) {
  const value = explicitCacheScopeValue(body);
  if (!value) return "";
  return `request-cache-${crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16)}`;
}

function explicitCacheScopeValue(body = {}) {
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    const value = String(body.metadata.agent_bus_cache_scope || body.metadata.cache_scope || "").trim();
    if (value) return value;
  }
  if (body.agent_bus && typeof body.agent_bus === "object" && !Array.isArray(body.agent_bus)) {
    const value = String(body.agent_bus.cache_scope || "").trim();
    if (value) return value;
  }
  return String(body.prompt_cache_key || "").trim();
}

function chatMessagesToAgentPrompt(messages) {
  const lines = [
    "You are being invoked through Agent Bus as an OpenAI-compatible chat completion model.",
    "Return the assistant response for the latest user request. Be direct and useful.",
    "",
    "Conversation:"
  ];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user");
    const name = String(message.name || "").trim();
    const label = `${role}${name ? ` (${name})` : ""}`;
    const content = chatMessageContentToText(message.content);
    if (!content) continue;
    lines.push(`[${label}]`, content, "");
  }
  lines.push("Assistant:");
  return lines.join("\n").trim();
}

function chatMessagesHaveContent(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some((message) => message && typeof message === "object" && chatMessageContentToText(message.content).trim());
}

function chatMessageContentToText(content) {
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part && typeof part === "object") {
        const type = String(part.type || "");
        if (["text", "input_text", "output_text"].includes(type)) return String(part.text || "");
        if ("text" in part) return String(part.text || "");
        return type ? `[${type} omitted]` : "";
      }
      return part == null ? "" : String(part);
    }).filter(Boolean).join("\n");
  }
  return String(content || "");
}

function responseInputHasContent(input) {
  return Boolean(responseInputToText(input).trim());
}

function responseInputToAgentPrompt(input, instructions = "") {
  const lines = [
    "You are being invoked through Agent Bus as an OpenAI-compatible Responses API model.",
    "Return the assistant response for the user input. Be direct and useful."
  ];
  if (instructions) lines.push("", "Instructions:", String(instructions).trim());
  lines.push("", "Input:", responseInputToText(input), "", "Assistant:");
  return lines.join("\n").trim();
}

function responseInputToText(input) {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (item && typeof item === "object") {
        const type = String(item.type || "");
        const role = String(item.role || "").trim();
        const content = Object.hasOwn(item, "content") ? item.content : [item];
        const text = chatMessageContentToText(content);
        return text ? `${role || type ? `[${role || type}]\n` : ""}${text}` : "";
      }
      return item == null ? "" : String(item);
    }).filter(Boolean).join("\n\n");
  }
  if (input && typeof input === "object") return responseInputToText([input]);
  return String(input || "");
}

function agentModelTimeoutSeconds(config, body) {
  const raw = body.timeout_seconds ?? body.timeoutSeconds ?? config.modelRouter?.agentModelTimeoutSeconds ?? 600;
  const value = Number.parseInt(raw, 10);
  return Math.max(1, Math.min(Number.isFinite(value) ? value : 600, 3600));
}

async function waitForRunTerminal(config, runId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastRun = state.runs.get(runId) || {};
  while (Date.now() < deadline) {
    lastRun = state.runs.get(runId) || readSnapshot(config, "runs", runId) || lastRun;
    if (TERMINAL_RUN_STATUSES.has(String(lastRun.status || "").toLowerCase())) return lastRun;
    await delay(250);
  }
  return { ...lastRun, status: "timeout" };
}

function openAiError(message, type, param = "") {
  return {
    error: {
      message: String(message || ""),
      type,
      code: type,
      ...(param ? { param } : {})
    }
  };
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

function createAgentRun(config, thread, agent, message) {
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
    message,
    stdout: "",
    stderr: "",
    events: []
  };
  if (thread.cache_scope) run.cache_scope = thread.cache_scope;
  thread.runs.push(run);
  state.runs.set(run.id, run);
  writeSnapshot(config, "runs", run.id, run);
  appendJsonl(config, "runs.jsonl", run);
  enqueueTask(agent.node_id, {
    type: "task.run",
    run_id: run.id,
    thread_id: thread.id,
    agent_id: agent.id,
    message,
    ...(run.cache_scope ? { cache_scope: run.cache_scope } : {}),
    created_at: run.created_at
  });
  return run;
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
    createAgentRun(config, thread, agent, body.message);
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

function pollNode(body, timeoutMs) {
  const nodeId = body?.node_id;
  if (!nodeId || !state.nodes.has(nodeId)) {
    const err = new Error("unknown node_id");
    err.statusCode = 404;
    throw err;
  }
  const node = state.nodes.get(nodeId);
  node.last_seen_at = new Date().toISOString();
  node.status = "online";
  if (Array.isArray(body.agents)) {
    node.agents = mergeAgentUpdates(nodeId, node.agents || [], body.agents);
  }

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

function mergeAgentUpdates(nodeId, current, updates) {
  const byId = new Map((current || []).filter((agent) => agent.id).map((agent) => [agent.id, { ...agent }]));
  for (const update of updates || []) {
    if (!update?.id) continue;
    byId.set(update.id, { ...(byId.get(update.id) || {}), ...normalizeAgent(nodeId, update) });
  }
  return [...byId.values()];
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

function sendJson(res, value, status = 200, options = {}) {
  const payload = options.redact === false ? value : redactObject(value);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
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

function intEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePath(value, baseDir) {
  if (!value) return value;
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return value;
  return path.resolve(baseDir, value);
}
