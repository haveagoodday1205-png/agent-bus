#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  if (command === "smoke") {
    await runScript("scripts/offline-smoke.mjs", stripCliOnlyArgs(argv.slice(1)));
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
  if (command === "room" || command === "rooms") {
    await room(argv.slice(1));
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
  agent-bus serve --config central.config.json
  agent-bus connect --config edge.config.json
  agent-bus doctor --config edge.config.json [--json]
  agent-bus smoke --offline
  agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ... --preset codex
  agent-bus pair join --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --out edge.config.json [--auto]
  agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --auto --service auto
  agent-bus service systemd --mode edge --config /opt/agent-bus/edge.config.json --agent-bus-path /usr/bin/agent-bus
  agent-bus probe --config edge.config.json
  agent-bus edge-agents --config edge.config.json
  agent-bus room create --goal "Check deployment" --agents codex-120,openclaw-hk --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room show room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room export room_xxx --format markdown --out room.md
  agent-bus room export room_xxx --format json --out room.json --no-redact
  agent-bus room wake room_xxx --agents hermes-hk --reason "Continue"
  agent-bus room message room_xxx --message "New context" --agents openclaw-hk
  agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ...

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

async function setup(args) {
  const target = args[0] || "edge";
  if (target !== "edge") {
    throw new Error("Usage: agent-bus setup edge [--gateway url] [--code pair-code] [--auto|--preset name] [--service auto|systemd|launchd|windows]");
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
  if (target === "systemd") return `Install hint: sudo cp ${file} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now agent-bus-edge`;
  if (target === "launchd") return `Install hint: cp ${file} ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/${path.basename(file)}`;
  return `Install hint: review ${file}, then run it from an elevated PowerShell prompt.`;
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
  const jsonOut = args.includes("--json");
  const checks = [];
  let config = null;

  addCheck(checks, "pass", "Node.js runtime", process.version);

  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    addCheck(checks, "pass", "Read edge config", configPath);
  } catch (err) {
    addCheck(checks, "fail", "Read edge config", err.message);
    printDoctorResult(checks, jsonOut);
    process.exitCode = 1;
    return;
  }

  const gatewayUrl = gatewayArg || config.gatewayUrl || "http://127.0.0.1:8788";
  const token = tokenArg || config.token || "";
  validateEdgeConfig(checks, config, gatewayUrl, token);
  checkConfiguredTools(checks, config, path.dirname(path.resolve(configPath)));

  await checkGateway(checks, gatewayUrl, token);
  await checkLocalProbe(checks, configPath);

  printDoctorResult(checks, jsonOut);
  if (checks.some((item) => item.status === "fail")) {
    process.exitCode = 1;
  }
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

function addCheck(checks, status, name, detail) {
  checks.push({ status, name, detail: detail || "" });
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
    let text = "";
    if (format === "json") {
      text = `${JSON.stringify(exportData, null, 2)}\n`;
    } else if (format === "markdown" || format === "md") {
      text = formatRoomMarkdown(exportData);
    } else {
      throw new Error("room export --format must be markdown or json.");
    }
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
      ...(agents.length ? { agents } : {}),
      ...(singleAgent ? { agent: singleAgent } : {})
    };
    return printJson(await gatewayJson(`/rooms/${pathPart(roomId)}/wake`, { auth: true, args, method: "POST", body }));
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
      ...(wake === undefined ? {} : { wake }),
      ...(agents.length ? { agents } : {})
    };
    return printJson(await gatewayJson(`/rooms/${pathPart(roomId)}/messages`, { auth: true, args, method: "POST", body }));
  }
  throw new Error("Usage: agent-bus room list|show|export|create|wake|message [options]");
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
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(["']?)[^\s"',}]+/gi, "$1$2[REDACTED]")
    .replace(/:\/\/([^:/@\s]+):([^/@\s]+)@/g, "://[REDACTED]@");
}

function formatRoomMarkdown(room) {
  const reports = room.reports || room.blackboard?.reports || [];
  const notes = room.blackboard?.notes || [];
  const messages = room.messages || [];
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
  let authWarning = "";

  if (token) {
    agents = await gatewayJson("/agents", { auth: true, args });
    rooms = await gatewayJson("/rooms", { auth: true, args });
  } else {
    authWarning = "Pass --token or AGENT_BUS_TOKEN to include agents and rooms.";
  }

  const result = summarizeStatus({ health, agents, rooms, authWarning });
  if (jsonOut) {
    printJson(result);
    return;
  }
  printStatus(result);
}

function summarizeStatus({ health, agents, rooms, authWarning }) {
  const agentList = Array.isArray(agents) ? agents : [];
  const roomList = Array.isArray(rooms) ? rooms : [];
  const onlineAgents = agentList.filter((agent) => agent.status === "online");
  const reachableAgents = agentList.filter((agent) => agent.ping_status === "reachable");
  const activeRooms = roomList.filter((room) => room.status === "active");
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
      rooms: roomList.length,
      active_rooms: activeRooms.length
    },
    agents: agentList.map((agent) => ({
      id: agent.id,
      status: agent.status || "unknown",
      ping_status: agent.ping_status || agent.health?.ping_status || "unknown",
      last_run_status: agent.last_run_status || agent.health?.last_run_status || null,
      last_seen_at: agent.last_seen_at || agent.node_last_seen_at || null
    })),
    rooms: roomList.slice(0, 8).map((room) => ({
      id: room.id,
      status: room.status,
      agents: room.agents || [],
      updated_at: room.updated_at,
      reports: room.report_count ?? null,
      messages: room.message_count ?? null
    })),
    warnings: authWarning ? [authWarning] : []
  };
}

function printStatus(result) {
  const s = result.summary || {};
  console.log(`Agent Bus status: ${result.ok ? "OK" : "WARN"}`);
  console.log(`Gateway: nodes ${s.nodes}/${s.registered_nodes}, agents ${s.agents}/${s.registered_agents}, queued ${s.queued}`);
  if (result.warnings?.length) {
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  }
  if (result.agents.length) {
    console.log("\nAgents:");
    for (const agent of result.agents) {
      const run = agent.last_run_status ? ` last_run=${agent.last_run_status}` : "";
      console.log(`- ${agent.id}: ${agent.status}, ping=${agent.ping_status}${run}`);
    }
  }
  if (result.rooms.length) {
    console.log("\nRecent rooms:");
    for (const room of result.rooms) {
      console.log(`- ${room.id}: ${room.status}, agents=${room.agents.join(",") || "-"}, updated=${room.updated_at || "-"}`);
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

function pathPart(value) {
  return encodeURIComponent(String(value || ""));
}

function stripCliOnlyArgs(args) {
  return args;
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
