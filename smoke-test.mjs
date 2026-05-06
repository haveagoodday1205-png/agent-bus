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
  assert(paired.token === token, "pair redemption did not return the gateway token");
  assert(paired.agentPreset === "echo", "pair redemption did not preserve the agent preset");

  const cliPairCreate = await runNode(["agent-bus.mjs", "pair", "create", "--gateway", "http://127.0.0.1:8788", "--token", token, "--preset", "echo", "--ttl", "120"]);
  assert(!cliPairCreate.stdout.includes(token), "pair create printed the gateway token");
  const cliPair = JSON.parse(cliPairCreate.stdout);
  const cliOut = path.join(tempDir, "paired-edge.config.json");
  const cliPairJoin = await runNode(["agent-bus.mjs", "pair", "join", "--gateway", "http://127.0.0.1:8788", "--code", cliPair.code, "--out", cliOut]);
  assert(!cliPairJoin.stdout.includes(token), "pair join printed the gateway token");
  const pairedConfig = JSON.parse(fs.readFileSync(cliOut, "utf8"));
  assert(pairedConfig.token === token, "pair join did not write the gateway token");
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
