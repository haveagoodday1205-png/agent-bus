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
const TELEGRAM_DEFAULT_EVENTS = ["central.started", "edge.registered", "run.completed", "run.failed", "room.completed", "telegram.test", "telegram.command"];
const CLIENT_DISCONNECT_CODES = new Set(["EPIPE", "ECONNRESET", "ECONNABORTED", "ERR_STREAM_DESTROYED"]);

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

function isClientDisconnect(err) {
  return err && CLIENT_DISCONNECT_CODES.has(err.code);
}

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
  config.gatewayUrl = process.env.AGENT_BUS_GATEWAY_URL || config.gatewayUrl || "";
  config.token = process.env.AGENT_BUS_TOKEN || config.token;
  config.dataDir = process.env.AGENT_BUS_DATA_DIR || resolvePath(config.dataDir || "./data/central", path.dirname(file));
  config.defaults ||= {};
  config.modelRouter ||= {};
  config.modelRouter.enabled ??= true;
  config.modelRouter.agentModels ??= true;
  config.modelRouter.allowEdgeAgentModels ??= false;
  config.modelRouter.agentModelTimeoutSeconds ??= 600;
  config.modelRouter.backends ||= [];
  config.plugins ||= {};
  config.plugins.telegramBot ||= {};
  config.edgeTokens ||= [];
  return config;
}

function ensureDataDirs(config) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "threads"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, "telegram_sessions"), { recursive: true });
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
        return sendJson(res, centralHealth());
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
      if (req.method === "GET" && (url.pathname === "/status" || url.pathname === "/v1/agent-bus/status")) {
        requireAuth(req, config, ["admin"]);
        return sendJson(res, publicStatus(config));
      }
      if (req.method === "GET" && (url.pathname === "/manifest" || url.pathname === "/v1/agent-bus/manifest")) {
        requireAuth(req, config, ["admin", "edge"]);
        return sendJson(res, agentBusManifest(config));
      }
      if (req.method === "GET" && (url.pathname === "/plugins" || url.pathname === "/v1/agent-bus/plugins")) {
        requireAuth(req, config, ["admin"]);
        return sendJson(res, publicPluginsStatus(config));
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
      if (req.method === "POST" && (url.pathname === "/plugins/telegram/test" || url.pathname === "/v1/agent-bus/plugins/telegram/test")) {
        requireAuth(req, config, ["admin"]);
        const body = await readJson(req);
        return sendJson(res, telegramPluginTest(config, body));
      }
      if (req.method === "POST" && (url.pathname === "/plugins/telegram/webhook" || url.pathname === "/v1/agent-bus/plugins/telegram/webhook")) {
        const body = await readJson(req);
        return sendJson(res, telegramWebhook(config, body, req));
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
        const payload = await pollNode(body, Number(body.timeout_ms || config.defaults.pollTimeoutMs || 25000), { res });
        const delivered = sendJson(res, payload);
        if (!delivered) requeueUndeliveredPollPayload(body.node_id, payload);
        return delivered;
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
        const thread = createThread(config, body, requestTraceId(req, body));
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
      if (req.method === "GET" && url.pathname.startsWith("/traces/")) {
        const traceId = url.pathname.split("/").filter(Boolean)[1];
        return sendJson(res, traceLookup(config, traceId));
      }

      return sendJson(res, { error: "not_found" }, 404);
    } catch (err) {
      if (isClientDisconnect(err) || res.destroyed || res.writableEnded) return;
      return sendJson(res, { error: err.message || "internal_error" }, err.statusCode || 500);
    }
  });

  server.listen(config.port, config.host, () => {
    console.log(`central-gateway listening on http://${config.host}:${config.port}`);
    console.log(`Agent Bus join endpoint: ${publicGatewayUrl(config)}`);
    notifyPlugin(config, "central.started", {
      gateway: publicGatewayUrl(config),
      runtime: "node"
    });
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
  notifyPlugin(config, "edge.registered", {
    node_id: body.node_id,
    hostname: node.hostname,
    agents: node.agents.map((agent) => agent.id),
    agent_count: node.agents.length
  });
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
  const heartbeatIntervalMs = Number(agent.run_heartbeat_interval_ms || agent.runHeartbeatIntervalMs || 0);
  if (Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) item.run_heartbeat_interval_ms = Math.round(heartbeatIntervalMs);
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
    agents: (node.agents || []).map((agent) => publicNodeAgent(agent))
  };
}

function publicNodeAgent(agent) {
  const item = {
    id: agent.id,
    kind: agent.kind,
    role: agent.role,
    enabled: agent.enabled !== false,
    capabilities: agent.capabilities || []
  };
  const heartbeatIntervalMs = Number(agent.run_heartbeat_interval_ms || 0);
  if (Number.isFinite(heartbeatIntervalMs) && heartbeatIntervalMs > 0) item.run_heartbeat_interval_ms = Math.round(heartbeatIntervalMs);
  return item;
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

function centralHealth() {
  const onlineNodes = [...state.nodes.values()].filter(nodeIsOnline);
  return {
    ok: true,
    nodes: onlineNodes.length,
    agents: publicAgents().length,
    registered_nodes: state.nodes.size,
    registered_agents: [...state.nodes.values()].reduce((sum, node) => sum + (node.agents || []).length, 0),
    queued: [...state.queues.values()].reduce((sum, queue) => sum + queue.length, 0)
  };
}

const STATUS_ACTIVE_ROOM_STATUSES = new Set(["active", "running", "finishing"]);
const STATUS_QUEUED_RUN_STALE_SECONDS = 21600;

function publicStatus(config) {
  const health = centralHealth();
  const agents = publicAgents();
  const nodes = publicNodes();
  const rooms = statusRoomDetails(config);
  const activeRooms = rooms.filter(statusIsActiveRoom);
  const runSummary = statusRoomRunSummary(activeRooms);
  const recoveryHints = statusRecoveryHints(runSummary.staleQueuedRuns);
  const busyAgentIds = new Set(runSummary.liveByAgent.keys());
  for (const room of activeRooms) {
    if (Array.isArray(room.runs)) continue;
    for (const agentId of room.agents || []) {
      if (agentId) busyAgentIds.add(agentId);
    }
  }
  const result = {
    ok: Boolean(health.ok),
    health,
    summary: {
      nodes: health.nodes || 0,
      agents: health.agents || 0,
      registered_nodes: health.registered_nodes ?? health.nodes ?? 0,
      registered_agents: health.registered_agents ?? health.agents ?? 0,
      queued: health.queued || 0,
      online_agents: agents.filter((agent) => agent.status === "online").length,
      reachable_agents: agents.filter((agent) => agent.ping_status === "reachable").length,
      busy_agents: agents.filter((agent) => busyAgentIds.has(agent.id)).length,
      rooms: rooms.length,
      active_rooms: activeRooms.length,
      active_runs: runSummary.liveRuns.length,
      stale_queued_runs: runSummary.staleQueuedRuns.length
    },
    nodes: nodes.map(statusNodeItem),
    agents: agents.map((agent) => statusAgentItem(agent, activeRooms, runSummary)),
    rooms: rooms.slice(0, 8).map(statusRoomItem),
    recovery_hints: recoveryHints
  };
  result.warnings = statusWarnings(result, runSummary.staleQueuedRuns, recoveryHints);
  result.readiness = statusReadiness(result);
  result.next_actions = statusNextActions(result);
  return result;
}

function statusRoomDetails(config) {
  const byId = new Map();
  for (const room of readSnapshots(config, "rooms")) {
    if (room?.id) byId.set(room.id, room);
  }
  return [...byId.values()]
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}

function statusIsActiveRoom(room) {
  return STATUS_ACTIVE_ROOM_STATUSES.has(String(room?.status || "").toLowerCase());
}

function statusRoomRunSummary(rooms) {
  const liveRuns = [];
  const staleQueuedRuns = [];
  const liveByAgent = new Map();
  const staleQueuedByAgent = new Map();
  for (const room of rooms) {
    const buckets = statusRunBuckets(room);
    liveRuns.push(...buckets.liveRuns);
    staleQueuedRuns.push(...buckets.staleQueuedRuns);
    statusAddRunsByAgent(liveByAgent, buckets.liveRuns);
    statusAddRunsByAgent(staleQueuedByAgent, buckets.staleQueuedRuns);
  }
  statusSortRunsByNewest(liveByAgent);
  statusSortRunsByNewest(staleQueuedByAgent);
  return { liveRuns, staleQueuedRuns, liveByAgent, staleQueuedByAgent };
}

function statusRunBuckets(room) {
  const roomId = room?.id || "";
  const liveRuns = [];
  const staleQueuedRuns = [];
  for (const rawRun of Array.isArray(room?.runs) ? room.runs : []) {
    const status = String(rawRun.status || "queued").toLowerCase();
    if (TERMINAL_RUN_STATUSES.has(status)) continue;
    const run = {
      id: rawRun.id,
      room_id: rawRun.room_id || roomId,
      agent_id: rawRun.agent_id,
      status: rawRun.status || "queued",
      created_at: rawRun.created_at || null,
      started_at: rawRun.started_at || null
    };
    if (statusIsStaleQueuedRun(run)) staleQueuedRuns.push(run);
    else liveRuns.push(run);
  }
  return { liveRuns, staleQueuedRuns };
}

function statusIsStaleQueuedRun(run) {
  if (String(run.status || "").toLowerCase() !== "queued") return false;
  const created = Date.parse(run.created_at || "");
  if (!Number.isFinite(created)) return false;
  return (Date.now() - created) / 1000 > STATUS_QUEUED_RUN_STALE_SECONDS;
}

function statusAddRunsByAgent(byAgent, runs) {
  for (const run of runs) {
    if (!run.agent_id) continue;
    const list = byAgent.get(run.agent_id) || [];
    list.push(run);
    byAgent.set(run.agent_id, list);
  }
}

function statusSortRunsByNewest(byAgent) {
  for (const runs of byAgent.values()) {
    runs.sort((a, b) => Date.parse(b.started_at || b.created_at || 0) - Date.parse(a.started_at || a.created_at || 0));
  }
}

function statusNodeItem(node) {
  return {
    id: node.node_id || node.id || "unknown",
    status: node.status || "unknown",
    last_seen_at: node.last_seen_at || null,
    agents: Array.isArray(node.agents)
      ? node.agents.map((agent) => typeof agent === "string" ? agent : agent.id).filter(Boolean)
      : []
  };
}

function statusAgentItem(agent, activeRooms, runSummary) {
  const activeRuns = runSummary.liveByAgent.get(agent.id) || [];
  const staleQueuedRuns = runSummary.staleQueuedByAgent.get(agent.id) || [];
  const activeRoomIds = statusUnique([
    ...activeRuns.map((run) => run.room_id).filter(Boolean),
    ...activeRooms
      .filter((room) => !Array.isArray(room.runs) && Array.isArray(room.agents) && room.agents.includes(agent.id))
      .map((room) => room.id)
      .filter(Boolean)
  ]);
  const latestRun = activeRuns[0] || null;
  return {
    id: agent.id,
    status: agent.status || "unknown",
    ping_status: agent.ping_status || agent.health?.ping_status || "unknown",
    last_run_status: agent.last_run_status || agent.health?.last_run_status || null,
    last_seen_at: agent.last_seen_at || agent.node_last_seen_at || null,
    activity: statusAgentActivity(activeRuns, activeRoomIds),
    active_rooms: activeRoomIds,
    active_runs: activeRuns,
    stale_queued_runs: staleQueuedRuns,
    current_run: latestRun?.id || null
  };
}

function statusAgentActivity(activeRuns, activeRoomIds) {
  if (activeRuns.some((run) => String(run.status || "").toLowerCase() === "running")) return "running";
  if (activeRuns.some((run) => String(run.status || "").toLowerCase() === "queued")) return "queued";
  return activeRoomIds.length ? "busy/room-active" : "idle";
}

function statusRoomItem(room) {
  const buckets = statusRunBuckets(room);
  return {
    id: room.id,
    status: room.status,
    agents: room.agents || [],
    updated_at: room.updated_at,
    reports: room.report_count ?? (room.reports || []).length,
    messages: room.message_count ?? (room.messages || []).length,
    active_runs: buckets.liveRuns.map((run) => run.id).filter(Boolean),
    stale_queued_runs: buckets.staleQueuedRuns.map((run) => run.id).filter(Boolean)
  };
}

function statusRecoveryHints(staleQueuedRuns) {
  const byRoom = new Map();
  for (const run of staleQueuedRuns) {
    const roomId = run.room_id || "";
    if (!roomId) continue;
    const hint = byRoom.get(roomId) || {
      room_id: roomId,
      stale_queued_runs: [],
      agents: [],
      inspect_command: `agent-bus room inspect ${roomId}`,
      pause_command: `agent-bus room pause ${roomId} --reason "orphan queued run recovery"`,
      recover_command: `agent-bus room recover ${roomId} --yes`
    };
    if (run.id && !hint.stale_queued_runs.includes(run.id)) hint.stale_queued_runs.push(run.id);
    if (run.agent_id && !hint.agents.includes(run.agent_id)) hint.agents.push(run.agent_id);
    byRoom.set(roomId, hint);
  }
  return [...byRoom.values()].sort((a, b) => String(a.room_id || "").localeCompare(String(b.room_id || "")));
}

function statusWarnings(result, staleQueuedRuns, recoveryHints) {
  const warnings = [];
  if (staleQueuedRuns.length) {
    const queueNote = Number(result.health?.queued || 0) === 0 ? "; gateway queue is empty" : "";
    const roomNote = recoveryHints.length ? ` Example: ${recoveryHints[0].inspect_command}` : "";
    warnings.push(`Ignored ${staleQueuedRuns.length} stale queued room run(s) older than ${STATUS_QUEUED_RUN_STALE_SECONDS}s${queueNote}. Inspect the old room before recovering or pausing it.${roomNote}`);
  }
  return warnings;
}

function statusReadiness(result) {
  const s = result.summary || {};
  if (!result.health?.ok) {
    return {
      level: "critical",
      status: "central-unhealthy",
      message: "Central health did not report ok."
    };
  }
  if (Number(s.nodes || 0) === 0 || Number(s.online_agents || 0) === 0) {
    return {
      level: "setup",
      status: "waiting-for-edge",
      message: "Central is up, but no online edge agents are ready to receive work."
    };
  }
  if (Number(s.stale_queued_runs || 0) > 0) {
    return {
      level: "attention",
      status: "stale-room-runs",
      message: "Central is usable, but old queued room runs need operator review."
    };
  }
  if (Number(s.queued || 0) > 0 && Number(s.busy_agents || 0) === 0) {
    return {
      level: "attention",
      status: "queue-needs-agent",
      message: "Central has queued work, but no agent is currently marked busy."
    };
  }
  if (Number(s.busy_agents || 0) > 0 || Number(s.active_rooms || 0) > 0) {
    return {
      level: "active",
      status: "working",
      message: "Agents are connected and work is currently active."
    };
  }
  return {
    level: "ready",
    status: "ready",
    message: "Central and edge agents are ready for work."
  };
}

function statusNextActions(result) {
  const s = result.summary || {};
  const actions = [];
  if (!result.health?.ok) actions.push("Check the Central service logs and restart the central process.");
  if (Number(s.registered_nodes || 0) === 0) actions.push("Create the first edge join command with agent-bus setup central or the Web Console Edge Join panel.");
  if (Number(s.nodes || 0) === 0 && Number(s.registered_nodes || 0) > 0) actions.push("Start or restart an edge with agent-bus connect --config edge.config.json.");
  if (Number(s.nodes || 0) > 0 && Number(s.online_agents || 0) === 0) actions.push("Run agent-bus doctor --config edge.config.json on the edge host and restart its service.");
  if (Number(s.registered_agents || 0) > Number(s.agents || 0)) actions.push("Some registered agents are offline or stale; inspect the Nodes section before routing work to them.");
  if (Number(s.queued || 0) > 0 && Number(s.busy_agents || 0) === 0) actions.push("Poll or restart edge services so queued runs can be claimed.");
  if (result.recovery_hints?.length) actions.push(`Inspect stale room work: ${result.recovery_hints[0].inspect_command}`);
  if (Number(s.online_agents || 0) > 0 && Number(s.active_rooms || 0) === 0 && Number(s.queued || 0) === 0) {
    actions.push("Try a live room with agent-bus room create --goal \"...\" --agents agent-a,agent-b.");
  }
  return statusUnique(actions).slice(0, 6);
}

function statusUnique(values) {
  return [...new Set(values.filter((value) => value != null))];
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
      status: "GET /v1/agent-bus/status",
      manifest: "GET /v1/agent-bus/manifest",
      nodes: "GET /nodes",
      agents: "GET /agents",
      route: "POST /route",
      threads: "POST /threads",
      trace: "GET /traces/{trace_id}",
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
    },
    plugins: {
      telegramBot: publicTelegramPluginStatus(config)
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
  const traceId = requestTraceId(req, body);
  const agentId = agentModelId(body.model);
  if (agentId) {
    const { payload, status } = await createAgentChatCompletion(config, body, agentId, traceId);
    return sendJson(res, payload, status);
  }
  const { backend, routedModel } = selectModelBackend(config, body.model);
  const proxied = { ...body, model: routedModel };
  const headers = {
    "content-type": "application/json",
    "accept": body.stream ? "text/event-stream" : "application/json",
    "x-agent-bus-trace-id": traceId
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

  try {
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
  } catch (err) {
    if (isClientDisconnect(err)) return;
    throw err;
  }
}

async function proxyResponses(config, req, res, body) {
  const traceId = requestTraceId(req, body);
  const agentId = agentModelId(body.model);
  if (agentId) {
    const { payload, status } = await createAgentResponse(config, body, agentId, traceId);
    return sendJson(res, payload, status);
  }
  const { backend, routedModel } = selectModelBackend(config, body.model);
  const proxied = { ...body, model: routedModel };
  const headers = {
    "content-type": "application/json",
    "accept": body.stream ? "text/event-stream" : "application/json",
    "x-agent-bus-trace-id": traceId
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

  try {
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
  } catch (err) {
    if (isClientDisconnect(err)) return;
    throw err;
  }
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

function sanitizeTraceId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(/[^A-Za-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
}

function newTraceId() {
  return `trace_${crypto.randomUUID()}`;
}

function traceIdFromBody(body = {}) {
  const direct = sanitizeTraceId(body.trace_id || body.traceId || body.request_id || body.requestId);
  if (direct) return direct;
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    const value = sanitizeTraceId(body.metadata.agent_bus_trace_id || body.metadata.trace_id || body.metadata.traceId || body.metadata.request_id);
    if (value) return value;
  }
  if (body.agent_bus && typeof body.agent_bus === "object" && !Array.isArray(body.agent_bus)) {
    const value = sanitizeTraceId(body.agent_bus.trace_id || body.agent_bus.traceId || body.agent_bus.request_id);
    if (value) return value;
  }
  return "";
}

function requestTraceId(req, body = {}) {
  return traceIdFromBody(body) || sanitizeTraceId(req.headers["x-agent-bus-trace-id"] || req.headers["x-request-id"]) || newTraceId();
}

async function createAgentChatCompletion(config, body, agentId, traceId = "") {
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
    trace_id: traceId || newTraceId(),
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
      trace_id: thread.trace_id,
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
        trace_id: thread.trace_id,
        agent_id: agentId,
        node_id: agent.node_id
      }
    }
  };
}

async function createAgentResponse(config, body, agentId, traceId = "") {
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
    trace_id: traceId || newTraceId(),
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
      trace_id: thread.trace_id,
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
      trace_id: thread.trace_id,
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

function createAgentRun(config, thread, agent, message, traceId = "") {
  traceId = traceId || thread.trace_id || newTraceId();
  const run = {
    id: `run_${crypto.randomUUID()}`,
    thread_id: thread.id,
    trace_id: traceId,
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
    trace_id: traceId,
    agent_id: agent.id,
    message,
    ...(run.cache_scope ? { cache_scope: run.cache_scope } : {}),
    created_at: run.created_at
  });
  return run;
}

function createThread(config, body, traceId = "") {
  traceId = traceId || traceIdFromBody(body) || newTraceId();
  const selection = selectAgentsForMessage(body.message, {
    mode: body.mode || config.defaults.mode || "broadcast",
    agents: body.agents
  });
  const thread = {
    id: `thread_${crypto.randomUUID()}`,
    trace_id: traceId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
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
  if (String(body.title || "").trim()) thread.title = String(body.title).trim();
  if (body.telegram && typeof body.telegram === "object") thread.telegram = body.telegram;

  for (const agent of selection.agents) {
    createAgentRun(config, thread, agent, body.message, traceId);
  }

  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
  appendJsonl(config, "threads.jsonl", thread);
  return thread;
}

function enqueueTask(nodeId, task) {
  const queue = state.queues.get(nodeId) || [];
  queue.push(task);
  state.queues.set(nodeId, queue);
  deliverQueuedPollTask(nodeId);
}

function deliverQueuedPollTask(nodeId) {
  const queue = state.queues.get(nodeId) || [];
  const waiterQueue = state.waiters.get(nodeId) || [];
  while (queue.length && waiterQueue.length) {
    const task = queue.shift();
    let delivered = false;
    while (waiterQueue.length) {
      const waiter = waiterQueue.shift();
      if (resolvePollWaiter(nodeId, waiter, { type: "task", task })) {
        delivered = true;
        break;
      }
    }
    if (!delivered) {
      queue.unshift(task);
      break;
    }
  }
  state.queues.set(nodeId, queue);
  state.waiters.set(nodeId, waiterQueue);
}

function pollNode(body, timeoutMs, lifecycle = {}) {
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
  if (lifecycle.res?.destroyed || lifecycle.res?.writableEnded) return Promise.resolve({ type: "idle" });

  return new Promise((resolve) => {
    const waiter = {
      resolve,
      done: false,
      cleanup: null,
      timer: null
    };
    waiter.timer = setTimeout(() => {
      resolvePollWaiter(nodeId, waiter, { type: "idle" });
    }, Math.min(Math.max(timeoutMs || 25000, 1000), 60000));
    const waiters = state.waiters.get(nodeId) || [];
    waiters.push(waiter);
    state.waiters.set(nodeId, waiters);
    if (lifecycle.res) {
      const onClose = () => resolvePollWaiter(nodeId, waiter, { type: "idle" });
      waiter.cleanup = () => lifecycle.res.off("close", onClose);
      lifecycle.res.once("close", onClose);
      if (lifecycle.res.destroyed || lifecycle.res.writableEnded) {
        resolvePollWaiter(nodeId, waiter, { type: "idle" });
      }
    }
  });
}

function resolvePollWaiter(nodeId, waiter, payload) {
  if (!waiter || waiter.done) return false;
  waiter.done = true;
  clearTimeout(waiter.timer);
  if (waiter.cleanup) waiter.cleanup();
  const waiters = state.waiters.get(nodeId) || [];
  const index = waiters.indexOf(waiter);
  if (index !== -1) waiters.splice(index, 1);
  waiter.resolve(payload);
  return true;
}

function requeueUndeliveredPollPayload(nodeId, payload) {
  if (!nodeId || payload?.type !== "task" || !payload.task) return false;
  const queue = state.queues.get(nodeId) || [];
  const runId = payload.task.run_id;
  if (runId && queue.some((task) => task?.run_id === runId)) return false;
  queue.unshift(payload.task);
  state.queues.set(nodeId, queue);
  deliverQueuedPollTask(nodeId);
  return true;
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
  event.trace_id = sanitizeTraceId(body.trace_id || event.trace_id || run.trace_id);
  if (event.trace_id && !run.trace_id) run.trace_id = event.trace_id;
  if (event.type === "run.started") {
    run.status = "running";
    run.started_at ||= event.at;
    run.last_heartbeat_at ||= event.at;
  }
  if (event.type === "run.heartbeat") run.last_heartbeat_at = event.at;
  if (event.stream === "stdout" && event.text) run.stdout += event.text;
  if (event.stream === "stderr" && event.text) run.stderr += event.text;
  run.events ||= [];
  run.events.push(event);
  state.runs.set(run.id, run);
  writeSnapshot(config, "runs", run.id, run);
  updateThreadRun(config, run);
  appendJsonl(config, "events.jsonl", { run_id: run.id, ...event });
}

function requestedCompletionState(run, body) {
  const result = body.result || {};
  const exitCode = result.exit_code ?? null;
  return {
    status: result.status || (Number(result.exit_code || 0) === 0 ? "completed" : "failed"),
    exit_code: exitCode,
    stdout: trimOutput(redactSensitive(result.stdout ?? run.stdout ?? "")),
    stderr: trimOutput(redactSensitive(result.stderr ?? run.stderr ?? "")),
    summary: trimOutput(redactSensitive(result.summary || ""))
  };
}

function storedCompletionState(run) {
  return {
    status: run.status,
    exit_code: run.exit_code ?? null,
    stdout: trimOutput(redactSensitive(run.stdout ?? "")),
    stderr: trimOutput(redactSensitive(run.stderr ?? "")),
    summary: trimOutput(redactSensitive(run.summary ?? ""))
  };
}

function completeRun(config, body) {
  const run = state.runs.get(body.run_id) || readSnapshot(config, "runs", body.run_id);
  if (!run) {
    const err = new Error("unknown run_id");
    err.statusCode = 404;
    throw err;
  }
  if (TERMINAL_RUN_STATUSES.has(String(run.status || "").toLowerCase())) {
    if (JSON.stringify(storedCompletionState(run)) === JSON.stringify(requestedCompletionState(run, body))) return run;
    const err = new Error("run already completed with different result");
    err.statusCode = 409;
    throw err;
  }
  const completion = requestedCompletionState(run, body);
  if (body.trace_id && !run.trace_id) run.trace_id = sanitizeTraceId(body.trace_id);
  run.status = completion.status;
  run.completed_at = new Date().toISOString();
  run.exit_code = completion.exit_code;
  run.stdout = completion.stdout;
  run.stderr = completion.stderr;
  run.summary = completion.summary;
  state.runs.set(run.id, run);
  writeSnapshot(config, "runs", run.id, run);
  updateThreadRun(config, run);
  appendJsonl(config, "runs.jsonl", run);
  if (!notifyTelegramConversationResult(config, run)) {
    notifyPlugin(config, run.status === "completed" ? "run.completed" : "run.failed", {
      run_id: run.id,
      thread_id: run.thread_id,
      agent_id: run.agent_id,
      node_id: run.node_id,
      status: run.status,
      exit_code: run.exit_code
    });
  }
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
  if (res.destroyed || res.writableEnded) return false;
  const payload = options.redact === false ? value : redactObject(value);
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(body);
    return true;
  } catch (err) {
    if (isClientDisconnect(err)) return false;
    throw err;
  }
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

function publicGatewayUrl(config) {
  const configured = String(config.gatewayUrl || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  return `http://${config.host || "127.0.0.1"}:${config.port || 8788}`.replace(/\/+$/, "");
}

function telegramPluginConfig(config) {
  const plugin = { ...((config.plugins && config.plugins.telegramBot) || {}) };
  if (process.env.AGENT_BUS_TELEGRAM_ENABLED) {
    plugin.enabled = /^(1|true|yes|on)$/i.test(process.env.AGENT_BUS_TELEGRAM_ENABLED);
  }
  plugin.enabled ??= false;
  plugin.botTokenEnv ||= "AGENT_BUS_TELEGRAM_BOT_TOKEN";
  plugin.chatIdEnv ||= "AGENT_BUS_TELEGRAM_CHAT_ID";
  plugin.events ||= TELEGRAM_DEFAULT_EVENTS;
  plugin.dryRun ??= false;
  plugin.control = { ...(plugin.control || {}) };
  if (process.env.AGENT_BUS_TELEGRAM_CONTROL_ENABLED) {
    plugin.control.enabled = /^(1|true|yes|on)$/i.test(process.env.AGENT_BUS_TELEGRAM_CONTROL_ENABLED);
  }
  plugin.control.enabled ??= false;
  plugin.control.secretTokenEnv ||= "AGENT_BUS_TELEGRAM_WEBHOOK_SECRET";
  plugin.control.allowedChatIds ||= [];
  plugin.control.allowRun ??= true;
  return plugin;
}

function publicTelegramPluginStatus(config) {
  const plugin = telegramPluginConfig(config);
  const control = telegramControlConfig(plugin);
  const conversation = telegramConversationConfig(control);
  return {
    enabled: plugin.enabled === true,
    configured: Boolean(telegramBotToken(plugin) && telegramChatId(plugin)),
    dry_run: plugin.dryRun === true || plugin.dry_run === true,
    events: pluginEvents(plugin),
    bot_token_env: plugin.botTokenEnv,
    chat_id_env: plugin.chatIdEnv,
    control: {
      enabled: control.enabled === true,
      webhook: "/v1/agent-bus/plugins/telegram/webhook",
      diagnostic_dry_run_header: true,
      allow_run: control.allowRun !== false && control.allow_run !== false,
      allowed_chat_count: telegramAllowedChatIds(plugin).length,
      secret_configured: Boolean(telegramControlSecret(control)),
      secret_token_env: control.secretTokenEnv,
      conversation: {
        enabled: conversation.enabled === true || envTruthy(conversation.enabled),
        agents: telegramConversationAgents(conversation),
        mode: conversation.mode || "orchestrate"
      }
    }
  };
}

function publicPluginsStatus(config) {
  return {
    telegramBot: publicTelegramPluginStatus(config)
  };
}

function pluginEvents(plugin) {
  return Array.isArray(plugin.events) && plugin.events.length
    ? plugin.events.map((event) => String(event))
    : TELEGRAM_DEFAULT_EVENTS;
}

function telegramBotToken(plugin) {
  return String(process.env[plugin.botTokenEnv || "AGENT_BUS_TELEGRAM_BOT_TOKEN"] || plugin.botToken || plugin.bot_token || "").trim();
}

function telegramChatId(plugin) {
  return String(process.env[plugin.chatIdEnv || "AGENT_BUS_TELEGRAM_CHAT_ID"] || plugin.chatId || plugin.chat_id || "").trim();
}

function telegramControlConfig(plugin) {
  return { ...(plugin.control || {}) };
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function telegramConversationConfig(control) {
  const raw = control.conversation || control.chat || {};
  const conversation = raw && typeof raw === "object" ? { ...raw } : {};
  if (process.env.AGENT_BUS_TELEGRAM_CONVERSATION_ENABLED !== undefined) {
    conversation.enabled = envTruthy(process.env.AGENT_BUS_TELEGRAM_CONVERSATION_ENABLED);
  }
  if (process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENT) {
    conversation.agentId = process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENT.trim();
  }
  if (process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS) {
    conversation.agents = process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return conversation;
}

function telegramConversationEnabled(control) {
  const conversation = telegramConversationConfig(control);
  return conversation.enabled === true || envTruthy(conversation.enabled);
}

function telegramConversationAgents(conversation = {}) {
  const values = [];
  for (const key of ["agentId", "agent_id", "defaultAgentId", "default_agent_id"]) {
    if (conversation[key]) values.push(String(conversation[key]).trim());
  }
  const raw = conversation.agents || conversation.agentIds || conversation.agent_ids || [];
  const items = Array.isArray(raw) ? raw : String(raw).split(",");
  for (const item of items) {
    const text = String(item || "").trim();
    if (text) values.push(text);
  }
  return [...new Set(values)].filter(Boolean);
}

function telegramSessionKey(chatId) {
  return String(chatId || "").trim().replace(/[^A-Za-z0-9_.-]+/g, "_") || "unknown";
}

function telegramSessionPath(config, chatId) {
  return path.join(config.dataDir, "telegram_sessions", `${telegramSessionKey(chatId)}.json`);
}

function readTelegramSession(config, chatId) {
  const file = telegramSessionPath(config, chatId);
  if (!fs.existsSync(file)) {
    return {
      chat_id: String(chatId || "").trim(),
      active_thread_id: null,
      agents: [],
      room_draft: null,
      updated_at: null
    };
  }
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    data = {};
  }
  data.chat_id = String(chatId || "").trim();
  data.active_thread_id ??= null;
  data.agents ||= [];
  data.room_draft ??= null;
  return data;
}

function writeTelegramSession(config, chatId, session) {
  const file = telegramSessionPath(config, chatId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = {
    ...(session || {}),
    chat_id: String(chatId || "").trim(),
    updated_at: new Date().toISOString()
  };
  fs.writeFileSync(file, `${JSON.stringify(redactObject(record), null, 2)}\n`);
  return record;
}

function telegramThreadForChat(thread, chatId) {
  const telegram = thread?.telegram;
  return telegram && telegram.conversation === true && String(telegram.chat_id || "") === String(chatId || "");
}

function telegramChatThreads(config, chatId) {
  const byId = new Map();
  for (const thread of readSnapshots(config, "threads")) {
    if (thread?.id && telegramThreadForChat(thread, chatId)) byId.set(thread.id, thread);
  }
  for (const thread of state.threads.values()) {
    if (thread?.id && telegramThreadForChat(thread, chatId)) byId.set(thread.id, thread);
  }
  return [...byId.values()].sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
}

function telegramActiveThread(config, chatId, session = null) {
  const current = session || readTelegramSession(config, chatId);
  const threadId = current.active_thread_id;
  if (!threadId) return null;
  const thread = state.threads.get(threadId) || readSnapshot(config, "threads", threadId);
  return thread && telegramThreadForChat(thread, chatId) ? thread : null;
}

function telegramThreadTitle(message) {
  return String(message || "").trim().split(/\s+/).join(" ").slice(0, 80) || "Untitled Telegram process";
}

function telegramThreadLabel(thread) {
  if (!thread) return "no active process";
  return String(thread.title || thread.message || thread.id || "").trim().slice(0, 80) || thread.id;
}

function validateAgentIds(agentIds) {
  const wanted = [];
  for (const value of agentIds || []) {
    const text = String(value || "").trim();
    if (text && !wanted.includes(text)) wanted.push(text);
  }
  if (!wanted.length) return [];
  const online = new Set(publicAgents().map((agent) => agent.id));
  const missing = wanted.filter((agentId) => !online.has(agentId));
  if (missing.length) {
    const err = new Error(`unknown registered agents: ${missing.join(", ")}`);
    err.statusCode = 400;
    throw err;
  }
  return wanted;
}

function telegramThreadAgentIds(thread) {
  return ((thread?.selection || {}).agents || []).map((item) => String(item)).filter(Boolean);
}

function setTelegramThreadAgents(config, thread, agentIds) {
  const values = validateAgentIds(agentIds);
  if (!thread) return [];
  thread.selection ||= {};
  thread.selection.agents = values;
  thread.updated_at = new Date().toISOString();
  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
  return values;
}

function updateTelegramThreadAgents(config, thread, agentIds) {
  if (!thread) return [];
  const merged = [];
  for (const item of [...telegramThreadAgentIds(thread), ...validateAgentIds(agentIds)]) {
    if (!merged.includes(item)) merged.push(item);
  }
  return setTelegramThreadAgents(config, thread, merged);
}

function telegramExtractMentions(text) {
  let remaining = String(text || "").trim();
  const mentions = [];
  while (true) {
    const match = remaining.match(/^@([A-Za-z0-9_.-]+)(?:\s+|$)/);
    if (!match) break;
    mentions.push(match[1]);
    remaining = remaining.slice(match[0].length).trim();
  }
  return { mentions, message: remaining };
}

function telegramProcessPrompt(thread, latestMessage) {
  const itemLimit = promptLimit("AGENT_BUS_TELEGRAM_PROMPT_MESSAGE_CHARS", 1800, 200, 12000);
  const itemCount = promptLimit("AGENT_BUS_TELEGRAM_PROMPT_MESSAGE_COUNT", 8, 1, 20);
  const latestLimit = promptLimit("AGENT_BUS_TELEGRAM_PROMPT_LATEST_CHARS", 4000, 500, 24000);
  const maxBytes = promptLimit("AGENT_BUS_TELEGRAM_PROMPT_MAX_BYTES", 20000, 4000, 120000);
  const conversation = thread.conversation || [];
  const recent = [];
  for (const item of conversation.slice(-itemCount)) {
    const speaker = item.speaker || item.role || "unknown";
    const content = truncateForPrompt(item.content || "", itemLimit);
    if (content) recent.push({ speaker, content });
  }
  const latest = truncateForPrompt(String(latestMessage || "").trim(), latestLimit);
  let items = recent;
  let omitted = Math.max(0, conversation.length - items.length);
  while (items.length) {
    const prompt = renderTelegramProcessPrompt(thread, items, omitted, latest);
    if (Buffer.byteLength(prompt, "utf8") <= maxBytes) return prompt;
    items = items.slice(1);
    omitted += 1;
  }
  return renderTelegramProcessPrompt(thread, [], omitted, latest);
}

function renderTelegramProcessPrompt(thread, items, omitted, latest) {
  const lines = [
    "You are continuing a Telegram Agent Bus process.",
    `Process: ${telegramThreadLabel(thread)}`,
    `Thread: ${thread.id}`,
    "Answer the latest user message directly. Keep continuity with the prior messages.",
    "Do not claim to be another agent. Your agent id will be added outside your reply.",
    "",
    "Recent process messages:"
  ];
  if (omitted) lines.push(`[${omitted} older process messages omitted to keep the prompt compact]`);
  for (const item of items) lines.push(`${item.speaker}: ${item.content}`);
  lines.push("", "Latest user message:", latest);
  return lines.join("\n");
}

function promptLimit(name, defaultValue, lower, upper) {
  const raw = Number.parseInt(process.env[name] || String(defaultValue), 10);
  const value = Number.isFinite(raw) ? raw : defaultValue;
  return Math.max(lower, Math.min(value, upper));
}

function truncateForPrompt(value, limit) {
  const text = String(value || "");
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n[truncated ${text.length - limit} chars]`;
}

function telegramSessionAgents(config, control, session, thread = null, mentions = []) {
  const mentioned = validateAgentIds(mentions);
  if (mentioned.length) return mentioned;
  const sessionAgents = validateAgentIds(session.agents || []);
  if (sessionAgents.length) return sessionAgents;
  const configured = validateAgentIds(telegramConversationAgents(telegramConversationConfig(control)));
  if (configured.length) return configured;
  const threadAgents = validateAgentIds(telegramThreadAgentIds(thread));
  if (threadAgents.length) return threadAgents;
  return [];
}

function telegramControlSecret(control) {
  return String(process.env[control.secretTokenEnv || "AGENT_BUS_TELEGRAM_WEBHOOK_SECRET"] || control.secretToken || control.secret_token || "").trim();
}

function telegramAllowedChatIds(plugin) {
  const control = telegramControlConfig(plugin);
  const raw = control.allowedChatIds || control.allowed_chat_ids || [];
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const allowed = new Set(values.map((item) => String(item).trim()).filter(Boolean));
  const defaultChat = telegramChatId(plugin);
  if (defaultChat) allowed.add(defaultChat);
  return [...allowed].sort();
}

function telegramChatAllowed(plugin, chatId) {
  const allowed = telegramAllowedChatIds(plugin);
  return !allowed.length || allowed.includes(String(chatId));
}

function telegramPluginDryRun(plugin) {
  return plugin.dryRun === true || plugin.dry_run === true;
}

function telegramShortLabel(value, limit = 34) {
  const text = String(value || "").trim().split(/\s+/).join(" ");
  return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 3)).trimEnd()}...`;
}

function telegramCallbackButton(text, callbackData) {
  const data = String(callbackData || "").trim();
  if (!data || Buffer.byteLength(data, "utf8") > 64) return null;
  return {
    text: telegramShortLabel(text, 40),
    callback_data: data
  };
}

function telegramButtonRows(buttons, width = 2) {
  const rows = [];
  let row = [];
  for (const button of buttons) {
    if (!button) continue;
    row.push(button);
    if (row.length >= width) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

function telegramBaseKeyboardRows() {
  return [
    [
      telegramCallbackButton("Status", "/status"),
      telegramCallbackButton("Agents", "/agents")
    ],
    [
      telegramCallbackButton("New process", "/new"),
      telegramCallbackButton("Resume", "/resume")
    ],
    [
      telegramCallbackButton("Rooms", "/rooms")
    ]
  ];
}

function telegramAgentKeyboardRows(config, chatId) {
  const agents = publicAgents().sort((a, b) => String(a.id || "").localeCompare(String(b.id || "")));
  if (!agents.length) return [];
  const session = chatId ? readTelegramSession(config, chatId) : { agents: [] };
  const active = chatId ? telegramActiveThread(config, chatId, session) : null;
  const current = new Set(session.agents?.length ? session.agents : telegramThreadAgentIds(active));
  const buttons = [];
  if (current.size) buttons.push(telegramCallbackButton("Auto route", "/agent clear"));
  for (const agent of agents.slice(0, 10)) {
    const agentId = String(agent.id || "").trim();
    if (!agentId) continue;
    const selected = current.has(agentId);
    const command = `/agent toggle ${agentId}`;
    buttons.push(telegramCallbackButton(`${selected ? "* " : (active ? "+ " : "")}${agentId}`, command));
  }
  return telegramButtonRows(buttons, 2);
}

function telegramProcessKeyboardRows(config, chatId) {
  if (!chatId) return [];
  const session = readTelegramSession(config, chatId);
  const activeId = session.active_thread_id;
  const buttons = telegramChatThreads(config, chatId).slice(0, 6).map((thread) => {
    const threadId = String(thread.id || "");
    const prefix = threadId === activeId ? "* " : "";
    return telegramCallbackButton(`${prefix}${telegramThreadLabel(thread)}`, `/resume ${threadId}`);
  });
  return telegramButtonRows(buttons, 1);
}

function telegramRoomDraft(config, chatId) {
  const session = readTelegramSession(config, chatId);
  const raw = session.room_draft && typeof session.room_draft === "object" ? session.room_draft : {};
  const agents = [];
  for (const value of raw.agents || []) {
    const text = String(value || "").trim();
    if (text && !agents.includes(text)) agents.push(text);
  }
  const steps = Number.parseInt(raw.max_steps || raw.maxSteps || 5, 10);
  return {
    agents,
    max_steps: Math.max(1, Math.min(Number.isFinite(steps) ? steps : 5, 100)),
    created_at: raw.created_at || new Date().toISOString()
  };
}

function writeTelegramRoomDraft(config, chatId, draft) {
  const session = readTelegramSession(config, chatId);
  session.room_draft = draft;
  writeTelegramSession(config, chatId, session);
  return draft;
}

function clearTelegramRoomDraft(config, chatId) {
  const session = readTelegramSession(config, chatId);
  session.room_draft = null;
  writeTelegramSession(config, chatId, session);
}

function telegramRoomDraftActive(config, chatId) {
  const session = readTelegramSession(config, chatId);
  return session.room_draft && typeof session.room_draft === "object";
}

function telegramRoomDraftKeyboardRows(config, chatId) {
  const draft = telegramRoomDraft(config, chatId);
  const current = new Set(draft.agents || []);
  const buttons = [];
  for (const agent of publicAgents().sort((a, b) => String(a.id || "").localeCompare(String(b.id || ""))).slice(0, 10)) {
    const agentId = String(agent.id || "").trim();
    if (!agentId) continue;
    buttons.push(telegramCallbackButton(`${current.has(agentId) ? "* " : "+ "}${agentId}`, `/room agent toggle ${agentId}`));
  }
  const rows = telegramButtonRows(buttons, 2);
  const steps = Number(draft.max_steps || 5);
  rows.push(...telegramButtonRows([2, 5, 10, 20].map((value) => (
    telegramCallbackButton(value === steps ? `* ${value} steps` : `${value} steps`, `/room steps ${value}`)
  )), 2));
  rows.push([
    telegramCallbackButton("Cancel", "/room cancel"),
    telegramCallbackButton("Rooms", "/rooms")
  ]);
  return rows;
}

function telegramRoomDraftText(draft) {
  return [
    "New Agent Bus room draft",
    `Agents: ${(draft.agents || []).join(", ") || "auto"}`,
    `Max steps: ${draft.max_steps || 5}`,
    "Select agents and steps, then send the room goal or use /room start <goal>."
  ].join("\n");
}

function telegramActiveRoomStatus(room) {
  return ["active", "running", "finishing"].includes(String(room?.status || "").toLowerCase());
}

function telegramRoomLabel(room) {
  const title = String(room?.title || room?.goal || room?.id || "").trim();
  const status = String(room?.status || "unknown").trim();
  return telegramShortLabel(`${status}: ${title}`, 38);
}

function listTelegramRooms(config) {
  const byId = new Map();
  for (const room of readSnapshots(config, "rooms")) {
    if (room?.id) byId.set(room.id, telegramRoomSummary(room));
  }
  return [...byId.values()].sort((a, b) => String(b.updated_at || "").localeCompare(String(a.updated_at || "")));
}

function telegramRoomSummary(room) {
  return {
    id: room.id,
    title: room.title,
    goal: room.goal,
    status: room.status,
    agents: room.agents || [],
    steps: room.autonomy?.steps || 0,
    max_steps: room.autonomy?.max_steps || 0,
    message_count: (room.messages || []).length,
    report_count: (room.reports || []).length,
    updated_at: room.updated_at
  };
}

function telegramRoomMatch(config, query) {
  const text = String(query || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  return listTelegramRooms(config).find((room) => {
    const roomId = String(room.id || "");
    const title = String(room.title || room.goal || "").toLowerCase();
    return roomId === text || roomId.endsWith(text) || roomId.includes(text) || title.includes(lowered);
  }) || null;
}

function telegramRoomKeyboardRows(config) {
  const rows = [[telegramCallbackButton("New room", "/room new")]];
  const buttons = listTelegramRooms(config).slice(0, 6).map((room) => (
    telegramCallbackButton(telegramRoomLabel(room), `/room ${room.id}`)
  ));
  rows.push(...telegramButtonRows(buttons, 1));
  return rows;
}

function telegramRoomActionKeyboardRows(room) {
  if (!room?.id) return [];
  const rows = [[telegramCallbackButton("Rooms", "/rooms")]];
  rows.push([telegramCallbackButton("New room", "/room new")]);
  if (telegramActiveRoomStatus(room)) {
    rows.push([
      telegramCallbackButton("Wake next", `/room wake ${room.id}`),
      telegramCallbackButton("Pause", `/room pause ${room.id}`)
    ]);
  } else if (String(room.status || "").toLowerCase() === "paused") {
    rows.push([telegramCallbackButton("Resume room", `/room wake ${room.id}`)]);
  }
  return rows.filter((row) => row.length && row.every(Boolean));
}

function telegramReplyMarkup(config, commandResult = {}, chatId = "") {
  const rows = [];
  const command = String(commandResult.command || "").toLowerCase();
  if (["start", "help", "status", "message", "unknown"].includes(command)) {
    rows.push(...telegramBaseKeyboardRows());
  }
  if (["agents", "agent", "new"].includes(command)) {
    rows.push(...telegramAgentKeyboardRows(config, chatId));
  }
  if (command === "resume") {
    rows.push(...telegramProcessKeyboardRows(config, chatId));
  }
  if (command === "rooms") {
    rows.push(...telegramRoomKeyboardRows(config));
  }
  if (command === "room_draft") {
    rows.push(...telegramRoomDraftKeyboardRows(config, chatId));
  }
  if (command === "room") {
    rows.push(...telegramRoomActionKeyboardRows(commandResult.room));
  }
  const kept = rows.filter((row) => row.length);
  return kept.length ? { inline_keyboard: kept } : null;
}

function answerTelegramCallback(config, plugin, callbackQueryId) {
  const id = String(callbackQueryId || "").trim();
  if (!id) return null;
  const token = telegramBotToken(plugin);
  const dryRun = telegramPluginDryRun(plugin);
  const status = dryRun ? "dry_run" : (token ? "queued" : "missing_config");
  appendJsonl(config, "notifications.jsonl", {
    at: new Date().toISOString(),
    plugin: "telegramBot",
    event: "telegram.callback_answer",
    status,
    callback_query_id: id
  });
  if (dryRun || !token) {
    return {
      ok: dryRun,
      plugin: "telegramBot",
      event: "telegram.callback_answer",
      status,
      configured: Boolean(token),
      dry_run: dryRun
    };
  }
  sendTelegramCallbackAnswer(config, plugin, token, id);
  return {
    ok: true,
    plugin: "telegramBot",
    event: "telegram.callback_answer",
    status,
    configured: true,
    dry_run: false
  };
}

function notifyPlugin(config, event, payload = {}, options = {}) {
  const plugin = telegramPluginConfig(config);
  if (plugin.enabled !== true) {
    return {
      ok: false,
      plugin: "telegramBot",
      event,
      status: "disabled"
    };
  }
  if (options.eventFilter !== false && !new Set(pluginEvents(plugin)).has(event)) {
    return {
      ok: false,
      plugin: "telegramBot",
      event,
      status: "event_disabled"
    };
  }
  const text = telegramNotificationText(event, payload);
  const token = telegramBotToken(plugin);
  const chatId = String(options.chatIdOverride || telegramChatId(plugin)).trim();
  const dryRun = options.dryRunOverride === undefined
    ? telegramPluginDryRun(plugin)
    : options.dryRunOverride === true;
  const replyMarkup = options.replyMarkup || payload.reply_markup || null;
  appendJsonl(config, "notifications.jsonl", {
    at: new Date().toISOString(),
    plugin: "telegramBot",
    event,
    status: dryRun ? "dry_run" : (token && chatId ? "queued" : "missing_config"),
    message: text,
    payload,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  });
  if (dryRun || !token || !chatId) {
    return {
      ok: dryRun,
      plugin: "telegramBot",
      event,
      status: dryRun ? "dry_run" : "missing_config",
      configured: Boolean(token && chatId),
      dry_run: dryRun,
      reply_markup: replyMarkup
    };
  }
  sendTelegramNotification(config, plugin, token, chatId, text, replyMarkup);
  return {
    ok: true,
    plugin: "telegramBot",
    event,
    status: "queued",
    configured: true,
    dry_run: false,
    reply_markup: replyMarkup
  };
}

function telegramPluginTest(config, body = {}) {
  const message = String(body.message || "Agent Bus Telegram plugin test.").trim();
  const dryRunValue = body.dryRun ?? body.dry_run;
  const result = notifyPlugin(config, "telegram.test", {
    message,
    gateway: publicGatewayUrl(config)
  }, {
    dryRunOverride: dryRunValue === undefined ? undefined : /^(1|true|yes|on)$/i.test(String(dryRunValue)),
    eventFilter: false
  });
  return {
    ok: result.ok === true,
    plugin: publicTelegramPluginStatus(config),
    notification: result
  };
}

function telegramWebhook(config, body = {}, req) {
  const plugin = telegramPluginConfig(config);
  const control = telegramControlConfig(plugin);
  if (plugin.enabled !== true || control.enabled !== true) {
    const err = new Error("telegram control webhook is disabled");
    err.statusCode = 403;
    throw err;
  }
  const secret = telegramControlSecret(control);
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    const err = new Error("invalid telegram webhook secret");
    err.statusCode = 403;
    throw err;
  }
  const message = telegramUpdateMessage(body);
  const chatId = String(message.chat?.id || "").trim();
  const text = String(message.text || "").trim();
  if (!chatId || !text) {
    const err = new Error("telegram webhook requires message.chat.id and message.text");
    err.statusCode = 400;
    throw err;
  }
  if (!telegramChatAllowed(plugin, chatId)) {
    const err = new Error("telegram chat is not allowed");
    err.statusCode = 403;
    throw err;
  }
  const dryRunProbe = /^(1|true|yes|on)$/i.test(String(req.headers["x-agent-bus-telegram-dry-run"] || ""));
  const callbackAnswer = answerTelegramCallback(config, plugin, message._callback_query_id);
  const command = telegramHandleCommand(config, plugin, control, text, chatId);
  const replyMarkup = telegramReplyMarkup(config, command, chatId);
  const replyStatus = notifyPlugin(config, "telegram.command", {
    command: command.command,
    reply: command.reply,
    chat_id: chatId,
    thread_id: command.thread?.id
  }, {
    dryRunOverride: dryRunProbe,
    eventFilter: false,
    chatIdOverride: chatId,
    replyMarkup
  });
  return {
    ok: true,
    diagnostic_dry_run: dryRunProbe,
    command: command.command,
    reply: command.reply,
    reply_status: replyStatus,
    reply_markup: replyMarkup,
    callback_answer: callbackAnswer,
    thread: command.thread,
    room: command.room
  };
}

function telegramUpdateMessage(body = {}) {
  if (body.message && typeof body.message === "object") return body.message;
  if (body.edited_message && typeof body.edited_message === "object") return body.edited_message;
  if (body.callback_query?.message) {
    return {
      ...body.callback_query.message,
      text: body.callback_query.data || body.callback_query.message.text || "",
      _callback_query_id: body.callback_query.id
    };
  }
  return {};
}

function telegramHandleCommand(config, plugin, control, text, chatId = "") {
  const isCommand = String(text || "").trimStart().startsWith("/");
  const { command, rest } = telegramParseCommand(text);
  if (isCommand && command === "new") return telegramNewCommand(config, chatId, rest);
  if (isCommand && command === "resume") return telegramResumeCommand(config, chatId, rest);
  if (isCommand && command === "agent") return telegramAgentCommand(config, chatId, rest);
  if (isCommand && command === "agents") return { command, reply: telegramAgentsText() };
  if (isCommand && command === "rooms") return telegramRoomsCommand(config, chatId, rest);
  if (isCommand && command === "room") return telegramRoomCommand(config, chatId, rest);
  if (!isCommand) {
    if (telegramRoomDraftActive(config, chatId)) {
      return telegramRoomStartCommand(config, chatId, text);
    }
    if (telegramConversationEnabled(control)) {
      return telegramConversationCommand(config, control, chatId, text);
    }
    return {
      command: "message",
      reply: telegramHelpText("Free-form chat is disabled. Use /run or enable control.conversation.enabled.")
    };
  }
  if (command === "start" || command === "help") return { command, reply: telegramHelpText() };
  if (command === "status") return { command, reply: telegramStatusText(config) };
  if (command === "run") {
    if (control.allowRun === false || control.allow_run === false) {
      return { command, reply: "Run commands are disabled for this Telegram bot." };
    }
    return telegramRunCommand(config, rest);
  }
  return { command: command || "unknown", reply: telegramHelpText("Unknown command.") };
}

function telegramNewCommand(config, chatId, rest = "") {
  const session = readTelegramSession(config, chatId);
  session.active_thread_id = null;
  session.agents = [];
  writeTelegramSession(config, chatId, session);
  if (String(rest || "").trim()) {
    const plugin = telegramPluginConfig(config);
    return telegramConversationCommand(config, telegramControlConfig(plugin), chatId, rest);
  }
  return {
    command: "new",
    reply: "Started a new Agent Bus process. Tap agents to preselect one or more, or send the first message for automatic routing."
  };
}

function telegramResumeCommand(config, chatId, rest = "") {
  const query = String(rest || "").trim();
  const threads = telegramChatThreads(config, chatId);
  const session = readTelegramSession(config, chatId);
  if (!query) {
    if (!threads.length) return { command: "resume", reply: "No Telegram processes found. Send a message to start one." };
    const lines = ["Recent Agent Bus processes:"];
    for (const thread of threads.slice(0, 8)) {
      const marker = thread.id === session.active_thread_id ? "*" : "-";
      lines.push(`${marker} ${thread.id} - ${telegramThreadLabel(thread)}`);
    }
    lines.push("Use /resume <thread-id or title words> to switch.");
    return { command: "resume", reply: lines.join("\n") };
  }
  const lowered = query.toLowerCase();
  const match = threads.find((thread) => {
    const title = telegramThreadLabel(thread).toLowerCase();
    const threadId = String(thread.id || "");
    return threadId === query || threadId.endsWith(query) || threadId.includes(query) || title.includes(lowered);
  });
  if (!match) return { command: "resume", reply: `No matching Telegram process for: ${query}` };
  session.active_thread_id = match.id;
  session.agents = telegramThreadAgentIds(match);
  writeTelegramSession(config, chatId, session);
  return {
    command: "resume",
    reply: `Resumed process: ${telegramThreadLabel(match)}\nThread: ${match.id}\nAgents: ${session.agents.join(", ") || "auto"}`,
    thread: {
      id: match.id,
      trace_id: match.trace_id,
      runs: [],
      agents: session.agents
    }
  };
}

function telegramAgentCommand(config, chatId, rest = "") {
  const session = readTelegramSession(config, chatId);
  const active = telegramActiveThread(config, chatId, session);
  const parts = String(rest || "").split(/\s+/).filter(Boolean);
  if (!parts.length) {
    const online = publicAgents().map((agent) => agent.id);
    const current = session.agents?.length ? session.agents : telegramThreadAgentIds(active);
    return {
      command: "agent",
      reply: `Current agents: ${current.join(", ") || "auto"}\nOnline agents: ${online.join(", ") || "none"}`
    };
  }
  const action = parts[0].toLowerCase();
  if (["clear", "auto"].includes(action)) {
    session.agents = [];
    if (active) setTelegramThreadAgents(config, active, []);
    writeTelegramSession(config, chatId, session);
    return { command: "agent", reply: "Agent selection cleared. The process will use Agent Bus routing." };
  }
  if (["add", "+"].includes(action)) {
    const values = validateAgentIds(parts.slice(1));
    if (!values.length) return { command: "agent", reply: "Usage: /agent add <agent-id> [agent-id...]" };
    let merged = [];
    for (const item of [...(session.agents?.length ? session.agents : telegramThreadAgentIds(active)), ...values]) {
      if (!merged.includes(item)) merged.push(item);
    }
    if (active) merged = updateTelegramThreadAgents(config, active, merged);
    session.agents = merged;
    writeTelegramSession(config, chatId, session);
    return { command: "agent", reply: `Agents for this process: ${merged.join(", ")}` };
  }
  if (["toggle", "pick"].includes(action)) {
    const values = validateAgentIds(parts.slice(1));
    if (!values.length) return { command: "agent", reply: "Usage: /agent toggle <agent-id> [agent-id...]" };
    const current = [];
    for (const item of (session.agents?.length ? session.agents : telegramThreadAgentIds(active))) {
      if (!current.includes(item)) current.push(item);
    }
    for (const item of values) {
      const index = current.indexOf(item);
      if (index === -1) current.push(item);
      else current.splice(index, 1);
    }
    if (active) setTelegramThreadAgents(config, active, current);
    session.agents = current;
    writeTelegramSession(config, chatId, session);
    return { command: "agent", reply: `Agents for this process: ${current.join(", ") || "auto"}` };
  }
  const values = validateAgentIds(["set", "="].includes(action) ? parts.slice(1) : parts);
  if (!values.length) return { command: "agent", reply: "Usage: /agent <agent-id> [agent-id...]" };
  if (active) updateTelegramThreadAgents(config, active, values);
  session.agents = values;
  writeTelegramSession(config, chatId, session);
  return { command: "agent", reply: `Agents for this process: ${values.join(", ")}` };
}

function telegramConversationCommand(config, control, chatId, text) {
  const extracted = telegramExtractMentions(text);
  let message = extracted.message;
  const mentions = extracted.mentions;
  if (!message) {
    if (mentions.length) return telegramAgentCommand(config, chatId, `add ${mentions.join(" ")}`);
    message = String(text || "").trim();
  }
  const session = readTelegramSession(config, chatId);
  const active = telegramActiveThread(config, chatId, session);
  const conversation = telegramConversationConfig(control);
  const agents = telegramSessionAgents(config, control, session, active, mentions);
  const mode = String(conversation.mode || "orchestrate").trim() || "orchestrate";
  const queuedRunIds = [];
  if (active) {
    if (mentions.length) {
      const merged = updateTelegramThreadAgents(config, active, [...telegramThreadAgentIds(active), ...mentions]);
      session.agents = merged;
      writeTelegramSession(config, chatId, session);
    }
    let selected = agents.length ? agents : telegramThreadAgentIds(active);
    if (!selected.length) selected = telegramSessionAgents(config, control, session, active, []);
    if (!selected.length) {
      const selection = selectAgentsForMessage(message, { mode, agents: null });
      selected = selection.agents.map((agent) => agent.id);
      updateTelegramThreadAgents(config, active, selected);
    }
    selected = validateAgentIds(selected);
    active.conversation ||= [];
    active.conversation.push({
      speaker: "user",
      role: "user",
      content: message,
      at: new Date().toISOString()
    });
    const prompt = telegramProcessPrompt(active, message);
    const onlineById = new Map(publicAgents().map((agent) => [agent.id, agent]));
    for (const agentId of selected) {
      const run = createAgentRun(config, active, onlineById.get(agentId), prompt, active.trace_id);
      queuedRunIds.push(run.id);
    }
    active.updated_at = new Date().toISOString();
    state.threads.set(active.id, active);
    writeSnapshot(config, "threads", active.id, active);
    appendJsonl(config, "threads.jsonl", active);
    return {
      command: "chat",
      reply: `Thinking with ${selected.join(", ") || "Agent Bus"}...\nProcess: ${telegramThreadLabel(active)}\nThread: ${active.id}`,
      thread: {
        id: active.id,
        trace_id: active.trace_id,
        runs: queuedRunIds,
        agents: selected
      }
    };
  }
  const body = {
    message,
    title: telegramThreadTitle(message),
    mode,
    source: "telegram",
    telegram: {
      conversation: true,
      chat_id: String(chatId || "").trim(),
      session: true
    }
  };
  if (agents.length) body.agents = agents;
  const thread = createThread(config, body);
  thread.conversation ||= [];
  thread.conversation.push({
    speaker: "user",
    role: "user",
    content: message,
    at: thread.created_at || new Date().toISOString()
  });
  thread.updated_at = new Date().toISOString();
  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
  session.active_thread_id = thread.id;
  session.agents = telegramThreadAgentIds(thread);
  writeTelegramSession(config, chatId, session);
  const runIds = (thread.runs || []).map((run) => run.id).filter(Boolean);
  const selected = thread.selection?.agents || agents;
  return {
    command: "chat",
    reply: `Thinking with ${selected.join(", ") || "Agent Bus"}...\nProcess: ${telegramThreadLabel(thread)}\nThread: ${thread.id}`,
    thread: {
      id: thread.id,
      trace_id: thread.trace_id,
      runs: runIds,
      agents: selected
    }
  };
}

function notifyTelegramConversationResult(config, run) {
  const threadId = run.thread_id;
  if (!threadId || run.room_id) return false;
  const thread = state.threads.get(threadId) || readSnapshot(config, "threads", threadId);
  const telegram = thread?.telegram;
  if (!telegram || telegram.conversation !== true) return false;
  const chatId = String(telegram.chat_id || "").trim();
  if (!chatId) return false;
  recordTelegramConversationReply(config, thread, run);
  const reply = telegramConversationReplyText(run);
  const replyMarkup = telegramReplyMarkup(config, {
    command: "chat",
    thread: { id: threadId }
  }, chatId);
  notifyPlugin(config, "telegram.command", {
    command: "chat",
    reply,
    chat_id: chatId,
    thread_id: threadId,
    run_id: run.id
  }, {
    eventFilter: false,
    chatIdOverride: chatId,
    replyMarkup
  });
  return true;
}

function recordTelegramConversationReply(config, thread, run) {
  if (!thread) return;
  const content = trimOutput(run.stdout || run.summary || run.stderr || "");
  thread.conversation ||= [];
  thread.conversation.push({
    speaker: run.agent_id || "agent",
    role: "assistant",
    content,
    run_id: run.id,
    status: run.status,
    at: run.completed_at || new Date().toISOString()
  });
  thread.updated_at = new Date().toISOString();
  state.threads.set(thread.id, thread);
  writeSnapshot(config, "threads", thread.id, thread);
}

function telegramConversationReplyText(run) {
  let content = trimOutput(run.stdout || run.summary || run.stderr || "").trim();
  if (!content) content = "(no output)";
  const limit = 3800;
  if (content.length > limit) content = `${content.slice(0, limit).trimEnd()}\n...[truncated ${content.length - limit} chars]`;
  const prefix = `[${run.agent_id || "agent"}]`;
  if (run.status === "completed") return `${prefix}\n${content}`;
  return `${prefix}\nAgent Bus run ${run.status || "failed"}\n${content}`;
}

function telegramParseCommand(text) {
  const [first = "", ...rest] = String(text || "").trim().split(/\s+/);
  const token = first.startsWith("/") ? first.slice(1).split("@")[0] : first;
  return {
    command: token.toLowerCase().replace(/-/g, "_"),
    rest: rest.join(" ").trim()
  };
}

function telegramHelpText(prefix = "") {
  return [
    prefix,
    "Agent Bus Telegram commands:",
    "/status - gateway, edge, queue, and room summary",
    "/agents - list online agents",
    "/run <agent-id> <task> - queue a task for one agent",
    "/new - end the current Telegram process and start a new one",
    "/resume [thread-id or title] - list or resume Telegram processes",
    "/agent [add|set|clear] <agent-id> - choose agents for this process",
    "/rooms - list Agent Bus rooms",
    "/room <room-id> - inspect, wake, or pause a room",
    "/room new - draft a room, multi-select agents, and set max steps",
    "@agent-id message - add or target an agent for this message",
    "Plain text - chat with the configured Agent Bus agent when conversation mode is enabled"
  ].filter(Boolean).join("\n");
}

function telegramStatusText() {
  const nodes = publicNodes();
  const agents = publicAgents();
  const queued = [...state.queues.values()].reduce((sum, queue) => sum + queue.length, 0);
  return [
    "Agent Bus status",
    `Nodes online: ${nodes.length}`,
    `Agents online: ${agents.length}`,
    `Queued runs: ${queued}`,
    "Active rooms: 0",
    `Agents: ${agents.map((agent) => agent.id).join(", ") || "none"}`
  ].join("\n");
}

function telegramAgentsText() {
  const agents = publicAgents();
  if (!agents.length) return "No online Agent Bus agents.";
  return [
    "Online Agent Bus agents:",
    ...agents.map((agent) => `- ${agent.id} (${agent.kind}/${agent.role}) on ${agent.node_id}`)
  ].join("\n");
}

function telegramRoomsCommand(config, chatId = "", rest = "") {
  const query = String(rest || "").trim();
  if (query) return telegramRoomCommand(config, chatId, query);
  const rooms = listTelegramRooms(config);
  if (!rooms.length) {
    return {
      command: "rooms",
      reply: "No Agent Bus rooms found. Use the CLI or web console to create a room."
    };
  }
  const lines = ["Recent Agent Bus rooms:"];
  for (const room of rooms.slice(0, 8)) {
    const agents = (room.agents || []).join(", ") || "auto";
    const steps = `${room.steps || 0}/${room.max_steps || "unlimited"}`;
    lines.push(`- ${room.id} - ${room.status || "unknown"} - ${telegramThreadTitle(room.title || room.goal)} [${agents}, steps ${steps}]`);
  }
  lines.push("Tap a room to inspect it, or use /room <room-id>.");
  return {
    command: "rooms",
    reply: lines.join("\n")
  };
}

function telegramRoomCommand(config, chatId = "", rest = "") {
  const parts = String(rest || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return telegramRoomsCommand(config, chatId);
  let action = parts[0].toLowerCase();
  let query = parts.join(" ");
  if (action === "new") {
    const goal = String(rest || "").trim().slice(parts[0].length).trim();
    return telegramRoomNewCommand(config, chatId, goal);
  }
  if (action === "cancel") {
    clearTelegramRoomDraft(config, chatId);
    return { command: "rooms", reply: "Cancelled the new room draft." };
  }
  if (action === "agent") return telegramRoomAgentCommand(config, chatId, parts.slice(1));
  if (["steps", "step", "max_steps", "maxsteps"].includes(action)) return telegramRoomStepsCommand(config, chatId, parts.slice(1));
  if (action === "start") {
    const goal = String(rest || "").trim().slice(parts[0].length).trim();
    if (!goal) {
      const draft = writeTelegramRoomDraft(config, chatId, telegramRoomDraft(config, chatId));
      return { command: "room_draft", reply: telegramRoomDraftText(draft) };
    }
    return telegramRoomStartCommand(config, chatId, goal);
  }
  if (["wake", "resume", "pause"].includes(action)) {
    query = parts.slice(1).join(" ");
  } else if (["show", "open"].includes(action)) {
    action = "show";
    query = parts.slice(1).join(" ");
  } else {
    action = "show";
  }
  const match = telegramRoomMatch(config, query);
  if (!match) {
    return {
      command: "room",
      reply: `No matching Agent Bus room for: ${query || rest}`
    };
  }
  const room = readSnapshot(config, "rooms", match.id) || match;
  if (action === "pause" || action === "wake" || action === "resume") {
    return {
      command: "room",
      reply: "Room action buttons require the Python central runtime. This Node central can inspect room snapshots only.\n" + telegramRoomDetailText(room),
      room: telegramRoomSummary(room)
    };
  }
  return {
    command: "room",
    reply: telegramRoomDetailText(room),
    room: telegramRoomSummary(room)
  };
}

function telegramRoomNewCommand(config, chatId, goal = "") {
  const draft = telegramRoomDraft(config, chatId);
  draft.agents ||= [];
  draft.max_steps ||= 5;
  writeTelegramRoomDraft(config, chatId, draft);
  if (String(goal || "").trim()) return telegramRoomStartCommand(config, chatId, goal);
  return { command: "room_draft", reply: telegramRoomDraftText(draft) };
}

function telegramRoomAgentCommand(config, chatId, parts = []) {
  const draft = telegramRoomDraft(config, chatId);
  const args = parts.map((item) => String(item || "").trim()).filter(Boolean);
  const action = String(args[0] || "").toLowerCase();
  if (["clear", "auto"].includes(action)) {
    draft.agents = [];
  } else if (["toggle", "pick"].includes(action)) {
    const values = validateAgentIds(args.slice(1));
    const current = [...(draft.agents || [])];
    for (const item of values) {
      const index = current.indexOf(item);
      if (index === -1) current.push(item);
      else current.splice(index, 1);
    }
    draft.agents = current;
  } else if (["add", "+"].includes(action)) {
    const current = [...(draft.agents || [])];
    for (const item of validateAgentIds(args.slice(1))) {
      if (!current.includes(item)) current.push(item);
    }
    draft.agents = current;
  } else {
    draft.agents = validateAgentIds(args);
  }
  writeTelegramRoomDraft(config, chatId, draft);
  return { command: "room_draft", reply: telegramRoomDraftText(draft) };
}

function telegramRoomStepsCommand(config, chatId, parts = []) {
  const draft = telegramRoomDraft(config, chatId);
  const steps = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(steps)) {
    return { command: "room_draft", reply: `Usage: /room steps <1-100>\n${telegramRoomDraftText(draft)}` };
  }
  draft.max_steps = Math.max(1, Math.min(steps, 100));
  writeTelegramRoomDraft(config, chatId, draft);
  return { command: "room_draft", reply: telegramRoomDraftText(draft) };
}

function telegramRoomStartCommand(config, chatId, goal) {
  const draft = telegramRoomDraft(config, chatId);
  if (!String(goal || "").trim()) return { command: "room_draft", reply: telegramRoomDraftText(draft) };
  return {
    command: "room_draft",
    reply: "Room creation from Telegram requires the Python central runtime. The draft is saved; run this command against a Python central or create the room from the CLI/web console."
  };
}

function telegramRoomDetailText(room) {
  const summary = telegramRoomSummary(room);
  const agents = (summary.agents || []).join(", ") || "auto";
  const steps = `${summary.steps || 0}/${summary.max_steps || "unlimited"}`;
  const lines = [
    "Agent Bus room",
    `Room: ${summary.id || ""}`,
    `Title: ${summary.title || "untitled"}`,
    `Status: ${summary.status || "unknown"}`,
    `Agents: ${agents}`,
    `Steps: ${steps}`,
    `Messages: ${summary.message_count || 0}`,
    `Reports: ${summary.report_count || 0}`
  ];
  const reports = room.reports || [];
  const latest = String(reports.at(-1)?.content || reports.at(-1)?.summary || "").trim();
  if (latest) lines.push("Latest report:", latest.slice(0, 800));
  return lines.join("\n");
}

function telegramRunCommand(config, rest) {
  const [agentId = "", ...messageParts] = String(rest || "").trim().split(/\s+/);
  const message = messageParts.join(" ").trim();
  if (!agentId || !message) return { command: "run", reply: "Usage: /run <agent-id> <task>" };
  const thread = createThread(config, {
    message,
    agents: [agentId],
    mode: "orchestrate",
    source: "telegram"
  });
  const runIds = (thread.runs || []).map((run) => run.id).filter(Boolean);
  return {
    command: "run",
    reply: `Queued ${thread.id} for ${agentId}.\nRuns: ${runIds.join(", ") || "none"}`,
    thread: {
      id: thread.id,
      trace_id: thread.trace_id,
      runs: runIds
    }
  };
}

function telegramNotificationText(event, payload) {
  if (event === "central.started") {
    return `Agent Bus central started\nGateway: ${payload.gateway || ""}\nRuntime: ${payload.runtime || ""}`;
  }
  if (event === "edge.registered") {
    return `Agent Bus edge registered\nNode: ${payload.node_id || ""}\nAgents: ${(payload.agents || []).join(", ") || "none"}`;
  }
  if (event === "run.completed" || event === "run.failed") {
    return `Agent Bus run ${payload.status || event}\nRun: ${payload.run_id || ""}\nAgent: ${payload.agent_id || ""}\nNode: ${payload.node_id || ""}`;
  }
  if (event === "room.completed") {
    return `Agent Bus room completed\nRoom: ${payload.room_id || ""}\nTitle: ${payload.title || ""}\nReports: ${payload.reports || 0}`;
  }
  if (event === "telegram.test") {
    return `Agent Bus Telegram test\n${payload.message || ""}\nGateway: ${payload.gateway || ""}`;
  }
  if (event === "telegram.command") {
    return String(payload.reply || "Agent Bus Telegram command completed.");
  }
  return `Agent Bus event: ${event}\n${JSON.stringify(payload)}`;
}

function sendTelegramNotification(config, plugin, token, chatId, text, replyMarkup = null) {
  const timeoutMs = Math.max(1000, Math.min(Number(plugin.timeoutSeconds || 5) * 1000, 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    disable_web_page_preview: "true"
  });
  if (replyMarkup) body.set("reply_markup", JSON.stringify(replyMarkup));
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: controller.signal
  }).then((res) => {
    clearTimeout(timer);
    appendJsonl(config, "notifications.jsonl", {
      at: new Date().toISOString(),
      plugin: "telegramBot",
      event: res.ok ? "send.completed" : "send.failed",
      status: res.ok ? "completed" : "failed",
      http_status: res.status
    });
  }).catch((err) => {
    clearTimeout(timer);
    appendJsonl(config, "notifications.jsonl", {
      at: new Date().toISOString(),
      plugin: "telegramBot",
      event: "send.failed",
      status: "failed",
      error: err.message || String(err)
    });
  });
}

function sendTelegramCallbackAnswer(config, plugin, token, callbackQueryId) {
  const timeoutMs = Math.max(1000, Math.min(Number(plugin.timeoutSeconds || 5) * 1000, 30000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const body = new URLSearchParams({
    callback_query_id: callbackQueryId,
    text: "Agent Bus command received.",
    cache_time: "1"
  });
  fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: controller.signal
  }).then((res) => {
    clearTimeout(timer);
    appendJsonl(config, "notifications.jsonl", {
      at: new Date().toISOString(),
      plugin: "telegramBot",
      event: res.ok ? "telegram.callback_answer.completed" : "telegram.callback_answer.failed",
      status: res.ok ? "completed" : "failed",
      http_status: res.status
    });
  }).catch((err) => {
    clearTimeout(timer);
    appendJsonl(config, "notifications.jsonl", {
      at: new Date().toISOString(),
      plugin: "telegramBot",
      event: "telegram.callback_answer.failed",
      status: "failed",
      error: err.message || String(err)
    });
  });
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

function readSnapshots(config, folder) {
  const dir = path.join(config.dataDir, folder);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))];
      } catch {
        return [];
      }
    });
}

function readJsonl(config, fileName) {
  const file = path.join(config.dataDir, fileName);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function traceLookup(config, traceId) {
  const id = sanitizeTraceId(traceId);
  if (!id) {
    const err = new Error("trace_id is required");
    err.statusCode = 400;
    throw err;
  }
  const threads = readSnapshots(config, "threads").filter((item) => objectHasTrace(item, id));
  const rooms = readSnapshots(config, "rooms").filter((item) => objectHasTrace(item, id));
  const runs = readSnapshots(config, "runs").filter((item) => objectHasTrace(item, id));
  const events = readJsonl(config, "events.jsonl").filter((item) => objectHasTrace(item, id));
  if (!threads.length && !rooms.length && !runs.length && !events.length) {
    const err = new Error("trace not found");
    err.statusCode = 404;
    throw err;
  }
  return {
    trace_id: id,
    summary: {
      threads: threads.length,
      rooms: rooms.length,
      runs: runs.length,
      events: events.length,
      agents: [...new Set(runs.map((item) => item.agent_id).filter(Boolean))].sort(),
      nodes: [...new Set(runs.map((item) => item.node_id).filter(Boolean))].sort(),
      statuses: [...new Set(runs.map((item) => item.status).filter(Boolean))].sort()
    },
    threads: threads.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))),
    rooms: rooms.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))),
    runs: runs.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || ""))),
    events: events.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))
  };
}

function objectHasTrace(value, traceId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (sanitizeTraceId(value.trace_id || value.traceId) === traceId) return true;
  for (const key of ["runs", "events", "messages", "reports", "conversation", "reminders"]) {
    if (Array.isArray(value[key]) && value[key].some((item) => objectHasTrace(item, traceId))) return true;
  }
  if (value.blackboard && typeof value.blackboard === "object" && !Array.isArray(value.blackboard)) {
    for (const item of Object.values(value.blackboard)) {
      if (Array.isArray(item) && item.some((entry) => objectHasTrace(entry, traceId))) return true;
    }
  }
  return false;
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
