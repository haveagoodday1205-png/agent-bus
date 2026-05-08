#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-edge-token-api-"));
const children = [];
const childLogs = new WeakMap();

main().catch((err) => {
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
  if (!python) throw new Error("edge token API smoke requires Python 3.10+ for Python central coverage.");

  const results = [];
  results.push(await centralSmoke({
    runtime: "python",
    command: python,
    argsForConfig: (configPath) => [path.join(root, "central_gateway.py")]
  }));
  results.push(await centralSmoke({
    runtime: "node",
    command: process.execPath,
    argsForConfig: (configPath) => [path.join(root, "central-gateway.mjs"), "serve", "--config", configPath]
  }));

  const result = {
    ok: true,
    quota: "no_model_calls",
    runtimes: results
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("edge token API smoke ok");
  }
}

async function centralSmoke({ runtime, command, argsForConfig }) {
  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const dataDir = path.join(tempDir, `${runtime}-data`);
  const configPath = path.join(tempDir, `${runtime}.central.config.json`);
  const adminToken = `sk-${runtime}-edge-token-api-smoke-000000`;
  fs.writeFileSync(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    gatewayUrl: gateway,
    dataDir,
    token: adminToken,
    defaults: { mode: "orchestrate", pollTimeoutMs: 1000 },
    edgeTokens: [],
    modelRouter: { enabled: false, agentModels: true, backends: [] }
  }, null, 2)}\n`);

  const central = start(command, argsForConfig(configPath), {
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_TOKEN: adminToken,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir,
    AGENT_BUS_GATEWAY_URL: gateway
  });
  await waitForJson(`${gateway}/health`, 30000, central);

  const created = await requestJson(`${gateway}/v1/agent-bus/edge-tokens`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({ label: "web-console-smoke" })
  });
  assert(created.ok === true, `${runtime} central did not report edge token creation ok`);
  assert(String(created.token || "").startsWith("abt_edge_"), `${runtime} central did not return the raw edge token once`);
  assert(created.edgeToken?.id, `${runtime} central did not return public edge token metadata`);
  assert(created.edgeToken?.label === "web-console-smoke", `${runtime} central did not persist the edge token label`);

  const joinCommand = edgeJoinCommand(gateway, created.token);
  assert(joinCommand.includes(`--gateway ${gateway}`), `${runtime} join command missing gateway`);
  assert(joinCommand.includes(`--token ${created.token}`), `${runtime} join command missing raw edge token`);

  const tokens = await requestJson(`${gateway}/v1/agent-bus/edge-tokens`, {
    headers: authHeaders(adminToken)
  });
  assert(Array.isArray(tokens), `${runtime} central did not list edge token metadata`);
  assert(tokens.some((item) => item.id === created.edgeToken.id && item.status === "active"), `${runtime} token list did not include the created active token`);
  assert(!JSON.stringify(tokens).includes(created.token), `${runtime} token list leaked the raw edge token`);

  const edgeListStatus = await requestStatus(`${gateway}/v1/agent-bus/edge-tokens`, {
    headers: authHeaders(created.token)
  });
  assert(edgeListStatus === 401, `${runtime} edge token could list admin edge-token metadata: ${edgeListStatus}`);

  const revoked = await requestJson(`${gateway}/v1/agent-bus/edge-tokens/revoke`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({ id: created.edgeToken.id })
  });
  assert(revoked.ok === true, `${runtime} central did not report edge token revoke ok`);
  assert(revoked.edgeToken?.status === "revoked", `${runtime} central did not mark the edge token revoked`);
  const tokensAfterRevoke = await requestJson(`${gateway}/v1/agent-bus/edge-tokens`, {
    headers: authHeaders(adminToken)
  });
  assert(tokensAfterRevoke.some((item) => item.id === created.edgeToken.id && item.status === "revoked"), `${runtime} token list did not keep revoked metadata`);
  assert(!JSON.stringify(tokensAfterRevoke).includes(created.token), `${runtime} token list leaked the raw edge token after revoke`);

  const pair = await requestJson(`${gateway}/v1/agent-bus/pair-codes`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({
      gatewayUrl: gateway,
      ttlSeconds: 600,
      label: "web-console-pair-smoke",
      agentPreset: "echo"
    })
  });
  assert(pair.ok === true, `${runtime} central did not report pair code creation ok`);
  assert(/^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/.test(pair.code || ""), `${runtime} central returned an invalid pair code`);
  assert(pair.agentPreset === "echo", `${runtime} central did not return pair preset`);
  const pairCommand = pairJoinCommand(gateway, pair);
  assert(pairCommand.includes(`--gateway ${gateway}`), `${runtime} pair command missing gateway`);
  assert(pairCommand.includes(`--code ${pair.code}`), `${runtime} pair command missing code`);
  assert(pairCommand.includes("--preset echo"), `${runtime} pair command missing preset`);

  const redeemed = await requestJson(`${gateway}/edge/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pair.code, nodeId: `${runtime}-pair-edge` })
  });
  assert(redeemed.ok === true, `${runtime} central did not redeem pair code`);
  assert(String(redeemed.token || "").startsWith("abt_edge_"), `${runtime} central did not return a scoped edge token from pair redemption`);
  assert(redeemed.tokenScope === "edge", `${runtime} pair redemption token scope was not edge`);
  assert(redeemed.agentPreset === "echo", `${runtime} pair redemption did not preserve preset`);
  const secondRedeemStatus = await requestStatus(`${gateway}/edge/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: pair.code, nodeId: `${runtime}-pair-edge-2` })
  });
  assert(secondRedeemStatus === 404, `${runtime} pair code could be redeemed twice: ${secondRedeemStatus}`);

  if (!central.killed) central.kill("SIGTERM");
  await waitForExit(central);
  return {
    runtime,
    gateway,
    token_id: created.edgeToken.id,
    token_prefix: created.token.slice(0, 12),
    command: joinCommand.replace(created.token, "abt_edge_..."),
    pair_command: pairCommand.replace(pair.code, "ABCD-2345"),
    pair_redeemed_token_prefix: redeemed.token.slice(0, 12)
  };
}

function edgeJoinCommand(gateway, token) {
  return `agent-bus setup edge --gateway ${gateway.replace(/\/$/, "")} --token ${token} --auto --service auto --out edge.config.json`;
}

function pairJoinCommand(gateway, data = {}) {
  const preset = data.agentPreset ? ` --preset ${data.agentPreset}` : "";
  return `agent-bus setup edge --gateway ${gateway.replace(/\/$/, "")} --code ${data.code}${preset} --auto --service auto --out edge.config.json`;
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = { command, args, stdout: "", stderr: "", exit: null, error: "" };
  childLogs.set(child, logs);
  child.stdout.on("data", (chunk) => {
    logs.stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    logs.stderr += chunk.toString("utf8");
  });
  child.on("error", (err) => {
    logs.error = err.message;
  });
  child.on("exit", (code, signal) => {
    logs.exit = { code, signal };
  });
  children.push(child);
  return child;
}

async function waitForJson(url, timeoutMs, child) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) throw new Error(`Process exited before ${url} became ready.\n${formatChildDiagnostics(child)}`);
    try {
      return await requestJson(url);
    } catch (err) {
      lastError = err;
      await delay(200);
    }
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "no response"}\n${child ? formatChildDiagnostics(child) : ""}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function requestStatus(url, options = {}) {
  const res = await fetch(url, options);
  await res.arrayBuffer();
  return res.status;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
}

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!result.error && result.status === 0) return candidate;
  }
  return "";
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

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function childFailed(child) {
  return child.exitCode !== null || child.signalCode || childLogs.get(child)?.error;
}

function formatChildDiagnostics(child) {
  const logs = childLogs.get(child) || {};
  return [
    `${logs.command || "process"} ${(logs.args || []).join(" ")}`,
    logs.exit ? `exit=${JSON.stringify(logs.exit)}` : "",
    logs.error ? `error=${logs.error}` : "",
    logs.stdout ? `stdout:\n${logs.stdout.slice(-3000)}` : "",
    logs.stderr ? `stderr:\n${logs.stderr.slice(-3000)}` : ""
  ].filter(Boolean).join("\n");
}

function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of ["AGENT_BUS_GATEWAY_URL", "AGENT_BUS_TOKEN", "AGENT_BUS_CONFIG", "AGENT_BUS_HOST", "AGENT_BUS_PORT", "AGENT_BUS_DATA_DIR"]) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
