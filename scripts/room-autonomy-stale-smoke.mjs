import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-room-stale-smoke-"));
const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];

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
    AGENT_BUS_NODE_STALE_SECONDS: "3"
  });
  await waitForJson(`${gateway}/health`);

  await requestJson(`${gateway}/edge/register`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "threshold-status-node",
      hostname: "threshold-status-smoke",
      agents: [{ id: "threshold-status-agent", kind: "smoke", role: "worker" }]
    })
  });
  await delay(1700);
  const thresholdStatus = await runCliJson(["status", "--json", "--gateway", gateway, "--token", token, "--stale-seconds", "1"]);
  assert(thresholdStatus.nodes?.some((node) => node.id === "threshold-status-node" && node.freshness?.startsWith("stale")), "CLI status --stale-seconds did not apply to node freshness");
  assert(thresholdStatus.agents?.some((agent) => agent.id === "threshold-status-agent" && agent.freshness?.startsWith("stale")), "CLI status --stale-seconds did not apply to agent freshness");

  const edge = start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
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
  const runningStatus = await runCliJson(["status", "--json", "--gateway", gateway, "--token", token]);
  const plannerStatus = runningStatus.agents?.find((agent) => agent.id === "slow-planner");
  const workerStatus = runningStatus.agents?.find((agent) => agent.id === "slow-worker");
  assert(runningStatus.summary?.busy_agents === 1, "CLI status should count only the running planner as busy");
  assert(plannerStatus?.activity === "running", "CLI status did not mark the planner as running");
  assert(plannerStatus?.active_runs?.some((run) => run.status === "running"), "CLI status did not include the active planner run");
  assert(workerStatus?.activity === "idle", "CLI status marked the idle peer as busy");
  assert(runningStatus.rooms?.some((item) => item.id === room.id && item.active_runs?.length), "CLI status did not expose active room runs");
  let activeRecoverRejected = false;
  try {
    await runCliText(["room", "recover", room.id, "--yes", "--gateway", gateway, "--token", token]);
  } catch (err) {
    activeRecoverRejected = /Refusing room recover --yes/.test(err.message || String(err));
  }
  assert(activeRecoverRejected, "room recover --yes should refuse active rooms without stale queued orphan runs");
  await waitForRunStatus(gateway, token, room.id, "slow-planner", "running");

  await requestJson(`${gateway}/edge/register`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "orphan-room-edge",
      hostname: "orphan-room-smoke",
      agents: [{ id: "orphan-worker", kind: "smoke", role: "worker" }]
    })
  });
  const orphanRoom = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Orphan queued room smoke",
      goal: "Verify status ignores an old queued room snapshot when the gateway queue is empty.",
      agents: ["orphan-worker"],
      max_steps: 1
    })
  });
  const orphanTask = await requestJson(`${gateway}/edge/poll`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ node_id: "orphan-room-edge", timeout_ms: 1 })
  });
  assert(orphanTask?.task?.room_id === orphanRoom.id, "orphan room task was not drained from the gateway queue");
  await delay(1200);
  const orphanHealth = await requestJson(`${gateway}/health`);
  assert(orphanHealth.queued === 0, "gateway queue should be empty for stale queued room status coverage");
  const staleQueuedStatus = await runCliJson(["status", "--json", "--gateway", gateway, "--token", token, "--queued-run-stale-seconds", "1"]);
  const orphanStatus = staleQueuedStatus.agents?.find((agent) => agent.id === "orphan-worker");
  const stillRunningPlanner = staleQueuedStatus.agents?.find((agent) => agent.id === "slow-planner");
  assert(staleQueuedStatus.summary?.stale_queued_runs === 1, "CLI status did not count the stale queued room run");
  assert(staleQueuedStatus.summary?.busy_agents === 1, "CLI status should ignore stale queued runs but keep the running planner busy");
  assert(orphanStatus?.activity === "idle", "CLI status marked a stale queued orphan as live queued work");
  assert(orphanStatus?.stale_queued_runs?.some((run) => run.room_id === orphanRoom.id && run.status === "queued"), "CLI status did not expose stale queued run metadata on the agent");
  const orphanRoomStatus = staleQueuedStatus.rooms?.find((item) => item.id === orphanRoom.id);
  assert(orphanRoomStatus?.active_runs?.length === 0, "CLI status should exclude stale queued runs from room active_runs");
  assert(orphanRoomStatus?.stale_queued_runs?.length === 1, "CLI status did not expose stale queued run metadata on the room");
  assert(staleQueuedStatus.warnings?.some((warning) => /Ignored 1 stale queued room run older than 1s; gateway queue is empty/.test(warning)), "CLI status did not warn about the ignored stale queued room run");
  assert(staleQueuedStatus.recovery_hints?.some((hint) => hint.room_id === orphanRoom.id && hint.inspect_command === `agent-bus room inspect ${orphanRoom.id}`), "CLI status JSON did not include room recovery hints");
  assert(stillRunningPlanner?.activity === "running", "CLI status should not mark a genuine running planner as stale");
  const staleQueuedHuman = await runCliText(["status", "--gateway", gateway, "--token", token, "--queued-run-stale-seconds", "1"]);
  assert(staleQueuedHuman.includes("Warning: Ignored 1 stale queued room run older than 1s; gateway queue is empty"), "CLI human status did not warn about the ignored stale queued room run");
  assert(staleQueuedHuman.includes("stale_queued="), "CLI human status did not label stale queued room runs");
  assert(staleQueuedHuman.includes("Recovery hints:"), "CLI human status did not print recovery hints");
  assert(staleQueuedHuman.includes(`agent-bus room recover ${orphanRoom.id} --yes`), "CLI human status did not print recover command hint");
  const inspectJson = await runCliJson(["room", "inspect", orphanRoom.id, "--json", "--gateway", gateway, "--token", token, "--queued-run-stale-seconds", "1"]);
  assert(inspectJson.counts?.stale_queued_runs === 1, "room inspect did not count stale queued runs");
  assert(inspectJson.recommendation === "pause_recover_orphan_queued_runs", "room inspect did not recommend stale queued recovery");
  const inspectHuman = await runCliText(["room", "inspect", orphanRoom.id, "--gateway", gateway, "--token", token, "--queued-run-stale-seconds", "1"]);
  assert(inspectHuman.includes("Recommendation: pause_recover_orphan_queued_runs"), "room inspect human output did not expose the recovery recommendation");
  assert(inspectHuman.includes(`agent-bus room recover ${orphanRoom.id} --yes`), "room inspect human output did not include a room-specific recover command");
  const recoverDryRun = await runCliText(["room", "recover", orphanRoom.id, "--gateway", gateway, "--token", token, "--queued-run-stale-seconds", "1"]);
  assert(recoverDryRun.includes("Dry run. Re-run with --yes"), "room recover should dry-run without --yes");
  await runCliText(["room", "recover", orphanRoom.id, "--yes", "--gateway", gateway, "--token", token, "--queued-run-stale-seconds", "1", "--reason", "stale queued smoke recovery"]);
  const recoveredOrphan = await requestJson(`${gateway}/rooms/${encodeURIComponent(orphanRoom.id)}`, { headers: authHeaders(token) });
  assert(recoveredOrphan.status === "paused", "room recover --yes did not pause the orphan room");
  assert(recoveredOrphan.runs?.some((run) => run.id === orphanTask.task.run_id && run.status === "cancelled"), "room recover --yes did not cancel the stale queued run");

  await delay(2200);
  const busyAgents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
  assert(busyAgents.some((agent) => agent.id === "slow-planner" && agent.status === "online"), "busy planner went stale while running");
  assert(busyAgents.some((agent) => agent.id === "slow-worker" && agent.status === "online"), "busy edge node hid peer agents while running");

  const completed = await waitForRoomComplete(gateway, token, room.id);
  assert(completed.status === "completed", "room did not complete");
  assert(completed.runs?.some((run) => run.agent_id === "slow-worker" && run.status === "completed"), "delegated worker run did not complete");
  assert(!completed.reports?.some((item) => /Agent offline or unknown/.test(item.content || "")), "room incorrectly reported an online busy agent as offline");

  edge.kill("SIGKILL");
  const staleStatus = await waitForStatusNodeFreshness(gateway, token, "stale-room-edge", "stale");
  const staleNode = staleStatus.nodes?.find((node) => node.id === "stale-room-edge");
  assert(staleNode?.agents?.includes("slow-planner"), "stale node inventory lost agent membership");
  await delay(1200);
  const staleAgents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
  assert(!staleAgents.some((agent) => agent.id === "slow-planner" || agent.id === "slow-worker"), "stale node agents should not remain routable via /agents");
  const registeredNodes = await runCliJson(["nodes", "--gateway", gateway, "--token", token]);
  assert(registeredNodes.some((node) => node.node_id === "stale-room-edge"), "CLI nodes did not include the stale registered node");

  const result = {
    ok: true,
    mode: "offline",
    quota: "no_model_calls",
    room_id: completed.id,
    room_status: completed.status,
    run_count: completed.runs?.length || 0,
    stale_node_freshness: staleNode?.freshness || null,
    stale_queued_room_id: orphanRoom.id
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
    env: smokeChildEnv(env),
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

async function waitForStatusNodeFreshness(gateway, token, nodeId, freshnessPrefix, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await runCliJson(["status", "--json", "--gateway", gateway, "--token", token, "--stale-seconds", "2"]);
    const node = status.nodes?.find((item) => item.id === nodeId);
    if (node?.freshness?.startsWith(freshnessPrefix)) return status;
    await delay(200);
  }
  throw new Error(`Timed out waiting for node ${nodeId} freshness ${freshnessPrefix}`);
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

function runCliJson(args, timeoutMs = 10000) {
  return runCliText(args, timeoutMs).then((stdout) => {
    try {
      return JSON.parse(stdout);
    } catch (err) {
      throw new Error(`CLI did not return JSON: ${stdout || err.message}`);
    }
  });
}

function runCliText(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      env: smokeChildEnv({ AGENT_BUS_GATEWAY_URL: "", AGENT_BUS_TOKEN: "" }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: agent-bus ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
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
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const command of [...new Set(candidates)]) {
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

function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}
