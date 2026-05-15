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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-node-poll-disconnect-"));
  const dataDir = path.join(tempDir, "data");
  const configPath = path.join(tempDir, "central.config.json");
  const token = "node-poll-disconnect-token";
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  fs.writeFileSync(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    token,
    dataDir,
    defaults: { pollTimeoutMs: 5000 }
  }, null, 2)}\n`);

  const central = spawn(process.execPath, ["central-gateway.mjs", "serve", "--config", configPath], {
    cwd: root,
    windowsHide: true,
    env: cleanEnv()
  });
  let stderr = "";
  central.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

  try {
    await waitForHealth(base);
    await requestJson(`${base}/edge/register`, {
      method: "POST",
      token,
      body: {
        node_id: "node-poll-disconnect-node",
        edge_session_id: "edge_session_node_poll_disconnect_1",
        agents: [{ id: "node-poll-disconnect-agent", kind: "smoke", role: "tester", enabled: true, adapter: "echo" }]
      }
    });

    const deadPoll = startRawPoll(base, token);
    await delay(250);
    deadPoll.destroy();
    await delay(250);

    const thread = await requestJson(`${base}/threads`, {
      method: "POST",
      token,
      body: {
        message: "node poll disconnect smoke task",
        agents: ["node-poll-disconnect-agent"]
      }
    });
    const runId = thread.runs?.[0]?.id;
    assert(runId, "thread did not create a run");

    const poll = await requestJson(`${base}/edge/poll`, {
      method: "POST",
      token,
      body: {
        node_id: "node-poll-disconnect-node",
        edge_session_id: "edge_session_node_poll_disconnect_2",
        timeout_ms: 3000,
        agents: [{ id: "node-poll-disconnect-agent", kind: "smoke", role: "tester", enabled: true, adapter: "echo" }]
      }
    });
    assert(poll.type === "task", `second poll did not receive queued task: ${JSON.stringify(poll)}`);
    assert(poll.task?.run_id === runId, "second poll received the wrong run id");

    console.log(JSON.stringify({
      ok: true,
      quota: "no_model_calls",
      run_id: runId,
      dead_poll_requeued: true,
      stderr: stderr.trim().slice(0, 300)
    }, null, 2));
  } finally {
    deadKill(central);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function startRawPoll(base, token) {
  const url = new URL("/edge/poll", base);
  const body = JSON.stringify({
    node_id: "node-poll-disconnect-node",
    edge_session_id: "edge_session_node_poll_disconnect_dead",
    timeout_ms: 5000,
    agents: [{ id: "node-poll-disconnect-agent", kind: "smoke", role: "tester", enabled: true, adapter: "echo" }]
  });
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body)
    }
  }, (res) => {
    res.resume();
  });
  req.on("error", () => {});
  req.write(body);
  req.end();
  return req;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text}`);
  return data;
}

async function waitForHealth(base) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const health = await requestJson(`${base}/health`);
      if (health.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Node central did not become healthy");
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadKill(child) {
  if (!child || child.killed) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL");
  }, 1000).unref?.();
}

function cleanEnv() {
  const env = { ...process.env };
  for (const name of ["AGENT_BUS_GATEWAY_URL", "AGENT_BUS_TOKEN", "AGENT_BUS_NODE_ID", "AGENT_BUS_CONFIG", "AGENT_BUS_HOST", "AGENT_BUS_PORT", "AGENT_BUS_DATA_DIR"]) {
    delete env[name];
  }
  return env;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
