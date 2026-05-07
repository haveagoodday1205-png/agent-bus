import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-room-stale-smoke-"));

main().catch((err) => {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}).finally(() => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const python = findPython();
  if (!python) throw new Error("stale room smoke requires Python 3.10+ for the room gateway.");

  const port = await freePort();
  const token = "sk-stale-room-smoke-token-000000";
  const gateway = `http://127.0.0.1:${port}`;
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "stale-room-agent.mjs");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 500
    },
    modelRouter: {
      enabled: false,
      backends: []
    },
    edgeTokens: [
      {
        token,
        nodeId: "stale-room-edge",
        label: "stale room smoke"
      }
    ]
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, `const id = process.env.AGENT_ID || "";\nif (id === "slow-planner") {\n  await new Promise((resolve) => setTimeout(resolve, 3600));\n  console.log("REPORT: Planner stayed busy past the node stale threshold.");\n  console.log("@slow-worker: Continue after the planner completed a long task.");\n} else {\n  console.log("REPORT: Worker received the delegated room task after the long planner run.");\n  console.log("DONE");\n}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "stale-room-edge",
    gatewayUrl: gateway,
    token,
    pollTimeoutMs: 500,
    idleDelayMs: 50,
    defaultTimeoutMs: 10000,
    runHeartbeatIntervalMs: 400,
    agents: [
      {
        id: "slow-planner",
        kind: "smoke",
        role: "planner",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "stale-regression"],
        runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(agentScript)}`
      },
      {
        id: "slow-worker",
        kind: "smoke",
        role: "worker",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "stale-regression"],
        runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(agentScript)}`
      }
    ]
  }, null, 2)}\n`);

  start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data"),
    AGENT_BUS_NODE_STALE_SECONDS: "2"
  });
  await waitForJson(`${gateway}/health`);

  start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig,
    AGENT_BUS_GATEWAY_URL: gateway,
    AGENT_BUS_TOKEN: token
  });
  await waitForAgents(gateway, token, ["slow-planner", "slow-worker"]);

  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Stale room autonomy smoke",
      goal: "Verify room directives keep flowing when an edge node is busy longer than the stale threshold.",
      agents: ["slow-planner", "slow-worker"],
      wakeAgents: ["slow-planner"],
      auto_rotate: false,
      max_steps: 3
    })
  });

  await waitForRunStatus(gateway, token, room.id, "slow-planner", "running");
  await delay(2200);
  const busyAgents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
  assert(busyAgents.some((agent) => agent.id === "slow-planner" && agent.status === "online"), "busy planner went stale while running");
  assert(busyAgents.some((agent) => agent.id === "slow-worker" && agent.status === "online"), "busy edge node hid peer agents while running");

  const completed = await waitForRoomComplete(gateway, token, room.id);
  assert(completed.status === "completed", "room did not complete");
  assert(completed.runs?.some((run) => run.agent_id === "slow-worker" && run.status === "completed"), "delegated worker run did not complete");
  assert(!completed.reports?.some((item) => /Agent offline or unknown/.test(item.content || "")), "room incorrectly reported an online busy agent as offline");

  const result = {
    ok: true,
    mode: "offline",
    quota: "no_model_calls",
    room_id: completed.id,
    room_status: completed.status,
    run_count: completed.runs?.length || 0
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Agent Bus stale room autonomy smoke passed");
    console.log(`Room: ${result.room_id}`);
    console.log("Quota: no model calls");
  }
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!jsonOut) {
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  procs.push(child);
  return child;
}

async function waitForRunStatus(gateway, token, roomId, agentId, status, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.runs?.some((run) => run.agent_id === agentId && run.status === status)) return room;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${agentId} run status ${status}`);
}

async function waitForAgents(gateway, token, agentIds, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      const online = new Set(agents.filter((agent) => agent.status === "online").map((agent) => agent.id));
      if (agentIds.every((id) => online.has(id))) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(200);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    await delay(200);
  }
  throw new Error(`Timed out waiting for room ${roomId}`);
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await delay(200);
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

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function findPython() {
  const candidates = [
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const command of candidates) {
    try {
      const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
        cwd: root,
        windowsHide: true,
        stdio: "ignore"
      });
      if (result.status === 0) return command;
    } catch {
      // Try the next candidate.
    }
  }
  return "";
}

function commonBundledPythonPaths() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python"),
    path.join(home, ".codex", "runtimes", "codex-primary-runtime", "dependencies", "python")
  ];
  const names = process.platform === "win32"
    ? ["python.exe"]
    : ["bin/python3", "bin/python", "python3", "python"];
  return roots.flatMap((rootDir) => names.map((name) => path.join(rootDir, name)));
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}
