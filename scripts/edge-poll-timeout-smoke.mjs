import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-edge-poll-timeout-"));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const configPath = path.join(tempDir, "edge.config.json");
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/edge/register") {
      req.resume();
      sendJson(res, { ok: true, node_id: "timeout-node" });
      return;
    }
    if (req.method === "POST" && req.url === "/edge/poll") {
      req.resume();
      return;
    }
    sendJson(res, { error: "not_found" }, 404);
  });

  await listen(server, port);
  fs.writeFileSync(configPath, `${JSON.stringify({
    nodeId: "timeout-node",
    gatewayUrl: base,
    token: "timeout-token",
    pollTimeoutMs: 100,
    pollRequestGraceMs: 100,
    requestTimeoutMs: 1000,
    idleDelayMs: 10,
    dataDir: path.join(tempDir, "edge-data"),
    agents: [{ id: "timeout-agent", adapter: "echo", enabled: true }]
  }, null, 2)}\n`);

  let child;
  try {
    const started = Date.now();
    child = spawn(process.execPath, ["edge-node.mjs", "connect", "--once", "--config", configPath], {
      cwd: root,
      windowsHide: true,
      env: cleanEnv()
    });
    const result = await waitForExit(child, 5000);
    const elapsedMs = Date.now() - started;
    assert(result.code !== 0, `edge-node unexpectedly exited successfully: stdout=${result.stdout}`);
    assert(/timed out after \d+ms/.test(result.stderr), `edge-node did not report request timeout: ${result.stderr}`);
    assert(elapsedMs < 4500, `edge-node did not fail fast enough: ${elapsedMs}ms`);

    console.log(JSON.stringify({
      ok: true,
      quota: "no_model_calls",
      elapsed_ms: elapsedMs,
      timeout_reported: true
    }, null, 2));
  } finally {
    if (child && !child.killed) child.kill("SIGTERM");
    await closeServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(value)}\n`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`edge-node did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const name of [
    "AGENT_BUS_GATEWAY_URL",
    "AGENT_BUS_TOKEN",
    "AGENT_BUS_NODE_ID",
    "AGENT_BUS_CONFIG",
    "AGENT_BUS_HOST",
    "AGENT_BUS_PORT",
    "AGENT_BUS_DATA_DIR",
    "AGENT_BUS_COMPLETION_OUTBOX_DIR"
  ]) {
    delete env[name];
  }
  return env;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
