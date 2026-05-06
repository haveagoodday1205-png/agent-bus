import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const node = process.execPath;
const root = path.resolve(import.meta.dirname, "..");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-demo-"));
const token = "sk-local-demo-token-000000000000";
const gateway = "http://127.0.0.1:8788";

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
}).finally(() => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port: 8788,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 2500
    }
  }, null, 2)}\n`);

  console.log("1. Starting local Agent Bus central gateway");
  start(["central-gateway.mjs", "serve", "--config", centralConfig], {
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: "8788"
  });
  await waitForJson(`${gateway}/health`);

  console.log("2. Creating a one-time pair code");
  const pairCreated = await runNode(["agent-bus.mjs", "pair", "create", "--gateway", gateway, "--token", token, "--preset", "echo", "--ttl", "120"]);
  const pair = JSON.parse(pairCreated.stdout);
  console.log(`   pair code: ${pair.code}`);

  console.log("3. Joining an edge node with the pair code");
  await runNode(["agent-bus.mjs", "pair", "join", "--gateway", gateway, "--code", pair.code, "--out", edgeConfig, "--node-id", "demo-edge"]);

  console.log("4. Starting the paired edge node");
  start(["edge-node.mjs", "connect", "--config", edgeConfig], {});
  await waitForAgent("local-echo");

  console.log("5. Sending a task to the remote assistant node");
  const thread = await requestJson(`${gateway}/threads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      message: "Hello from a local AI-to-AI bus demo.",
      agents: ["local-echo"]
    })
  });
  const completed = await waitForThread(thread.id);
  const run = completed.runs?.[0] || {};
  console.log(`6. Result from ${run.agent_id}: ${String(run.summary || run.stdout || "").trim()}`);
  console.log("Demo complete.");
}

function start(args, env = {}) {
  const child = spawn(node, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (/listening|connected/.test(text)) process.stdout.write(`   ${text}`);
  });
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  procs.push(child);
  return child;
}

function runNode(args, env = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, {
      cwd: root,
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

async function waitForAgent(agentId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await requestJson(`${gateway}/agents`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (agents.some((agent) => agent.id === agentId)) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${agentId}`);
}

async function waitForThread(threadId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const thread = await requestJson(`${gateway}/threads/${threadId}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    const runs = thread.runs || [];
    if (runs.length && runs.every((run) => ["completed", "complete", "failed", "error"].includes(run.status))) {
      return thread;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for thread ${threadId}`);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
