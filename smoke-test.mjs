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
  const token = "smoke-test-token";
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
