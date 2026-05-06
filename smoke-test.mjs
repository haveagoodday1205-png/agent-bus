import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const node = process.execPath;
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-smoke-"));
const centralConfig = path.join(tempDir, "central.config.json");

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
}).finally(async () => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const token = "sk-smoke-test-token-000000000000";
  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port: 8788,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 25000
    },
    modelRouter: {
      enabled: true,
      defaultBackend: "mock-local",
      defaultModel: "agent-bus-mock",
      backends: [{
        id: "mock-local",
        enabled: true,
        baseUrl: "http://127.0.0.1:8790/v1",
        models: ["agent-bus-mock"],
        modelAliases: {
          "agent-bus-default": "agent-bus-mock"
        },
        timeoutSeconds: 60
      }]
    }
  }, null, 2)}\n`);
  const mock = start(node, ["mock-openai-backend.mjs"], {
    MOCK_OPENAI_PORT: "8790"
  });
  const central = start(node, ["central-gateway.mjs", "serve", "--config", centralConfig], {
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: "8788"
  });
  await waitForJson("http://127.0.0.1:8788/health");
  const consoleHtml = await requestText("http://127.0.0.1:8788/console/");
  assert(consoleHtml.includes("Agent Bus"), "console HTML did not load");

  const fakeBin = path.join(tempDir, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  createFakeTool(fakeBin, "codex");
  createFakeTool(fakeBin, "hermes");
  const fakeEnv = { PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}` };
  const detected = JSON.parse((await runNode(["agent-bus.mjs", "detect", "--json"], fakeEnv)).stdout);
  assert(detected.tools?.some((tool) => tool.id === "codex" && tool.available), "detect did not find fake codex");
  assert(detected.tools?.some((tool) => tool.id === "hermes" && tool.available), "detect did not find fake hermes");
  const autoOut = path.join(tempDir, "auto-edge.config.json");
  await runNode(["agent-bus.mjs", "init", "edge", "--auto", "--out", autoOut, "--gateway", "http://127.0.0.1:8788", "--token", token], fakeEnv);
  const autoConfig = JSON.parse(fs.readFileSync(autoOut, "utf8"));
  assert(autoConfig.agents?.some((agent) => agent.kind === "codex"), "auto init did not create a Codex agent");
  assert(autoConfig.agents?.some((agent) => agent.kind === "hermes"), "auto init did not create a Hermes agent");
  assert(autoConfig.gatewayUrl === "http://127.0.0.1:8788", "auto init did not apply gateway URL");

  const pair = await requestJson("http://127.0.0.1:8788/pair-codes", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      gatewayUrl: "http://127.0.0.1:8788",
      agentPreset: "echo",
      ttlSeconds: 120
    })
  });
  assert(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pair.code), "pair code was not generated");

  const paired = await requestJson("http://127.0.0.1:8788/edge/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: pair.code,
      nodeId: "smoke-node"
    })
  });
  assert(paired.token && paired.token !== token, "pair redemption did not return a scoped edge token");
  assert(paired.tokenScope === "edge", "pair redemption did not mark the token as edge-scoped");
  assert(paired.agentPreset === "echo", "pair redemption did not preserve the agent preset");
  const edgeManifest = await requestJson("http://127.0.0.1:8788/v1/agent-bus/manifest", {
    headers: { authorization: `Bearer ${paired.token}` }
  });
  assert(edgeManifest.protocol === "agent-bus.v1", "edge token could not read the manifest");
  await assertRequestFails("edge token cannot create threads", () => requestJson("http://127.0.0.1:8788/threads", {
    method: "POST",
    headers: {
      authorization: `Bearer ${paired.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ message: "should be forbidden", agents: ["local-echo"] })
  }));
  const manualEdge = await requestJson("http://127.0.0.1:8788/edge/tokens", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ nodeId: "manual-smoke-node", label: "manual-smoke" })
  });
  assert(manualEdge.token?.startsWith("abt_edge_"), "manual edge token was not returned once");
  assert(manualEdge.edgeToken?.id, "manual edge token metadata is missing an id");
  const edgeTokens = await requestJson("http://127.0.0.1:8788/edge/tokens", {
    headers: { authorization: `Bearer ${token}` }
  });
  assert(edgeTokens.some((item) => item.id === manualEdge.edgeToken.id && item.status === "active"), "manual edge token was not listed as active");
  assert(!JSON.stringify(edgeTokens).includes("token_hash"), "edge token list exposed token hashes");
  const manualManifest = await requestJson("http://127.0.0.1:8788/v1/agent-bus/manifest", {
    headers: { authorization: `Bearer ${manualEdge.token}` }
  });
  assert(manualManifest.protocol === "agent-bus.v1", "manual edge token could not read the manifest");
  const revoked = await requestJson("http://127.0.0.1:8788/edge/tokens/revoke", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ id: manualEdge.edgeToken.id })
  });
  assert(revoked.edgeToken?.status === "revoked", "manual edge token was not revoked");
  await assertRequestFails("revoked edge token cannot read manifest", () => requestJson("http://127.0.0.1:8788/v1/agent-bus/manifest", {
    headers: { authorization: `Bearer ${manualEdge.token}` }
  }));

  const cliPairCreate = await runNode(["agent-bus.mjs", "pair", "create", "--gateway", "http://127.0.0.1:8788", "--token", token, "--preset", "echo", "--ttl", "120"]);
  assert(!cliPairCreate.stdout.includes(token), "pair create printed the gateway token");
  const cliPair = JSON.parse(cliPairCreate.stdout);
  const cliOut = path.join(tempDir, "paired-edge.config.json");
  const cliPairJoin = await runNode(["agent-bus.mjs", "pair", "join", "--gateway", "http://127.0.0.1:8788", "--code", cliPair.code, "--out", cliOut]);
  assert(!cliPairJoin.stdout.includes(token), "pair join printed the gateway token");
  const pairedConfig = JSON.parse(fs.readFileSync(cliOut, "utf8"));
  assert(pairedConfig.token && pairedConfig.token !== token, "pair join did not write a scoped edge token");
  assert(pairedConfig.tokenScope === "edge", "pair join did not write tokenScope=edge");
  assert(pairedConfig.gatewayUrl === "http://127.0.0.1:8788", "pair join wrote the wrong gateway URL");
  assert(pairedConfig.agents?.[0]?.adapter === "echo", "pair join did not use the echo preset");

  const models = await requestJson("http://127.0.0.1:8788/v1/models", {
    headers: { authorization: `Bearer ${token}` }
  });
  assert(models.data?.some((model) => model.id === "agent-bus-default"), "agent-bus-default model alias is missing");

  const chat = await requestJson("http://127.0.0.1:8788/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "agent-bus-default",
      messages: [{ role: "user", content: "hello smoke test" }]
    })
  });
  assert(chat.choices?.[0]?.message?.content === "mock: hello smoke test", "chat completion did not route through mock backend");

  const envDumpScript = path.join(tempDir, "env-dump.mjs");
  fs.writeFileSync(envDumpScript, `const keys = ["AGENT_MESSAGE", "AGENT_RUN_ID", "AGENT_THREAD_ID", "AGENT_ROOM_ID", "AGENT_CACHE_KEY", "AGENT_SESSION_ID", "AGENT_ID", "EDGE_NODE_ID"];\nconsole.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] || ""]))));\n`);
  const edgeConfig = path.join(tempDir, "edge-env.config.json");
  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "env-smoke-node",
    gatewayUrl: "http://127.0.0.1:8788",
    token,
    pollTimeoutMs: 25000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "env-agent",
      kind: "test",
      role: "worker",
      enabled: true,
      adapter: "command",
      capabilities: ["test"],
      runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(envDumpScript)}`
    }]
  }, null, 2)}\n`);
  const edge = start(node, ["edge-node.mjs", "connect", "--config", edgeConfig, "--once"]);
  await waitForAgent("env-agent", token);
  const envThread = await requestJson("http://127.0.0.1:8788/threads", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      message: "check cache env",
      agents: ["env-agent"],
      mode: "broadcast"
    })
  });
  const envRun = await waitForRun(envThread.runs?.[0]?.id, token);
  assert(envRun.status === "completed", "edge env smoke run did not complete");
  const envOut = JSON.parse(envRun.stdout.trim());
  assert(envOut.AGENT_MESSAGE === "check cache env", "edge env did not include AGENT_MESSAGE");
  assert(envOut.AGENT_RUN_ID === envRun.id, "edge env did not include AGENT_RUN_ID");
  assert(envOut.AGENT_THREAD_ID === envThread.id, "edge env did not include AGENT_THREAD_ID");
  assert(envOut.AGENT_ROOM_ID === "", "edge env should leave AGENT_ROOM_ID empty for normal threads");
  assert(envOut.AGENT_ID === "env-agent", "edge env did not include AGENT_ID");
  assert(envOut.EDGE_NODE_ID === "env-smoke-node", "edge env did not include EDGE_NODE_ID");
  assert(envOut.AGENT_CACHE_KEY === `agent-bus-env-agent-${envThread.id}`, "edge env did not build a stable AGENT_CACHE_KEY");
  assert(envOut.AGENT_SESSION_ID === envOut.AGENT_CACHE_KEY, "edge env did not mirror cache key as session id");
  if (!edge.killed) edge.kill("SIGTERM");

  const proxy = start(node, ["windows-openai-proxy.mjs"], {
    AGENT_BUS_UPSTREAM: "http://127.0.0.1:8788",
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_WINDOWS_PORT: "8789"
  });
  await waitForJson("http://127.0.0.1:8789/v1/models");

  const proxied = await requestJson("http://127.0.0.1:8789/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "agent-bus-default",
      messages: [{ role: "user", content: "hello windows proxy" }]
    })
  });
  assert(proxied.choices?.[0]?.message?.content === "mock: hello windows proxy", "Windows proxy did not forward chat completion");

  console.log("smoke test passed");

  proxy.kill("SIGTERM");
  central.kill("SIGTERM");
  mock.kill("SIGTERM");
}

function start(cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code, signal) => {
    if (code && !child.killed) console.error(`${args[0]} exited with ${code || signal}`);
  });
  procs.push(child);
  return child;
}

function createFakeTool(dir, name) {
  const shellPath = path.join(dir, name);
  fs.writeFileSync(shellPath, `#!/usr/bin/env sh\necho "${name} fake 0.0.0"\n`);
  fs.chmodSync(shellPath, 0o755);
  const cmdPath = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(cmdPath, `@echo off\r\necho ${name} fake 0.0.0\r\n`);
}

function runNode(args, env = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${args.join(" ")} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(`${args.join(" ")} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForAgent(agentId, token, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const agents = await requestJson("http://127.0.0.1:8788/agents", {
      headers: { authorization: `Bearer ${token}` }
    });
    if (agents.some((agent) => agent.id === agentId)) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for agent ${agentId}`);
}

async function waitForRun(runId, token, timeoutMs = 15000) {
  assert(runId, "missing run id");
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await requestJson(`http://127.0.0.1:8788/runs/${runId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (["completed", "failed", "error"].includes(run.status)) return run;
    await delay(250);
  }
  throw new Error(`Timed out waiting for run ${runId}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function requestText(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertRequestFails(name, fn) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`${name} unexpectedly succeeded`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}
