import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const jsonOut = process.argv.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-doctor-smoke-"));

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
  if (!python) throw new Error("doctor smoke requires Python 3.10+ for room endpoint coverage.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-doctor-smoke-token-000000";
  const edgeToken = "abt_edge_doctor_smoke_token_000000";
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 1000
    },
    edgeTokens: [edgeToken],
    modelRouter: {
      enabled: true,
      agentModels: true,
      allowEdgeAgentModels: true,
      backends: [{
        id: "doctor-mock",
        enabled: true,
        baseUrl: "http://127.0.0.1:1/v1",
        models: ["doctor-backend-model"],
        modelAliases: {
          "agent-bus-default": "doctor-backend-model"
        }
      }]
    }
  }, null, 2)}\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "doctor-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    tokenScope: "edge",
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "doctor-echo",
      kind: "echo",
      role: "diagnostic",
      enabled: true,
      adapter: "echo",
      capabilities: ["doctor", "no-quota"]
    }]
  }, null, 2)}\n`);

  step("Starting private gateway");
  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`, 30000, central);

  step("Starting echo edge");
  const edge = start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig]);
  await waitForAgent(gateway, token, "doctor-echo");

  step("Running admin doctor");
  const adminDoctor = await runDoctor(["--config", edgeConfig, "--token", token, "--json"]);
  assertDoctor(adminDoctor, {
    requiredPasses: ["gateway agents", "gateway nodes", "gateway models", "gateway rooms", "configured agents online"]
  });

  step("Running edge-scope doctor");
  const edgeDoctor = await runDoctor(["--config", edgeConfig, "--json"]);
  assertDoctor(edgeDoctor, {
    requiredPasses: ["gateway agents", "gateway nodes", "gateway models"],
    requiredWarnings: ["gateway rooms"]
  });
  const legacyPermissionObservations = findDoctorCheck(edgeDoctor, "agent permission observations");
  assert(legacyPermissionObservations?.status === "warn" && /doctor-echo/.test(legacyPermissionObservations.detail), `legacy edge config should warn about missing permission observations: ${JSON.stringify(legacyPermissionObservations)}`);
  const legacyDescriptiveObservations = findDoctorCheck(edgeDoctor, "agent descriptive observations");
  assert(legacyDescriptiveObservations?.status === "warn" && /doctor-echo/.test(legacyDescriptiveObservations.detail), `legacy edge config should warn about missing descriptive observations: ${JSON.stringify(legacyDescriptiveObservations)}`);

  step("Verifying observation-ready edge config");
  const observedConfig = path.join(tempDir, "edge-observed.config.json");
  fs.writeFileSync(observedConfig, `${JSON.stringify({
    nodeId: "doctor-observed-edge",
    gatewayUrl: gateway,
    token: edgeToken,
    tokenScope: "edge",
    agents: [{
      id: "doctor-observed",
      kind: "echo",
      role: "diagnostic",
      enabled: true,
      adapter: "echo",
      capabilities: ["doctor", "no-quota"],
      owner: "edge-operator",
      runtime: "agent-bus-echo",
      permission_profile: "local-demo",
      cost_class: "free",
      latency_class: "interactive",
      allowed_rooms: ["room_*"],
      allowed_wake_targets: []
    }]
  }, null, 2)}\n`);
  const observedDoctor = await runDoctor(["--config", observedConfig, "--local-only", "--json"]);
  const observedPermissionCheck = findDoctorCheck(observedDoctor, "agent permission observations");
  assert(observedPermissionCheck?.status === "pass", `observation-ready config should pass permission observations: ${JSON.stringify(observedPermissionCheck)}`);
  const observedDescriptorCheck = findDoctorCheck(observedDoctor, "agent descriptive observations");
  assert(observedDescriptorCheck?.status === "pass", `observation-ready config should pass descriptive observations: ${JSON.stringify(observedDescriptorCheck)}`);

  step("Verifying local-only doctor summary");
  const localDoctor = await runCli(["doctor", "--config", edgeConfig, "--local-only"]);
  assert(localDoctor.stdout.includes("gateway checks skipped"), "local-only doctor did not skip gateway checks");
  assert(/Doctor: (OK|WARN|FAIL) pass=\d+ warn=\d+ fail=\d+/.test(localDoctor.stdout), "doctor human output omitted summary counts");

  step("Verifying command script path safety checks");
  const relativeScriptDir = path.join(tempDir, "doctor-script-runtime");
  fs.mkdirSync(relativeScriptDir, { recursive: true });
  fs.writeFileSync(path.join(relativeScriptDir, "doctor-agent.mjs"), "console.log('doctor smoke command path ok');\n");
  const relativeScript = "./doctor-script-runtime/doctor-agent.mjs";
  const quotedNode = JSON.stringify(process.execPath);
  const pinnedScriptConfig = path.join(tempDir, "edge-script-pinned.config.json");
  const unpinnedScriptConfig = path.join(tempDir, "edge-script-unpinned.config.json");
  const brokenScriptConfig = path.join(tempDir, "edge-script-broken.config.json");
  for (const [file, id, cwd, scriptPath] of [
    [pinnedScriptConfig, "script-pinned", tempDir, relativeScript],
    [unpinnedScriptConfig, "script-unpinned", "", relativeScript],
    [brokenScriptConfig, "script-broken", tempDir, "./doctor-script-runtime/missing-agent.mjs"]
  ]) {
    fs.writeFileSync(file, `${JSON.stringify({
      nodeId: `doctor-${id}`,
      gatewayUrl: gateway,
      token: edgeToken,
      tokenScope: "edge",
      ...(cwd ? { cwd } : {}),
      agents: [{
        id,
        kind: "command",
        role: "diagnostic",
        enabled: true,
        adapter: "command",
        runCommand: `${quotedNode} ${scriptPath}`
      }]
    }, null, 2)}\n`);
  }
  const pinnedScriptDoctor = await runDoctor(["--config", pinnedScriptConfig, "--local-only", "--json"]);
  const pinnedScriptCheck = findDoctorCheck(pinnedScriptDoctor, "agent script-pinned command file");
  assert(pinnedScriptCheck?.status === "pass", `pinned relative script should pass doctor: ${JSON.stringify(pinnedScriptCheck)}`);
  const unpinnedScriptDoctor = await runDoctor(["--config", unpinnedScriptConfig, "--local-only", "--json"]);
  const unpinnedScriptCheck = findDoctorCheck(unpinnedScriptDoctor, "agent script-unpinned command file");
  assert(unpinnedScriptCheck?.status === "warn", `unpinned relative script should warn about cwd drift: ${JSON.stringify(unpinnedScriptCheck)}`);
  const brokenScriptDoctor = await runCliAllowFailure(["doctor", "--config", brokenScriptConfig, "--local-only", "--json"]);
  assert(brokenScriptDoctor.code !== 0, "doctor should fail when a pinned relative script path is missing");
  const brokenScriptJson = JSON.parse(brokenScriptDoctor.stdout);
  const brokenScriptCheck = findDoctorCheck(brokenScriptJson, "agent script-broken command file");
  assert(brokenScriptCheck?.status === "fail", `missing pinned script should fail doctor: ${JSON.stringify(brokenScriptCheck)}`);

  step("Verifying operator status readiness");
  const statusJson = await runCli(["status", "--gateway", gateway, "--token", token, "--json"]);
  const status = JSON.parse(statusJson.stdout);
  assert(status.readiness?.status === "ready", `status readiness mismatch: ${JSON.stringify(status.readiness)}`);
  assert(Array.isArray(status.next_actions), "status omitted next_actions");
  assert(status.next_actions.some((item) => /agent-bus room create/.test(item) && /doctor-echo/.test(item)), `status next_actions did not include a copyable room command with the online agent id: ${JSON.stringify(status.next_actions)}`);
  assert(status.status_meta?.room_details, "status omitted room detail hydration metadata");
  assert(typeof status.status_meta.room_details.hydrated === "number", "status room detail metadata omitted hydrated count");
  const statusFromCentralConfig = await runCli(["status", "--config", centralConfig, "--json"]);
  const statusViaCentralConfig = JSON.parse(statusFromCentralConfig.stdout);
  assert(statusViaCentralConfig.ok === true, "status --config central.config.json did not reuse the local gateway");
  assert(statusViaCentralConfig.readiness?.status === "ready", `central config status readiness mismatch: ${JSON.stringify(statusViaCentralConfig.readiness)}`);
  assert(statusViaCentralConfig.status_meta?.room_access === "full", `central config status should expose full room access: ${JSON.stringify(statusViaCentralConfig.status_meta)}`);
  const statusFromEdgeConfig = await runCli(["status", "--config", edgeConfig, "--json"]);
  const statusViaEdgeConfig = JSON.parse(statusFromEdgeConfig.stdout);
  assert(statusViaEdgeConfig.ok === true, "status --config edge.config.json did not reuse gateway/token from the edge config");
  assert(statusViaEdgeConfig.summary?.online_agents === 1, "status --config edge.config.json did not show the online edge agent");
  assert(statusViaEdgeConfig.status_meta?.room_access === "limited", `edge config status should mark room access limited: ${JSON.stringify(statusViaEdgeConfig.status_meta)}`);
  assert(statusViaEdgeConfig.warnings?.some((item) => /admin-only/.test(item)), `edge config status did not explain room access limits: ${JSON.stringify(statusViaEdgeConfig.warnings)}`);
  assert(statusViaEdgeConfig.next_actions?.some((item) => /admin token/.test(item)), `edge config status did not suggest an admin token for room details: ${JSON.stringify(statusViaEdgeConfig.next_actions)}`);
  assert(!statusViaEdgeConfig.next_actions?.some((item) => /agent-bus room create/.test(item)), `edge config status should not suggest room creation when room access is limited: ${JSON.stringify(statusViaEdgeConfig.next_actions)}`);
  const statusHumanFromEdgeConfig = await runCli(["status", "--config", edgeConfig]);
  assert(statusHumanFromEdgeConfig.stdout.includes("admin-only"), "status --config edge.config.json human output omitted the room-access warning");
  const agentsFromEdgeConfig = await runCli(["agents", "--config", edgeConfig]);
  const edgeAgents = JSON.parse(agentsFromEdgeConfig.stdout);
  assert(Array.isArray(edgeAgents) && edgeAgents.some((item) => item.id === "doctor-echo"), "agents --config edge.config.json did not reuse gateway/token from the edge config");
  const centralStatus = await requestJson(`${gateway}/v1/agent-bus/status`, { headers: authJsonHeaders(token) });
  assert(centralStatus.readiness?.status === "ready", `central status readiness mismatch: ${JSON.stringify(centralStatus.readiness)}`);
  assert(Array.isArray(centralStatus.next_actions), "central status omitted next_actions");
  assert(centralStatus.next_actions.some((item) => /agent-bus room create/.test(item) && /doctor-echo/.test(item)), `central status next_actions did not include a copyable room command with the online agent id: ${JSON.stringify(centralStatus.next_actions)}`);
  const statusHuman = await runCli(["status", "--gateway", gateway, "--token", token]);
  assert(statusHuman.stdout.includes("Readiness:"), "status human output omitted readiness");
  assert(statusHuman.stdout.includes("Next actions:"), "status human output omitted next actions");

  step("Verifying central preflight doctor");
  const centralDoctor = await runDoctor(["--mode", "central", "--config", centralConfig, "--gateway", gateway, "--token", token, "--json"]);
  assertDoctor(centralDoctor, {
    requiredPasses: ["doctor mode", "central dataDir", "central health endpoint", "central readiness status", "runtime edge connectivity", "runtime edge tokens"]
  });
  const centralProductionDoctor = await runDoctor(["--mode", "central", "--production", "--config", centralConfig, "--gateway", gateway, "--token", token, "--json"]);
  assertDoctor(centralProductionDoctor, {
    requiredPasses: ["doctor profile", "runtime edge connectivity", "runtime edge tokens"]
  });

  step("Verifying gateway request failure guidance");
  const closedPort = await freePort();
  const failedStatus = await runCliAllowFailure(["status", "--gateway", `http://127.0.0.1:${closedPort}`, "--gateway-timeout-ms", "250"], 5000);
  assert(failedStatus.code !== 0, "status against a closed gateway unexpectedly succeeded");
  assert((failedStatus.stderr + failedStatus.stdout).includes("Gateway request failed"), "closed gateway error omitted actionable guidance");

  step("Verifying diagnostics bundle redaction");
  const bundlePath = path.join(tempDir, "diagnostics.json");
  await runDoctor(["--config", edgeConfig, "--json", "--bundle", bundlePath]);
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  const bundleText = JSON.stringify(bundle);
  assert(bundle.schema === "agent_bus.diagnostics.v1", "diagnostics bundle has the wrong schema");
  assert(bundle.doctor?.counts?.pass >= 1, "diagnostics bundle omitted doctor counts");
  assert(!bundleText.includes(token), "diagnostics bundle leaked the admin token");
  assert(!bundleText.includes(edgeToken), "diagnostics bundle leaked the edge token");
  assert(!bundleText.includes(gateway), "diagnostics bundle leaked the raw gateway URL");
  assert(bundleText.includes("[REDACTED"), "diagnostics bundle did not include redaction markers");

  step("Verifying edge token model-router boundaries");
  const realBackendDenied = await requestStatus(`${gateway}/v1/chat/completions`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent-bus-default",
      messages: [{ role: "user", content: "should be denied before backend routing" }]
    })
  });
  assert(realBackendDenied === 401, `edge token could call a real backend model: ${realBackendDenied}`);

  step("Verifying setup central dry-run path");
  const setupCentralConfig = path.join(tempDir, "setup-central.config.json");
  const setupCentralOutput = await runCli(["setup", "central", "--out", setupCentralConfig, "--gateway", gateway, "--token", "sk-setup-central-smoke-token-000000", "--service", "none"]);
  const setupConfig = JSON.parse(fs.readFileSync(setupCentralConfig, "utf8"));
  assert(setupConfig.token === "sk-setup-central-smoke-token-000000", "setup central did not write the configured token");
  assert(setupConfig.modelRouter?.enabled === true, "setup central did not keep the model router enabled by default");
  assert(setupConfig.plugins?.telegramBot?.control?.conversation?.enabled === false, "setup central did not include Telegram conversation defaults");
  assert(setupCentralOutput.stdout.includes("Operator checklist:"), "setup central did not print operator checklist");

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
  await Promise.all([waitForExit(edge), waitForExit(central)]);

  const result = {
    ok: true,
    quota: "no_model_calls",
    gateway,
    agents: ["doctor-echo"],
    admin_counts: adminDoctor.counts,
    edge_counts: edgeDoctor.counts,
    central_counts: centralDoctor.counts,
    diagnostics_bundle: path.basename(bundlePath),
    edge_backend_denied: realBackendDenied
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("doctor smoke ok");
    console.log(`Gateway: ${gateway}`);
    console.log(`Admin doctor: ${JSON.stringify(adminDoctor.counts)}`);
    console.log(`Edge doctor: ${JSON.stringify(edgeDoctor.counts)}`);
  }
}

function assertDoctor(result, { requiredPasses = [], requiredWarnings = [] } = {}) {
  if (!result.ok) {
    throw new Error(`doctor returned failures: ${JSON.stringify(result.counts)}\n${JSON.stringify(result.checks, null, 2)}`);
  }
  for (const name of requiredPasses) {
    const check = result.checks.find((item) => item.name === name);
    if (!check || check.status !== "pass") {
      throw new Error(`expected passing doctor check ${name}, got ${check ? JSON.stringify(check) : "missing"}`);
    }
  }
  for (const name of requiredWarnings) {
    const check = result.checks.find((item) => item.name === name);
    if (!check || check.status !== "warn") {
      throw new Error(`expected warning doctor check ${name}, got ${check ? JSON.stringify(check) : "missing"}`);
    }
  }
}

function findDoctorCheck(result, name) {
  return result?.checks?.find((item) => item.name === name) || null;
}

function runDoctor(args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), "doctor", ...args], {
      cwd: root,
      env: smokeChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus doctor timed out\n${stderr || stdout}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`agent-bus doctor exited with ${code}\n${stderr || stdout}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`doctor did not return JSON: ${err.message}\n${stdout}`));
      }
    });
  });
}

function runCli(args, timeoutMs = 20000) {
  return runCliProcess(args, { timeoutMs, allowFailure: false });
}

function runCliAllowFailure(args, timeoutMs = 20000) {
  return runCliProcess(args, { timeoutMs, allowFailure: true });
}

function runCliProcess(args, { timeoutMs = 20000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      env: smokeChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus ${args.join(" ")} timed out\n${stderr || stdout}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !allowFailure) return reject(new Error(`agent-bus ${args.join(" ")} exited with ${code}\n${stderr || stdout}`));
      resolve({ stdout, stderr, code });
    });
  });
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: smokeChildEnv(env),
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

async function waitForAgent(gateway, token, agentId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await requestJson(`${gateway}/agents`, {
        headers: { authorization: `Bearer ${token}` }
      });
      if (agents.some((agent) => agent.id === agentId && agent.status === "online")) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${agentId}\n${formatChildDiagnostics(procs[procs.length - 1])}`);
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
  const diagnostics = child ? `\n${formatChildDiagnostics(child)}` : "";
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "no response"}${diagnostics}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function requestStatus(url, options = {}) {
  const res = await fetch(url, options);
  await res.arrayBuffer();
  return res.status;
}

function authJsonHeaders(token) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
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

function step(message) {
  if (!jsonOut) console.log(message);
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

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function unique(values) {
  return [...new Set(values)];
}

function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];

function redactDiagnostics(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\babt_edge_[A-Za-z0-9_-]{12,}\b/g, "abt_edge_[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
}
