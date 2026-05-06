#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] || "help";

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exitCode = 1;
});

async function main() {
  if (argv.includes("--help") || argv.includes("-h") || command === "help") {
    printHelp();
    return;
  }
  if (command === "version" || argv.includes("--version") || argv.includes("-v")) {
    console.log(readPackageVersion());
    return;
  }
  if (command === "init") {
    initConfig(argv.slice(1));
    return;
  }
  if (command === "serve") {
    await runScript("central-gateway.mjs", ["serve", ...stripCliOnlyArgs(argv.slice(1))]);
    return;
  }
  if (command === "connect") {
    await runScript("edge-node.mjs", ["connect", ...stripCliOnlyArgs(argv.slice(1))]);
    return;
  }
  if (command === "probe") {
    await runScript("edge-node.mjs", ["health", ...stripCliOnlyArgs(argv.slice(1))]);
    return;
  }
  if (command === "doctor") {
    await doctor(argv.slice(1));
    return;
  }
  if (command === "service") {
    service(argv.slice(1));
    return;
  }
  if (command === "edge-agents") {
    await runScript("edge-node.mjs", ["agents", ...stripCliOnlyArgs(argv.slice(1))]);
    return;
  }
  if (command === "manifest") {
    await getJson("/v1/agent-bus/manifest", { auth: true });
    return;
  }
  if (command === "well-known") {
    await getJson("/.well-known/agent-bus.json", { auth: false });
    return;
  }
  if (command === "agents") {
    await getJson("/agents", { auth: true });
    return;
  }
  if (command === "health") {
    await getJson("/health", { auth: false });
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

function printHelp() {
  console.log(`agent-bus

Usage:
  agent-bus init central [--out central.config.json] [--force]
  agent-bus init edge [--out edge.config.json] [--preset echo|codex|openclaw|hermes] [--force]
  agent-bus serve --config central.config.json
  agent-bus connect --config edge.config.json
  agent-bus doctor --config edge.config.json
  agent-bus service systemd --mode edge --config /opt/agent-bus/edge.config.json --agent-bus-path /usr/bin/agent-bus
  agent-bus probe --config edge.config.json
  agent-bus edge-agents --config edge.config.json

Gateway queries:
  agent-bus well-known --gateway https://YOUR-DOMAIN/agent-bus
  agent-bus manifest --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus agents --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus health --gateway https://YOUR-DOMAIN/agent-bus

Environment:
  AGENT_BUS_GATEWAY_URL  default gateway URL for query/connect commands
  AGENT_BUS_TOKEN        bearer token for protected gateway queries
`);
}

function service(args) {
  const target = args[0];
  if (!["systemd", "launchd", "windows"].includes(target)) {
    throw new Error("Usage: agent-bus service systemd|launchd|windows --mode edge|central --config file [--out file]");
  }
  const mode = optionValue(args, "--mode") || "edge";
  if (!["edge", "central"].includes(mode)) {
    throw new Error("--mode must be edge or central");
  }
  const configPath = optionValue(args, "--config") || (mode === "central" ? "central.config.json" : "edge.config.json");
  const name = optionValue(args, "--name") || (mode === "central" ? "agent-bus-central" : "agent-bus-edge");
  const cwd = optionValue(args, "--cwd") || process.cwd();
  const gateway = optionValue(args, "--gateway") || "";
  const dataDir = optionValue(args, "--data-dir") || "";
  const tokenEnv = optionValue(args, "--token-env") || "AGENT_BUS_TOKEN";
  const agentBusPath = optionValue(args, "--agent-bus-path") || "";
  const content = target === "systemd"
    ? systemdService({ mode, configPath, name, cwd, gateway, dataDir, tokenEnv, agentBusPath })
    : target === "launchd"
      ? launchdService({ mode, configPath, name, cwd, gateway, dataDir, tokenEnv, agentBusPath })
      : windowsService({ mode, configPath, name, cwd, gateway, dataDir, tokenEnv, agentBusPath });
  const out = optionValue(args, "--out");
  if (out) {
    fs.writeFileSync(out, content);
    console.log(`Wrote ${out}`);
  } else {
    console.log(content);
  }
}

function serviceCommand(mode, configPath, agentBusPath = "", cwd = "") {
  return serviceCommandParts(mode, configPath, agentBusPath, cwd).map(quoteForShell).join(" ");
}

function serviceEnvironment(gateway, dataDir, tokenEnv) {
  const env = [];
  if (gateway) env.push(["AGENT_BUS_GATEWAY_URL", gateway]);
  if (dataDir) env.push(["AGENT_BUS_DATA_DIR", dataDir]);
  return env;
}

function systemdService(options) {
  const env = serviceEnvironment(options.gateway, options.dataDir, options.tokenEnv)
    .map(([key, value]) => `Environment=${key}=${systemdEscape(value)}`)
    .join("\n");
  return `[Unit]
Description=${options.name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.cwd}
${env ? `${env}\n` : ""}ExecStart=${serviceCommand(options.mode, options.configPath, options.agentBusPath, options.cwd)}
# Put AGENT_BUS_TOKEN in an EnvironmentFile or system secret store. Do not commit it.
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
`;
}

function launchdService(options) {
  const parts = serviceCommandParts(options.mode, options.configPath, options.agentBusPath, options.cwd);
  const env = serviceEnvironment(options.gateway, options.dataDir, options.tokenEnv);
  const envXml = env.length
    ? `  <key>EnvironmentVariables</key>
  <dict>
${env.map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join("\n")}
  </dict>
`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(options.name)}</string>
  <key>WorkingDirectory</key><string>${escapeXml(options.cwd)}</string>
${envXml}  <key>ProgramArguments</key>
  <array>
${parts.map((part) => `    <string>${escapeXml(part)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/${escapeXml(options.name)}.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/${escapeXml(options.name)}.err.log</string>
</dict>
</plist>
`;
}

function windowsService(options) {
  const command = serviceCommand(options.mode, options.configPath, options.agentBusPath, options.cwd).replace(/"/g, '\\"');
  const env = serviceEnvironment(options.gateway, options.dataDir, options.tokenEnv);
  const envLines = env.map(([key, value]) => `setx ${key} "${value.replace(/"/g, '\\"')}" /M`).join("\n");
  return `# Run in an elevated PowerShell prompt.
# This uses Windows Service Control Manager and expects Node.js to be installed.
${envLines ? `${envLines}\n` : ""}# Set AGENT_BUS_TOKEN separately, for example with the Windows service account environment.
sc.exe create ${options.name} binPath= "${command}" start= auto DisplayName= "${options.name}"
sc.exe failure ${options.name} reset= 60 actions= restart/5000
sc.exe start ${options.name}
`;
}

function serviceCommandParts(mode, configPath, agentBusPath = "", cwd = "") {
  const action = mode === "central" ? "serve" : "connect";
  const resolvedConfig = resolveServicePath(configPath, cwd);
  if (agentBusPath) return [agentBusPath, action, "--config", resolvedConfig];
  const cliPath = process.argv[1] && fs.existsSync(process.argv[1]) ? process.argv[1] : path.join(__dirname, "agent-bus.mjs");
  return [process.execPath, cliPath, action, "--config", resolvedConfig];
}

function resolveServicePath(value, cwd) {
  const text = String(value || "");
  if (text.startsWith("/") || text.startsWith("~") || /^[A-Za-z]:[\\/]/.test(text)) return text;
  const base = String(cwd || "");
  if (base.startsWith("/")) return `${base.replace(/\/$/, "")}/${text}`;
  if (/^[A-Za-z]:[\\/]/.test(base)) return `${base.replace(/[\\/]$/, "")}\\${text}`;
  return path.resolve(text);
}

function quoteForShell(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:=@+-]+$/.test(text) ? text : `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function systemdEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function doctor(args) {
  const configPath = optionValue(args, "--config") || "edge.config.json";
  const gatewayArg = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL;
  const tokenArg = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN;
  const checks = [];
  let config = null;

  addCheck(checks, "pass", "Node.js runtime", process.version);

  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    addCheck(checks, "pass", "Read edge config", configPath);
  } catch (err) {
    addCheck(checks, "fail", "Read edge config", err.message);
    printDoctor(checks);
    process.exitCode = 1;
    return;
  }

  const gatewayUrl = gatewayArg || config.gatewayUrl || "http://127.0.0.1:8788";
  const token = tokenArg || config.token || "";
  validateEdgeConfig(checks, config, gatewayUrl, token);

  await checkGateway(checks, gatewayUrl, token);
  await checkLocalProbe(checks, configPath);

  printDoctor(checks);
  if (checks.some((item) => item.status === "fail")) {
    process.exitCode = 1;
  }
}

function validateEdgeConfig(checks, config, gatewayUrl, token) {
  if (config.nodeId) {
    addCheck(checks, "pass", "nodeId", String(config.nodeId));
  } else {
    addCheck(checks, "warn", "nodeId", "missing; hostname will be used");
  }

  if (gatewayUrl && !isPlaceholder(gatewayUrl)) {
    addCheck(checks, "pass", "gatewayUrl", gatewayUrl);
  } else {
    addCheck(checks, "fail", "gatewayUrl", "set gatewayUrl or AGENT_BUS_GATEWAY_URL");
  }

  if (token && !isPlaceholder(token)) {
    addCheck(checks, "pass", "token", "configured");
  } else {
    addCheck(checks, "warn", "token", "missing or placeholder; protected gateway checks will fail");
  }

  const agents = Array.isArray(config.agents) ? config.agents.filter((agent) => agent.enabled !== false) : [];
  if (agents.length) {
    addCheck(checks, "pass", "enabled agents", agents.map((agent) => agent.id).join(", "));
  } else {
    addCheck(checks, "fail", "enabled agents", "no enabled agents configured");
  }

  for (const agent of agents) {
    const prefix = `agent ${agent.id || "(missing id)"}`;
    if (!agent.id) addCheck(checks, "fail", `${prefix} id`, "missing");
    if ((agent.adapter || "command") === "command" && !agent.runCommand) {
      addCheck(checks, "fail", `${prefix} runCommand`, "missing");
    }
    if ((agent.adapter || "command") === "command" && isPlaceholder(agent.runCommand || "")) {
      addCheck(checks, "warn", `${prefix} runCommand`, "contains placeholder");
    }
    const pingUrl = agent.pingUrl || agent.healthUrl || agent.modelUrl || "";
    if (!pingUrl) {
      addCheck(checks, "warn", `${prefix} pingUrl`, "not configured");
    } else if (isPlaceholder(pingUrl)) {
      addCheck(checks, "warn", `${prefix} pingUrl`, "contains placeholder");
    } else {
      addCheck(checks, "pass", `${prefix} pingUrl`, pingUrl);
    }
  }
}

async function checkGateway(checks, gatewayUrl, token) {
  if (!gatewayUrl || isPlaceholder(gatewayUrl)) return;
  const wellKnown = await fetchJson(gatewayUrl, "/.well-known/agent-bus.json", "", 8000);
  if (wellKnown.ok) {
    addCheck(checks, "pass", "gateway well-known", wellKnown.data.protocol || "ok");
  } else {
    addCheck(checks, "warn", "gateway well-known", wellKnown.error);
  }

  const health = await fetchJson(gatewayUrl, "/health", "", 8000);
  if (health.ok) {
    addCheck(checks, "pass", "gateway health", `nodes=${health.data.nodes ?? "?"} agents=${health.data.agents ?? "?"}`);
  } else {
    addCheck(checks, "fail", "gateway health", health.error);
  }

  if (!token || isPlaceholder(token)) return;
  const manifest = await fetchJson(gatewayUrl, "/v1/agent-bus/manifest", token, 8000);
  if (manifest.ok) {
    addCheck(checks, "pass", "gateway manifest", `${manifest.data.protocol || "agent-bus"} agents=${manifest.data.agents?.length ?? "?"}`);
  } else {
    addCheck(checks, "warn", "gateway manifest", manifest.error);
  }
}

async function checkLocalProbe(checks, configPath) {
  const result = await runScriptCapture("edge-node.mjs", ["health", "--config", configPath], 20000);
  if (result.ok) {
    try {
      const probes = JSON.parse(result.stdout);
      const summary = probes.map((item) => `${item.agent_id}:${item.ping_status || item.status}`).join(", ");
      addCheck(checks, "pass", "local probe", summary || "ok");
    } catch {
      addCheck(checks, "warn", "local probe", "ran but did not return JSON");
    }
  } else {
    addCheck(checks, "warn", "local probe", trimOneLine(result.stderr || result.stdout || result.error));
  }
}

async function fetchJson(gateway, pathname, token, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(gatewayEndpoint(gateway, pathname), {
      signal: controller.signal,
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText}: ${trimOneLine(text)}` };
    return { ok: true, data: text.trim() ? JSON.parse(text) : {} };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function runScriptCapture(name, args, timeoutMs) {
  return new Promise((resolve) => {
    const script = materializeScript(name);
    const child = spawn(process.execPath, [script, ...args], {
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ ok: false, stdout, stderr, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, error: code === 0 ? "" : `exit ${code}` });
    });
  });
}

function addCheck(checks, status, name, detail) {
  checks.push({ status, name, detail: detail || "" });
}

function printDoctor(checks) {
  for (const item of checks) {
    const mark = item.status === "pass" ? "OK" : item.status === "warn" ? "WARN" : "FAIL";
    console.log(`${mark.padEnd(4)} ${item.name}${item.detail ? ` - ${item.detail}` : ""}`);
  }
}

function isPlaceholder(value) {
  return /YOUR-|change-me|replace-with|example\.com/i.test(String(value || ""));
}

function trimOneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function initConfig(args) {
  const kind = args[0];
  if (!["central", "edge"].includes(kind)) {
    throw new Error("Usage: agent-bus init central|edge [--out file] [--preset name] [--force]");
  }
  const out = optionValue(args, "--out") || (kind === "central" ? "central.config.json" : "edge.config.json");
  const force = args.includes("--force");
  if (fs.existsSync(out) && !force) {
    throw new Error(`Refusing to overwrite ${out}; pass --force to replace it.`);
  }
  const config = kind === "central"
    ? centralTemplate()
    : edgeTemplate(optionValue(args, "--preset") || "echo");
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Wrote ${out}`);
}

function centralTemplate() {
  return {
    host: "127.0.0.1",
    port: 8788,
    dataDir: "./data/central",
    token: "change-me-to-a-long-random-token",
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 25000
    },
    modelRouter: {
      enabled: true,
      defaultBackend: "openai-compatible",
      defaultModel: "agent-bus-default",
      backends: [{
        id: "openai-compatible",
        enabled: true,
        baseUrl: "https://YOUR-MODEL-GATEWAY/v1",
        apiKeyEnv: "AGENT_BUS_MODEL_API_KEY",
        models: ["gpt-4o-mini"],
        modelAliases: {
          "agent-bus-default": "gpt-4o-mini"
        },
        timeoutSeconds: 600
      }]
    }
  };
}

function edgeTemplate(preset) {
  const agents = {
    echo: [{
      id: "local-echo",
      kind: "echo",
      role: "executor",
      enabled: true,
      adapter: "echo",
      capabilities: ["shell", "files"]
    }],
    codex: [{
      id: "codex-local",
      kind: "codex",
      role: "coder",
      enabled: true,
      adapter: "command",
      capabilities: ["code", "review", "shell", "files"],
      pingUrl: "https://api.openai.com/v1/models",
      runCommand: "codex exec --color never --dangerously-bypass-approvals-and-sandbox \"$AGENT_MESSAGE\" < /dev/null"
    }],
    openclaw: [{
      id: "openclaw-local",
      kind: "openclaw",
      role: "executor",
      enabled: true,
      adapter: "command",
      capabilities: ["shell", "files", "browser", "cron", "skills"],
      pingUrl: "https://YOUR-MODEL-GATEWAY/v1/models",
      runCommand: "OPENCLAW_AGENT_ID=main ./scripts/openclaw-agent-bus.sh"
    }],
    hermes: [{
      id: "hermes-local",
      kind: "hermes",
      role: "researcher",
      enabled: true,
      adapter: "command",
      capabilities: ["skills", "memory", "shell", "webhook", "cron"],
      pingUrl: "https://YOUR-MODEL-GATEWAY/v1/models",
      runCommand: "/root/.local/bin/hermes chat -q \"$AGENT_MESSAGE\" -Q"
    }]
  };
  if (!agents[preset]) {
    throw new Error(`Unknown edge preset: ${preset}`);
  }
  return {
    nodeId: os.hostname(),
    gatewayUrl: "https://YOUR-GATEWAY-DOMAIN/agent-bus",
    token: "change-me-to-the-central-token",
    pollTimeoutMs: 25000,
    idleDelayMs: 1000,
    defaultTimeoutMs: 600000,
    healthProbeIntervalMs: 60000,
    healthProbeTimeoutMs: 5000,
    agents: agents[preset]
  };
}

async function getJson(pathname, options) {
  const gateway = optionValue(argv, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "http://127.0.0.1:8788";
  const token = optionValue(argv, "--token") || process.env.AGENT_BUS_TOKEN || "";
  if (options.auth && !token) {
    throw new Error("This endpoint requires --token or AGENT_BUS_TOKEN.");
  }
  const url = gatewayEndpoint(gateway, pathname);
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

function runScript(name, args) {
  return new Promise((resolve, reject) => {
    const script = materializeScript(name);
    const child = spawn(process.execPath, [script, ...args], {
      stdio: "inherit",
      env: process.env
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const err = new Error(`${name} exited with ${signal || code}`);
      err.exitCode = code || 1;
      reject(err);
    });
  });
}

function materializeScript(name) {
  const source = path.join(__dirname, name);
  if (!process.pkg || fs.existsSync(source)) return source;
  const tempDir = path.join(os.tmpdir(), "agent-bus-cli");
  fs.mkdirSync(tempDir, { recursive: true });
  const target = path.join(tempDir, name);
  fs.writeFileSync(target, fs.readFileSync(source));
  return target;
}

function gatewayEndpoint(gatewayUrl, pathname) {
  const url = new URL(gatewayUrl);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${pathname}`.replace(/\/{2,}/g, "/");
  return url;
}

function stripCliOnlyArgs(args) {
  return args;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
