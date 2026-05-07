#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const command = argv[0] || "help";

const OPENCLAW_AGENT_BUS_AGENTS_MD = `# Agent Bus Runtime

You are an OpenClaw executor connected through Agent Bus.
Answer the current request directly and stay focused on the task.
Do not run first-run onboarding, bootstrap rituals, or persona setup in Agent Bus sessions.
Use tools when the request needs files, shell, browser, or server inspection.
`;

const OPENCLAW_AGENT_BUS_TOOLS_MD = `# Agent Bus Tool Notes

Agent Bus provides the user request through the OpenClaw bridge script.
Large requests may originate from a temporary AGENT_MESSAGE_FILE path before reaching OpenClaw.
Return the useful result of the task, not internal routing or bridge details.
`;

const OPENCLAW_AGENT_BUS_IDENTITY_MD = `# Identity

Name: Agent Bus OpenClaw executor.
Purpose: execute remote assistant tasks for Agent Bus rooms and threads.
Voice: plain, direct, and task-focused.
`;

const OPENCLAW_AGENT_BUS_USER_MD = `# User Context

Requests arrive from Agent Bus rooms or direct threads.
Treat room and thread continuity as useful context when it is present, but answer the latest request first.
`;

const OPENCLAW_AGENT_BUS_SOUL_MD = `# Operating Boundaries

Prefer practical help, concise status, and verifiable results.
Do not introduce yourself unless the user asks.
Do not expose secrets, tokens, or private configuration values in normal replies.
`;

const OPENCLAW_AGENT_BUS_HEARTBEAT_MD = `# Heartbeat

No proactive heartbeat is required for Agent Bus CLI turns.
`;

const OPENCLAW_AGENT_BUS_SYSTEM_PROMPT = `You are an Agent Bus OpenClaw executor.

You receive tasks from Agent Bus rooms and threads.
Answer the latest task directly, use tools when useful, and return concise verifiable results.
Do not run first-run onboarding, bootstrap rituals, persona setup, or casual greetings in Agent Bus sessions.
Do not expose secrets, tokens, private configuration, bridge internals, or routing details unless explicitly required for the task.
When a room asks you to coordinate with other agents, use Agent Bus directives exactly as requested by the room prompt.
`;

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
    await initConfig(argv.slice(1));
    return;
  }
  if (command === "detect") {
    await detect(argv.slice(1));
    return;
  }
  if (command === "openclaw") {
    await openclaw(argv.slice(1));
    return;
  }
  if (command === "serve") {
    await serve(argv.slice(1));
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
  if (command === "diagnostics" || command === "diag") {
    await diagnostics(argv.slice(1));
    return;
  }
  if (command === "smoke") {
    await runScript("scripts/offline-smoke.mjs", stripCliOnlyArgs(argv.slice(1)));
    return;
  }
  if (command === "demo") {
    await demo(argv.slice(1));
    return;
  }
  if (command === "pair") {
    await pair(argv.slice(1));
    return;
  }
  if (command === "setup") {
    await setup(argv.slice(1));
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
  if (command === "nodes") {
    await getJson("/nodes", { auth: true });
    return;
  }
  if (command === "room" || command === "rooms") {
    await room(argv.slice(1));
    return;
  }
  if (command === "trace" || command === "traces") {
    await trace(argv.slice(1));
    return;
  }
  if (command === "status") {
    await status(argv.slice(1));
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
  agent-bus init edge [--out edge.config.json] [--preset echo|codex|openclaw|hermes|ollama] [--force]
  agent-bus init edge --auto [--gateway https://YOUR-DOMAIN/agent-bus] [--token ...] [--out edge.config.json]
  agent-bus detect [--json]
  agent-bus openclaw prepare [--config ~/.openclaw/openclaw.json] [--workspace ./openclaw-workspace] [--context-tokens 48000]
  agent-bus serve --config central.config.json [--runtime node|python]
  agent-bus connect --config edge.config.json
  agent-bus doctor --config edge.config.json [--json]
  agent-bus diagnostics bundle --config edge.config.json --out diagnostics.json
  agent-bus smoke --offline
  agent-bus demo
  agent-bus demo room
  agent-bus demo starter
  agent-bus demo agent-model
  agent-bus demo issue
  agent-bus demo local
  agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ... --preset codex
  agent-bus pair join --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --out edge.config.json [--auto]
  agent-bus setup central --gateway https://YOUR-DOMAIN/agent-bus --out central.config.json --service auto
  agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --auto --service auto
  agent-bus service systemd --mode edge --config /opt/agent-bus/edge.config.json --agent-bus-path /usr/bin/agent-bus
  agent-bus probe --config edge.config.json
  agent-bus edge-agents --config edge.config.json
  agent-bus room create --goal "Check deployment" --agents codex-120,openclaw-hk --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room show room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room export room_xxx --format markdown --out room.md
  agent-bus room export room_xxx --reports-only --out room-summary.md
  agent-bus room export room_xxx --format json --out room.json --no-redact
  agent-bus room export room_xxx --format events --out room-events.json
  agent-bus room replay --in room-events.json --format markdown
  agent-bus room wake room_xxx --agents hermes-hk --reason "Continue"
  agent-bus room pause room_xxx --reason "old orphan queued run recovery"
  agent-bus room message room_xxx --message "New context" --agents openclaw-hk
  agent-bus trace show trace_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus trace export trace_xxx --format markdown --out trace.md
  agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ... [--json] [--no-room-details] [--room-detail-limit 25] [--stale-seconds 180] [--queued-run-stale-seconds 21600]

Gateway queries:
  agent-bus well-known --gateway https://YOUR-DOMAIN/agent-bus
  agent-bus manifest --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus nodes --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus agents --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus health --gateway https://YOUR-DOMAIN/agent-bus

Environment:
  AGENT_BUS_GATEWAY_URL  default gateway URL for query/connect commands
  AGENT_BUS_TOKEN        bearer token for protected gateway queries
`);
}

function demo(args) {
  const target = args[0] || "starter";
  const extra = stripCliOnlyArgs(args.slice(1));
  if (target === "starter" || target === "quickstart" || target === "golden") {
    return runScript("scripts/demo-starter.mjs", extra);
  }
  if (target === "room" || target === "ai-to-ai") {
    return runScript("scripts/demo-room.mjs", extra);
  }
  if (target === "agent-model" || target === "model" || target === "responses") {
    return runScript("scripts/demo-agent-model.mjs", extra);
  }
  if (target === "issue" || target === "issue-pr" || target === "flagship") {
    return runScript("scripts/demo-issue-pr.mjs", extra);
  }
  if (target === "local" || target === "pairing" || target === "remote-assistant") {
    return runScript("scripts/demo-local.mjs", extra);
  }
  throw new Error("Usage: agent-bus demo starter|room|agent-model|issue|local");
}

async function serve(args) {
  const runtime = String(optionValue(args, "--runtime") || process.env.AGENT_BUS_CENTRAL_RUNTIME || "node").toLowerCase();
  const config = optionValue(args, "--config") || process.env.AGENT_BUS_CONFIG || "";
  if (["python", "py", "full"].includes(runtime)) {
    const python = process.env.AGENT_BUS_PYTHON || findExecutable("python3") || findExecutable("python") || "python3";
    const env = {
      ...process.env,
      ...(config ? { AGENT_BUS_CONFIG: config } : {})
    };
    await runProcess("central_gateway.py", python, [materializeScript("central_gateway.py")], { env });
    return;
  }
  if (!["node", "js"].includes(runtime)) {
    throw new Error("--runtime must be node or python.");
  }
  await runScript("central-gateway.mjs", ["serve", ...stripCliOnlyArgs(removeOptionWithValue(args, "--runtime"))]);
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

async function setup(args) {
  const target = args[0] || "edge";
  if (target === "central") {
    await setupCentral(args.slice(1));
    return;
  }
  if (target !== "edge") {
    throw new Error("Usage: agent-bus setup central|edge [options]");
  }

  const out = optionValue(args, "--out") || "edge.config.json";
  const force = args.includes("--force");
  if (fs.existsSync(out) && !force) {
    throw new Error(`Refusing to overwrite ${out}; pass --force to replace it.`);
  }

  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "";
  const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN || "";
  const code = optionValue(args, "--code") || process.env.AGENT_BUS_PAIR_CODE || "";
  const preset = optionValue(args, "--preset") || "";
  const auto = args.includes("--auto") || (!preset && !args.includes("--no-auto"));
  const nodeId = optionValue(args, "--node-id") || os.hostname();

  console.log("Agent Bus edge setup");
  if (code) {
    console.log("Step 1/3: redeeming pair code and writing edge config");
    await writePairedEdgeConfig({ args, gateway, code, out, force, preset, auto, nodeId });
  } else {
    console.log("Step 1/3: writing edge config");
    await writeSetupEdgeConfig({ args, gateway, token, out, preset, auto });
  }

  const serviceTarget = resolveSetupServiceTarget(optionValue(args, "--service") || "");
  if (serviceTarget) {
    const serviceOut = optionValue(args, "--service-out") || defaultServiceOut(serviceTarget, "edge");
    const cwd = optionValue(args, "--cwd") || path.dirname(path.resolve(out));
    const agentBusPath = optionValue(args, "--agent-bus-path") || defaultAgentBusPath();
    const content = serviceTarget === "systemd"
      ? systemdService({ mode: "edge", configPath: out, name: optionValue(args, "--name") || "agent-bus-edge", cwd, gateway, dataDir: optionValue(args, "--data-dir") || "", tokenEnv: optionValue(args, "--token-env") || "AGENT_BUS_TOKEN", agentBusPath })
      : serviceTarget === "launchd"
        ? launchdService({ mode: "edge", configPath: out, name: optionValue(args, "--name") || "agent-bus-edge", cwd, gateway, dataDir: optionValue(args, "--data-dir") || "", tokenEnv: optionValue(args, "--token-env") || "AGENT_BUS_TOKEN", agentBusPath })
        : windowsService({ mode: "edge", configPath: out, name: optionValue(args, "--name") || "agent-bus-edge", cwd, gateway, dataDir: optionValue(args, "--data-dir") || "", tokenEnv: optionValue(args, "--token-env") || "AGENT_BUS_TOKEN", agentBusPath });
    fs.writeFileSync(serviceOut, content);
    console.log(`Step 2/3: wrote ${serviceTarget} service template to ${serviceOut}`);
    console.log(serviceInstallHint(serviceTarget, serviceOut));
  } else {
    console.log("Step 2/3: service template skipped; pass --service auto to generate one");
  }

  if (args.includes("--skip-doctor")) {
    console.log("Step 3/3: doctor skipped");
  } else {
    console.log("Step 3/3: running zero-quota doctor checks");
    await doctor(["--config", out, ...(gateway ? ["--gateway", gateway] : []), ...(token && !code ? ["--token", token] : [])]);
  }

  console.log(`Next: agent-bus connect --config ${out}`);
}

async function setupCentral(args) {
  const out = optionValue(args, "--out") || "central.config.json";
  const force = args.includes("--force");
  if (fs.existsSync(out) && !force) {
    throw new Error(`Refusing to overwrite ${out}; pass --force to replace it.`);
  }

  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "https://YOUR-DOMAIN/agent-bus";
  const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN || randomToken("abt_admin");
  const config = centralTemplate();
  config.token = token;
  config.host = optionValue(args, "--host") || config.host;
  config.port = positiveIntegerOption(optionValue(args, "--port"), config.port, 65535);
  config.dataDir = optionValue(args, "--data-dir") || config.dataDir;
  if (args.includes("--allow-edge-agent-models")) {
    config.modelRouter.allowEdgeAgentModels = true;
  }
  if (args.includes("--no-model-router")) {
    config.modelRouter.enabled = false;
    config.modelRouter.backends = [];
  }

  fs.writeFileSync(out, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log("Agent Bus central setup");
  console.log(`Step 1/3: wrote ${out}`);
  if (!optionValue(args, "--token") && !process.env.AGENT_BUS_TOKEN) {
    console.log("         generated a long admin token and stored it only in the config file");
  }

  const serviceTarget = resolveSetupServiceTarget(optionValue(args, "--service") || "");
  if (serviceTarget) {
    const serviceOut = optionValue(args, "--service-out") || defaultServiceOut(serviceTarget, "central");
    const cwd = optionValue(args, "--cwd") || path.dirname(path.resolve(out));
    const agentBusPath = optionValue(args, "--agent-bus-path") || defaultAgentBusPath();
    const content = serviceTarget === "systemd"
      ? systemdService({ mode: "central", configPath: out, name: optionValue(args, "--name") || "agent-bus-central", cwd, gateway, dataDir: config.dataDir, tokenEnv: optionValue(args, "--token-env") || "AGENT_BUS_TOKEN", agentBusPath })
      : serviceTarget === "launchd"
        ? launchdService({ mode: "central", configPath: out, name: optionValue(args, "--name") || "agent-bus-central", cwd, gateway, dataDir: config.dataDir, tokenEnv: optionValue(args, "--token-env") || "AGENT_BUS_TOKEN", agentBusPath })
        : windowsService({ mode: "central", configPath: out, name: optionValue(args, "--name") || "agent-bus-central", cwd, gateway, dataDir: config.dataDir, tokenEnv: optionValue(args, "--token-env") || "AGENT_BUS_TOKEN", agentBusPath });
    fs.writeFileSync(serviceOut, content);
    console.log(`Step 2/3: wrote ${serviceTarget} service template to ${serviceOut}`);
    console.log(serviceInstallHint(serviceTarget, serviceOut));
  } else {
    console.log("Step 2/3: service template skipped; pass --service auto to generate one");
  }

  const preset = optionValue(args, "--preset") || "codex";
  edgeTemplate(preset);
  console.log("Step 3/3: first edge pairing command");
  console.log(`  agent-bus pair create --gateway ${gateway} --token <admin token from ${out}> --preset ${preset}`);
  console.log("Then run the returned setup edge command on the edge machine.");
  console.log(`Start local central now: agent-bus serve --runtime python --config ${out}`);
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

async function writePairedEdgeConfig({ args, gateway, code, out, force, preset, auto, nodeId }) {
  const joinArgs = ["--gateway", gateway || "http://127.0.0.1:8788", "--code", code, "--out", out, "--node-id", nodeId];
  if (force) joinArgs.push("--force");
  if (preset) joinArgs.push("--preset", preset);
  if (auto) joinArgs.push("--auto");
  const tools = optionValue(args, "--tools");
  if (tools) joinArgs.push("--tools", tools);
  await joinPairCode(joinArgs);
}

async function writeSetupEdgeConfig({ args, gateway, token, out, preset, auto }) {
  const config = auto ? await edgeAutoTemplate(args) : edgeTemplate(preset || "echo");
  if (gateway) config.gatewayUrl = gateway;
  if (token) config.token = token;
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Wrote ${out}`);
}

function resolveSetupServiceTarget(value) {
  const target = String(value || "").toLowerCase();
  if (!target || target === "none" || target === "off") return "";
  if (target === "auto") {
    if (process.platform === "win32") return "windows";
    if (process.platform === "darwin") return "launchd";
    return "systemd";
  }
  if (["systemd", "launchd", "windows"].includes(target)) return target;
  throw new Error("--service must be auto, systemd, launchd, windows, or none");
}

function defaultServiceOut(target, mode) {
  if (target === "launchd") return mode === "central" ? "com.agent-bus.central.plist" : "com.agent-bus.edge.plist";
  if (target === "windows") return mode === "central" ? "agent-bus-central-service.ps1" : "agent-bus-edge-service.ps1";
  return mode === "central" ? "agent-bus-central.service" : "agent-bus-edge.service";
}

function defaultAgentBusPath() {
  if (process.platform === "win32") return path.join(process.cwd(), "agent-bus.cmd");
  return path.join(process.cwd(), "agent-bus");
}

function serviceInstallHint(target, file) {
  if (target === "systemd") return `Install hint: sudo cp ${file} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now ${path.basename(file)}`;
  if (target === "launchd") return `Install hint: cp ${file} ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/${path.basename(file)}`;
  return `Install hint: review ${file}, then run it from an elevated PowerShell prompt.`;
}

function serviceCommandParts(mode, configPath, agentBusPath = "", cwd = "") {
  const action = mode === "central" ? "serve" : "connect";
  const resolvedConfig = resolveServicePath(configPath, cwd);
  const modeArgs = mode === "central" ? ["--runtime", "python"] : [];
  if (agentBusPath) return [agentBusPath, action, "--config", resolvedConfig, ...modeArgs];
  const cliPath = process.argv[1] && fs.existsSync(process.argv[1]) ? process.argv[1] : path.join(__dirname, "agent-bus.mjs");
  return [process.execPath, cliPath, action, "--config", resolvedConfig, ...modeArgs];
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
  const context = await collectDoctorContext(args);
  const bundleOut = optionValue(args, "--bundle") || optionValue(args, "--diagnostics");
  const jsonOut = args.includes("--json");
  if (bundleOut) {
    writeDiagnosticsBundle(context, bundleOut, {
      includeHosts: args.includes("--include-hosts"),
      includePaths: args.includes("--include-paths")
    });
  }
  printDoctorResult(context.checks, jsonOut);
  if (context.checks.some((item) => item.status === "fail")) {
    process.exitCode = 1;
  }
}

async function diagnostics(args) {
  const action = args[0] || "bundle";
  if (action !== "bundle") {
    throw new Error("Usage: agent-bus diagnostics bundle --config edge.config.json --out diagnostics.json");
  }
  const bundleArgs = args.slice(1);
  const out = optionValue(bundleArgs, "--out") || optionValue(bundleArgs, "-o") || "agent-bus-diagnostics.json";
  const context = await collectDoctorContext(bundleArgs);
  const bundle = createDiagnosticsBundle(context, {
    includeHosts: bundleArgs.includes("--include-hosts"),
    includePaths: bundleArgs.includes("--include-paths")
  });
  if (out === "-") {
    printJson(bundle);
  } else {
    fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
    if (bundleArgs.includes("--json")) {
      printJson({ ok: true, out, counts: bundle.doctor.counts });
    } else {
      console.log(`Wrote ${out}`);
      console.log("Review before sharing. Secrets, hosts, and private paths are redacted by default.");
    }
  }
  if (context.checks.some((item) => item.status === "fail")) {
    process.exitCode = 1;
  }
}

async function collectDoctorContext(args) {
  const configPath = optionValue(args, "--config") || "edge.config.json";
  const gatewayArg = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL;
  const tokenArg = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN;
  const checks = [];
  let config = null;

  addCheck(checks, "pass", "Node.js runtime", process.version);
  addCheck(checks, "pass", "Agent Bus version", readPackageVersion());

  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!isPlainObject(config)) throw new Error("edge config must be a JSON object");
    addCheck(checks, "pass", "Read edge config", configPath);
  } catch (err) {
    addCheck(checks, "fail", "Read edge config", err.message);
    return {
      configPath,
      config: null,
      gatewayUrl: gatewayArg || "",
      tokenPresent: Boolean(tokenArg),
      configDir: path.dirname(path.resolve(configPath)),
      checks
    };
  }

  const gatewayUrl = gatewayArg || config.gatewayUrl || "http://127.0.0.1:8788";
  const token = tokenArg || config.token || "";
  const configDir = path.dirname(path.resolve(configPath));
  validateEdgeConfig(checks, config, gatewayUrl, token, configDir);
  checkConfiguredTools(checks, config, configDir);

  await checkGateway(checks, gatewayUrl, token, config);
  await checkLocalProbe(checks, configPath);

  return {
    configPath,
    config,
    gatewayUrl,
    tokenPresent: Boolean(token && !isPlaceholder(token)),
    configDir,
    checks
  };
}

async function detect(args) {
  const tools = await discoverLocalTools();
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      ok: true,
      hostname: os.hostname(),
      tools
    }, null, 2));
    return;
  }
  printToolDetection(tools);
}

async function openclaw(args) {
  const action = args[0] || "prepare";
  if (action === "prepare") {
    prepareOpenClawAgentBus(args.slice(1));
    return;
  }
  throw new Error("Usage: agent-bus openclaw prepare [--config file] [--workspace dir] [--agent-id agent-bus] [--context-tokens 48000]");
}

function prepareOpenClawAgentBus(args) {
  const agentId = sanitizeOpenClawAgentId(optionValue(args, "--agent-id") || process.env.OPENCLAW_AGENT_ID || "agent-bus");
  const configPath = path.resolve(expandHome(optionValue(args, "--config") || process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), ".openclaw", "openclaw.json")));
  const workspaceDir = path.resolve(expandHome(optionValue(args, "--workspace") || path.join(process.cwd(), "openclaw-workspace")));
  const keepBootstrap = args.includes("--keep-bootstrap");
  const contextTokens = args.includes("--no-context-cap")
    ? 0
    : positiveIntegerOption(optionValue(args, "--context-tokens") || process.env.OPENCLAW_AGENT_BUS_CONTEXT_TOKENS || "48000", 48000, 200000);

  const config = readJsonObjectIfExists(configPath);
  config.agents = isPlainObject(config.agents) ? config.agents : {};
  const hadExplicitAgentList = Array.isArray(config.agents.list);
  config.agents.list = hadExplicitAgentList ? config.agents.list : [];
  if (!hadExplicitAgentList && agentId !== "main") {
    config.agents.list.push({
      id: "main",
      default: true,
      workspace: defaultOpenClawWorkspace(config)
    });
  }
  const existingIndex = config.agents.list.findIndex((agent) => isPlainObject(agent) && agent.id === agentId);
  const existing = existingIndex >= 0 ? config.agents.list[existingIndex] : {};
  const existingParams = isPlainObject(existing.params) ? existing.params : {};
  const preparedAgent = {
    ...existing,
    id: agentId,
    name: existing.name || "Agent Bus",
    workspace: workspaceDir,
    params: {
      ...existingParams,
      cacheRetention: existingParams.cacheRetention || "long"
    }
  };
  if (!Object.hasOwn(existing, "contextTokens") && contextTokens > 0) {
    preparedAgent.contextTokens = contextTokens;
  }
  if (!Object.hasOwn(existing, "skills")) {
    preparedAgent.skills = [];
  }
  if (!String(existing.systemPromptOverride || "").trim()) {
    preparedAgent.systemPromptOverride = OPENCLAW_AGENT_BUS_SYSTEM_PROMPT;
  }
  if (existingIndex >= 0) {
    config.agents.list[existingIndex] = preparedAgent;
  } else {
    config.agents.list.push(preparedAgent);
  }

  fs.mkdirSync(workspaceDir, { recursive: true });
  writeWorkspaceFileIfMissing(workspaceDir, "AGENTS.md", OPENCLAW_AGENT_BUS_AGENTS_MD);
  writeWorkspaceFileIfMissing(workspaceDir, "TOOLS.md", OPENCLAW_AGENT_BUS_TOOLS_MD);
  writeWorkspaceFileIfMissing(workspaceDir, "IDENTITY.md", OPENCLAW_AGENT_BUS_IDENTITY_MD);
  writeWorkspaceFileIfMissing(workspaceDir, "USER.md", OPENCLAW_AGENT_BUS_USER_MD);
  writeWorkspaceFileIfMissing(workspaceDir, "SOUL.md", OPENCLAW_AGENT_BUS_SOUL_MD);
  writeWorkspaceFileIfMissing(workspaceDir, "HEARTBEAT.md", OPENCLAW_AGENT_BUS_HEARTBEAT_MD);
  const archivedBootstrap = keepBootstrap ? "" : archiveBootstrapFile(workspaceDir);
  markOpenClawWorkspaceComplete(workspaceDir);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });

  console.log(`Prepared OpenClaw agent: ${agentId}`);
  console.log(`Config: ${configPath}`);
  console.log(`Workspace: ${workspaceDir}`);
  if (preparedAgent.contextTokens) console.log(`Context cap: ${preparedAgent.contextTokens} tokens`);
  if (archivedBootstrap) console.log(`Archived bootstrap: ${archivedBootstrap}`);
  console.log(`Run command: OPENCLAW_AGENT_ID=${agentId} ./scripts/openclaw-agent-bus.sh`);
}

async function pair(args) {
  const action = args[0];
  if (action === "create") {
    await createPairCode(args.slice(1));
    return;
  }
  if (action === "join") {
    await joinPairCode(args.slice(1));
    return;
  }
  throw new Error("Usage: agent-bus pair create|join [options]");
}

async function createPairCode(args) {
  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "http://127.0.0.1:8788";
  const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN || "";
  if (!token) {
    throw new Error("pair create requires --token or AGENT_BUS_TOKEN.");
  }
  const preset = optionValue(args, "--preset") || "";
  if (preset) edgeTemplate(preset);
  const ttlSeconds = positiveIntegerOption(optionValue(args, "--ttl-seconds") || optionValue(args, "--ttl"), 600, 86400);
  const body = {
    ttlSeconds,
    gatewayUrl: gateway
  };
  const nodeId = optionValue(args, "--node-id");
  const label = optionValue(args, "--label");
  if (preset) body.agentPreset = preset;
  if (nodeId) body.nodeId = nodeId;
  if (label) body.label = label;
  const result = await postJson(gateway, "/pair-codes", token, body, 10000);
  console.log(JSON.stringify({
    ok: true,
    code: result.code,
    expires_at: result.expires_at,
    gatewayUrl: result.gatewayUrl,
    agentPreset: result.agentPreset || preset || null,
    join_hint: result.join_hint
  }, null, 2));
}

async function joinPairCode(args) {
  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "http://127.0.0.1:8788";
  const code = optionValue(args, "--code");
  if (!code) {
    throw new Error("pair join requires --code.");
  }
  const out = optionValue(args, "--out") || "edge.config.json";
  const force = args.includes("--force");
  if (fs.existsSync(out) && !force) {
    throw new Error(`Refusing to overwrite ${out}; pass --force to replace it.`);
  }
  const requestedPreset = optionValue(args, "--preset") || "";
  const nodeId = optionValue(args, "--node-id") || os.hostname();
  const result = await postJson(gateway, "/edge/pair", "", {
    code,
    nodeId,
    preset: requestedPreset || undefined
  }, 10000);
  const useAuto = args.includes("--auto") || (!requestedPreset && !result.agentPreset && args.includes("--detect"));
  const preset = requestedPreset || result.agentPreset || "codex";
  const config = useAuto
    ? await edgeAutoTemplate(args)
    : edgeTemplate(preset);
  config.nodeId = result.nodeId || nodeId;
  config.gatewayUrl = result.gatewayUrl || gateway;
  config.token = result.token || "";
  config.tokenScope = result.tokenScope || "edge";
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Wrote ${out}`);
  console.log(`Next: agent-bus doctor --config ${out}`);
}

function validateEdgeConfig(checks, config, gatewayUrl, token, baseDir) {
  if (config.nodeId) {
    addCheck(checks, "pass", "nodeId", String(config.nodeId));
  } else {
    addCheck(checks, "warn", "nodeId", "missing; hostname will be used", "Set nodeId to a stable machine id so other agents can recognize this edge.");
  }

  const gatewayStatus = validateGatewayUrl(gatewayUrl);
  if (gatewayStatus.ok && !isPlaceholder(gatewayUrl)) {
    addCheck(checks, "pass", "gatewayUrl", gatewayUrl);
  } else {
    addCheck(checks, "fail", "gatewayUrl", gatewayStatus.error || "set gatewayUrl or AGENT_BUS_GATEWAY_URL", "Use the public central gateway URL, for example https://example.com/agent-bus.");
  }

  if (token && !isPlaceholder(token)) {
    addCheck(checks, "pass", "token", "configured");
  } else {
    addCheck(checks, "warn", "token", "missing or placeholder; protected gateway checks will fail", "Pair the edge or set AGENT_BUS_TOKEN before starting the service.");
  }

  if (token && !isPlaceholder(token)) {
    const scope = String(config.tokenScope || config.token_scope || "").trim();
    if (!scope) {
      addCheck(checks, "warn", "token scope", "not declared", "Set tokenScope to edge for edge configs, or admin only for operator configs.");
    } else if (["edge", "admin"].includes(scope)) {
      addCheck(checks, "pass", "token scope", scope);
    } else {
      addCheck(checks, "warn", "token scope", scope, "Expected tokenScope to be edge or admin.");
    }
  }

  if (!Array.isArray(config.agents)) {
    addCheck(checks, "fail", "agents", "config.agents must be an array", "Run agent-bus init edge --preset echo --out edge.config.json for a known-good shape.");
    return;
  }

  const duplicateIds = duplicateValues(config.agents.map((agent) => agent?.id).filter(Boolean));
  if (duplicateIds.length) {
    addCheck(checks, "fail", "agent ids", `duplicates: ${duplicateIds.join(", ")}`, "Each agent id must be unique across the gateway.");
  }

  const disabled = config.agents.filter((agent) => agent.enabled === false);
  if (disabled.length) {
    addCheck(checks, "pass", "disabled agents", `${disabled.length}: ${disabled.map((agent) => agent.id || "(missing id)").join(", ")}`);
  }

  const agents = config.agents.filter((agent) => agent.enabled !== false);
  if (agents.length) {
    addCheck(checks, "pass", "enabled agents", agents.map((agent) => agent.id).join(", "));
  } else {
    addCheck(checks, "fail", "enabled agents", "no enabled agents configured", "Enable at least one echo, command, Codex, OpenClaw, Hermes, or Ollama agent.");
  }

  for (const agent of agents) {
    const prefix = `agent ${agent.id || "(missing id)"}`;
    const adapter = agent.adapter || "command";
    if (!agent.id) addCheck(checks, "fail", `${prefix} id`, "missing", "Give every enabled agent a stable id.");
    if (!["command", "echo"].includes(adapter)) {
      addCheck(checks, "fail", `${prefix} adapter`, adapter, "Supported adapters are command and echo.");
    }
    if ((agent.adapter || "command") === "command" && !agent.runCommand) {
      addCheck(checks, "fail", `${prefix} runCommand`, "missing", "Command agents need a runCommand that can read AGENT_MESSAGE or AGENT_MESSAGE_FILE.");
    }
    if ((agent.adapter || "command") === "command" && isPlaceholder(agent.runCommand || "")) {
      addCheck(checks, "warn", `${prefix} runCommand`, "contains placeholder", "Replace template placeholders before starting the edge service.");
    }
    if ((agent.adapter || "command") === "command" && (agent.cwd || config.cwd)) {
      const cwdPath = resolveConfigPath(agent.cwd || config.cwd, baseDir);
      if (isDirectory(cwdPath)) {
        addCheck(checks, "pass", `${prefix} cwd`, cwdPath);
      } else {
        addCheck(checks, "fail", `${prefix} cwd`, `${cwdPath} not found`, "Create the directory or point cwd at the workspace this agent should use.");
      }
    }
    const pingUrl = agent.pingUrl || agent.healthUrl || agent.modelUrl || "";
    if (!pingUrl) {
      addCheck(checks, "warn", `${prefix} pingUrl`, "not configured", "Add pingUrl for shallow online checks; it should be a URL probe, not a real model request.");
    } else if (isPlaceholder(pingUrl)) {
      addCheck(checks, "warn", `${prefix} pingUrl`, "contains placeholder", "Use a cheap health endpoint such as /v1/models or a provider status URL.");
    } else {
      addCheck(checks, "pass", `${prefix} pingUrl`, pingUrl);
    }
  }
}

async function checkGateway(checks, gatewayUrl, token, config = {}) {
  if (!gatewayUrl || isPlaceholder(gatewayUrl) || !validateGatewayUrl(gatewayUrl).ok) return;
  const wellKnown = await fetchJson(gatewayUrl, "/.well-known/agent-bus.json", "", 8000);
  if (wellKnown.ok) {
    addCheck(checks, "pass", "gateway well-known", wellKnown.data.protocol || "ok");
  } else {
    addCheck(checks, "warn", "gateway well-known", wellKnown.error, "The gateway can still work, but discovery clients may not recognize it automatically.");
  }

  const health = await fetchJson(gatewayUrl, "/health", "", 8000);
  if (health.ok) {
    addCheck(checks, "pass", "gateway health", gatewayHealthSummary(health.data));
  } else {
    addCheck(checks, "fail", "gateway health", health.error, "Check that the central gateway is running and that the URL includes any reverse-proxy path prefix.");
  }

  if (!token || isPlaceholder(token)) return;
  const manifest = await fetchJson(gatewayUrl, "/v1/agent-bus/manifest", token, 8000);
  if (manifest.ok) {
    addCheck(checks, "pass", "gateway manifest", `${manifest.data.protocol || "agent-bus"} agents=${manifest.data.agents?.length ?? "?"}`);
  } else {
    addEndpointFailure(checks, "gateway manifest", manifest, "Manifest requires an admin or edge token on modern gateways.");
  }

  const agents = await fetchJson(gatewayUrl, "/agents", token, 8000);
  if (agents.ok) {
    const list = asList(agents.data);
    const detail = list.length ? `${list.length} online: ${sampleIds(list).join(", ")}` : "0 online agents";
    addCheck(checks, list.length ? "pass" : "warn", "gateway agents", detail, list.length ? "" : "Start at least one edge service and wait for it to register.");
    checkConfiguredAgentsOnline(checks, config, list);
  } else {
    addEndpointFailure(checks, "gateway agents", agents, "The token needs admin or edge scope to read /agents.");
  }

  const nodes = await fetchJson(gatewayUrl, "/nodes", token, 8000);
  if (nodes.ok) {
    const list = asList(nodes.data);
    const online = list.filter((node) => String(node.status || node.node_status || "").toLowerCase() === "online");
    const detail = list.length
      ? `${online.length}/${list.length} online: ${sampleNodeIds(list).join(", ")}`
      : "0 registered nodes";
    addCheck(checks, list.length ? "pass" : "warn", "gateway nodes", detail, list.length ? "" : "Start an edge service so the gateway can register a node.");
    checkConfiguredNodeRegistered(checks, config, list);
  } else {
    addEndpointFailure(checks, "gateway nodes", nodes, "The token needs admin or edge scope to read /nodes.");
  }

  const models = await fetchJson(gatewayUrl, "/v1/models", token, 8000);
  if (models.ok) {
    const list = asList(models.data);
    const agentModels = list.filter((item) => String(item.id || "").startsWith("agent:")).length;
    const backendModels = Math.max(0, list.length - agentModels);
    addCheck(checks, list.length ? "pass" : "warn", "gateway models", `${list.length} total; agent=${agentModels} backend=${backendModels}`, list.length ? "" : "Configure a backend model or start online agents with agent-backed models enabled.");
  } else {
    addEndpointFailure(checks, "gateway models", models, "GET /v1/models is a cheap list call. Edge tokens can read it only when allowEdgeAgentModels is enabled.");
  }

  const rooms = await fetchJson(gatewayUrl, "/rooms", token, 8000);
  if (rooms.ok) {
    const list = asList(rooms.data);
    const active = list.filter(isActiveRoom).length;
    addCheck(checks, "pass", "gateway rooms", `${list.length} rooms; active=${active}`);
  } else {
    const hint = isUnauthorizedResult(rooms)
      ? "Room listing is admin-only; use an admin token for operator checks."
      : "If this is an older gateway, upgrade central_gateway.py to enable room diagnostics.";
    addEndpointFailure(checks, "gateway rooms", rooms, hint);
  }
}

function validateGatewayUrl(value) {
  const text = String(value || "").trim();
  if (!text) return { ok: false, error: "set gatewayUrl or AGENT_BUS_GATEWAY_URL" };
  if (isPlaceholder(text)) return { ok: false, error: "contains placeholder" };
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) {
      return { ok: false, error: "must use http or https" };
    }
    return { ok: true, error: "" };
  } catch (err) {
    return { ok: false, error: err.message || "invalid URL" };
  }
}

function gatewayHealthSummary(data) {
  const parts = [
    `nodes=${data?.nodes ?? "?"}`,
    `agents=${data?.agents ?? "?"}`
  ];
  if (data?.registered_nodes !== undefined) parts.push(`registered_nodes=${data.registered_nodes}`);
  if (data?.registered_agents !== undefined) parts.push(`registered_agents=${data.registered_agents}`);
  if (data?.queued !== undefined) parts.push(`queued=${data.queued}`);
  return parts.join(" ");
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rooms)) return value.rooms;
  if (Array.isArray(value?.agents)) return value.agents;
  if (Array.isArray(value?.nodes)) return value.nodes;
  return [];
}

function sampleIds(items, limit = 5) {
  return items
    .map((item) => String(item?.id || item?.agent_id || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function sampleNodeIds(items, limit = 5) {
  return items
    .map((item) => String(item?.node_id || item?.id || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function checkConfiguredAgentsOnline(checks, config, gatewayAgents) {
  const expected = configuredEnabledAgentIds(config);
  if (!expected.length) return;
  const online = new Set(gatewayAgents.map((agent) => String(agent?.id || "")));
  const missing = expected.filter((id) => !online.has(id));
  if (missing.length) {
    addCheck(checks, "warn", "configured agents online", `missing: ${missing.join(", ")}`, "Start or restart agent-bus connect on this edge and wait for registration.");
  } else {
    addCheck(checks, "pass", "configured agents online", expected.join(", "));
  }
}

function checkConfiguredNodeRegistered(checks, config, gatewayNodes) {
  const nodeId = String(config.nodeId || "").trim();
  if (!nodeId) return;
  const node = gatewayNodes.find((item) => String(item?.node_id || item?.id || "") === nodeId);
  if (!node) {
    addCheck(checks, "warn", "configured node registered", `${nodeId} not registered`, "Start agent-bus connect for this edge or check that nodeId matches the service config.");
    return;
  }
  const status = String(node.status || node.node_status || "unknown");
  addCheck(checks, status.toLowerCase() === "online" ? "pass" : "warn", "configured node registered", `${nodeId} status=${status}`);
}

function configuredEnabledAgentIds(config) {
  return Array.isArray(config.agents)
    ? config.agents
      .filter((agent) => agent?.enabled !== false && agent?.id)
      .map((agent) => String(agent.id))
    : [];
}

function addEndpointFailure(checks, name, result, hint) {
  addCheck(checks, "warn", name, result?.error || "request failed", hint);
}

function isUnauthorizedResult(result) {
  return [401, 403].includes(httpStatusFromError(result?.error));
}

function httpStatusFromError(value) {
  const match = String(value || "").match(/^(\d{3})\b/);
  return match ? Number(match[1]) : 0;
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values.map((item) => String(item || "").trim()).filter(Boolean)) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function resolveConfigPath(value, baseDir) {
  const text = expandHome(value);
  if (path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text)) return text;
  return path.resolve(baseDir || process.cwd(), text);
}

function isDirectory(value) {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
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

async function postJson(gateway, pathname, token, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(gatewayEndpoint(gateway, pathname), {
      method: "POST",
      signal: controller.signal,
      headers,
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(text || `${res.status} ${res.statusText}`);
    }
    return text.trim() ? JSON.parse(text) : {};
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

function addCheck(checks, status, name, detail, hint = "") {
  checks.push({
    status,
    name,
    detail: detail || "",
    ...(hint ? { hint } : {})
  });
}

function printDoctorResult(checks, jsonOut = false) {
  if (jsonOut) {
    console.log(JSON.stringify(doctorResult(checks), null, 2));
    return;
  }
  printDoctor(checks);
}

function doctorResult(checks) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const item of checks) {
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
  }
  return {
    ok: counts.fail === 0,
    counts,
    checks
  };
}

function writeDiagnosticsBundle(context, out, options = {}) {
  const bundle = createDiagnosticsBundle(context, options);
  if (out === "-") {
    printJson(bundle);
    return;
  }
  fs.writeFileSync(out, `${JSON.stringify(bundle, null, 2)}\n`, { mode: 0o600 });
}

function createDiagnosticsBundle(context, options = {}) {
  const config = isPlainObject(context.config) ? context.config : null;
  const bundle = {
    schema: "agent_bus.diagnostics.v1",
    generated_at: new Date().toISOString(),
    package: {
      name: "agent-bus-cli",
      version: readPackageVersion()
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      release: os.release()
    },
    command: {
      cwd: process.cwd(),
      config_path: context.configPath
    },
    config: config ? diagnosticsConfigSummary(config, context.gatewayUrl, context.tokenPresent) : {
      readable: false
    },
    doctor: doctorResult(context.checks || []),
    sharing_note: "This bundle is redacted for public issue triage. Review it before sharing."
  };
  return redactDiagnosticsValue(bundle, {
    redactHosts: !options.includeHosts,
    redactPaths: !options.includePaths
  });
}

function diagnosticsConfigSummary(config, gatewayUrl, tokenPresent) {
  return {
    readable: true,
    nodeId: config.nodeId || "",
    gatewayUrl: gatewayUrl || config.gatewayUrl || "",
    token: tokenPresent ? "configured" : "missing_or_placeholder",
    tokenScope: config.tokenScope || config.token_scope || "",
    pollTimeoutMs: config.pollTimeoutMs,
    idleDelayMs: config.idleDelayMs,
    defaultTimeoutMs: config.defaultTimeoutMs,
    agents: Array.isArray(config.agents)
      ? config.agents.map((agent) => ({
        id: agent?.id || "",
        kind: agent?.kind || "",
        role: agent?.role || "",
        enabled: agent?.enabled !== false,
        adapter: agent?.adapter || "command",
        capabilities: Array.isArray(agent?.capabilities) ? agent.capabilities : [],
        command: agent?.runCommand ? configuredExecutable(agent.runCommand) || "configured" : "",
        hasRunCommand: Boolean(agent?.runCommand),
        cwd: agent?.cwd || "",
        pingUrl: agent?.pingUrl || agent?.healthUrl || agent?.modelUrl || ""
      }))
      : []
  };
}

function redactDiagnosticsValue(value, options = {}, key = "") {
  if (isSensitiveExportKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactDiagnosticsText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticsValue(item, options));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([itemKey, item]) => [itemKey, redactDiagnosticsValue(item, options, itemKey)]));
  }
  return value;
}

function redactDiagnosticsText(value, options = {}) {
  let text = redactExportText(value);
  if (options.redactHosts !== false) {
    text = text.replace(/\bhttps?:\/\/[^\s"',)]+/gi, (match) => redactUrlForSharing(match));
  }
  if (options.redactPaths !== false) {
    text = text
      .replace(/\b[A-Za-z]:\\(?:[^\\\s"',}]+\\)*[^\\\s"',}]*/g, "[REDACTED_PATH]")
      .replace(/(?:^|[\s"'(])\/(?:Users|home|root)\/[^\s"',)}]+/g, (match) => `${match[0].trim() ? match[0] : ""}[REDACTED_PATH]`);
  }
  return text;
}

function redactUrlForSharing(value) {
  try {
    const url = new URL(value);
    const pathValue = url.pathname && url.pathname !== "/" ? url.pathname : "";
    const query = url.search ? "?[REDACTED_QUERY]" : "";
    return `${url.protocol}//[REDACTED_HOST]${pathValue}${query}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function printDoctor(checks) {
  for (const item of checks) {
    const mark = item.status === "pass" ? "OK" : item.status === "warn" ? "WARN" : "FAIL";
    console.log(`${mark.padEnd(4)} ${item.name}${item.detail ? ` - ${item.detail}` : ""}`);
    if (item.hint) console.log(`     hint: ${item.hint}`);
  }
}

function isPlaceholder(value) {
  return /YOUR-|change-me|replace-with|example\.com/i.test(String(value || ""));
}

function trimOneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

async function initConfig(args) {
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
    : args.includes("--auto")
      ? await edgeAutoTemplate(args)
      : edgeTemplate(optionValue(args, "--preset") || "echo");
  if (kind === "edge") {
    const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL;
    const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN;
    if (gateway) config.gatewayUrl = gateway;
    if (token) config.token = token;
  }
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
    edgeTokens: [],
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

function presetAgents() {
  return {
    echo: [{
      id: "local-echo",
      kind: "echo",
      role: "executor",
      enabled: true,
      adapter: "echo",
      capabilities: ["shell", "files"]
    }],
    codex: [codexAgent("codex")],
    openclaw: [openclawAgent("./scripts/openclaw-agent-bus.sh")],
    hermes: [hermesAgent(defaultHermesCommand())],
    ollama: [ollamaAgent("ollama", "llama3.1")]
  };
}

function edgeTemplate(preset) {
  const agents = presetAgents();
  if (!agents[preset]) {
    throw new Error(`Unknown edge preset: ${preset}`);
  }
  return edgeConfigWithAgents(agents[preset]);
}

async function edgeAutoTemplate(args = []) {
  const include = parseListOption(optionValue(args, "--tools"));
  const tools = await discoverLocalTools();
  const selected = tools.filter((tool) => {
    if (include.length && !include.includes(tool.id)) return false;
    return tool.available && tool.agent;
  });
  if (!selected.length) {
    const detected = tools.map((tool) => `${tool.id}:${tool.available ? "found" : "missing"}`).join(", ");
    throw new Error(`No supported local AI tools were detected. Found: ${detected}. Install Codex, OpenClaw, Hermes, or Ollama, or use --preset echo.`);
  }
  const agents = selected.map((tool) => tool.agent);
  return edgeConfigWithAgents(agents);
}

function edgeConfigWithAgents(agents) {
  return {
    nodeId: safeId(os.hostname()),
    gatewayUrl: "https://YOUR-GATEWAY-DOMAIN/agent-bus",
    token: "change-me-to-a-scoped-edge-token",
    tokenScope: "edge",
    pollTimeoutMs: 25000,
    idleDelayMs: 1000,
    defaultTimeoutMs: 600000,
    healthProbeIntervalMs: 60000,
    healthProbeTimeoutMs: 5000,
    agents
  };
}

async function discoverLocalTools() {
  const host = safeId(os.hostname() || "local");
  const codexPath = findExecutable("codex");
  const hermesPath = findExecutable("hermes", commonHermesPaths());
  const ollamaPath = findExecutable("ollama");
  const openclawCommand = process.env.OPENCLAW_AGENT_COMMAND || "";
  const openclawScript = findFirstExisting([
    path.resolve(process.cwd(), "scripts", "openclaw-agent-bus.sh"),
    path.resolve(__dirname, "scripts", "openclaw-agent-bus.sh"),
    "/root/agent-bus/scripts/openclaw-agent-bus.sh"
  ]);
  const hermesScript = os.platform() === "win32" ? "" : findFirstExisting([
    path.resolve(process.cwd(), "scripts", "hermes-agent-bus.sh"),
    path.resolve(__dirname, "scripts", "hermes-agent-bus.sh"),
    "/root/agent-bus/scripts/hermes-agent-bus.sh"
  ]);
  const openclawPath = openclawCommand ? "" : findExecutable("openclaw");
  const openclawRunner = openclawCommand || (openclawPath && openclawScript) || openclawPath;
  const ollamaModels = ollamaPath ? await readOllamaModels() : [];
  const ollamaModel = ollamaModels[0] || process.env.AGENT_BUS_OLLAMA_MODEL || "llama3.1";
  const tools = [
    {
      id: "codex",
      name: "Codex",
      available: Boolean(codexPath),
      command: codexPath || "codex",
      version: codexPath ? commandVersion(codexPath) : "",
      agent: codexPath ? codexAgent(codexPath, `codex-${host}`) : null
    },
    {
      id: "openclaw",
      name: "OpenClaw",
      available: Boolean(openclawRunner),
      command: openclawRunner || "openclaw",
      version: openclawPath ? commandVersion(openclawPath) : "",
      note: openclawCommand
        ? "Using OPENCLAW_AGENT_COMMAND."
        : openclawPath && openclawScript
          ? "Using bundled/openclaw bridge script."
          : openclawPath
            ? "Generic OpenClaw command detected; review runCommand after generation."
            : "Not found. Set OPENCLAW_AGENT_COMMAND or add openclaw to PATH.",
      agent: openclawRunner
        ? openclawAgent(openclawRunner, `openclaw-${host}`, {
          generic: Boolean(!openclawCommand && !openclawScript && openclawPath),
          rawCommand: Boolean(openclawCommand)
        })
        : null
    },
    {
      id: "hermes",
      name: "Hermes",
      available: Boolean(hermesPath),
      command: hermesScript || hermesPath || defaultHermesCommand(),
      version: hermesPath ? commandVersion(hermesPath) : "",
      note: hermesScript
        ? "Using bundled Hermes Agent Bus bridge script for stable prompt-cache keys."
        : "",
      agent: hermesPath ? hermesAgent(hermesPath, `hermes-${host}`, { script: hermesScript }) : null
    },
    {
      id: "ollama",
      name: "Ollama",
      available: Boolean(ollamaPath),
      command: ollamaPath || "ollama",
      version: ollamaPath ? commandVersion(ollamaPath) : "",
      models: ollamaModels,
      note: ollamaModels.length ? `Defaulting to local model ${ollamaModel}.` : "Set AGENT_BUS_OLLAMA_MODEL or edit runCommand if llama3.1 is not installed.",
      agent: ollamaPath ? ollamaAgent(ollamaPath, ollamaModel, `ollama-${host}`) : null
    }
  ];
  return tools;
}

function printToolDetection(tools) {
  for (const tool of tools) {
    const mark = tool.available ? "FOUND" : "MISS ";
    console.log(`${mark} ${tool.id.padEnd(9)} ${tool.command || ""}${tool.version ? ` - ${tool.version}` : ""}`);
    if (tool.note) console.log(`      ${tool.note}`);
    if (tool.agent) console.log(`      agent: ${tool.agent.id} (${tool.agent.kind}/${tool.agent.role})`);
  }
  const available = tools.filter((tool) => tool.available).map((tool) => tool.id);
  if (available.length) {
    console.log(`\nNext: agent-bus init edge --auto --out edge.config.json`);
  } else {
    console.log("\nNo supported tools found. Install Codex, OpenClaw, Hermes, or Ollama, then run agent-bus detect again.");
  }
}

function checkConfiguredTools(checks, config, baseDir) {
  for (const agent of config.agents || []) {
    if (agent.enabled === false || (agent.adapter || "command") !== "command") continue;
    const command = configuredExecutable(agent.runCommand || "");
    if (!command) {
      addCheck(checks, "warn", `agent ${agent.id} tool`, "could not parse runCommand");
      continue;
    }
    const resolved = resolveConfiguredExecutable(command, baseDir);
    if (resolved) {
      addCheck(checks, "pass", `agent ${agent.id} tool`, resolved);
    } else {
      addCheck(checks, "warn", `agent ${agent.id} tool`, `${command} not found; run agent-bus detect`);
    }
  }
}

function codexAgent(commandPath, id = "codex-local") {
  return {
    id,
    kind: "codex",
    role: "coder",
    enabled: true,
    adapter: "command",
    capabilities: ["code", "review", "shell", "files"],
    pingUrl: "https://api.openai.com/v1/models",
    runCommand: `${quoteCommand(commandPath)} exec --color never --dangerously-bypass-approvals-and-sandbox ${messageArgument()}${nullInputRedirect()}`
  };
}

function openclawAgent(commandPath, id = "openclaw-local", options = {}) {
  const command = String(commandPath || "").trim();
  return {
    id,
    kind: "openclaw",
    role: "executor",
    enabled: true,
    adapter: "command",
    capabilities: ["shell", "files", "browser", "cron", "skills"],
    pingUrl: "https://YOUR-MODEL-GATEWAY/v1/models",
    runCommand: options.rawCommand
      ? command
      : options.generic
      ? `${quoteCommand(command)} ${messageArgument()}`
      : `OPENCLAW_AGENT_ID=agent-bus ${quoteCommand(command)}`
  };
}

function hermesAgent(commandPath, id = "hermes-local", options = {}) {
  const script = options.script || "";
  return {
    id,
    kind: "hermes",
    role: "researcher",
    enabled: true,
    adapter: "command",
    capabilities: ["skills", "memory", "shell", "webhook", "cron"],
    pingUrl: "https://YOUR-MODEL-GATEWAY/v1/models",
    runCommand: script
      ? `HERMES_COMMAND=${quoteCommand(commandPath)} ${quoteCommand(script)}`
      : `${quoteCommand(commandPath)} chat -q ${messageArgument()} -Q`
  };
}

async function room(args) {
  const action = args[0] || "list";
  if (action === "list" || action === "ls") {
    return printJson(await gatewayJson("/rooms", { auth: true, args }));
  }
  if (action === "show" || action === "get") {
    const roomId = requiredPositional(args, 1, "room id");
    return printJson(await gatewayJson(`/rooms/${pathPart(roomId)}`, { auth: true, args }));
  }
  if (action === "export" || action === "dump") {
    const roomId = requiredPositional(args, 1, "room id");
    const format = optionValue(args, "--format") || (args.includes("--json") ? "json" : "markdown");
    const out = optionValue(args, "--out") || optionValue(args, "-o") || "";
    const roomData = await gatewayJson(`/rooms/${pathPart(roomId)}`, { auth: true, args });
    const exportData = args.includes("--no-redact") ? roomData : redactRoomExport(roomData);
    const reportsOnly = args.includes("--reports-only") || args.includes("--summary");
    let text = "";
    if (format === "json") {
      text = `${JSON.stringify(reportsOnly ? roomExportSummary(exportData) : exportData, null, 2)}\n`;
    } else if (format === "events" || format === "event-bundle" || format === "replay") {
      text = `${JSON.stringify(roomEventBundle(exportData, { reportsOnly }), null, 2)}\n`;
    } else if (format === "markdown" || format === "md") {
      text = formatRoomMarkdown(exportData, { reportsOnly });
    } else {
      throw new Error("room export --format must be markdown, json, or events.");
    }
    if (out) {
      fs.writeFileSync(path.resolve(out), text);
      return;
    }
    process.stdout.write(text);
    return;
  }
  if (action === "replay") {
    const input = optionValue(args, "--in") || optionValue(args, "--input") || requiredPositional(args, 1, "event bundle path");
    const format = optionValue(args, "--format") || (args.includes("--markdown") ? "markdown" : "json");
    const summary = replayRoomEvents(readJsonFile(input));
    const text = format === "markdown" || format === "md"
      ? formatRoomReplayMarkdown(summary)
      : `${JSON.stringify(summary, null, 2)}\n`;
    const out = optionValue(args, "--out") || optionValue(args, "-o") || "";
    if (out) {
      fs.writeFileSync(path.resolve(out), text);
      return;
    }
    process.stdout.write(text);
    return;
  }
  if (action === "create") {
    const goal = optionValue(args, "--goal") || optionValue(args, "--message") || "";
    const agents = csvOption(args, "--agents");
    if (!goal) throw new Error("room create requires --goal.");
    if (!agents.length) throw new Error("room create requires --agents a,b.");
    const wakeAgents = csvOption(args, "--wake-agents");
    const maxSteps = positiveIntegerOption(optionValue(args, "--max-steps") || optionValue(args, "--maxSteps"), 0, 1000);
    const autoRotate = booleanOption(args, "--auto-rotate", "--no-auto-rotate");
    const body = {
      title: optionValue(args, "--title") || undefined,
      trace_id: optionValue(args, "--trace-id") || optionValue(args, "--trace") || undefined,
      goal,
      agents,
      wakeAgents: wakeAgents.length ? wakeAgents : undefined,
      ...(maxSteps > 0 ? { maxSteps } : {}),
      ...(autoRotate === undefined ? {} : { autoRotate })
    };
    return printJson(await gatewayJson("/rooms", { auth: true, args, method: "POST", body }));
  }
  if (action === "wake") {
    const roomId = requiredPositional(args, 1, "room id");
    const agents = csvOption(args, "--agents");
    const singleAgent = optionValue(args, "--agent");
    const body = {
      reason: optionValue(args, "--reason") || optionValue(args, "--message") || "Manual wake.",
      trace_id: optionValue(args, "--trace-id") || optionValue(args, "--trace") || undefined,
      ...(agents.length ? { agents } : {}),
      ...(singleAgent ? { agent: singleAgent } : {})
    };
    return printJson(await gatewayJson(`/rooms/${pathPart(roomId)}/wake`, { auth: true, args, method: "POST", body }));
  }
  if (action === "pause") {
    const roomId = requiredPositional(args, 1, "room id");
    const body = {
      reason: optionValue(args, "--reason") || optionValue(args, "--message") || "Operator paused room."
    };
    return printJson(await gatewayJson(`/rooms/${pathPart(roomId)}/pause`, { auth: true, args, method: "POST", body }));
  }
  if (action === "message" || action === "say") {
    const roomId = requiredPositional(args, 1, "room id");
    const message = optionValue(args, "--message") || optionValue(args, "-m") || "";
    if (!message) throw new Error("room message requires --message.");
    const wake = booleanOption(args, "--wake", "--no-wake");
    const agents = csvOption(args, "--agents");
    const body = {
      message,
      speaker: optionValue(args, "--speaker") || "user",
      trace_id: optionValue(args, "--trace-id") || optionValue(args, "--trace") || undefined,
      ...(wake === undefined ? {} : { wake }),
      ...(agents.length ? { agents } : {})
    };
    return printJson(await gatewayJson(`/rooms/${pathPart(roomId)}/messages`, { auth: true, args, method: "POST", body }));
  }
  throw new Error("Usage: agent-bus room list|show|export|replay|create|wake|pause|message [options]");
}

async function trace(args) {
  const action = args[0] || "show";
  if (!["show", "get", "export", "dump"].includes(action)) {
    throw new Error("Usage: agent-bus trace show|export TRACE_ID [--format json|markdown] [--out file]");
  }
  const traceId = requiredPositional(args, 1, "trace id");
  const format = optionValue(args, "--format") || (args.includes("--json") ? "json" : action === "export" ? "json" : "human");
  const result = await gatewayJson(`/traces/${pathPart(traceId)}`, { auth: true, args });
  const out = optionValue(args, "--out") || optionValue(args, "-o") || "";
  let text = "";
  if (format === "json") {
    text = `${JSON.stringify(result, null, 2)}\n`;
  } else if (format === "markdown" || format === "md") {
    text = formatTraceMarkdown(result);
  } else if (format === "human" || format === "text") {
    text = formatTraceHuman(result);
  } else {
    throw new Error("trace --format must be json, markdown, or human.");
  }
  if (out) {
    fs.writeFileSync(path.resolve(out), text);
    return;
  }
  process.stdout.write(text);
}

function formatTraceHuman(traceData) {
  const s = traceData.summary || {};
  const lines = [
    `Trace ${traceData.trace_id}`,
    `Threads ${s.threads || 0}, rooms ${s.rooms || 0}, runs ${s.runs || 0}, events ${s.events || 0}`,
    `Agents: ${(s.agents || []).join(", ") || "-"}`,
    `Nodes: ${(s.nodes || []).join(", ") || "-"}`,
    `Statuses: ${(s.statuses || []).join(", ") || "-"}`
  ];
  if (traceData.runs?.length) {
    lines.push("", "Runs:");
    for (const run of traceData.runs) {
      const target = run.room_id ? ` room=${run.room_id}` : ` thread=${run.thread_id || "-"}`;
      lines.push(`- ${run.id}: ${run.status || "unknown"} agent=${run.agent_id || "-"} node=${run.node_id || "-"}${target}`);
    }
  }
  if (traceData.events?.length) {
    lines.push("", "Recent events:");
    for (const event of traceData.events.slice(-10)) {
      const stream = event.stream ? ` ${event.stream}` : "";
      lines.push(`- ${event.at || "-"} ${event.type || "event"}${stream} run=${event.run_id || "-"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatTraceMarkdown(traceData) {
  const s = traceData.summary || {};
  const lines = [
    `# Agent Bus Trace ${traceData.trace_id}`,
    "",
    `- Threads: ${s.threads || 0}`,
    `- Rooms: ${s.rooms || 0}`,
    `- Runs: ${s.runs || 0}`,
    `- Events: ${s.events || 0}`,
    `- Agents: ${(s.agents || []).join(", ") || "-"}`,
    `- Nodes: ${(s.nodes || []).join(", ") || "-"}`,
    `- Statuses: ${(s.statuses || []).join(", ") || "-"}`,
    ""
  ];
  if (traceData.rooms?.length) {
    lines.push("## Rooms", "");
    for (const room of traceData.rooms) {
      lines.push(`- \`${room.id}\`: ${room.status || "unknown"}; agents=${(room.agents || []).join(", ") || "-"}; updated=${room.updated_at || "-"}`);
    }
    lines.push("");
  }
  if (traceData.threads?.length) {
    lines.push("## Threads", "");
    for (const thread of traceData.threads) {
      lines.push(`- \`${thread.id}\`: ${thread.mode || "unknown"}; source=${thread.source || "-"}; created=${thread.created_at || "-"}`);
    }
    lines.push("");
  }
  if (traceData.runs?.length) {
    lines.push("## Runs", "");
    for (const run of traceData.runs) {
      const target = run.room_id ? `room=\`${run.room_id}\`` : `thread=\`${run.thread_id || "-"}\``;
      lines.push(`- \`${run.id}\`: ${run.status || "unknown"}; agent=${run.agent_id || "-"}; node=${run.node_id || "-"}; ${target}`);
      if (run.summary) lines.push(`  - Summary: ${oneLine(run.summary, 240)}`);
      if (run.stderr) lines.push(`  - Stderr: ${oneLine(run.stderr, 240)}`);
    }
    lines.push("");
  }
  if (traceData.events?.length) {
    lines.push("## Events", "");
    for (const event of traceData.events) {
      const stream = event.stream ? `/${event.stream}` : "";
      lines.push(`- ${event.at || "-"} \`${event.type || "event"}${stream}\` run=\`${event.run_id || "-"}\``);
    }
    lines.push("");
  }
  return `${lines.join("\n")}`;
}

function oneLine(value, limit = 240) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function redactRoomExport(value) {
  return redactRoomExportValue(value);
}

function redactRoomExportValue(value, key = "") {
  if (isSensitiveExportKey(key)) return "[REDACTED]";
  if (typeof value === "string") return redactExportText(value);
  if (Array.isArray(value)) return value.map((item) => redactRoomExport(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([itemKey, item]) => [itemKey, redactRoomExportValue(item, itemKey)]));
  }
  return value;
}

function isSensitiveExportKey(key) {
  return /^(?:api[_-]?key|token|secret|password|authorization|access[_-]?token|refresh[_-]?token)$/i.test(String(key || ""));
}

function redactExportText(value) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(abt_edge_[A-Za-z0-9_-]{12,})\b/g, "[REDACTED_EDGE_TOKEN]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(npm_[A-Za-z0-9]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(["']?)[^\s"',}]+/gi, "$1$2[REDACTED]")
    .replace(/:\/\/([^:/@\s]+):([^/@\s]+)@/g, "://[REDACTED]@");
}

function roomExportSummary(room) {
  return {
    id: room.id,
    trace_id: room.trace_id,
    title: room.title,
    goal: room.goal,
    status: room.status,
    created_at: room.created_at,
    updated_at: room.updated_at,
    agents: room.agents || [],
    reports: room.reports || room.blackboard?.reports || [],
    blackboard: {
      notes: room.blackboard?.notes || [],
      next_actions: room.blackboard?.next_actions || [],
      open_questions: room.blackboard?.open_questions || []
    },
    runs: (room.runs || []).map((run) => ({
      id: run.id,
      trace_id: run.trace_id,
      agent_id: run.agent_id,
      status: run.status,
      exit_code: run.exit_code ?? null,
      created_at: run.created_at,
      completed_at: run.completed_at
    }))
  };
}

function roomEventBundle(room, options = {}) {
  const events = [];
  const roomId = room.id || "";
  const reportsOnly = options.reportsOnly === true;
  const add = (type, at, actor, payload = {}, extra = {}) => {
    events.push({
      type,
      at: at || room.updated_at || room.created_at || new Date(0).toISOString(),
      actor: actor || "system",
      room_id: roomId,
      ...extra,
      payload
    });
  };

  add("room.created", room.created_at, "system", {
    title: room.title || "",
    goal: room.goal || "",
    status: room.status || "unknown",
    agents: room.agents || []
  });

  if (!reportsOnly) {
    for (const [index, message] of (room.messages || []).entries()) {
      add("room.message.added", message.at, message.speaker || message.role || "unknown", {
        index,
        role: message.role || "",
        speaker: message.speaker || "",
        content: message.content || ""
      });
    }
  }

  for (const run of room.runs || []) {
    add("run.queued", run.created_at, run.agent_id || "system", {
      agent_id: run.agent_id || "",
      node_id: run.node_id || "",
      kind: run.kind || "",
      role: run.role || ""
    }, { run_id: run.id || "" });
    if (run.started_at) {
      add("run.started", run.started_at, run.agent_id || "system", {
        agent_id: run.agent_id || "",
        node_id: run.node_id || ""
      }, { run_id: run.id || "" });
    }
    if (!reportsOnly) {
      for (const [index, event] of (run.events || []).entries()) {
        if (!event?.text && !event?.stream) continue;
        add("run.output", event.at || run.started_at || run.created_at, run.agent_id || "system", {
          index,
          stream: event.stream || "",
          text: event.text || ""
        }, { run_id: run.id || "" });
      }
    }
    if (isTerminalRunStatus(run.status)) {
      add(run.status === "completed" ? "run.completed" : "run.failed", run.completed_at || room.updated_at, run.agent_id || "system", {
        agent_id: run.agent_id || "",
        status: run.status || "unknown",
        exit_code: run.exit_code ?? null,
        stdout_bytes: Buffer.byteLength(run.stdout || "", "utf8"),
        stderr_bytes: Buffer.byteLength(run.stderr || "", "utf8")
      }, { run_id: run.id || "" });
    }
  }

  for (const [index, report] of (room.reports || room.blackboard?.reports || []).entries()) {
    add("room.report.added", report.at, report.speaker || report.agent_id || "unknown", {
      index,
      content: report.content || ""
    });
  }

  for (const [index, note] of (room.blackboard?.notes || []).entries()) {
    add("room.blackboard.updated", note.at, note.speaker || note.agent_id || "unknown", {
      index,
      content: note.content || ""
    });
  }

  if (room.status) {
    add("room.status.changed", room.updated_at || room.completed_at, "system", {
      status: room.status
    });
  }

  const sorted = events
    .map((event, index) => ({ ...event, _index: index }))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)) || left._index - right._index)
    .map((event, index) => {
      const { _index, ...clean } = event;
      return { id: `${roomId || "room"}:event:${String(index + 1).padStart(4, "0")}`, ...clean };
    });

  return {
    object: "agent_bus.room_event_bundle",
    protocol: "agent-bus.v1",
    generated_at: new Date().toISOString(),
    source: "room.snapshot",
    reports_only: reportsOnly,
    room: {
      id: roomId,
      title: room.title || "",
      status: room.status || "unknown",
      agents: room.agents || [],
      created_at: room.created_at || "",
      updated_at: room.updated_at || ""
    },
    counts: countRoomEvents(sorted),
    events: sorted
  };
}

function replayRoomEvents(bundle) {
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.events)) {
    throw new Error("room replay requires a JSON event bundle with an events array.");
  }
  const summary = {
    object: "agent_bus.room_replay",
    protocol: bundle.protocol || "agent-bus.v1",
    replayed_at: new Date().toISOString(),
    source: bundle.object || "unknown",
    room: {
      id: bundle.room?.id || "",
      title: bundle.room?.title || "",
      status: bundle.room?.status || "unknown",
      agents: bundle.room?.agents || []
    },
    counts: {
      events: 0,
      messages: 0,
      reports: 0,
      blackboard_updates: 0,
      runs: 0,
      completed_runs: 0,
      failed_runs: 0,
      output_events: 0,
      output_bytes: 0
    },
    runs: [],
    reports: [],
    blackboard: []
  };
  const runs = new Map();
  for (const event of bundle.events) {
    summary.counts.events += 1;
    if (event.type === "room.created") {
      summary.room.id ||= event.room_id || "";
      summary.room.title ||= event.payload?.title || "";
      summary.room.status = event.payload?.status || summary.room.status;
      summary.room.agents = event.payload?.agents || summary.room.agents;
    } else if (event.type === "room.status.changed") {
      summary.room.status = event.payload?.status || summary.room.status;
    } else if (event.type === "room.message.added") {
      summary.counts.messages += 1;
    } else if (event.type === "room.report.added") {
      summary.counts.reports += 1;
      summary.reports.push({
        at: event.at,
        speaker: event.actor,
        content: event.payload?.content || ""
      });
    } else if (event.type === "room.blackboard.updated") {
      summary.counts.blackboard_updates += 1;
      summary.blackboard.push({
        at: event.at,
        speaker: event.actor,
        content: event.payload?.content || ""
      });
    } else if (event.type === "run.queued") {
      const run = ensureReplayRun(runs, event);
      run.status = "queued";
      run.created_at = event.at;
      run.agent_id = event.payload?.agent_id || event.actor || run.agent_id;
    } else if (event.type === "run.started") {
      const run = ensureReplayRun(runs, event);
      run.status = "running";
      run.started_at = event.at;
    } else if (event.type === "run.output") {
      const run = ensureReplayRun(runs, event);
      const bytes = Buffer.byteLength(event.payload?.text || "", "utf8");
      run.output_events += 1;
      run.output_bytes += bytes;
      summary.counts.output_events += 1;
      summary.counts.output_bytes += bytes;
    } else if (event.type === "run.completed" || event.type === "run.failed") {
      const run = ensureReplayRun(runs, event);
      run.status = event.payload?.status || (event.type === "run.completed" ? "completed" : "failed");
      run.completed_at = event.at;
      run.exit_code = event.payload?.exit_code ?? null;
      if (event.type === "run.completed") summary.counts.completed_runs += 1;
      if (event.type === "run.failed") summary.counts.failed_runs += 1;
    }
  }
  summary.runs = [...runs.values()].sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")));
  summary.counts.runs = summary.runs.length;
  return summary;
}

function ensureReplayRun(runs, event) {
  const runId = event.run_id || "run_unknown";
  if (!runs.has(runId)) {
    runs.set(runId, {
      id: runId,
      agent_id: event.payload?.agent_id || event.actor || "",
      status: "unknown",
      created_at: "",
      started_at: "",
      completed_at: "",
      exit_code: null,
      output_events: 0,
      output_bytes: 0
    });
  }
  return runs.get(runId);
}

function countRoomEvents(events) {
  const counts = { events: events.length };
  for (const event of events) {
    counts[event.type] = (counts[event.type] || 0) + 1;
  }
  return counts;
}

function isTerminalRunStatus(status) {
  return ["completed", "failed", "error", "cancelled", "canceled", "skipped"].includes(String(status || "").toLowerCase());
}

function formatRoomReplayMarkdown(summary) {
  const lines = [];
  lines.push(`# Agent Bus Room Replay: ${summary.room.title || summary.room.id || "untitled"}`);
  lines.push("");
  lines.push(`- room: \`${summary.room.id || "-"}\``);
  lines.push(`- status: \`${summary.room.status || "unknown"}\``);
  lines.push(`- agents: ${formatInlineList(summary.room.agents)}`);
  lines.push(`- events: ${summary.counts.events}`);
  lines.push(`- runs: ${summary.counts.completed_runs}/${summary.counts.runs} completed`);
  lines.push(`- reports: ${summary.counts.reports}`);
  lines.push(`- blackboard updates: ${summary.counts.blackboard_updates}`);
  lines.push("");
  if (summary.reports.length) {
    lines.push("## Reports");
    lines.push("");
    for (const report of summary.reports) {
      lines.push(`- ${report.at || "-"} ${report.speaker || "unknown"}: ${report.content || ""}`);
    }
    lines.push("");
  }
  if (summary.blackboard.length) {
    lines.push("## Blackboard");
    lines.push("");
    for (const note of summary.blackboard) {
      lines.push(`- ${note.at || "-"} ${note.speaker || "unknown"}: ${note.content || ""}`);
    }
    lines.push("");
  }
  if (summary.runs.length) {
    lines.push("## Runs");
    lines.push("");
    for (const run of summary.runs) {
      lines.push(`- ${run.id}: ${run.agent_id || "-"} ${run.status || "unknown"} output_events=${run.output_events}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function formatRoomMarkdown(room, options = {}) {
  const reports = room.reports || room.blackboard?.reports || [];
  const notes = room.blackboard?.notes || [];
  const messages = options.reportsOnly ? [] : (room.messages || []);
  const runs = room.runs || [];
  const lines = [];
  lines.push(`# Agent Bus Room: ${room.title || room.id || "untitled"}`);
  lines.push("");
  lines.push(`- id: \`${room.id || "-"}\``);
  lines.push(`- status: \`${room.status || "unknown"}\``);
  lines.push(`- agents: ${formatInlineList(room.agents)}`);
  lines.push(`- created: ${room.created_at || "-"}`);
  lines.push(`- updated: ${room.updated_at || "-"}`);
  lines.push("");
  if (room.goal) {
    lines.push("## Goal");
    lines.push("");
    lines.push(markdownFence(room.goal));
    lines.push("");
  }
  if (reports.length) {
    lines.push("## Reports");
    lines.push("");
    for (const report of reports) {
      lines.push(`- ${report.at || "-"} ${report.speaker || "unknown"}: ${report.content || ""}`);
    }
    lines.push("");
  }
  if (notes.length) {
    lines.push("## Blackboard Notes");
    lines.push("");
    for (const note of notes) {
      lines.push(`- ${note.at || "-"} ${note.speaker || "unknown"}: ${note.content || ""}`);
    }
    lines.push("");
  }
  if (runs.length) {
    lines.push("## Runs");
    lines.push("");
    for (const run of runs) {
      lines.push(`- ${run.id || "-"}: ${run.agent_id || "-"} ${run.status || "unknown"}${run.exit_code === undefined || run.exit_code === null ? "" : ` exit=${run.exit_code}`}`);
    }
    lines.push("");
  }
  if (messages.length) {
    lines.push("## Messages");
    lines.push("");
    for (const message of messages) {
      const heading = [message.speaker || "unknown", message.role || "", message.status ? `status=${message.status}` : "", message.at || ""]
        .filter(Boolean)
        .join(" ");
      lines.push(`### ${heading}`);
      lines.push("");
      lines.push(markdownFence(message.content || ""));
      lines.push("");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function formatInlineList(value) {
  const list = Array.isArray(value) ? value : [];
  return list.length ? list.map((item) => `\`${item}\``).join(", ") : "-";
}

function markdownFence(value) {
  const text = String(value ?? "").replace(/\r\n/g, "\n");
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

async function status(args) {
  const jsonOut = args.includes("--json");
  const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN || "";
  const health = await gatewayJson("/health", { auth: false, args });
  let agents = [];
  let rooms = [];
  let nodes = [];
  let authWarning = "";

  if (token) {
    agents = await gatewayJson("/agents", { auth: true, args });
    nodes = await optionalGatewayJson("/nodes", { auth: true, args }, []);
    rooms = await gatewayJson("/rooms", { auth: true, args });
    rooms = await hydrateStatusRooms(rooms, args);
  } else {
    authWarning = "Pass --token or AGENT_BUS_TOKEN to include agents, nodes, and rooms.";
  }

  const staleSeconds = positiveIntegerOption(optionValue(args, "--stale-seconds") || process.env.AGENT_BUS_STATUS_STALE_SECONDS, 180, 86400);
  const queuedRunStaleSeconds = positiveIntegerOption(optionValue(args, "--queued-run-stale-seconds") || process.env.AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS, 21600, 604800);
  const result = summarizeStatus({ health, agents, rooms, nodes, authWarning, staleSeconds, queuedRunStaleSeconds });
  if (jsonOut) {
    printJson(result);
    return;
  }
  printStatus(result);
}

function summarizeStatus({ health, agents, rooms, nodes, authWarning, staleSeconds = 180, queuedRunStaleSeconds = 21600 }) {
  const agentList = Array.isArray(agents) ? agents : [];
  const roomList = Array.isArray(rooms) ? rooms : [];
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const onlineAgents = agentList.filter((agent) => agent.status === "online");
  const reachableAgents = agentList.filter((agent) => agent.ping_status === "reachable");
  const activeRooms = roomList.filter(isActiveRoom);
  const runSummary = activeRoomRunSummary(activeRooms, { queuedRunStaleSeconds });
  const activeRunsByAgent = runSummary.liveByAgent;
  const fallbackBusyAgentIds = new Set(activeRooms
    .filter((room) => !Array.isArray(room.runs))
    .flatMap((room) => Array.isArray(room.agents) ? room.agents : []));
  const busyAgentIds = new Set([...activeRunsByAgent.keys(), ...fallbackBusyAgentIds]);
  return {
    ok: Boolean(health?.ok),
    health,
    summary: {
      nodes: health?.nodes ?? 0,
      agents: health?.agents ?? 0,
      registered_nodes: health?.registered_nodes ?? health?.nodes ?? 0,
      registered_agents: health?.registered_agents ?? health?.agents ?? 0,
      queued: health?.queued ?? 0,
      online_agents: onlineAgents.length,
      reachable_agents: reachableAgents.length,
      busy_agents: agentList.filter((agent) => busyAgentIds.has(agent.id)).length,
      rooms: roomList.length,
      active_rooms: activeRooms.length,
      active_runs: runSummary.liveRuns.length,
      stale_queued_runs: runSummary.staleQueuedRuns.length
    },
    nodes: nodeList.map((node) => ({
      id: node.node_id || node.id || "unknown",
      status: node.status || "unknown",
      last_seen_at: node.last_seen_at || null,
      freshness: statusFreshness(node.status, node.last_seen_at || null, staleSeconds),
      agents: Array.isArray(node.agents) ? node.agents.map((agent) => typeof agent === "string" ? agent : agent.id).filter(Boolean) : []
    })),
    agents: agentList.map((agent) => {
      const pingStatus = agent.ping_status || agent.health?.ping_status || "unknown";
      const lastRunStatus = agent.last_run_status || agent.health?.last_run_status || null;
      const lastSeenAt = agent.last_seen_at || agent.node_last_seen_at || null;
      const activeRuns = activeRunsByAgent.get(agent.id) || [];
      const staleQueuedRuns = runSummary.staleQueuedByAgent.get(agent.id) || [];
      const activeRoomIds = unique([
        ...activeRuns.map((run) => run.room_id).filter(Boolean),
        ...activeRooms
          .filter((room) => !Array.isArray(room.runs) && Array.isArray(room.agents) && room.agents.includes(agent.id))
          .map((room) => room.id)
          .filter(Boolean)
      ]);
      const latestRun = activeRuns[0] || null;
      return {
        id: agent.id,
        status: agent.status || "unknown",
        ping_status: pingStatus,
        last_run_status: lastRunStatus,
        last_seen_at: lastSeenAt,
        freshness: statusFreshness(agent.status, lastSeenAt, staleSeconds),
        activity: agentActivity(activeRuns, activeRoomIds),
        active_rooms: activeRoomIds,
        active_runs: activeRuns,
        stale_queued_runs: staleQueuedRuns,
        current_run: latestRun?.id || null,
        ping_label: pingLabel(pingStatus),
        last_run_health: lastRunHealth(lastRunStatus)
      };
    }),
    rooms: roomList.slice(0, 8).map((room) => ({
      id: room.id,
      status: room.status,
      agents: room.agents || [],
      updated_at: room.updated_at,
      reports: room.report_count ?? null,
      messages: room.message_count ?? null,
      active_runs: activeRunsForRoom(room, { queuedRunStaleSeconds })
        .map((run) => run.id),
      stale_queued_runs: staleQueuedRunsForRoom(room, { queuedRunStaleSeconds })
        .map((run) => run.id)
    })),
    warnings: statusWarnings({ authWarning, staleQueuedRuns: runSummary.staleQueuedRuns, queuedRunStaleSeconds, health })
  };
}

async function hydrateStatusRooms(rooms, args) {
  if (!Array.isArray(rooms) || args.includes("--no-room-details")) return rooms;
  const limit = positiveIntegerOption(optionValue(args, "--room-detail-limit"), 25, 100);
  const active = rooms.filter(isActiveRoom).filter((room) => room.id).slice(0, limit);
  if (!active.length) return rooms;
  const details = new Map();
  for (const room of active) {
    try {
      const detail = await gatewayJson(`/rooms/${pathPart(room.id)}`, { auth: true, args });
      details.set(room.id, detail);
    } catch {
      // Status should remain useful even if an old gateway cannot hydrate room details.
    }
  }
  if (!details.size) return rooms;
  return rooms.map((room) => details.has(room.id) ? { ...room, ...details.get(room.id) } : room);
}

function isActiveRoom(room) {
  return ["active", "running", "finishing"].includes(String(room?.status || "").toLowerCase());
}

const STATUS_TERMINAL_RUNS = new Set(["completed", "failed", "error", "cancelled", "canceled", "skipped"]);

function activeRunsForRoom(room, options = {}) {
  return activeRunBucketsForRoom(room, options).liveRuns;
}

function staleQueuedRunsForRoom(room, options = {}) {
  return activeRunBucketsForRoom(room, options).staleQueuedRuns;
}

function activeRunBucketsForRoom(room, { queuedRunStaleSeconds = 21600 } = {}) {
  const roomId = room?.id || "";
  const liveRuns = [];
  const staleQueuedRuns = [];
  for (const rawRun of Array.isArray(room?.runs) ? room.runs : []) {
    const status = String(rawRun.status || "queued").toLowerCase();
    if (STATUS_TERMINAL_RUNS.has(status)) continue;
    const run = {
      id: rawRun.id,
      room_id: rawRun.room_id || roomId,
      agent_id: rawRun.agent_id,
      status: rawRun.status || "queued",
      created_at: rawRun.created_at || null,
      started_at: rawRun.started_at || null
    };
    if (isStaleQueuedRun(run, queuedRunStaleSeconds)) {
      staleQueuedRuns.push(run);
    } else {
      liveRuns.push(run);
    }
  }
  return { liveRuns, staleQueuedRuns };
}

function activeRoomRunSummary(rooms, options = {}) {
  const liveRuns = [];
  const staleQueuedRuns = [];
  const liveByAgent = new Map();
  const staleQueuedByAgent = new Map();
  for (const room of rooms) {
    const buckets = activeRunBucketsForRoom(room, options);
    liveRuns.push(...buckets.liveRuns);
    staleQueuedRuns.push(...buckets.staleQueuedRuns);
    addRunsByAgent(liveByAgent, buckets.liveRuns);
    addRunsByAgent(staleQueuedByAgent, buckets.staleQueuedRuns);
  }
  sortRunsByNewest(liveByAgent);
  sortRunsByNewest(staleQueuedByAgent);
  return { liveRuns, staleQueuedRuns, liveByAgent, staleQueuedByAgent };
}

function addRunsByAgent(byAgent, runs) {
  for (const run of runs) {
    if (!run.agent_id) continue;
    const list = byAgent.get(run.agent_id) || [];
    list.push(run);
    byAgent.set(run.agent_id, list);
  }
}

function sortRunsByNewest(byAgent) {
  for (const list of byAgent.values()) {
    list.sort((a, b) => Date.parse(b.started_at || b.created_at || 0) - Date.parse(a.started_at || a.created_at || 0));
  }
}

function isStaleQueuedRun(run, queuedRunStaleSeconds) {
  if (String(run.status || "").toLowerCase() !== "queued") return false;
  if (!run.created_at) return false;
  const created = Date.parse(run.created_at);
  if (!Number.isFinite(created)) return false;
  return (Date.now() - created) / 1000 > queuedRunStaleSeconds;
}

function statusWarnings({ authWarning, staleQueuedRuns, queuedRunStaleSeconds, health }) {
  const warnings = authWarning ? [authWarning] : [];
  const count = staleQueuedRuns.length;
  if (count) {
    const queueNote = Number(health?.queued || 0) === 0 ? "; gateway queue is empty" : "";
    warnings.push(`Ignored ${count} stale queued room run${count === 1 ? "" : "s"} older than ${queuedRunStaleSeconds}s${queueNote}. Inspect or recover the old room.`);
  }
  return warnings;
}

function agentActivity(activeRuns, activeRoomIds) {
  if (activeRuns.some((run) => String(run.status || "").toLowerCase() === "running")) return "running";
  if (activeRuns.some((run) => String(run.status || "").toLowerCase() === "queued")) return "queued";
  return activeRoomIds.length ? "busy/room-active" : "idle";
}

function unique(values) {
  return Array.from(new Set(values));
}

function statusFreshness(status, lastSeenAt, staleSeconds = 180) {
  if (status !== "online") return status || "unknown";
  if (!lastSeenAt) return "online/unknown";
  const parsed = Date.parse(lastSeenAt);
  if (!Number.isFinite(parsed)) return "online/unknown";
  const ageSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (ageSeconds > staleSeconds) return `stale (${ageSeconds}s ago)`;
  return `online/fresh (${ageSeconds}s ago)`;
}

function pingLabel(status) {
  const value = String(status || "unknown").toLowerCase();
  if (["reachable", "ok", "healthy", "success"].includes(value)) return "reachable";
  if (["unreachable", "timeout", "connection_error", "dns_error", "error", "failed"].includes(value)) return "unreachable";
  if (["unhealthy", "bad_status", "http_error"].includes(value)) return "unhealthy";
  if (["not_configured", "none", "disabled"].includes(value)) return "not configured";
  return "unknown";
}

function lastRunHealth(status) {
  const value = String(status || "").toLowerCase();
  if (!value) return "unknown";
  if (["completed", "complete", "success", "succeeded", "ok"].includes(value)) return "ok";
  if (["failed", "failure", "error", "errored", "timeout", "timed_out", "cancelled", "canceled", "nonzero"].includes(value)) return "failed";
  if (["running", "active", "queued", "pending", "started"].includes(value)) return "running";
  return "unknown";
}

function printStatus(result) {
  const s = result.summary || {};
  console.log(`Agent Bus status: ${result.ok ? "OK" : "WARN"}`);
  console.log(`Gateway: nodes ${s.nodes}/${s.registered_nodes}, agents ${s.agents}/${s.registered_agents}, online ${s.online_agents}, busy ${s.busy_agents || 0}, queued ${s.queued}`);
  if (result.warnings?.length) {
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  }
  if (result.nodes?.length) {
    console.log("\nNodes:");
    for (const node of result.nodes) {
      const seen = node.last_seen_at ? ` seen=${node.last_seen_at}` : " seen=unknown";
      console.log(`- ${node.id}: node=${node.freshness}, agents=${node.agents.join(",") || "-"}${seen}`);
    }
  }
  if (result.agents.length) {
    console.log("\nAgents:");
    for (const agent of result.agents) {
      const seen = agent.last_seen_at ? ` seen=${agent.last_seen_at}` : " seen=unknown";
      const active = agent.active_rooms?.length ? ` rooms=${agent.active_rooms.join(",")}` : "";
      const run = agent.current_run ? ` run=${agent.current_run}` : "";
      const staleQueued = agent.stale_queued_runs?.length ? ` stale_queued=${agent.stale_queued_runs.map((item) => item.id).join(",")}` : "";
      console.log(`- ${agent.id}: node=${agent.freshness}, activity=${agent.activity}, ping=${agent.ping_label}, last_run=${agent.last_run_health}${seen}${active}${run}${staleQueued}`);
    }
  }
  if (result.rooms.length) {
    console.log("\nRecent rooms:");
    for (const room of result.rooms) {
      const activeRuns = room.active_runs?.length ? ` active_runs=${room.active_runs.join(",")}` : "";
      const staleQueued = room.stale_queued_runs?.length ? ` stale_queued=${room.stale_queued_runs.join(",")}` : "";
      console.log(`- ${room.id}: ${room.status}, agents=${room.agents.join(",") || "-"}, updated=${room.updated_at || "-"}${activeRuns}${staleQueued}`);
    }
  }
}

function ollamaAgent(commandPath, model, id = "ollama-local") {
  return {
    id,
    kind: "ollama",
    role: "model",
    enabled: true,
    adapter: "command",
    capabilities: ["local-model", "chat", "private"],
    pingUrl: "http://127.0.0.1:11434/api/tags",
    runCommand: `${quoteCommand(commandPath)} run ${quoteCommand(model || "llama3.1")} ${messageArgument()}`
  };
}

function messageArgument() {
  return process.platform === "win32" ? "\"%AGENT_MESSAGE%\"" : "\"$AGENT_MESSAGE\"";
}

function nullInputRedirect() {
  return process.platform === "win32" ? " < NUL" : " < /dev/null";
}

function defaultHermesCommand() {
  return process.platform === "win32" ? "hermes" : "/root/.local/bin/hermes";
}

function commonHermesPaths() {
  const paths = [path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "hermes.exe" : "hermes")];
  if (process.platform !== "win32") paths.push("/root/.local/bin/hermes");
  return paths;
}

async function readOllamaModels() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", { signal: controller.signal });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((item) => item.name).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function findExecutable(name, extraPaths = []) {
  for (const candidate of extraPaths) {
    if (candidate && fs.existsSync(expandHome(candidate))) return expandHome(candidate);
  }
  if (!name) return "";
  if (/[\\/]/.test(name)) return fs.existsSync(expandHome(name)) ? expandHome(name) : "";
  const result = process.platform === "win32"
    ? spawnSync("where.exe", [name], { encoding: "utf8", windowsHide: true })
    : spawnSync("sh", ["-lc", "command -v \"$1\"", "sh", name], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function findFirstExisting(values) {
  for (const value of values) {
    if (value && fs.existsSync(expandHome(value))) return expandHome(value);
  }
  return "";
}

function commandVersion(commandPath) {
  const result = spawnSync(commandPath, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 3000 });
  const text = String(result.stdout || result.stderr || "").replace(/\s+/g, " ").trim();
  return text.slice(0, 120);
}

function quoteCommand(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function configuredExecutable(commandText) {
  const tokens = String(commandText || "").match(/"[^"]+"|'[^']+'|\S+/g) || [];
  while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens.shift();
  if (!tokens.length) return "";
  return stripShellQuotes(tokens[0]);
}

function stripShellQuotes(value) {
  return String(value || "").replace(/^["']|["']$/g, "");
}

function resolveConfiguredExecutable(command, baseDir) {
  const text = expandHome(command);
  if (/[\\/]/.test(text)) {
    const absolute = path.isAbsolute(text) || /^[A-Za-z]:[\\/]/.test(text) ? text : path.resolve(baseDir || process.cwd(), text);
    return fs.existsSync(absolute) ? absolute : "";
  }
  return findExecutable(text);
}

function expandHome(value) {
  const text = String(value || "");
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2));
  return text;
}

function readJsonObjectIfExists(file) {
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isPlainObject(parsed)) throw new Error(`${file} must contain a JSON object`);
  return parsed;
}

function readJsonFile(file) {
  const resolved = path.resolve(file);
  return JSON.parse(fs.readFileSync(resolved, "utf8"));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeOpenClawAgentId(value) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!cleaned) throw new Error("--agent-id cannot be empty");
  return cleaned.slice(0, 128);
}

function writeWorkspaceFileIfMissing(dir, name, content) {
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, content.replace(/\n?$/, "\n"));
}

function archiveBootstrapFile(workspaceDir) {
  const file = path.join(workspaceDir, "BOOTSTRAP.md");
  if (!fs.existsSync(file)) return "";
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const archived = path.join(workspaceDir, `BOOTSTRAP.md.agent-bus-archive-${stamp}`);
  fs.renameSync(file, archived);
  return archived;
}

function markOpenClawWorkspaceComplete(workspaceDir) {
  const stateDir = path.join(workspaceDir, ".openclaw");
  const stateFile = path.join(stateDir, "workspace-state.json");
  const state = readJsonObjectIfExists(stateFile);
  state.version ||= 1;
  state.setupCompletedAt ||= new Date().toISOString();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

function defaultOpenClawWorkspace(config) {
  const configured = isPlainObject(config.agents?.defaults) ? config.agents.defaults.workspace : "";
  return configured || path.join(os.homedir(), ".openclaw", "workspace");
}

function safeId(value) {
  return String(value || "local").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "local";
}


function parseListOption(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

async function getJson(pathname, options) {
  printJson(await gatewayJson(pathname, { ...options, args: argv }));
}

async function gatewayJson(pathname, options = {}) {
  const args = options.args || argv;
  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "http://127.0.0.1:8788";
  const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN || "";
  if (options.auth && !token) {
    throw new Error("This endpoint requires --token or AGENT_BUS_TOKEN.");
  }
  const url = gatewayEndpoint(gateway, pathname);
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" })
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `${res.status} ${res.statusText}`);
  }
  return parseJsonText(text);
}

async function optionalGatewayJson(pathname, options = {}, fallback = null) {
  try {
    return await gatewayJson(pathname, options);
  } catch {
    return fallback;
  }
}

function parseJsonText(text) {
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

function printJson(value) {
  if (typeof value === "string") {
    console.log(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

function runScript(name, args) {
  const script = materializeScript(name);
  return runProcess(name, process.execPath, [script, ...args]);
}

function runProcess(name, commandPath, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, args, {
      stdio: "inherit",
      env: options.env || process.env,
      windowsHide: true
    });
    let settled = false;
    const cleanupHandlers = [];
    const killChild = (signal = "SIGTERM") => {
      if (!child.killed) child.kill(signal);
    };
    const onSignal = (signal) => {
      killChild(signal);
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const handler = () => onSignal(signal);
      process.once(signal, handler);
      cleanupHandlers.push(() => process.off(signal, handler));
    }
    const onExit = () => killChild("SIGTERM");
    process.once("exit", onExit);
    cleanupHandlers.push(() => process.off("exit", onExit));
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanupHandlers) cleanup();
      fn();
    };
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code, signal) => {
      if (code === 0) return finish(resolve);
      const err = new Error(`${name} exited with ${signal || code}`);
      err.exitCode = code || 1;
      finish(() => reject(err));
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

function pathPart(value) {
  return encodeURIComponent(String(value || ""));
}

function stripCliOnlyArgs(args) {
  return args;
}

function removeOptionWithValue(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

function requiredPositional(args, index, label) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${label}.`);
  return value;
}

function csvOption(args, name) {
  return String(optionValue(args, name) || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function booleanOption(args, positive, negative) {
  if (args.includes(negative)) return false;
  if (args.includes(positive)) return true;
  return undefined;
}

function positiveIntegerOption(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function readPackageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
