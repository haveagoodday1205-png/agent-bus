import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}
const jsonOut = args.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-zero-token-demo-"));
const FEEDBACK_URL = "https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=zero_token_demo.yml";
const TRY_DOCS_URL = "https://github.com/haveagoodday1205-png/agent-bus/blob/main/docs/try-agent-bus.md";

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
  if (!python) throw new Error("Zero-token demo requires Python 3.10+ for room support.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const adminToken = "sk-zero-token-demo-token-000000";
  const edgeToken = "abt_edge_zero_token_demo_token_000000";
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "zero-token-agent.mjs");

  writeFakeAgent(agentScript);
  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token: adminToken,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 1000
    },
    edgeTokens: [edgeToken],
    modelRouter: {
      enabled: false,
      agentModels: false,
      allowEdgeAgentModels: false,
      backends: []
    }
  }, null, 2)}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "zero-token-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [
      {
        id: "fake-hermes",
        kind: "fake",
        role: "planner",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "planning", "demo", "zero-token"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      },
      {
        id: "fake-openclaw",
        kind: "fake",
        role: "reviewer",
        enabled: true,
        adapter: "command",
        capabilities: ["room", "review", "demo", "zero-token"],
        runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
      }
    ]
  }, null, 2)}\n`);

  step("No API key required: starting a private local gateway");
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: adminToken,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`, 30000, central);

  step("Starting a local edge with two fake agents");
  const edge = start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig,
    AGENT_BUS_GATEWAY_URL: gateway,
    AGENT_BUS_TOKEN: edgeToken
  });
  const onlineAgents = await waitForAgents(gateway, adminToken, ["fake-hermes", "fake-openclaw"], 15000, edge);

  step("Creating a two-agent room and waking fake-hermes");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(adminToken),
    body: JSON.stringify({
      title: "Zero-token Agent Bus playground",
      goal: "Show fake-hermes delegating to fake-openclaw in a shared Agent Bus room without API keys, model providers, Telegram, or remote machines.",
      agents: ["fake-hermes", "fake-openclaw"],
      wakeAgents: ["fake-hermes"],
      auto_rotate: false,
      max_steps: 4
    })
  });
  const finalRoom = await waitForRoomComplete(gateway, adminToken, room.id, 30000);

  const reports = finalRoom.reports || [];
  const notes = finalRoom.blackboard?.notes || [];
  const runs = finalRoom.runs || [];
  const workerRun = runs.find((run) => run.agent_id === "fake-openclaw" && run.status === "completed");
  const completedAgentIds = new Set(runs.filter((run) => run.status === "completed").map((run) => run.agent_id));

  assert(onlineAgents.length === 2, "demo did not register two online fake agents");
  assert(reports.length >= 2, "room did not capture at least two REPORT directives");
  assert(notes.some((note) => /fake-hermes/.test(note.content || "")), "blackboard did not include fake-hermes");
  assert(notes.some((note) => /fake-openclaw/.test(note.content || "")), "blackboard did not include fake-openclaw");
  assert(workerRun && /DONE/.test(workerRun.stdout || ""), "fake-openclaw stdout did not include DONE");
  assert(completedAgentIds.has("fake-hermes") && completedAgentIds.has("fake-openclaw"), "both fake agents did not complete");

  const result = {
    ok: true,
    mode: "zero-token-playground",
    quota: "no_model_calls",
    gateway,
    node_id: "zero-token-edge",
    agents: {
      expected: 2,
      online: onlineAgents.length,
      ids: onlineAgents.map((agent) => agent.id).sort()
    },
    model_router: "disabled",
    provider_env: "cleared_for_child_processes",
    room_id: finalRoom.id,
    room_status: finalRoom.status,
    reports: reports.length,
    blackboard_notes: notes.length,
    completed_agents: completedAgentIds.size,
    worker_done: true,
    feedback_url: FEEDBACK_URL,
    try_docs_url: TRY_DOCS_URL,
    next_commands: [
      "agent-bus demo issue",
      "agent-bus demo room",
      "agent-bus smoke --offline"
    ]
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  step("Exporting a reports-only shareable summary");
  const reportPath = zeroTokenReportPath();
  await runCli(["room", "export", finalRoom.id, "--reports-only", "--out", reportPath, "--gateway", gateway, "--token", adminToken]);
  appendZeroTokenReport(reportPath, result, { reports, notes });

  console.log("");
  console.log("Agent Bus zero-token playground passed");
  console.log("No API key required. No model calls were made.");
  console.log(`Gateway: ${result.gateway}`);
  console.log(`Agents: ${result.agents.ids.join(", ")} (${result.agents.online}/${result.agents.expected} online)`);
  console.log(`Room: ${result.room_id} (${result.room_status})`);
  for (const report of reports) {
    console.log(`REPORT from ${report.speaker}: ${report.content}`);
  }
  console.log(`Reports-only export: ${reportPath}`);
  console.log(`Feedback: ${FEEDBACK_URL}`);
}

function printHelp() {
  console.log(`Usage: agent-bus demo zero-token [--json] [--out-dir DIR] [--report-out FILE]

Runs a private local Central plus Edge with fake agents. No API keys, model
quota, Telegram bot, SSH, or remote machines are used.

Options:
  --json             Print a machine-readable result without writing a report.
  --out-dir DIR      Write the share-safe report in DIR.
  --report-out FILE  Write the share-safe report to FILE.
`);
}

function writeFakeAgent(file) {
  fs.writeFileSync(file, `import fs from "node:fs";\n\nconst id = process.env.AGENT_ID || "fake-agent";\nconst messageFile = process.env.AGENT_MESSAGE_FILE || "";\nlet message = process.env.AGENT_MESSAGE || "";\nif (messageFile && fs.existsSync(messageFile)) message = fs.readFileSync(messageFile, "utf8");\nconst preview = message.replace(/\\s+/g, " ").slice(0, 120);\nconsole.log(\`REPORT: \${id} received a zero-token room task. Preview: \${preview}\`);\nif (id === "fake-hermes") {\n  console.log("REPORT: fake-hermes split the playground goal and delegated verification to fake-openclaw.");\n  console.log("BLACKBOARD: fake-hermes delegated to fake-openclaw with no API key, provider model, Telegram bot, or remote machine configured.");\n  console.log("@fake-openclaw: Verify the zero-token room flow, add your own blackboard note, and finish with DONE.");\n} else if (id === "fake-openclaw") {\n  console.log("REPORT: fake-openclaw verified fake-hermes delegation, shared room state, and no model quota usage.");\n  console.log("BLACKBOARD: fake-openclaw completed after fake-hermes delegated the local zero-token playground task.");\n  console.log("DONE");\n} else {\n  console.log(\`REPORT: \${id} has no special fake-agent role.\`);\n  console.log("DONE");\n}\n`);
}

function step(message) {
  if (!jsonOut) console.log(message);
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: demoChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = { command, args: commandArgs, stdout: "", stderr: "", error: "", exit: null };
  childLogs.set(child, logs);
  child.stdout.on("data", (chunk) => {
    appendLog(logs, "stdout", chunk);
    if (!jsonOut && /listening|connected/.test(chunk.toString())) process.stdout.write(`  ${chunk}`);
  });
  child.stderr.on("data", (chunk) => {
    appendLog(logs, "stderr", chunk);
    if (!jsonOut) process.stderr.write(chunk);
  });
  child.on("error", (err) => {
    logs.error = err.message || String(err);
  });
  child.on("exit", (code, signal) => {
    logs.exit = { code, signal };
  });
  procs.push(child);
  return child;
}

function runCli(cliArgs, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...cliArgs], {
      cwd: root,
      env: demoChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus ${cliArgs.join(" ")} timed out`));
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
      reject(new Error(`agent-bus ${cliArgs.join(" ")} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

async function waitForAgents(gateway, token, agentIds, timeoutMs = 10000, child = null) {
  const started = Date.now();
  let lastAgents = [];
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) {
      throw new Error(`Process exited before agents became ready.\n${formatChildDiagnostics(child)}`);
    }
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      lastAgents = agents;
      const online = agents.filter((agent) => agent.status === "online" && agentIds.includes(agent.id));
      if (agentIds.every((id) => online.some((agent) => agent.id === id))) return online;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}; saw ${lastAgents.map((agent) => `${agent.id}:${agent.status}`).join(", ") || "none"}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 30000) {
  const started = Date.now();
  let lastRoom = null;
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    lastRoom = room;
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    const failed = failedRoomRunDetails(room);
    if (failed) throw new Error(`Room run failed before completion: ${failed}`);
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId}; status=${lastRoom?.status || "unknown"} runs=${roomRunStates(lastRoom)}`);
}

async function waitForJson(url, timeoutMs = 10000, child = null) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) {
      throw new Error(`Process exited before ${url} became ready.\n${formatChildDiagnostics(child)}`);
    }
    try {
      return await requestJson(url);
    } catch (err) {
      lastError = err;
      await delay(250);
    }
  }
  const cause = lastError ? `; last request error: ${lastError.message || String(lastError)}` : "";
  const diagnostics = child ? `\n${formatChildDiagnostics(child)}` : "";
  throw new Error(`Timed out waiting for ${url}${cause}${diagnostics}`);
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

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...setupPythonPaths(),
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const candidate of unique(candidates)) {
    const result = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore"
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return "";
}

function setupPythonPaths() {
  const roots = [
    process.env.pythonLocation,
    process.env.Python_ROOT_DIR,
    process.env.Python3_ROOT_DIR,
    process.env.PYTHON_ROOT_DIR,
    process.env.PYTHON3_ROOT_DIR
  ].filter(Boolean);
  const names = process.platform === "win32"
    ? ["python.exe", "bin/python.exe", "bin/python3.exe"]
    : ["bin/python3", "bin/python", "python3", "python"];
  return roots.flatMap((rootDir) => names.map((name) => path.join(rootDir, name)));
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(logs, key, chunk) {
  const limit = 24000;
  logs[key] += chunk.toString();
  if (logs[key].length > limit) logs[key] = logs[key].slice(-limit);
}

function childFailed(child) {
  const logs = childLogs.get(child);
  return Boolean(logs?.error || child.exitCode !== null || child.signalCode);
}

function formatChildDiagnostics(child) {
  const logs = childLogs.get(child);
  if (!logs) return "child diagnostics unavailable";
  const exit = logs.exit || { code: child.exitCode, signal: child.signalCode };
  const lines = [
    `child: ${logs.command} ${logs.args.join(" ")}`,
    `exit: code=${exit.code ?? "running"} signal=${exit.signal ?? ""}`
  ];
  if (logs.error) lines.push(`spawn_error: ${logs.error}`);
  if (logs.stdout.trim()) lines.push(`stdout:\n${redactDiagnostics(logs.stdout.trim())}`);
  if (logs.stderr.trim()) lines.push(`stderr:\n${redactDiagnostics(logs.stderr.trim())}`);
  return lines.join("\n");
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

function optionValue(values, name) {
  const index = values.indexOf(name);
  if (index < 0 || index + 1 >= values.length) return "";
  return values[index + 1];
}

function zeroTokenReportPath() {
  const explicit = optionValue(args, "--report-out") || optionValue(args, "--out");
  if (explicit) {
    const target = path.resolve(explicit);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    return target;
  }
  const outDir = optionValue(args, "--out-dir") || process.cwd();
  const dir = path.resolve(outDir);
  fs.mkdirSync(dir, { recursive: true });
  return uniqueOutputPath(path.join(dir, "agent-bus-zero-token-report.md"));
}

function appendZeroTokenReport(reportPath, result, details = {}) {
  const agents = result.agents?.ids || [];
  const reports = Array.isArray(details.reports) ? details.reports : [];
  const notes = Array.isArray(details.notes) ? details.notes : [];
  const lines = [
    "",
    "## Zero-token Demo Result",
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Mode | ${result.mode} |`,
    `| Model quota | ${result.quota} |`,
    `| Model router | ${result.model_router} |`,
    `| Agents online | ${result.agents.online}/${result.agents.expected} (${agents.join(", ")}) |`,
    `| Room status | ${result.room_status} |`,
    `| Reports captured | ${result.reports} |`,
    `| Blackboard notes | ${result.blackboard_notes} |`,
    `| Completed agents | ${result.completed_agents} |`,
    `| Worker DONE | ${result.worker_done ? "yes" : "no"} |`,
    "",
    "This report is intended for public feedback. It omits the room goal, full messages, run output, tokens, model keys, private hosts, SSH paths, and provider configuration.",
    "",
    "## Demo Evidence",
    "",
    ...reports.map((report) => `- REPORT from ${report.speaker || "agent"}: ${oneLine(report.content)}`),
    ...notes.map((note) => `- BLACKBOARD from ${note.speaker || "agent"}: ${oneLine(note.content)}`),
    "",
    "## What To Try Next",
    "",
    "- `agent-bus demo issue` shows the issue -> planner -> coder -> reviewer -> patch/PR draft skeleton without contacting GitHub.",
    "- `agent-bus demo room` exports a reports-only AI-to-AI room summary.",
    "- `agent-bus smoke --offline` runs the packaged no-quota smoke path.",
    "",
    "## Feedback",
    "",
    `Open zero-token demo feedback: ${FEEDBACK_URL}`,
    `Try Agent Bus guide: ${TRY_DOCS_URL}`,
    ""
  ];
  fs.appendFileSync(reportPath, `${lines.join("\n")}\n`);
}

function oneLine(value, limit = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function roomRunStates(room) {
  return (room?.runs || [])
    .map((run) => `${run.agent_id || "agent"}:${run.status || "unknown"}`)
    .join(", ") || "none";
}

function failedRoomRunDetails(room) {
  const failed = (room?.runs || []).find((run) => ["failed", "error"].includes(String(run.status || "").toLowerCase()));
  if (!failed) return "";
  const stderr = String(failed.stderr || failed.summary || "").trim().replace(/\s+/g, " ").slice(0, 280);
  return `${failed.agent_id || "agent"}:${failed.status || "failed"} exit=${failed.exit_code ?? "unknown"}${stderr ? ` stderr=${stderr}` : ""}`;
}

function unique(values) {
  return [...new Set(values)];
}

function demoChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of [...HERMETIC_AGENT_BUS_ENV, ...HERMETIC_PROVIDER_ENV]) delete env[name];
  return { ...env, ...overrides };
}

function redactDiagnostics(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\babt_edge_[A-Za-z0-9_-]{12,}\b/g, "abt_edge_[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
}

const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_ROOM_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR",
  "AGENT_BUS_COMPLETION_OUTBOX_DIR"
];

const HERMETIC_PROVIDER_ENV = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "ANTHROPIC_API_KEY",
  "CLAUDE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "TOGETHER_API_KEY"
];
