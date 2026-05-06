import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-room-demo-"));

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
  const python = findPython();
  if (!python) throw new Error("Room demo requires Python 3.10+ for the room gateway.");

  const port = await freePort();
  const token = "sk-local-room-demo-token-000000";
  const gateway = `http://127.0.0.1:${port}`;
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "room-demo-agent.mjs");
  const reportPath = uniqueOutputPath(path.join(process.cwd(), "agent-bus-room-demo-report.md"));

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 2500
    },
    modelRouter: {
      enabled: false,
      backends: []
    }
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, `const id = process.env.AGENT_ID || "demo-agent";\nif (id === "demo-planner") {\n  console.log("REPORT: Planner split the demo goal and delegated verification to demo-worker.");\n  console.log("BLACKBOARD: demo-worker should verify room directives and reports-only export.");\n  console.log("@demo-worker: Verify the room directive flow, write a concise public report, and mark DONE if complete.");\n} else {\n  console.log("REPORT: Worker verified AI-to-AI room delegation, REPORT capture, BLACKBOARD notes, and safe reports-only export without model calls.");\n  console.log("BLACKBOARD: Local demo completed with no external model quota; share the generated Markdown report.");\n  console.log("DONE");\n}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "room-demo-edge",
    gatewayUrl: gateway,
    token,
    pollTimeoutMs: 2500,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [
      {
        id: "demo-planner",
        kind: "demo",
        role: "planner",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "planning", "demo"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      },
      {
        id: "demo-worker",
        kind: "demo",
        role: "executor",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "verification", "demo"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      }
    ]
  }, null, 2)}\n`);

  console.log("Agent Bus local AI-to-AI room demo");
  console.log("1. Starting a private local gateway");
  start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`);

  console.log("2. Starting a local edge node with two demo agents");
  start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  await waitForAgents(gateway, token, ["demo-planner", "demo-worker"]);

  console.log("3. Creating a room and waking demo-planner");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Local AI-to-AI room demo",
      goal: "Show one agent delegating to another in a shared Agent Bus room, then export a share-safe report.",
      agents: ["demo-planner", "demo-worker"],
      wakeAgents: ["demo-planner"],
      auto_rotate: false,
      max_steps: 4
    })
  });

  const completed = await waitForRoomComplete(gateway, token, room.id);
  console.log(`4. Room completed: ${completed.id}`);
  for (const report of completed.reports || []) {
    console.log(`   REPORT from ${report.speaker}: ${report.content}`);
  }

  console.log("5. Exporting reports-only Markdown");
  await runCli(["room", "export", completed.id, "--reports-only", "--out", reportPath, "--gateway", gateway, "--token", token]);
  console.log(`   wrote ${reportPath}`);
  console.log("Demo complete. Share the Markdown report; it omits full prompts/messages by default.");
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
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

function runCli(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      env: { ...process.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(new Error(`agent-bus ${args.join(" ")} exited with ${code}\n${stderr || stdout}`));
    });
  });
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
    await delay(250);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId}`);
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

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
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
  const candidates = [process.env.PYTHON, "python3", "python"].filter(Boolean);
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

function uniqueOutputPath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  const parsed = path.parse(basePath);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused report path near ${basePath}`);
}

function quoteCommandArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}
