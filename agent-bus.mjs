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
const gatewayQueryConfigCache = new Map();

const ROOM_EVENT_TYPES = [
  "room.created",
  "room.message.added",
  "room.blackboard.updated",
  "room.report.added",
  "room.status.changed",
  "run.queued",
  "run.started",
  "run.output",
  "run.completed",
  "run.failed",
  "agent.registered",
  "agent.health.updated",
  "wake.requested",
  "wake.dispatched",
  "wake.cancelled",
  "policy.denied"
];
const DEFAULT_RUN_HEARTBEAT_STALE_SECONDS = 90;

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
  if (command === "protocol" || command === "conformance") {
    await protocol(argv.slice(command === "conformance" ? 0 : 1));
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
  if (command === "plugin" || command === "plugins") {
    await plugin(argv.slice(1));
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

A good first run is: agent-bus demo zero-token

Usage:
  agent-bus init central [--out central.config.json] [--force]
  agent-bus init edge [--out edge.config.json] [--preset echo|codex|openclaw|hermes|claudecode|ollama] [--force]
  agent-bus init edge --auto [--gateway https://YOUR-DOMAIN/agent-bus] [--token ...] [--out edge.config.json]
  agent-bus detect [--json]
  agent-bus openclaw prepare [--config ~/.openclaw/openclaw.json] [--workspace ./openclaw-workspace] [--context-tokens 48000]
  agent-bus serve --config central.config.json [--runtime node|python]
  agent-bus connect --config edge.config.json
  agent-bus doctor --config edge.config.json [--json]
  agent-bus doctor --mode central --config central.config.json [--json]
  agent-bus diagnostics bundle --config edge.config.json --out diagnostics.json
  agent-bus smoke --offline
  agent-bus protocol check
  agent-bus protocol conformance [--json] [--artifact-dir DIR]
  agent-bus protocol certify [--json] [--artifact-dir DIR]
  agent-bus protocol validate-result --artifact-dir conformance-artifacts
  agent-bus demo
  agent-bus demo zero-token
  agent-bus demo room
  agent-bus demo starter
  agent-bus demo agent-model
  agent-bus demo issue
  agent-bus demo local
  agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ... --preset codex
  agent-bus pair join --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --out edge.config.json [--auto]
  agent-bus setup central --gateway https://YOUR-DOMAIN/agent-bus --out central.config.json --service auto
  agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --auto --service auto
  agent-bus setup telegram --gateway http://127.0.0.1:8788 --bot-token ... --chat-id ... --service auto
  agent-bus service systemd --mode edge --config /opt/agent-bus/edge.config.json --agent-bus-path /usr/bin/agent-bus
  agent-bus probe --config edge.config.json
  agent-bus edge-agents --config edge.config.json
  agent-bus room create --goal "Check deployment" --agents codex-120,openclaw-hk --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room show room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room memory room_xxx --query "cache decision" --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room expand room_xxx 'messages[7]' --around 1 --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room health room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ... [--json]
  agent-bus room inspect room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ... [--json] [--stale-seconds 180] [--queued-run-stale-seconds 21600] [--run-heartbeat-stale-seconds 90]
  agent-bus room doctor room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ... [--json]
  agent-bus room follow-up room_xxx [--agents a,b] [--dry-run] --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room event-log room_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ... [--json] [--reports-only] [--tail 50]
  agent-bus room export room_xxx --format markdown --out room.md
  agent-bus room export room_xxx --reports-only --out room-summary.md
  agent-bus room export room_xxx --format json --out room.json --no-redact
  agent-bus room export room_xxx --format events --out room-events.json
  agent-bus room replay --in room-events.json --format markdown [--strict]
  agent-bus room wake room_xxx --agents hermes-hk --reason "Continue"
  agent-bus room pause room_xxx --reason "old orphan queued run recovery"
  agent-bus room retry-failed room_xxx [--yes] [--force] --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room recover room_xxx --yes --reason "stale queued run recovery"
  agent-bus room resolve-duplicates room_xxx [--yes] --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus room supervisor room_xxx [--yes] [--queued-run-stale-seconds 21600] [--run-heartbeat-stale-seconds 90]
  agent-bus room recover room_xxx --yes --force --reason "operator-confirmed pause"
  agent-bus room message room_xxx --message "New context" --agents openclaw-hk
  agent-bus trace show trace_xxx --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus trace export trace_xxx --format markdown --out trace.md
  agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ... [--json] [--no-room-details] [--room-detail-limit 25] [--stale-seconds 180] [--queued-run-stale-seconds 21600] [--run-heartbeat-stale-seconds 90]
  agent-bus status --config edge.config.json [--json]
  agent-bus plugin status --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus plugin telegram test --message "hello" --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus plugin telegram doctor --gateway https://YOUR-DOMAIN/agent-bus --token ... --transport poller
  agent-bus plugin telegram commands set
  agent-bus plugin telegram poll --gateway http://127.0.0.1:8788 --delete-webhook

Gateway queries:
  agent-bus well-known --gateway https://YOUR-DOMAIN/agent-bus
  agent-bus manifest --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus nodes --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus agents --gateway https://YOUR-DOMAIN/agent-bus --token ...
  agent-bus health --gateway https://YOUR-DOMAIN/agent-bus
  agent-bus agents --config edge.config.json
  agent-bus nodes --config edge.config.json

Environment:
  AGENT_BUS_GATEWAY_URL  default gateway URL for query/connect commands
  AGENT_BUS_TOKEN        bearer token for protected gateway queries
`);
}

function demo(args) {
  const first = args[0] || "";
  const target = first && !first.startsWith("-") ? first : "zero-token";
  const extra = stripCliOnlyArgs(first && !first.startsWith("-") ? args.slice(1) : args);
  if (["zero-token", "zerotoken", "playground", "fake-agents"].includes(target)) {
    return runScript("scripts/demo-zero-token.mjs", extra);
  }
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
  throw new Error("Usage: agent-bus demo zero-token|starter|room|agent-model|issue|local");
}

function protocol(args) {
  const first = args[0] || "";
  const action = first && !first.startsWith("-") ? first : "conformance";
  const extra = stripCliOnlyArgs(first && !first.startsWith("-") ? args.slice(1) : args);
  if (["check", "verify", "schema"].includes(action)) {
    return runScript("scripts/verify-protocol-v1.mjs", extra);
  }
  if (["conformance", "conform", "compat", "compatibility"].includes(action)) {
    return runScript("scripts/protocol-conformance.mjs", extra);
  }
  if (["certify", "certification", "certificate", "artifacts", "badge"].includes(action)) {
    const hasArtifactTarget = hasAnyOption(extra, ["--artifact-dir", "--artifacts", "--result-out", "--json-out", "--report-out", "--markdown-out", "--badge-out"]);
    const certifyArgs = hasArtifactTarget ? extra : ["--artifact-dir", "conformance-artifacts", ...extra];
    return runScript("scripts/protocol-conformance.mjs", certifyArgs);
  }
  if (["validate-result", "result-check", "certify-check", "certification-check"].includes(action)) {
    return runScript("scripts/verify-conformance-result-schema.mjs", extra);
  }
  throw new Error("Usage: agent-bus protocol check|conformance|certify|validate-result [--json]");
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
  if (target === "telegram" || target === "tg") {
    await setupTelegram(args.slice(1));
    return;
  }
  if (target !== "edge") {
    throw new Error("Usage: agent-bus setup central|edge|telegram [options]");
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
    await writeSetupEdgeConfig({ args, gateway, token, out, preset, auto, nodeId });
  }

  const serviceTarget = resolveSetupServiceTarget(optionValue(args, "--service") || "");
  if (serviceTarget) {
    const serviceOut = optionValue(args, "--service-out") || defaultServiceOut(serviceTarget, "edge");
    const cwd = optionValue(args, "--cwd") || path.dirname(path.resolve(out));
    const agentBusPath = optionValue(args, "--agent-bus-path") || "";
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

  console.log("\nOperator checklist:");
  console.log(`1. Validate this edge: agent-bus doctor --config ${out}`);
  console.log(`2. Start this edge: agent-bus connect --config ${out}`);
  console.log(`3. Check this edge locally: agent-bus status --config ${out}`);
  console.log(`4. Watch rooms from Central: agent-bus status --gateway ${gateway || "GATEWAY"} --token ADMIN_TOKEN`);
}

async function setupCentral(args) {
  const out = optionValue(args, "--out") || "central.config.json";
  const force = args.includes("--force");
  if (fs.existsSync(out) && !force) {
    throw new Error(`Refusing to overwrite ${out}; pass --force to replace it.`);
  }

  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "https://YOUR-DOMAIN/agent-bus";
  const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN || randomToken("abt_admin");
  const firstEdgeToken = args.includes("--no-first-edge-token") ? "" : randomToken("abt_edge");
  const config = centralTemplate();
  config.gatewayUrl = gateway;
  config.token = token;
  config.host = optionValue(args, "--host") || config.host;
  config.port = positiveIntegerOption(optionValue(args, "--port"), config.port, 65535);
  config.dataDir = optionValue(args, "--data-dir") || config.dataDir;
  if (firstEdgeToken) {
    config.edgeTokens.push({
      token: firstEdgeToken,
      label: optionValue(args, "--first-edge-label") || "first edge quick-start token"
    });
  }
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
  console.log(`         public gateway: ${gateway}`);
  console.log(`         admin token: ${token}`);
  if (firstEdgeToken) console.log(`         first edge token: ${firstEdgeToken}`);
  console.log("         store these tokens privately; the edge token is scoped and can be revoked later");

  const serviceTarget = resolveSetupServiceTarget(optionValue(args, "--service") || "");
  if (serviceTarget) {
    const serviceOut = optionValue(args, "--service-out") || defaultServiceOut(serviceTarget, "central");
    const cwd = optionValue(args, "--cwd") || path.dirname(path.resolve(out));
    const agentBusPath = optionValue(args, "--agent-bus-path") || "";
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
  console.log("Step 3/3: first edge join command");
  if (firstEdgeToken) {
    console.log(`  agent-bus setup edge --gateway ${gateway} --token ${firstEdgeToken} --auto --service auto --out edge.config.json`);
  } else {
    console.log(`  agent-bus pair create --gateway ${gateway} --token ${token} --preset ${preset}`);
    console.log("Then run the returned setup edge command on the edge machine.");
  }
  console.log("\nOperator checklist:");
  console.log(`1. Start Central: agent-bus serve --runtime python --config ${out}`);
  console.log(`2. Open health: ${gatewayEndpoint(gateway, "/health")}`);
  console.log(`3. Check readiness: agent-bus status --gateway ${gateway} --token ${token}`);
  if (firstEdgeToken) {
    console.log(`4. Join the first edge: agent-bus setup edge --gateway ${gateway} --token ${firstEdgeToken} --auto --service auto --out edge.config.json`);
  } else {
    console.log(`4. Create an edge join: agent-bus pair create --gateway ${gateway} --token ${token} --preset ${preset}`);
  }
  console.log("5. Optional Telegram: agent-bus plugin telegram commands set");
  console.log("6. If Telegram webhooks are blocked: agent-bus plugin telegram poll --gateway http://127.0.0.1:8788 --delete-webhook --set-commands");
}

async function setupTelegram(args) {
  const out = optionValue(args, "--out") || "agent-bus-telegram.env";
  const force = args.includes("--force");
  if (fs.existsSync(out) && !force) {
    throw new Error(`Refusing to overwrite ${out}; pass --force to replace it.`);
  }

  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "http://127.0.0.1:8788";
  const botToken = optionValue(args, "--bot-token") || process.env.AGENT_BUS_TELEGRAM_BOT_TOKEN || "";
  const chatId = optionValue(args, "--chat-id") || process.env.AGENT_BUS_TELEGRAM_CHAT_ID || "";
  const allowUnrestrictedControl = args.includes("--allow-unrestricted-control");
  const webhookSecret = optionValue(args, "--secret-token") || process.env.AGENT_BUS_TELEGRAM_WEBHOOK_SECRET || randomToken("abt_tg_secret");
  const apiBaseUrl = optionValue(args, "--api-base-url") || process.env.AGENT_BUS_TELEGRAM_API_BASE_URL || "https://api.telegram.org";
  const agent = optionValue(args, "--agent") || process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENT || "";
  const agents = optionValue(args, "--agents") || process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS || "";
  const pollerOffsetFile = optionValue(args, "--offset-file") || process.env.AGENT_BUS_TELEGRAM_POLLER_OFFSET_FILE || "";
  const transport = telegramTransport(args);
  const setCommands = args.includes("--set-commands") || args.includes("--install-commands");
  const deleteWebhook = args.includes("--delete-webhook") || (transport === "poller" && botToken && !args.includes("--no-delete-webhook"));
  if (!chatId && !allowUnrestrictedControl) {
    throw new Error("setup telegram requires --chat-id or AGENT_BUS_TELEGRAM_CHAT_ID because Telegram control is enabled. Pass --allow-unrestricted-control only for isolated tests.");
  }

  const env = telegramSetupEnv({
    gateway,
    botToken,
    chatId,
    webhookSecret,
    apiBaseUrl,
    agent,
    agents,
    pollerOffsetFile,
    setCommands: setCommands || transport === "poller"
  });
  fs.writeFileSync(out, `${env.join("\n")}\n`, { mode: 0o600 });

  console.log("Agent Bus Telegram setup");
  console.log(`Step 1/3: wrote ${out}`);
  console.log(`         gateway: ${gateway}`);
  console.log(`         transport: ${transport}`);
  console.log(`         bot token: ${botToken ? "configured" : "missing"}`);
  console.log(`         chat id: ${chatId ? "configured" : "missing"}`);

  if ((setCommands || deleteWebhook) && !botToken) {
    throw new Error("--bot-token or AGENT_BUS_TELEGRAM_BOT_TOKEN is required for --set-commands or --delete-webhook.");
  }
  if (deleteWebhook) {
    await telegramApi(botToken, "deleteWebhook", {
      drop_pending_updates: args.includes("--drop-pending") ? "true" : "false"
    }, apiBaseUrl);
  }
  if (setCommands) {
    await telegramApi(botToken, "setMyCommands", {
      commands: JSON.stringify(defaultTelegramCommands())
    }, apiBaseUrl);
  }
  console.log(`Step 2/3: Telegram API ${deleteWebhook ? "deleteWebhook " : ""}${setCommands ? "setMyCommands" : "not changed"}`);

  const serviceTarget = resolveSetupServiceTarget(optionValue(args, "--service") || "");
  if (serviceTarget && transport === "webhook") {
    console.log("Step 3/3: poller service skipped for webhook transport");
  } else if (serviceTarget) {
    const serviceOut = optionValue(args, "--service-out") || defaultServiceOut(serviceTarget, "telegram-poller");
    const cwd = optionValue(args, "--cwd") || process.cwd();
    const agentBusPath = optionValue(args, "--agent-bus-path") || "";
    const name = optionValue(args, "--name") || "agent-bus-telegram-poller";
    const content = telegramPollerService(serviceTarget, {
      name,
      cwd,
      gateway,
      envFile: path.resolve(out),
      agentBusPath,
      deleteWebhook: true,
      setCommands: setCommands || transport === "poller"
    });
    fs.writeFileSync(serviceOut, content);
    console.log(`Step 3/3: wrote ${serviceTarget} service template to ${serviceOut}`);
    console.log(serviceInstallHint(serviceTarget, serviceOut));
  } else {
    console.log("Step 3/3: service template skipped; pass --service auto to generate one");
  }

  console.log("\nOperator checklist:");
  console.log(`1. Enable Telegram in Central env: load ${out} before starting agent-bus serve`);
  console.log(`2. Validate Telegram: agent-bus plugin telegram doctor --gateway ${gateway} --token ADMIN_TOKEN --transport ${transport}`);
  console.log(transport === "webhook"
    ? "3. Configure Telegram webhook to /v1/agent-bus/plugins/telegram/webhook with the generated secret token"
    : `3. Start poller if using poller transport: agent-bus plugin telegram poll --gateway ${gateway} --delete-webhook --set-commands`);
}

function randomToken(prefix) {
  return `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
}

function telegramTransport(args) {
  const value = String(optionValue(args, "--transport") || (args.includes("--webhook") ? "webhook" : args.includes("--poller") ? "poller" : "poller")).toLowerCase();
  if (!["poller", "webhook", "auto"].includes(value)) throw new Error("--transport must be poller, webhook, or auto");
  return value;
}

function telegramSetupEnv(options) {
  const lines = [
    "# Agent Bus Telegram control bot.",
    "AGENT_BUS_TELEGRAM_ENABLED=true",
    `AGENT_BUS_TELEGRAM_BOT_TOKEN=${shellEnvValue(options.botToken)}`,
    `AGENT_BUS_TELEGRAM_CHAT_ID=${shellEnvValue(options.chatId)}`,
    "AGENT_BUS_TELEGRAM_CONTROL_ENABLED=true",
    `AGENT_BUS_TELEGRAM_WEBHOOK_SECRET=${shellEnvValue(options.webhookSecret)}`,
    "AGENT_BUS_TELEGRAM_CONVERSATION_ENABLED=true",
    `AGENT_BUS_GATEWAY_URL=${shellEnvValue(options.gateway)}`,
    `AGENT_BUS_TELEGRAM_API_BASE_URL=${shellEnvValue(options.apiBaseUrl)}`,
    `AGENT_BUS_TELEGRAM_SET_COMMANDS=${options.setCommands ? "true" : "false"}`
  ];
  if (options.agent) lines.push(`AGENT_BUS_TELEGRAM_CONVERSATION_AGENT=${shellEnvValue(options.agent)}`);
  if (options.agents) lines.push(`AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS=${shellEnvValue(options.agents)}`);
  if (options.pollerOffsetFile) lines.push(`AGENT_BUS_TELEGRAM_POLLER_OFFSET_FILE=${shellEnvValue(options.pollerOffsetFile)}`);
  return lines;
}

function shellEnvValue(value) {
  const text = String(value || "");
  if (!text) return "";
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function defaultTelegramCommands() {
  return [
    ["start", "Open the Agent Bus control menu"],
    ["help", "Show Telegram control commands"],
    ["status", "Show central, edge, queue, and room status"],
    ["agents", "List online agents and choose process agents"],
    ["new", "Start a new Telegram process/thread"],
    ["resume", "Resume a previous process/thread"],
    ["agent", "Set, toggle, or clear process agents"],
    ["rooms", "List Agent Bus rooms"],
    ["room", "Inspect or create rooms, set agents and steps"],
    ["run", "Queue one task for a specific agent"]
  ].map(([command, description]) => ({ command, description }));
}

async function telegramApi(botToken, method, params = {}, apiBaseUrl = "https://api.telegram.org", timeoutMs = 10000) {
  if (!botToken) throw new Error("Telegram bot token is required.");
  const root = String(apiBaseUrl || "https://api.telegram.org").replace(/\/+$/, "");
  const url = new URL(`${root}/bot${botToken}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", signal: controller.signal });
    const text = await res.text();
    const body = parseJsonText(text);
    if (!res.ok || body?.ok === false) {
      throw new Error(body?.description || text || `${res.status} ${res.statusText}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function telegramPollerService(target, options) {
  if (target === "systemd") return telegramPollerSystemdService(options);
  if (target === "launchd") return telegramPollerLaunchdService(options);
  return telegramPollerWindowsService(options);
}

function telegramPollerCommandParts(options) {
  const base = options.agentBusPath
    ? [options.agentBusPath]
    : [process.execPath, process.argv[1] && fs.existsSync(process.argv[1]) ? process.argv[1] : path.join(__dirname, "agent-bus.mjs")];
  const parts = [...base, "plugin", "telegram", "poll", "--gateway", options.gateway || "http://127.0.0.1:8788"];
  if (options.deleteWebhook) parts.push("--delete-webhook");
  if (options.setCommands) parts.push("--set-commands");
  return parts;
}

function telegramPollerSystemdService(options) {
  return `[Unit]
Description=${options.name}
After=network-online.target agent-bus-central.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${options.cwd}
EnvironmentFile=${options.envFile}
ExecStart=${telegramPollerCommandParts(options).map(quoteForShell).join(" ")}
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
`;
}

function telegramPollerLaunchdService(options) {
  const parts = telegramPollerCommandParts(options);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(options.name)}</string>
  <key>WorkingDirectory</key><string>${escapeXml(options.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_BUS_TELEGRAM_ENV_FILE</key><string>${escapeXml(options.envFile)}</string>
  </dict>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>. ${escapeXml(quoteForShell(options.envFile))} && exec ${parts.map(quoteForShell).join(" ")}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/${escapeXml(options.name)}.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/${escapeXml(options.name)}.err.log</string>
</dict>
</plist>
`;
}

function telegramPollerWindowsService(options) {
  const command = telegramPollerCommandParts(options).map(quoteForShell).join(" ").replace(/"/g, '\\"');
  return `# Run in an elevated PowerShell prompt.
# Load ${options.envFile} into the service account environment first, or set the variables below with setx.
setx AGENT_BUS_GATEWAY_URL "${String(options.gateway || "").replace(/"/g, '\\"')}" /M
sc.exe create ${options.name} binPath= "${command}" start= auto DisplayName= "${options.name}"
sc.exe failure ${options.name} reset= 60 actions= restart/5000
sc.exe start ${options.name}
`;
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

async function writeSetupEdgeConfig({ args, gateway, token, out, preset, auto, nodeId }) {
  const config = auto ? await edgeAutoTemplate(args) : edgeTemplate(preset || "echo");
  if (nodeId) config.nodeId = safeId(nodeId);
  if (gateway) config.gatewayUrl = gateway;
  if (token) config.token = token;
  fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  console.log(`Wrote ${out}`);
  console.log(`Node id: ${config.nodeId || "(hostname default)"}`);
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
  if (mode === "telegram-poller") {
    if (target === "launchd") return "com.agent-bus.telegram-poller.plist";
    if (target === "windows") return "agent-bus-telegram-poller-service.ps1";
    return "agent-bus-telegram-poller.service";
  }
  if (target === "launchd") return mode === "central" ? "com.agent-bus.central.plist" : "com.agent-bus.edge.plist";
  if (target === "windows") return mode === "central" ? "agent-bus-central-service.ps1" : "agent-bus-edge-service.ps1";
  return mode === "central" ? "agent-bus-central.service" : "agent-bus-edge.service";
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
  const localOnly = args.includes("--local-only");
  const production = args.includes("--production");
  const requestedMode = doctorRequestedMode(args);
  const checks = [];
  let config = null;

  addCheck(checks, "pass", "Node.js runtime", process.version);
  addCheck(checks, "pass", "Agent Bus version", readPackageVersion());

  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!isPlainObject(config)) throw new Error("edge config must be a JSON object");
    addCheck(checks, "pass", "Read config", configPath);
  } catch (err) {
    addCheck(checks, "fail", "Read config", err.message);
    return {
      configPath,
      config: null,
      gatewayUrl: gatewayArg || "",
      tokenPresent: Boolean(tokenArg),
      configDir: path.dirname(path.resolve(configPath)),
      mode: requestedMode || "edge",
      checks
    };
  }

  const mode = requestedMode || inferDoctorMode(config);
  const gatewayUrl = gatewayArg || config.gatewayUrl || (mode === "central" ? localCentralGatewayUrl(config) : "http://127.0.0.1:8788");
  const token = tokenArg || config.token || "";
  const configDir = path.dirname(path.resolve(configPath));

  if (mode === "central") {
    validateCentralConfig(checks, config, gatewayUrl, token, configDir, { production });
  } else {
    validateEdgeConfig(checks, config, gatewayUrl, token, configDir);
    checkConfiguredTools(checks, config, configDir);
  }

  if (localOnly) {
    addCheck(checks, "pass", "gateway checks skipped", "--local-only");
  } else {
    if (mode === "central") {
      await checkCentralGateway(checks, gatewayUrl, token, { production });
    } else {
      await checkGateway(checks, gatewayUrl, token, config);
    }
  }
  if (mode === "edge") {
    await checkLocalProbe(checks, configPath);
  }

  return {
    configPath,
    config,
    gatewayUrl,
    tokenPresent: Boolean(token && !isPlaceholder(token)),
    configDir,
    mode,
    production,
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
    addCheck(checks, "fail", "enabled agents", "no enabled agents configured", "Enable at least one echo, command, Codex, OpenClaw, Hermes, Claude Code, or Ollama agent.");
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

async function checkCentralGateway(checks, gatewayUrl, token, options = {}) {
  const production = options.production === true;
  if (!gatewayUrl || isPlaceholder(gatewayUrl) || !validateGatewayUrl(gatewayUrl).ok) return;
  const health = await fetchJson(gatewayUrl, "/health", "", 8000);
  if (health.ok) {
    addCheck(checks, "pass", "central health endpoint", gatewayHealthSummary(health.data));
  } else {
    addCheck(checks, "fail", "central health endpoint", health.error, "Start Central, check the service port, and include any reverse-proxy path prefix in --gateway.");
  }

  const wellKnown = await fetchJson(gatewayUrl, "/.well-known/agent-bus.json", "", 8000);
  if (wellKnown.ok) {
    addCheck(checks, "pass", "central well-known", wellKnown.data.protocol || "ok");
  } else {
    addCheck(checks, "warn", "central well-known", wellKnown.error, "Discovery can still work manually, but public join UX is better when this endpoint is reachable.");
  }

  if (!token || isPlaceholder(token)) return;
  const status = await fetchJson(gatewayUrl, "/v1/agent-bus/status", token, 8000);
  let summary = {};
  if (status.ok) {
    summary = status.data.summary || status.data.health || {};
    addCheck(checks, "pass", "central readiness status", `nodes=${summary.nodes ?? "?"} agents=${summary.agents ?? "?"} queued=${summary.queued ?? "?"}`);
    const onlineNodes = Number(summary.nodes ?? 0);
    const onlineAgents = Number(summary.agents ?? 0);
    if (onlineNodes > 0 || onlineAgents > 0) {
      addCheck(checks, "pass", "runtime edge connectivity", `nodes=${onlineNodes} agents=${onlineAgents}`);
    } else {
      addCheck(checks, production ? "fail" : "warn", "runtime edge connectivity", "no online edges", "Create or join at least one edge token, then start an edge service.");
    }
  } else {
    addEndpointFailure(checks, "central readiness status", status, "The admin token must be valid to read /v1/agent-bus/status.");
  }

  const edgeTokens = await fetchJson(gatewayUrl, "/edge/tokens", token, 8000);
  if (edgeTokens.ok) {
    const list = asList(edgeTokens.data);
    const active = list.filter((item) => String(item.status || "active").toLowerCase() === "active");
    if (active.length) {
      addCheck(checks, "pass", "runtime edge tokens", `${active.length}/${list.length} active`);
    } else if (Number(summary.nodes ?? 0) > 0) {
      addCheck(checks, "pass", "runtime edge tokens", "no active registry tokens, but online edges are present");
    } else {
      addCheck(checks, production ? "fail" : "warn", "runtime edge tokens", "none active", "Create an edge token from the Web Console, pair-code flow, or agent-bus pair create.");
    }
  } else {
    addEndpointFailure(checks, "runtime edge tokens", edgeTokens, "Upgrade Central if you need token registry diagnostics.");
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

function pathExists(value) {
  try {
    fs.accessSync(value);
    return true;
  } catch {
    return false;
  }
}

function nearestExistingAncestor(value) {
  let current = path.resolve(value);
  while (current && current !== path.dirname(current)) {
    current = path.dirname(current);
    if (pathExists(current)) return current;
  }
  return current && pathExists(current) ? current : "";
}

function isWritable(value) {
  try {
    fs.accessSync(value, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isLikelyEphemeralPath(value) {
  const resolved = path.resolve(value).replace(/\\/g, "/").toLowerCase();
  const tmp = path.resolve(os.tmpdir()).replace(/\\/g, "/").toLowerCase();
  return resolved === tmp || resolved.startsWith(`${tmp}/`) || /^\/tmp(\/|$)/.test(resolved) || /^\/var\/tmp(\/|$)/.test(resolved);
}

function safeBackendUrlDetail(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname || ""}`;
  } catch {
    return "configured";
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
    config: config ? diagnosticsConfigSummary(config, context.gatewayUrl, context.tokenPresent, context.mode) : {
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

function diagnosticsConfigSummary(config, gatewayUrl, tokenPresent, mode = "edge") {
  if (mode === "central") {
    const router = isPlainObject(config.modelRouter) ? config.modelRouter : {};
    const telegram = config.plugins?.telegramBot;
    return {
      readable: true,
      mode: "central",
      host: config.host || "",
      port: config.port,
      gatewayUrl: gatewayUrl || config.gatewayUrl || "",
      dataDir: config.dataDir || "",
      token: tokenPresent ? "configured" : "missing_or_placeholder",
      edgeTokens: Array.isArray(config.edgeTokens) ? config.edgeTokens.length : 0,
      modelRouter: {
        enabled: router.enabled !== false,
        agentModels: router.agentModels !== false,
        allowEdgeAgentModels: router.allowEdgeAgentModels === true,
        defaultBackend: router.defaultBackend || "",
        defaultModel: router.defaultModel || "",
        backends: Array.isArray(router.backends)
          ? router.backends.map((backend) => ({
            id: backend?.id || "",
            enabled: backend?.enabled !== false,
            baseUrl: backend?.baseUrl || "",
            apiKeyEnv: backend?.apiKeyEnv || "",
            models: Array.isArray(backend?.models) ? backend.models : []
          }))
          : []
      },
      telegramBot: isPlainObject(telegram) ? {
        enabled: telegram.enabled === true,
        dryRun: telegram.dryRun === true,
        controlEnabled: telegram.control?.enabled === true,
        conversationEnabled: telegram.control?.conversation?.enabled === true
      } : { enabled: false }
    };
  }
  return {
    readable: true,
    mode: "edge",
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
      .replace(/(^|[\s"'(])\/(?:Users|home|root|tmp|private|var(?:\/folders)?|opt|srv|mnt|Volumes|workspace|workspaces)(?:\/[^\s"',)}]+)+/g, (_, prefix) => `${prefix}[REDACTED_PATH]`)
      .replace(/(^|[\s"'(])\/(?:[^/\s"',)}]+\/)+[^/\s"',)}]+\.[A-Za-z0-9._-]+/g, (_, prefix) => `${prefix}[REDACTED_PATH]`);
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
  const result = doctorResult(checks);
  const status = result.counts.fail > 0 ? "FAIL" : result.counts.warn > 0 ? "WARN" : "OK";
  console.log(`Doctor: ${status} pass=${result.counts.pass} warn=${result.counts.warn} fail=${result.counts.fail}`);
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
    gatewayUrl: "",
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
    },
    plugins: {
      telegramBot: {
        enabled: false,
        botTokenEnv: "AGENT_BUS_TELEGRAM_BOT_TOKEN",
        chatIdEnv: "AGENT_BUS_TELEGRAM_CHAT_ID",
        dryRun: false,
        events: ["central.started", "edge.registered", "run.completed", "run.failed", "room.completed", "telegram.test", "telegram.command"],
        control: {
          enabled: false,
          secretTokenEnv: "AGENT_BUS_TELEGRAM_WEBHOOK_SECRET",
          allowedChatIds: [],
          allowRun: true,
          conversation: {
            enabled: false,
            agentId: "",
            agents: []
          }
        }
      }
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
      capabilities: ["shell", "files"],
      permission_profile: "local-demo",
      allowed_wake_targets: ["local-echo"]
    }],
    codex: [codexAgent("codex", "codex-local", { script: process.platform === "win32" ? "" : "./scripts/codex-agent-bus.sh" })],
    openclaw: [openclawAgent("./scripts/openclaw-agent-bus.sh")],
    hermes: [hermesAgent(defaultHermesCommand())],
    claudecode: [claudeCodeAgent(defaultClaudeCodeCommand(), "claudecode-local", { script: process.platform === "win32" ? "" : "./scripts/claudecode-agent-bus.sh" })],
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
    throw new Error(`No supported local AI tools were detected. Found: ${detected}. Install Codex, OpenClaw, Hermes, Claude Code, or Ollama, or use --preset echo.`);
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

function doctorRequestedMode(args) {
  const explicit = String(optionValue(args, "--mode") || "").trim().toLowerCase();
  const positional = ["central", "edge"].includes(String(args[0] || "").toLowerCase())
    ? String(args[0]).toLowerCase()
    : "";
  const mode = explicit || positional;
  if (!mode) return "";
  if (!["central", "edge"].includes(mode)) throw new Error("doctor --mode must be central or edge.");
  return mode;
}

function inferDoctorMode(config) {
  if (Array.isArray(config.agents) || config.nodeId) return "edge";
  if (Object.hasOwn(config, "dataDir") || Object.hasOwn(config, "edgeTokens") || Object.hasOwn(config, "modelRouter") || Object.hasOwn(config, "port")) {
    return "central";
  }
  return "edge";
}

function localCentralGatewayUrl(config) {
  const host = String(config.host || process.env.AGENT_BUS_HOST || "127.0.0.1").trim();
  const port = positiveIntegerOption(config.port || process.env.AGENT_BUS_PORT, 8788, 65535);
  const clientHost = ["0.0.0.0", "::", ""].includes(host) ? "127.0.0.1" : host;
  return `http://${clientHost}:${port}`;
}

async function discoverLocalTools() {
  const host = safeId(os.hostname() || "local");
  const codexPath = findExecutable("codex");
  const codexScript = os.platform() === "win32" ? "" : findFirstExisting([
    path.resolve(process.cwd(), "scripts", "codex-agent-bus.sh"),
    path.resolve(__dirname, "scripts", "codex-agent-bus.sh"),
    "/root/agent-bus/scripts/codex-agent-bus.sh"
  ]);
  const hermesPath = findExecutable("hermes", commonHermesPaths());
  const claudeCodePath = findExecutable("claude", commonClaudeCodePaths()) || findExecutable("claude-code") || findExecutable("claudecode");
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
  const claudeCodeScript = os.platform() === "win32" ? "" : findFirstExisting([
    path.resolve(process.cwd(), "scripts", "claudecode-agent-bus.sh"),
    path.resolve(__dirname, "scripts", "claudecode-agent-bus.sh"),
    "/root/agent-bus/scripts/claudecode-agent-bus.sh"
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
      note: codexScript ? "Using bundled Codex Agent Bus bridge script for large room prompts." : "",
      agent: codexPath ? codexAgent(codexPath, `codex-${host}`, { script: codexScript }) : null
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
      id: "claudecode",
      name: "Claude Code",
      available: Boolean(claudeCodePath),
      command: claudeCodeScript || claudeCodePath || defaultClaudeCodeCommand(),
      version: claudeCodePath ? commandVersion(claudeCodePath) : "",
      note: claudeCodeScript
        ? "Using bundled Claude Code Agent Bus bridge script for non-OpenAI CLI routing."
        : "",
      agent: claudeCodePath ? claudeCodeAgent(claudeCodePath, `claudecode-${host}`, { script: claudeCodeScript }) : null
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
    console.log("\nNo supported tools found. Install Codex, OpenClaw, Hermes, Claude Code, or Ollama, then run agent-bus detect again.");
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
    checkConfiguredCommandFile(checks, config, agent, baseDir);
  }
}

function checkConfiguredCommandFile(checks, config, agent, baseDir) {
  const reference = configuredCommandFileReference(agent.runCommand || "");
  if (!reference) return;
  const name = `agent ${agent.id} command file`;
  const missingHint = "Pull/sync the repo or portable bundle that contains this script, or update runCommand/config.cwd before restarting the edge service.";
  if (reference.absolute) {
    const resolved = resolveConfigPath(reference.path, baseDir);
    if (pathExists(resolved)) {
      addCheck(checks, "pass", name, resolved);
    } else {
      addCheck(checks, "fail", name, `${resolved} not found`, missingHint);
    }
    return;
  }

  const cwdInfo = configuredAgentWorkingDir(config, agent, baseDir);
  const resolved = path.resolve(cwdInfo.path, reference.path);
  if (!cwdInfo.pinned) {
    const detail = pathExists(resolved)
      ? `${reference.path} resolves from current cwd ${cwdInfo.path}`
      : `${reference.path} not found from current cwd ${cwdInfo.path}`;
    addCheck(checks, "warn", name, detail, "Set config.cwd or agent.cwd, or start the edge service with --cwd pointing at the repo or portable bundle root that contains this relative script.");
    return;
  }
  if (pathExists(resolved)) {
    addCheck(checks, "pass", name, resolved);
  } else {
    addCheck(checks, "fail", name, `${resolved} not found`, missingHint);
  }
}

function configuredCommandFileReference(commandText) {
  const tokens = shellCommandTokens(commandText).map(stripShellQuotes);
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1;
  if (index >= tokens.length) return null;
  const first = tokens[index];
  if (looksLikeDirectScriptPath(first)) return commandFileReference(first);
  if (!isCommandInterpreter(first)) return null;
  for (let i = index + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || token === "--") continue;
    if (["-m", "-c", "-e", "-lc", "/c", "/k"].includes(token)) return null;
    if (token.startsWith("-")) continue;
    return looksLikeCommandPathToken(token) ? commandFileReference(token) : null;
  }
  return null;
}

function commandFileReference(value) {
  return {
    path: value,
    absolute: value.startsWith("~") || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)
  };
}

function looksLikeDirectScriptPath(value) {
  const token = String(value || "");
  if (!token || token.startsWith("$") || token.startsWith("%") || /:\/\//.test(token)) return false;
  const normalized = token.replace(/\\/g, "/");
  if (normalized.startsWith("./") || normalized.startsWith("../") || normalized.startsWith("~/")) return true;
  if (/(^|\/)scripts\//i.test(normalized)) return true;
  const extension = path.posix.extname(normalized).toLowerCase();
  return new Set([".sh", ".js", ".mjs", ".cjs", ".py", ".ps1", ".cmd", ".bat"]).has(extension);
}

function looksLikeCommandPathToken(value) {
  const token = String(value || "");
  if (!token || token.startsWith("$") || token.startsWith("%") || /:\/\//.test(token)) return false;
  if (token.startsWith("./") || token.startsWith("../") || token.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(token) || token.startsWith("/")) return true;
  if (/[\\/]/.test(token)) return true;
  const extension = path.posix.extname(token.replace(/\\/g, "/")).toLowerCase();
  return new Set([".sh", ".js", ".mjs", ".cjs", ".py", ".ps1", ".cmd", ".bat"]).has(extension);
}

function isCommandInterpreter(value) {
  const base = String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/i, "");
  return new Set(["bash", "sh", "zsh", "fish", "node", "bun", "deno", "python", "python3", "pwsh", "powershell", "cmd"]).has(base);
}

function configuredAgentWorkingDir(config, agent, baseDir) {
  if (agent.cwd) {
    return { path: resolveConfigPath(agent.cwd, baseDir), pinned: true, source: "agent.cwd" };
  }
  if (config.cwd) {
    return { path: resolveConfigPath(config.cwd, baseDir), pinned: true, source: "config.cwd" };
  }
  return { path: process.cwd(), pinned: false, source: "process.cwd()" };
}

function validateCentralConfig(checks, config, gatewayUrl, token, baseDir, options = {}) {
  const production = options.production === true;
  addCheck(checks, "pass", "doctor mode", "central");
  if (production) addCheck(checks, "pass", "doctor profile", "production");

  const host = String(config.host || process.env.AGENT_BUS_HOST || "127.0.0.1").trim();
  if (host) {
    addCheck(checks, "pass", "central host", host);
  } else {
    addCheck(checks, "warn", "central host", "missing; defaults to 127.0.0.1", "Set host explicitly in production service config.");
  }

  const port = Number(config.port || process.env.AGENT_BUS_PORT || 8788);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    addCheck(checks, "pass", "central port", String(port));
  } else {
    addCheck(checks, "fail", "central port", String(config.port || process.env.AGENT_BUS_PORT || ""), "Use a TCP port between 1 and 65535.");
  }

  const gatewayStatus = validateGatewayUrl(gatewayUrl);
  if (gatewayStatus.ok && !isPlaceholder(gatewayUrl)) {
    addCheck(checks, "pass", "public gatewayUrl", gatewayUrl);
  } else {
    addCheck(checks, "warn", "public gatewayUrl", gatewayStatus.error || "not configured", "Set gatewayUrl/AGENT_BUS_GATEWAY_URL to the public reverse-proxy URL users and edges will join.");
  }

  validateCentralToken(checks, token, { production });
  validateCentralDataDir(checks, config, baseDir);
  validateCentralEdgeTokens(checks, config);
  validateCentralDefaults(checks, config);
  validateCentralModelRouter(checks, config);
  validateCentralTelegram(checks, config, { production });
}

function validateCentralToken(checks, token, options = {}) {
  const production = options.production === true;
  const text = String(token || "").trim();
  if (!text || isPlaceholder(text)) {
    addCheck(checks, "fail", "admin token", "missing or placeholder", "Set AGENT_BUS_TOKEN or central.config.json token to a long random value before exposing Central.");
    return;
  }
  if (text.length < 24) {
    addCheck(checks, production ? "fail" : "warn", "admin token", "configured but short", "Use at least 24 random characters for operator/admin access.");
    return;
  }
  addCheck(checks, "pass", "admin token", "configured");
}

function validateCentralDataDir(checks, config, baseDir) {
  const configured = config.dataDir || process.env.AGENT_BUS_DATA_DIR || "./data/central";
  const resolved = resolveConfigPath(configured, baseDir);
  if (!path.isAbsolute(String(configured))) {
    addCheck(checks, "warn", "central dataDir path", `${configured} is relative`, "For systemd/Docker, prefer an absolute persistent path or mounted volume.");
  }
  if (pathExists(resolved)) {
    if (!isDirectory(resolved)) {
      addCheck(checks, "fail", "central dataDir", `${resolved} is not a directory`, "Point dataDir at a writable directory.");
      return;
    }
    if (isWritable(resolved)) {
      addCheck(checks, "pass", "central dataDir", `${resolved} writable`);
    } else {
      addCheck(checks, "fail", "central dataDir", `${resolved} is not writable`, "Fix ownership/permissions before starting Central.");
    }
  } else {
    const ancestor = nearestExistingAncestor(resolved);
    if (ancestor && isDirectory(ancestor) && isWritable(ancestor)) {
      addCheck(checks, "pass", "central dataDir", `${resolved} can be created`);
    } else {
      addCheck(checks, "fail", "central dataDir", `${resolved} parent is not writable`, "Create the parent directory or use a persistent volume.");
    }
  }
  if (isLikelyEphemeralPath(resolved)) {
    addCheck(checks, "warn", "central dataDir persistence", `${resolved} looks ephemeral`, "Use a persistent disk or Docker volume for rooms, runs, traces, and Telegram sessions.");
  } else {
    addCheck(checks, "pass", "central dataDir persistence", "persistent-looking path");
  }
}

function validateCentralEdgeTokens(checks, config) {
  const raw = Array.isArray(config.edgeTokens) ? config.edgeTokens : [];
  if (!raw.length) {
    addCheck(checks, "pass", "static edge tokens", "none in config; runtime registry or pair codes may be used");
    return;
  }
  const tokens = raw.map(edgeTokenValue).filter(Boolean);
  const placeholders = tokens.filter((item) => isPlaceholder(item));
  const short = tokens.filter((item) => !isPlaceholder(item) && item.length < 20);
  const duplicates = duplicateValues(tokens);
  if (placeholders.length) addCheck(checks, "fail", "static edge tokens", `${placeholders.length} placeholder token(s)`, "Replace example edge tokens before exposing Central.");
  if (short.length) addCheck(checks, "warn", "static edge tokens strength", `${short.length} short token(s)`, "Use long random scoped edge tokens.");
  if (duplicates.length) addCheck(checks, "fail", "static edge tokens duplicates", `${duplicates.length} duplicate token(s)`, "Each edge token must be unique.");
  if (!placeholders.length && !duplicates.length) addCheck(checks, "pass", "static edge tokens", `${tokens.length} configured`);
}

function edgeTokenValue(item) {
  if (typeof item === "string") return item;
  if (isPlainObject(item)) return String(item.token || item.value || "");
  return "";
}

function validateCentralDefaults(checks, config) {
  const defaults = isPlainObject(config.defaults) ? config.defaults : {};
  const pollTimeout = Number(defaults.pollTimeoutMs || 0);
  if (Number.isFinite(pollTimeout) && pollTimeout >= 1000 && pollTimeout <= 120000) {
    addCheck(checks, "pass", "central poll timeout", `${pollTimeout}ms`);
  } else if (pollTimeout) {
    addCheck(checks, "warn", "central poll timeout", `${pollTimeout}ms`, "Use a practical long-poll timeout such as 25000ms.");
  } else {
    addCheck(checks, "pass", "central poll timeout", "default");
  }
}

function validateCentralModelRouter(checks, config) {
  const router = isPlainObject(config.modelRouter) ? config.modelRouter : {};
  if (router.enabled === false) {
    addCheck(checks, "pass", "model router", "disabled");
    return;
  }
  addCheck(checks, "pass", "model router", "enabled");
  if (router.agentModels === false) {
    addCheck(checks, "warn", "agent-backed models", "disabled", "Enable modelRouter.agentModels if you want model=agent:<id> routing.");
  } else {
    addCheck(checks, "pass", "agent-backed models", "enabled");
  }
  const backends = Array.isArray(router.backends) ? router.backends : [];
  const enabled = backends.filter((backend) => isPlainObject(backend) && backend.enabled !== false);
  if (!backends.length) {
    addCheck(checks, "warn", "model backends", "none configured", "Agent-backed models can still work, but real upstream model routing needs a backend.");
    return;
  }
  if (!enabled.length) {
    addCheck(checks, "warn", "model backends", "all disabled", "Enable at least one backend before routing non-agent models.");
  } else {
    addCheck(checks, "pass", "model backends", `${enabled.length}/${backends.length} enabled`);
  }
  const backendIds = new Set(backends.map((backend) => backend?.id).filter(Boolean));
  if (router.defaultBackend && !backendIds.has(router.defaultBackend)) {
    addCheck(checks, "warn", "default backend", `${router.defaultBackend} not found`, "Set modelRouter.defaultBackend to an existing backend id.");
  }
  for (const backend of enabled) {
    validateCentralBackend(checks, backend);
  }
}

function validateCentralBackend(checks, backend) {
  const prefix = `backend ${backend.id || "(missing id)"}`;
  if (!backend.id) addCheck(checks, "fail", `${prefix} id`, "missing", "Give every model backend a stable id.");
  const baseUrl = String(backend.baseUrl || "").trim();
  const status = validateGatewayUrl(baseUrl);
  if (!baseUrl || isPlaceholder(baseUrl)) {
    addCheck(checks, "warn", `${prefix} baseUrl`, "missing or placeholder", "Set an OpenAI-compatible /v1 base URL before routing real model traffic.");
  } else if (!status.ok) {
    addCheck(checks, "fail", `${prefix} baseUrl`, status.error, "Backend baseUrl must be http or https.");
  } else {
    addCheck(checks, "pass", `${prefix} baseUrl`, safeBackendUrlDetail(baseUrl));
  }
  if (backend.apiKey && !isPlaceholder(backend.apiKey)) {
    addCheck(checks, "warn", `${prefix} apiKey`, "inline secret configured", "Prefer apiKeyEnv so diagnostics and config files stay share-safe.");
  } else if (backend.apiKeyEnv) {
    addCheck(checks, process.env[backend.apiKeyEnv] ? "pass" : "warn", `${prefix} apiKeyEnv`, process.env[backend.apiKeyEnv] ? `${backend.apiKeyEnv} set` : `${backend.apiKeyEnv} not set`, "Set this environment variable before sending real model requests.");
  } else {
    addCheck(checks, "warn", `${prefix} api key`, "not configured", "Set apiKeyEnv or apiKey for authenticated upstream model routing.");
  }
  if (Array.isArray(backend.models) && backend.models.length) {
    addCheck(checks, "pass", `${prefix} models`, `${backend.models.length} configured`);
  } else {
    addCheck(checks, "warn", `${prefix} models`, "none listed", "List models so /v1/models can advertise routing choices.");
  }
}

function validateCentralTelegram(checks, config, options = {}) {
  const production = options.production === true;
  const plugin = config.plugins?.telegramBot;
  const pluginConfig = isPlainObject(plugin) ? plugin : {};
  const envEnabled = envBoolean("AGENT_BUS_TELEGRAM_ENABLED");
  const enabled = envEnabled === undefined ? pluginConfig.enabled === true : envEnabled;
  if (!enabled) {
    addCheck(checks, "pass", "telegram plugin", "disabled");
    return;
  }
  const dryRun = envBoolean("AGENT_BUS_TELEGRAM_DRY_RUN") ?? (pluginConfig.dryRun === true || pluginConfig.dry_run === true);
  addCheck(checks, "pass", "telegram plugin", dryRun ? "enabled dry-run" : "enabled");
  const botTokenEnv = pluginConfig.botTokenEnv || "AGENT_BUS_TELEGRAM_BOT_TOKEN";
  const chatIdEnv = pluginConfig.chatIdEnv || "AGENT_BUS_TELEGRAM_CHAT_ID";
  addCheck(checks, process.env[botTokenEnv] || dryRun ? "pass" : production ? "fail" : "warn", "telegram bot token env", process.env[botTokenEnv] ? `${botTokenEnv} set` : `${botTokenEnv} not set`, "Set the bot token env var or keep dryRun enabled.");
  addCheck(checks, process.env[chatIdEnv] || dryRun ? "pass" : production ? "fail" : "warn", "telegram chat id env", process.env[chatIdEnv] ? `${chatIdEnv} set` : `${chatIdEnv} not set`, "Set the operator chat id env var or keep dryRun enabled.");

  const control = isPlainObject(pluginConfig.control) ? pluginConfig.control : {};
  const controlEnabled = envBoolean("AGENT_BUS_TELEGRAM_CONTROL_ENABLED") ?? (control.enabled === true);
  if (controlEnabled) {
    const secretEnv = control.secretTokenEnv || "AGENT_BUS_TELEGRAM_WEBHOOK_SECRET";
    addCheck(checks, process.env[secretEnv] ? "pass" : production ? "fail" : "warn", "telegram webhook secret", process.env[secretEnv] ? `${secretEnv} set` : `${secretEnv} not set`, "Set a webhook secret before accepting public Telegram callbacks.");
    const allowedChats = telegramAllowedChatIds(pluginConfig, control);
    if (allowedChats.length) {
      addCheck(checks, "pass", "telegram allowed chats", `${allowedChats.length} configured`);
    } else {
      addCheck(checks, production ? "fail" : "warn", "telegram allowed chats", "not restricted", "Set allowedChatIds for production control bots.");
    }
  }
  const conversation = isPlainObject(control.conversation) ? control.conversation : {};
  const conversationEnabled = envBoolean("AGENT_BUS_TELEGRAM_CONVERSATION_ENABLED") ?? (conversation.enabled === true);
  if (conversationEnabled) {
    const agents = telegramConversationAgents(conversation);
    if (agents.length) {
      addCheck(checks, "pass", "telegram conversation agents", agents.join(", "));
    } else {
      addCheck(checks, "pass", "telegram conversation agents", "default routing");
    }
  }
}

function telegramAllowedChatIds(plugin, control) {
  const values = [];
  const configured = control.allowedChatIds || control.allowed_chat_ids || [];
  if (Array.isArray(configured)) values.push(...configured);
  if (typeof configured === "string") values.push(...configured.split(","));
  const chatIdEnv = plugin.chatIdEnv || "AGENT_BUS_TELEGRAM_CHAT_ID";
  if (process.env[chatIdEnv]) values.push(process.env[chatIdEnv]);
  return unique(values.map((item) => String(item || "").trim()).filter(Boolean));
}

function telegramConversationAgents(conversation) {
  const values = [];
  for (const key of ["agentId", "agent_id", "defaultAgentId", "default_agent_id"]) {
    if (conversation[key]) values.push(conversation[key]);
  }
  const configured = conversation.agents || conversation.agentIds || conversation.agent_ids || [];
  if (Array.isArray(configured)) values.push(...configured);
  if (typeof configured === "string") values.push(...configured.split(","));
  if (process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENT) values.push(process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENT);
  if (process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS) values.push(...process.env.AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS.split(","));
  return unique(values.map((item) => String(item || "").trim()).filter(Boolean));
}

function envBoolean(name) {
  if (!Object.hasOwn(process.env, name)) return undefined;
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return undefined;
}

function codexAgent(commandPath, id = "codex-local", options = {}) {
  const script = options.script || "";
  return {
    id,
    kind: "codex",
    role: "coder",
    enabled: true,
    adapter: "command",
    capabilities: ["code", "review", "shell", "files"],
    permission_profile: "coder",
    allowed_wake_targets: [],
    pingUrl: "https://api.openai.com/v1/models",
    runCommand: script
      ? `CODEX_COMMAND=${quoteCommand(commandPath)} bash ${quoteCommand(script)}`
      : `${quoteCommand(commandPath)} exec --color never --dangerously-bypass-approvals-and-sandbox ${messageArgument()}${nullInputRedirect()}`
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
    permission_profile: "operator-browser",
    allowed_wake_targets: [],
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
    permission_profile: "research-readonly",
    allowed_wake_targets: [],
    pingUrl: "https://YOUR-MODEL-GATEWAY/v1/models",
    runCommand: script
      ? `HERMES_COMMAND=${quoteCommand(commandPath)} ${quoteCommand(script)}`
      : `${quoteCommand(commandPath)} chat -q ${messageArgument()} -Q`
  };
}

function claudeCodeAgent(commandPath, id = "claudecode-local", options = {}) {
  const script = options.script || "";
  return {
    id,
    kind: "claudecode",
    role: "coder",
    enabled: true,
    adapter: "command",
    capabilities: ["code", "review", "shell", "files", "agent"],
    permission_profile: "coder",
    allowed_wake_targets: [],
    healthCommand: `${quoteCommand(commandPath)} --version`,
    runCommand: script
      ? `CLAUDECODE_COMMAND=${quoteCommand(commandPath)} ${quoteCommand(script)}`
      : `${quoteCommand(commandPath)} --print --output-format text --permission-mode acceptEdits ${messageArgument()}${nullInputRedirect()}`
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
  if (action === "memory" || action === "index" || action === "toc" || action === "recall") {
    const roomId = requiredPositional(args, 1, "room id");
    const query = optionValue(args, "--query") || optionValue(args, "--q") || "";
    const pathname = `/rooms/${pathPart(roomId)}/memory${query ? `?q=${encodeURIComponent(query)}` : ""}`;
    const memory = await gatewayJson(pathname, { auth: true, args });
    if (args.includes("--json")) return printJson(memory);
    process.stdout.write(formatRoomMemory(memory, {
      limit: positiveIntegerOption(optionValue(args, "--limit"), 20, 100),
      snippets: positiveIntegerOption(optionValue(args, "--snippets"), 3, 20),
      preview: args.includes("--preview")
    }));
    return;
  }
  if (action === "expand" || action === "open") {
    const roomId = requiredPositional(args, 1, "room id");
    const ref = requiredPositional(args, 2, "memory ref");
    const params = new URLSearchParams({ ref });
    const around = optionValue(args, "--around");
    const chars = optionValue(args, "--chars");
    if (around !== undefined) params.set("around", around);
    if (chars !== undefined) params.set("chars", chars);
    const expanded = await gatewayJson(`/rooms/${pathPart(roomId)}/memory/expand?${params.toString()}`, { auth: true, args });
    if (args.includes("--json")) return printJson(expanded);
    process.stdout.write(formatRoomMemoryExpand(expanded));
    return;
  }
  if (action === "inspect") {
    const roomId = requiredPositional(args, 1, "room id");
    const staleSeconds = positiveIntegerOption(optionValue(args, "--stale-seconds") || process.env.AGENT_BUS_STATUS_STALE_SECONDS, 180, 86400);
    const queuedRunStaleSeconds = positiveIntegerOption(optionValue(args, "--queued-run-stale-seconds") || process.env.AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS, 21600, 604800);
    const runHeartbeatStaleSeconds = positiveIntegerOption(runHeartbeatStaleOption(args), DEFAULT_RUN_HEARTBEAT_STALE_SECONDS, 86400);
    const roomData = await gatewayJson(`/rooms/${pathPart(roomId)}`, { auth: true, args });
    const nodes = await optionalGatewayJson("/nodes", { auth: true, args }, []);
    const inspection = inspectRoomState(roomData, { nodes, staleSeconds, queuedRunStaleSeconds, runHeartbeatStaleSeconds });
    if (args.includes("--json")) return printJson(inspection);
    process.stdout.write(formatRoomStateInspection(inspection));
    return;
  }
  if (action === "health" || action === "ops") {
    const roomId = requiredPositional(args, 1, "room id");
    const staleSeconds = positiveIntegerOption(optionValue(args, "--stale-seconds") || process.env.AGENT_BUS_STATUS_STALE_SECONDS, 180, 86400);
    const queuedRunStaleSeconds = positiveIntegerOption(optionValue(args, "--queued-run-stale-seconds") || process.env.AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS, 21600, 604800);
    const runHeartbeatStaleSeconds = positiveIntegerOption(runHeartbeatStaleOption(args), DEFAULT_RUN_HEARTBEAT_STALE_SECONDS, 86400);
    const roomData = await gatewayJson(`/rooms/${pathPart(roomId)}`, { auth: true, args });
    const nodes = await optionalGatewayJson("/nodes", { auth: true, args }, []);
    const health = roomHealthSummary(roomData, { nodes, staleSeconds, queuedRunStaleSeconds, runHeartbeatStaleSeconds });
    if (args.includes("--json")) return printJson(health);
    process.stdout.write(formatRoomHealth(health));
    return;
  }
  if (action === "doctor" || action === "diagnose") {
    const roomId = requiredPositional(args, 1, "room id");
    const params = new URLSearchParams();
    const queuedRunStaleSeconds = optionValue(args, "--queued-run-stale-seconds") || process.env.AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS;
    const staleSeconds = optionValue(args, "--node-stale-seconds") || optionValue(args, "--stale-seconds") || process.env.AGENT_BUS_STATUS_STALE_SECONDS;
    const runHeartbeatStaleSeconds = runHeartbeatStaleOption(args);
    if (queuedRunStaleSeconds) params.set("queued_run_stale_seconds", queuedRunStaleSeconds);
    if (staleSeconds) params.set("node_stale_seconds", staleSeconds);
    if (runHeartbeatStaleSeconds) params.set("run_heartbeat_stale_seconds", runHeartbeatStaleSeconds);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const result = await gatewayJson(`/rooms/${pathPart(roomId)}/doctor${suffix}`, { auth: true, args });
    if (args.includes("--json")) return printJson(result);
    process.stdout.write(formatRoomDoctor(result));
    return;
  }
  if (action === "follow-up" || action === "followup" || action === "continue") {
    const roomId = requiredPositional(args, 1, "room id");
    const roomData = await gatewayJson(`/rooms/${pathPart(roomId)}`, { auth: true, args });
    const doctor = await optionalGatewayJson(`/rooms/${pathPart(roomId)}/doctor`, { auth: true, args }, null);
    const selectedAgents = csvOption(args, "--agents");
    const contractAgents = Array.isArray(doctor?.contract?.contract_gap_agents) ? doctor.contract.contract_gap_agents.filter(Boolean) : [];
    const blockingAgents = Array.isArray(doctor?.blocking_agents) ? doctor.blocking_agents.filter(Boolean) : [];
    const roomAgents = Array.isArray(roomData?.agents) ? roomData.agents.filter(Boolean) : [];
    const agents = uniqueStrings(selectedAgents.length ? selectedAgents : contractAgents.length ? contractAgents : blockingAgents.length ? blockingAgents : roomAgents);
    if (!agents.length) throw new Error("room follow-up could not infer agents; pass --agents a,b.");
    const wakeOverride = csvOption(args, "--wake-agents");
    const wakeAgents = args.includes("--no-wake") || args.includes("--no-wake-agents")
      ? []
      : uniqueStrings(wakeOverride.length ? wakeOverride : agents);
    const reason = optionValue(args, "--reason") || optionValue(args, "--message") || "";
    const body = {
      title: optionValue(args, "--title") || roomFollowUpDefaultTitle(roomData),
      trace_id: optionValue(args, "--trace-id") || optionValue(args, "--trace") || undefined,
      goal: optionValue(args, "--goal") || roomFollowUpDefaultGoal(roomData, doctor, reason),
      agents,
      ...(wakeAgents.length ? { wakeAgents } : {}),
    };
    const maxSteps = positiveIntegerOption(optionValue(args, "--max-steps") || optionValue(args, "--maxSteps"), 0, 1000);
    const autoRotate = booleanOption(args, "--auto-rotate", "--no-auto-rotate");
    if (maxSteps > 0) body.maxSteps = maxSteps;
    if (autoRotate !== undefined) body.autoRotate = autoRotate;
    const preview = {
      object: "agent_bus.room_followup_preview",
      source_room: {
        id: roomData?.id || roomId,
        title: roomData?.title || "",
        status: roomData?.status || "unknown",
      },
      doctor_summary: doctor?.summary || "",
      contract_gap_agents: contractAgents,
      request: body,
    };
    if (args.includes("--dry-run") || args.includes("--preview")) return printJson(preview);
    const created = await gatewayJson("/rooms", { auth: true, args, method: "POST", body });
    return printJson({
      object: "agent_bus.room_followup",
      source_room: preview.source_room,
      doctor_summary: preview.doctor_summary,
      contract_gap_agents: contractAgents,
      room: created,
    });
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
  if (["event-log", "events", "timeline", "tail"].includes(action)) {
    const roomId = requiredPositional(args, 1, "room id");
    const roomData = await gatewayJson(`/rooms/${pathPart(roomId)}`, { auth: true, args });
    const exportData = args.includes("--no-redact") ? roomData : redactRoomExport(roomData);
    const reportsOnly = args.includes("--reports-only") || args.includes("--summary");
    const bundle = roomEventBundle(exportData, { reportsOnly });
    const explicitTail = optionValue(args, "--tail");
    const limit = args.includes("--all")
      ? 0
      : positiveIntegerOption(optionValue(args, "--limit") || explicitTail, 0, 10000);
    const log = roomEventLog(bundle, {
      limit,
      tail: action === "tail" || explicitTail !== undefined,
      reverse: args.includes("--reverse"),
      full: args.includes("--full") || args.includes("--no-truncate")
    });
    if (args.includes("--json")) return printJson(log);
    process.stdout.write(formatRoomEventLog(log));
    return;
  }
  if (action === "replay") {
    const input = optionValue(args, "--in") || optionValue(args, "--input") || requiredPositional(args, 1, "event bundle path");
    const format = optionValue(args, "--format") || (args.includes("--markdown") ? "markdown" : "json");
    const bundle = readJsonFile(input);
    if (args.includes("--strict")) validateRoomEventBundle(bundle, { strictTypes: true });
    const summary = replayRoomEvents(bundle);
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
  if (action === "retry-failed" || action === "retry_failed" || action === "retry") {
    const roomId = requiredPositional(args, 1, "room id");
    const agents = csvOption(args, "--agents");
    const singleAgent = optionValue(args, "--agent");
    const yes = args.includes("--yes");
    const force = args.includes("--force");
    const reason = optionValue(args, "--reason") || optionValue(args, "--message") || "Retry failed room agents.";
    const body = {
      dry_run: !yes,
      confirm: yes,
      yes,
      force,
      reason,
      ...(agents.length ? { agents } : {}),
      ...(singleAgent ? { agent: singleAgent } : {})
    };
    const result = await gatewayJson(`/rooms/${pathPart(roomId)}/retry-failed`, { auth: true, args, method: "POST", body });
    if (args.includes("--json")) return printJson(result);
    process.stdout.write(formatRoomFailedRetryResult(result, { roomId, reason }));
    return;
  }
  if (action === "recover") {
    const roomId = requiredPositional(args, 1, "room id");
    const queuedRunStaleSeconds = positiveIntegerOption(optionValue(args, "--queued-run-stale-seconds") || process.env.AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS, 21600, 604800);
    const yes = args.includes("--yes");
    const force = args.includes("--force");
    const reason = optionValue(args, "--reason") || optionValue(args, "--message") || "Stale/orphan room recovery.";
    const body = {
      queued_run_stale_seconds: queuedRunStaleSeconds,
      dry_run: !yes,
      confirm: yes,
      yes,
      force,
      reason
    };
    let result;
    try {
      result = await gatewayJson(`/rooms/${pathPart(roomId)}/recover`, { auth: true, args, method: "POST", body });
    } catch (err) {
      if (httpStatusFromError(err?.message || err) !== 404) throw err;
      return legacyRoomRecover(args, roomId, { queuedRunStaleSeconds, reason });
    }
    if (args.includes("--json")) return printJson(result);
    process.stdout.write(formatRoomRecoveryResult(result, { roomId, queuedRunStaleSeconds, reason }));
    return;
  }
  if (action === "resolve-duplicates" || action === "dedupe" || action === "deduplicate") {
    const roomId = requiredPositional(args, 1, "room id");
    const yes = args.includes("--yes");
    const reason = optionValue(args, "--reason") || optionValue(args, "--message") || "Resolve duplicate active room runs.";
    const body = {
      dry_run: !yes,
      confirm: yes,
      yes,
      reason
    };
    const result = await gatewayJson(`/rooms/${pathPart(roomId)}/resolve-duplicates`, { auth: true, args, method: "POST", body });
    if (args.includes("--json")) return printJson(result);
    process.stdout.write(formatRoomDuplicateResolutionResult(result, { roomId, reason }));
    return;
  }
  if (action === "supervisor" || action === "supervise" || action === "tick") {
    const roomId = requiredPositional(args, 1, "room id");
    const queuedRunStaleSeconds = positiveIntegerOption(optionValue(args, "--queued-run-stale-seconds") || process.env.AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS, 21600, 604800);
    const staleSeconds = positiveIntegerOption(optionValue(args, "--node-stale-seconds") || optionValue(args, "--stale-seconds") || process.env.AGENT_BUS_STATUS_STALE_SECONDS, 180, 86400);
    const runHeartbeatStaleSeconds = positiveIntegerOption(runHeartbeatStaleOption(args), DEFAULT_RUN_HEARTBEAT_STALE_SECONDS, 86400);
    const yes = args.includes("--yes");
    const reason = optionValue(args, "--reason") || optionValue(args, "--message") || "Conservative room supervisor recovery.";
    const body = {
      queued_run_stale_seconds: queuedRunStaleSeconds,
      node_stale_seconds: staleSeconds,
      run_heartbeat_stale_seconds: runHeartbeatStaleSeconds,
      dry_run: !yes,
      confirm: yes,
      yes,
      reason
    };
    const result = await gatewayJson(`/rooms/${pathPart(roomId)}/supervisor`, { auth: true, args, method: "POST", body });
    if (args.includes("--json")) return printJson(result);
    process.stdout.write(formatRoomSupervisorResult(result, {
      roomId,
      queuedRunStaleSeconds,
      staleSeconds,
      runHeartbeatStaleSeconds,
      reason
    }));
    return;
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
  throw new Error("Usage: agent-bus room list|show|memory|expand|health|inspect|doctor|follow-up|export|replay|create|wake|pause|retry-failed|recover|resolve-duplicates|supervisor|message [options]");
}

function formatRoomMemory(value, options = {}) {
  const memory = value?.memory || {};
  const promptView = value?.prompt_view || {};
  const toc = Array.isArray(memory.table_of_contents) ? memory.table_of_contents : [];
  const promptToc = Array.isArray(promptView.table_of_contents) ? promptView.table_of_contents : [];
  const entries = toc.length ? toc : promptToc;
  const limit = Number.isFinite(options.limit) ? options.limit : 20;
  const snippetLimit = Number.isFinite(options.snippets) ? options.snippets : 3;
  const lines = [];
  lines.push(`Room memory ${value?.room_id || "-"} v${value?.version || memory.version || "-"}`);
  lines.push(`Sources: ${memory.source_count ?? promptView.source_count ?? 0}; index entries: ${toc.length}; snippets: ${(memory.snippets || []).length}; updated: ${memory.updated_at || promptView.updated_at || "-"}`);
  const keywords = memory.keywords || promptView.keywords || [];
  if (keywords.length) lines.push(`Keywords: ${keywords.slice(0, 18).join(", ")}`);
  if (entries.length) {
    lines.push("");
    lines.push("Table of contents:");
    for (const item of entries.slice(0, limit)) {
      const ref = item.ref || {};
      const meta = [ref.speaker, ref.at, ref.run_id].filter(Boolean).join(" ");
      const topics = Array.isArray(item.topics) && item.topics.length ? ` topics=${item.topics.slice(0, 6).join(",")}` : "";
      lines.push(`- ${ref.label || "-"}${meta ? ` ${meta}` : ""}${topics}`);
      if (item.title) lines.push(`  ${truncateOneLine(item.title, 140)}`);
      if (item.preview && options.preview) lines.push(`  ${truncateOneLine(item.preview, 180)}`);
    }
    if (entries.length > limit) lines.push(`... ${entries.length - limit} more entries. Re-run with --limit ${entries.length} or use --json.`);
  }
  const snippets = promptView.relevant_snippets || memory.snippets || [];
  if (snippetLimit > 0 && snippets.length) {
    lines.push("");
    lines.push("Relevant snippets:");
    for (const item of snippets.slice(0, snippetLimit)) {
      const ref = item.ref || {};
      lines.push(`- ${ref.label || "-"}: ${truncateOneLine(item.content || item.preview || "", 220)}`);
    }
  }
  const endpoint = value?.expand?.endpoint;
  if (endpoint) {
    lines.push("");
    lines.push("Expand with: agent-bus room expand ROOM_ID 'messages[7]' --around 1");
  }
  return `${lines.join("\n")}\n`;
}

function formatRoomMemoryExpand(value) {
  const lines = [];
  lines.push(`Room memory expand ${value?.room_id || "-"} ${value?.ref || "-"}`);
  lines.push(`Around: ${value?.around ?? 0}; source items: ${value?.source_count ?? 0}`);
  if (value?.toc_entry?.title) lines.push(`Title: ${value.toc_entry.title}`);
  lines.push("");
  for (const item of value?.items || []) {
    const ref = item.ref || {};
    const marker = item.selected ? "*" : "-";
    const meta = [ref.label, ref.speaker, ref.at, ref.run_id].filter(Boolean).join(" ");
    lines.push(`${marker} ${meta || "-"}`);
    if (item.topics?.length) lines.push(`  topics: ${item.topics.join(", ")}`);
    lines.push(markdownFence(item.content || ""));
    lines.push("");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

function truncateOneLine(value, limit = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function inspectRoomRecovery(room, { queuedRunStaleSeconds = 21600 } = {}) {
  const buckets = activeRunBucketsForRoom(room, { queuedRunStaleSeconds });
  const runs = Array.isArray(room?.runs) ? room.runs : [];
  const activeRuns = buckets.liveRuns.map((run) => ({ ...run, age_seconds: runAgeSeconds(run) }));
  const staleQueuedRuns = buckets.staleQueuedRuns.map((run) => ({ ...run, age_seconds: runAgeSeconds(run) }));
  return {
    room: {
      id: room?.id || "",
      title: room?.title || "",
      status: room?.status || "unknown",
      updated_at: room?.updated_at || null,
      agents: room?.agents || []
    },
    thresholds: { queued_run_stale_seconds: queuedRunStaleSeconds },
    counts: { runs: runs.length, active_runs: activeRuns.length, stale_queued_runs: staleQueuedRuns.length },
    active_runs: activeRuns,
    stale_queued_runs: staleQueuedRuns,
    recommendation: staleQueuedRuns.length
      ? "pause_recover_orphan_queued_runs"
      : activeRuns.length
      ? "wait_or_inspect_running_agents"
      : "no_active_run_recovery_needed"
  };
}

function runAgeSeconds(run) {
  const at = Date.parse(run.started_at || run.created_at || "");
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((Date.now() - at) / 1000));
}

function formatRoomInspection(inspection) {
  const room = inspection.room || {};
  const lines = [];
  lines.push(`Room ${room.id || "-"}: ${room.status || "unknown"}${room.title ? ` (${room.title})` : ""}`);
  lines.push(`Agents: ${(room.agents || []).join(",") || "-"}`);
  lines.push(`Runs: ${inspection.counts?.runs || 0} total, ${inspection.counts?.active_runs || 0} active, ${inspection.counts?.stale_queued_runs || 0} stale queued`);
  if (inspection.active_runs?.length) {
    lines.push("Active runs:");
    for (const run of inspection.active_runs) lines.push(`- ${run.id || "-"}: ${run.agent_id || "-"} ${run.status || "unknown"} age=${run.age_seconds ?? "?"}s`);
  }
  if (inspection.stale_queued_runs?.length) {
    lines.push("Stale queued runs:");
    for (const run of inspection.stale_queued_runs) lines.push(`- ${run.id || "-"}: ${run.agent_id || "-"} queued age=${run.age_seconds ?? "?"}s`);
    lines.push(`Recommendation: ${inspection.recommendation || "pause_recover_orphan_queued_runs"}`);
    lines.push(`Recommended recovery: export the room if needed, then run \`agent-bus room recover ${room.id || "ROOM_ID"} --yes\` to pause the orphan room and cancel stale queued runs.`);
  } else if (inspection.active_runs?.length) {
    lines.push(`Recommendation: ${inspection.recommendation || "wait_or_inspect_running_agents"}`);
    lines.push("No stale queued runs found. Wait for live runs or inspect the edge node/agent before pausing.");
  } else {
    lines.push(`Recommendation: ${inspection.recommendation || "no_active_run_recovery_needed"}`);
    lines.push("No active run recovery needed.");
  }
  return `${lines.join("\n")}\n`;
}

async function legacyRoomRecover(args, roomId, { queuedRunStaleSeconds = 21600, reason = "Stale/orphan room recovery." } = {}) {
  const roomData = await gatewayJson(`/rooms/${pathPart(roomId)}`, { auth: true, args });
  const inspection = inspectRoomRecovery(roomData, { queuedRunStaleSeconds });
  const thresholdFlag = queuedRunStaleThresholdFlag(queuedRunStaleSeconds);
  if (!args.includes("--yes")) {
    if (args.includes("--json")) {
      return printJson({
        ok: true,
        dry_run: true,
        legacy_client_side_recover: true,
        room_id: roomId,
        reason,
        inspection
      });
    }
    process.stdout.write(formatRoomInspection(inspection));
    process.stdout.write(`\nDry run. This gateway does not expose server-side /recover; re-run with --yes to pause the room and cancel queued runs via the legacy pause path:\nagent-bus room recover ${roomId} --yes${thresholdFlag} --reason ${JSON.stringify(reason)}\n`);
    return;
  }
  const force = args.includes("--force");
  if (!force && inspection.recommendation !== "pause_recover_orphan_queued_runs") {
    process.stdout.write(formatRoomInspection(inspection));
    throw new Error("Refusing room recover --yes because no stale queued orphan runs were found. Use `agent-bus room pause ROOM_ID --reason ...` for an intentional operator pause, or add --force after verifying no agent process should keep running.");
  }
  const recovered = await gatewayJson(`/rooms/${pathPart(roomId)}/pause`, { auth: true, args, method: "POST", body: { reason } });
  if (args.includes("--json")) {
    return printJson({
      ok: true,
      dry_run: false,
      executed: true,
      legacy_client_side_recover: true,
      room_id: roomId,
      reason,
      room: recovered
    });
  }
  console.log(`Recovered room ${roomId}: paused and cancelled queued runs via legacy pause path. Use room export before creating a follow-up room if work should continue.`);
}

function formatRoomRecoveryResult(result, { roomId, queuedRunStaleSeconds = 21600, reason = "Stale/orphan room recovery." } = {}) {
  const lines = [];
  const inspection = result?.inspection || result?.inspection_after;
  if (inspection) lines.push(formatRoomInspection(inspection).trimEnd());
  if (result?.dry_run !== false) {
    const thresholdFlag = queuedRunStaleThresholdFlag(queuedRunStaleSeconds);
    lines.push("");
    lines.push("Dry run. Re-run with --yes to pause the room and cancel queued runs.");
    lines.push("Server-side recovery did not modify the room.");
    lines.push(`agent-bus room recover ${roomId} --yes${thresholdFlag} --reason ${JSON.stringify(reason)}`);
    return `${lines.join("\n")}\n`;
  }
  const count = Array.isArray(result?.cancelled_queued_runs) ? result.cancelled_queued_runs.length : 0;
  lines.push(`Recovered room ${roomId}: paused and cancelled ${count} queued run${count === 1 ? "" : "s"}. Use room export before creating a follow-up room if work should continue.`);
  return `${lines.join("\n").trimStart()}\n`;
}

function formatRoomFailedRetryResult(result, { roomId, reason = "Retry failed room agents." } = {}) {
  const inspection = result?.inspection || {};
  const lines = [];
  lines.push(`Room failed-agent retry: ${roomId}`);
  lines.push(`Recommendation: ${inspection.recommendation || "unknown"}`);
  lines.push(`Force: ${result?.force || inspection.force ? "yes" : "no"}`);
  lines.push(`Failed agents: ${formatInlineList(inspection.failed_agents || [])}`);
  lines.push(`Retryable agents: ${formatInlineList(inspection.retryable_agents || [])}`);
  if (Array.isArray(inspection.blocked_failure_class_agents) && inspection.blocked_failure_class_agents.length) {
    lines.push(`Blocked by failure class: ${formatInlineList(inspection.blocked_failure_class_agents)}`);
  }
  if (Array.isArray(inspection.groups) && inspection.groups.length) {
    lines.push("", "Agents:");
    for (const group of inspection.groups) {
      const state = group.retryable ? (group.forced_retry ? "forced-retryable" : "retryable") : (group.blocked_reason || "blocked");
      const failure = group.failure_class ? ` failure=${group.failure_class}${group.failure_category ? `:${group.failure_category}` : ""}${group.taxonomy_retryable ? "/auto" : "/manual"}` : "";
      const action = group.recommended_action ? ` action=${group.recommended_action}` : "";
      const error = group.latest_error ? ` error=${oneLine(group.latest_error, 100)}` : "";
      lines.push(`- ${group.agent_id || "-"}: ${state} latest=${group.latest_run_id || "-"} status=${group.latest_status || "unknown"}${failure}${action}${error}`);
    }
  }
  if (result?.dry_run !== false) {
    lines.push("");
    lines.push("Dry run. Server-side retry did not create new room runs.");
    if (Array.isArray(inspection.retryable_agents) && inspection.retryable_agents.length) {
      const forceFlag = result?.force || inspection.force ? " --force" : "";
      lines.push(`To retry failed agents: agent-bus room retry-failed ${roomId} --yes${forceFlag} --reason ${JSON.stringify(reason)}`);
    } else {
      lines.push("No failed online agent is safe to retry automatically.");
      if (Array.isArray(inspection.blocked_failure_class_agents) && inspection.blocked_failure_class_agents.length) {
        lines.push(`After operator review, dry-run force with: agent-bus room retry-failed ${roomId} --agents ${inspection.blocked_failure_class_agents.join(",")} --force`);
      }
    }
    return `${lines.join("\n")}\n`;
  }
  if (result?.executed) {
    const count = Array.isArray(result?.created_run_ids) ? result.created_run_ids.length : 0;
    lines.push(`Retried failed agents: created ${count} room run${count === 1 ? "" : "s"}.`);
  } else {
    lines.push("Failed-agent retry did not execute a room change.");
    if (result?.refusal_reason) lines.push(result.refusal_reason);
  }
  return `${lines.join("\n").trimStart()}\n`;
}

function formatRoomDuplicateResolutionResult(result, { roomId, reason = "Resolve duplicate active room runs." } = {}) {
  const inspection = result?.inspection || {};
  const lines = [];
  lines.push(`Room duplicate active run resolution: ${roomId}`);
  lines.push(`Recommendation: ${inspection.recommendation || "unknown"}`);
  lines.push(`Duplicate active agents: ${formatInlineList(inspection.duplicate_active_agents || [])}`);
  lines.push(`Cancellable queued runs: ${formatInlineList(inspection.cancellable_queued_run_ids || [])}`);
  if (Array.isArray(inspection.groups) && inspection.groups.length) {
    lines.push("", "Groups:");
    for (const group of inspection.groups) {
      lines.push(`- ${group.agent_id || "-"}: active=${formatInlineList(group.active_run_ids || [])} kept=${formatInlineList(group.kept_run_ids || [])} cancellable=${formatInlineList(group.cancellable_queued_run_ids || [])}`);
    }
  }
  if (result?.dry_run !== false) {
    lines.push("");
    lines.push("Dry run. Server-side duplicate resolution did not modify the room.");
    if (Array.isArray(inspection.cancellable_queued_run_ids) && inspection.cancellable_queued_run_ids.length) {
      lines.push(`To cancel only the duplicate queued runs: agent-bus room resolve-duplicates ${roomId} --yes --reason ${JSON.stringify(reason)}`);
    } else if (Array.isArray(inspection.groups) && inspection.groups.length) {
      lines.push("Duplicate active runs exist, but no queued duplicate is safe to cancel automatically. Inspect running processes before taking action.");
    } else {
      lines.push("No duplicate active runs were found.");
    }
    return `${lines.join("\n")}\n`;
  }
  if (result?.executed) {
    const count = Array.isArray(result?.cancelled_queued_runs) ? result.cancelled_queued_runs.length : 0;
    lines.push(`Resolved duplicates: cancelled ${count} queued run${count === 1 ? "" : "s"} and left running work untouched.`);
  } else {
    lines.push("Duplicate resolution did not execute a room change.");
    if (result?.refusal_reason) lines.push(result.refusal_reason);
  }
  return `${lines.join("\n").trimStart()}\n`;
}

function formatRoomSupervisorResult(result, {
  roomId,
  queuedRunStaleSeconds = 21600,
  staleSeconds = 180,
  runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS,
  reason = "Conservative room supervisor recovery."
} = {}) {
  const lines = [];
  const inspection = result?.inspection_after || result?.inspection;
  if (inspection) lines.push(formatRoomStateInspection(inspection).trimEnd());
  const actions = Array.isArray(result?.plan?.actions) ? result.plan.actions : [];
  if (actions.length) {
    lines.push("", "Supervisor plan:");
    for (const action of actions) {
      const marker = action.executable ? "can execute" : "manual";
      lines.push(`- ${action.kind || "action"} (${marker}): ${action.message || ""}`.trimEnd());
      if (action.command) lines.push(`  ${action.command}`);
      if (action.fallback_command) lines.push(`  fallback: ${action.fallback_command}`);
    }
  }
  if (result?.dry_run !== false) {
    const thresholdFlag = queuedRunStaleThresholdFlag(queuedRunStaleSeconds);
    const heartbeatFlag = runHeartbeatStaleThresholdFlag(runHeartbeatStaleSeconds);
    const staleFlag = staleThresholdFlag(staleSeconds);
    const safeActions = Array.isArray(result?.plan?.safe_executable_actions) ? result.plan.safe_executable_actions : [];
    const canExecute = safeActions.length > 0;
    const safeActionLabel = safeActions[0]?.kind === "resolve_duplicate_active_runs" ? "duplicate-run cleanup" : "queued-run recovery";
    lines.push("");
    lines.push("Dry run. Server-side supervisor did not modify the room.");
    if (canExecute) {
      lines.push(`To execute the safe ${safeActionLabel}: agent-bus room supervisor ${roomId} --yes${thresholdFlag}${staleFlag}${heartbeatFlag} --reason ${JSON.stringify(reason)}`);
    } else {
      lines.push("No safe automatic action is available; inspect the listed room state before pausing, waking, or replacing work.");
    }
    return `${lines.join("\n")}\n`;
  }
  if (result?.executed) {
    const count = Array.isArray(result?.cancelled_queued_runs) ? result.cancelled_queued_runs.length : 0;
    if (result?.executed_action?.kind === "resolve_duplicate_active_runs") {
      lines.push(`Supervisor resolved duplicate active runs for ${roomId}: cancelled ${count} duplicate queued run${count === 1 ? "" : "s"} and left running work untouched.`);
    } else {
      lines.push(`Supervisor executed conservative recovery for ${roomId}: paused the room and cancelled ${count} queued run${count === 1 ? "" : "s"}.`);
    }
  } else {
    lines.push(`Supervisor did not execute a room change for ${roomId}.`);
    if (result?.refusal_reason) lines.push(result.refusal_reason);
  }
  return `${lines.join("\n").trimStart()}\n`;
}

function roomHealthSummary(room, {
  nodes = [],
  staleSeconds = 180,
  queuedRunStaleSeconds = 21600,
  runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS
} = {}) {
  const inspection = inspectRoomState(room, { nodes, staleSeconds, queuedRunStaleSeconds, runHeartbeatStaleSeconds });
  const checklist = roomAgentChecklist(room) || {};
  const checklistAgents = checklist.agents && typeof checklist.agents === "object" ? checklist.agents : {};
  const runBuckets = roomHealthRunBuckets(room?.runs || []);
  const latestRunByAgent = latestRoomRunByAgent(room?.runs || []);
  const activeRunsByAgent = roomHealthActiveRunsByAgent(room?.runs || []);
  const inspectionRunsById = roomInspectionRunsById(inspection);
  const agents = (Array.isArray(room?.agents) ? room.agents : []).map((agentId) => {
    const run = latestRunByAgent.get(agentId) || {};
    const attempt = runAttemptRecord(run);
    const checklistItem = checklistAgents[agentId] || {};
    const failureGuidance = runFailureGuidance(attempt.failure_class || checklistItem.failure_class);
    const inspectRun = inspectionRunsById.get(run.id || checklistItem.run_id || "") || {};
    const contract = roomHealthContractStatus(room, run, checklistItem);
    const activeRuns = activeRunsByAgent.get(agentId) || [];
    return {
      agent_id: agentId,
      status: checklistItem.status || run.status || "missing",
      run_id: checklistItem.run_id || run.id || "",
      active_run_count: activeRuns.length,
      active_run_ids: activeRuns.map((item) => item.id).filter(Boolean),
      node_id: run.node_id || checklistItem.node_id || inspectRun.node_id || "",
      edge_session_id: run.edge_session_id || run.lease?.edge_session_id || inspectRun.edge_session_id || "",
      lease_state: run.lease?.state || inspectRun.lease_state || "",
      attempt_no: attempt.attempt_no || run.attempt_no || null,
      failure_class: attempt.failure_class || checklistItem.failure_class || "",
      failure_category: attempt.failure_category || checklistItem.failure_category || failureGuidance.failure_category || "",
      recommended_action: attempt.recommended_action || checklistItem.recommended_action || failureGuidance.recommended_action || "",
      retryable: typeof attempt.retryable === "boolean" ? attempt.retryable : null,
      retry_reason: attempt.retry_reason || "",
      retry_request_reason: attempt.retry_request_reason || run.retry_request_reason || "",
      last_error_excerpt: attempt.last_error_excerpt || "",
      retry_of_run_id: attempt.retry_of_run_id || run.retry_of_run_id || "",
      source_failure_class: attempt.source_failure_class || "",
      has_report: contract.has_report,
      has_done: contract.has_done,
      duration_seconds: checklistItem.duration_seconds ?? null,
      wake_reason: checklistItem.wake_reason || run.wake_reason || "",
      last_error: checklistItem.error || roomRunErrorSummary(run),
      stale_state: roomHealthStaleState(inspectRun),
      heartbeat_age_seconds: inspectRun.heartbeat_age_seconds ?? null,
      node_freshness: inspectRun.node_freshness || "",
      updated_at: checklistItem.updated_at || run.completed_at || run.started_at || run.created_at || null
    };
  });
  const latestRun = latestRoomRun(room?.runs || []);
  const derivedSummary = roomHealthDerivedSummary(room, agents);
  const recoveryActions = roomHealthRecoveryActions(room, agents, inspection);
  return {
    object: "agent_bus.room_health",
    room: {
      id: room?.id || "",
      title: room?.title || "",
      status: room?.status || "unknown",
      trace_id: room?.trace_id || "",
      agents: room?.agents || [],
      steps: room?.autonomy?.steps || 0,
      max_steps: room?.autonomy?.max_steps || 0,
      created_at: room?.created_at || null,
      updated_at: room?.updated_at || null
    },
    summary: {
      ...derivedSummary,
      ...(checklist.summary || {}),
      total_runs: (room?.runs || []).length,
      run_statuses: runBuckets,
      last_wake_reason: latestRun?.wake_reason || "",
      last_message_at: latestRoomMessageAt(room),
      last_report_at: latestRoomReportAt(room)
    },
    thresholds: inspection.analysis?.thresholds || {},
    agents,
    recovery_actions: recoveryActions,
    operator_hints: inspection.operator_hints || [],
    inspect_summary: inspection.analysis?.summary || "unknown"
  };
}

function roomHealthContractStatus(room, run, checklistItem = {}) {
  const reportFromChecklist = typeof checklistItem.has_report === "boolean" ? checklistItem.has_report : null;
  const doneFromChecklist = typeof checklistItem.has_done === "boolean" ? checklistItem.has_done : null;
  const text = roomHealthRunText(room, run);
  const counts = roomHealthDirectiveCounts(text);
  const runId = run?.id || checklistItem?.run_id || "";
  const reports = [
    ...(Array.isArray(room?.reports) ? room.reports : []),
    ...(Array.isArray(room?.blackboard?.reports) ? room.blackboard.reports : [])
  ];
  const hasReportRecord = Boolean(runId && reports.some((item) => item?.run_id === runId));
  return {
    has_report: reportFromChecklist ?? (hasReportRecord || counts.report > 0),
    has_done: doneFromChecklist ?? (counts.done > 0)
  };
}

function roomHealthRunText(room, run) {
  const runId = run?.id || "";
  const message = runId
    ? (Array.isArray(room?.messages) ? room.messages : []).find((item) => item?.run_id === runId)
    : null;
  return String(run?.stdout || run?.summary || run?.stderr || message?.content || "");
}

function roomHealthDirectiveCounts(content) {
  const counts = { report: 0, done: 0 };
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^REPORT\s*:/i.test(line)) counts.report += 1;
    if (/^DONE\b/i.test(line)) counts.done += 1;
  }
  return counts;
}

function roomHealthDerivedSummary(room, agents) {
  const expectedAgents = Array.isArray(room?.agents) ? room.agents.filter(Boolean) : [];
  const failedStatuses = new Set(["failed", "error", "cancelled", "canceled", "skipped", "replaced", "superseded"]);
  const terminalAgents = agents.filter((item) => roomHealthTerminalStatus(item.status));
  const duplicateActiveAgents = agents
    .filter((item) => Number(item.active_run_count || 0) > 1)
    .map((item) => item.agent_id)
    .filter(Boolean);
  return {
    expected_agents: expectedAgents.length,
    agents_with_runs: agents.filter((item) => item.run_id).length,
    replied_agents: terminalAgents.length,
    completed_agents: agents.filter((item) => String(item.status || "").toLowerCase() === "completed").length,
    failed_agents: agents.filter((item) => failedStatuses.has(String(item.status || "").toLowerCase())).length,
    missing_agents: agents.filter((item) => !item.run_id).map((item) => item.agent_id),
    running_agents: agents.filter((item) => String(item.status || "").toLowerCase() === "running").map((item) => item.agent_id),
    queued_agents: agents.filter((item) => String(item.status || "").toLowerCase() === "queued").map((item) => item.agent_id),
    duplicate_active_agents: duplicateActiveAgents,
    duplicate_active_agent_count: duplicateActiveAgents.length,
    missing_report_agents: terminalAgents.filter((item) => !item.has_report).map((item) => item.agent_id),
    missing_done_agents: terminalAgents.filter((item) => !item.has_done).map((item) => item.agent_id)
  };
}

function roomHealthTerminalStatus(status) {
  return ["completed", "failed", "error", "cancelled", "canceled", "skipped", "replaced", "superseded"].includes(String(status || "").toLowerCase());
}

function roomHealthRecoveryActions(room, agents, inspection) {
  const roomId = room?.id || "ROOM_ID";
  const actions = [];
  const duplicateActiveAgents = agents
    .filter((item) => Number(item.active_run_count || 0) > 1)
    .map((item) => item.agent_id)
    .filter(Boolean);
  const missingReport = agents
    .filter((item) => roomHealthTerminalStatus(item.status) && !item.has_report)
    .map((item) => item.agent_id)
    .filter(Boolean);
  const missingDone = agents
    .filter((item) => roomHealthTerminalStatus(item.status) && !item.has_done)
    .map((item) => item.agent_id)
    .filter(Boolean);
  const failedAgents = agents
    .filter((item) => ["failed", "error", "cancelled", "canceled", "skipped"].includes(String(item.status || "").toLowerCase()))
    .map((item) => item.agent_id)
    .filter(Boolean);
  const liveAgents = agents
    .filter((item) => roomHealthLiveNonTerminalState(item.stale_state) && !roomHealthTerminalStatus(item.status))
    .map((item) => item.agent_id)
    .filter(Boolean);
  const staleAgents = agents
    .filter((item) => roomHealthRecoveryStaleState(item.stale_state) && !roomHealthTerminalStatus(item.status))
    .map((item) => item.agent_id)
    .filter(Boolean);
  if (duplicateActiveAgents.length) {
    actions.push({
      kind: "resolve_duplicate_active_runs",
      level: "warn",
      agents: duplicateActiveAgents,
      message: "One or more agents have multiple active runs in this room. Inspect before waking or resuming so duplicate work does not fork the room.",
      command: `agent-bus room resolve-duplicates ${roomId}`
    });
  }
  if (missingReport.length) {
    actions.push({
      kind: "request_report",
      level: "warn",
      agents: missingReport,
      message: roomHealthTerminalRoom(room)
        ? "Terminal agents are missing REPORT, but this room is already terminal. Create a follow-up room if an operator report is still needed."
        : "Terminal agents are missing REPORT. Wake them only to publish a concise operator report before continuing or archiving.",
      command: roomHealthContractCommand(room, missingReport, "Please provide a concise REPORT for your last run, then DONE if your work is complete.")
    });
  }
  if (missingDone.length) {
    actions.push({
      kind: "request_done",
      level: "info",
      agents: missingDone,
      message: roomHealthTerminalRoom(room)
        ? "Terminal agents are missing DONE, but this room is already terminal. Create a follow-up room if the contract needs explicit closure."
        : "Terminal agents are missing DONE. Ask them to finalize the room contract if no work remains.",
      command: roomHealthContractCommand(room, missingDone, "Please finalize your room turn. Emit DONE if your assigned work is complete, or REPORT the remaining blocker.")
    });
  }
  if (failedAgents.length) {
    actions.push({
      kind: "recover_failed_agents",
      level: "warn",
      agents: failedAgents,
      message: "One or more agents failed. Use the guarded retry command to re-open the room and wake only failed online agents with the latest failure context.",
      command: `agent-bus room retry-failed ${roomId} --agents ${failedAgents.join(",")}`
    });
  }
  if (staleAgents.length) {
    actions.push({
      kind: "inspect_stale_agents",
      level: "warn",
      agents: staleAgents,
      message: "Some non-terminal agent runs look stale or orphaned. Inspect before creating duplicate work.",
      command: `agent-bus room inspect ${roomId}`
    });
  }
  const staleQueued = Array.isArray(inspection?.analysis?.stale_queued_runs) ? inspection.analysis.stale_queued_runs : [];
  if (staleQueued.length) {
    actions.push({
      kind: "recover_stale_queued",
      level: "warn",
      agents: Array.from(new Set(staleQueued.map((run) => run.agent_id).filter(Boolean))),
      message: "Stale queued runs can wake unexpectedly later. Use guarded recovery when you have confirmed they are abandoned.",
      command: `agent-bus room recover ${roomId} --yes`
    });
  }
  if (!actions.length && String(room?.status || "").toLowerCase() === "completed") {
    actions.push({
      kind: "archive_completed_room",
      level: "info",
      agents: [],
      message: "Room is complete and contracts are satisfied. Export a reports-only summary for handoff or public discussion.",
      command: `agent-bus room export ${roomId} --reports-only --out room-summary.md`
    });
  }
  if (!actions.length && liveAgents.length) {
    actions.push({
      kind: "monitor_live_room",
      level: "info",
      agents: liveAgents,
      message: "Room has live queued or running work and no recovery action is needed right now. Re-check health or doctor after the current run changes state.",
      command: `agent-bus room health ${roomId}`
    });
  }
  if (!actions.length) {
    actions.push({
      kind: "inspect_room",
      level: "info",
      agents: [],
      message: "No contract-specific recovery action is needed from the health snapshot. Use inspect for deeper stale/orphan analysis.",
      command: `agent-bus room inspect ${roomId}`
    });
  }
  return actions;
}

function roomHealthContractCommand(room, agents, reason) {
  const roomId = room?.id || "ROOM_ID";
  const agentList = (Array.isArray(agents) ? agents : []).filter(Boolean).join(",");
  if (!agentList) return "";
  if (roomHealthTerminalRoom(room)) {
    const goal = `Follow up on Agent Bus room ${roomId}. ${reason}`;
    return `agent-bus room create --title ${JSON.stringify(`Contract follow-up for ${roomId}`)} --goal ${JSON.stringify(goal)} --agents ${agentList} --wake-agents ${agentList}`;
  }
  return `agent-bus room wake ${roomId} --agents ${agentList} --reason ${JSON.stringify(reason)}`;
}

function roomHealthTerminalRoom(room) {
  return ["completed", "paused"].includes(String(room?.status || "").toLowerCase());
}

function roomHealthRecoveryStaleState(state) {
  return ["stale_queued", "stale_running", "orphaned_running"].includes(String(state || "").toLowerCase());
}

function roomHealthLiveNonTerminalState(state) {
  return ["live_queued", "live_running", "other_non_terminal"].includes(String(state || "").toLowerCase());
}

function roomFollowUpDefaultTitle(room) {
  const roomId = room?.id || "ROOM_ID";
  const title = String(room?.title || "").trim();
  return title ? `Follow-up: ${title}` : `Follow-up for ${roomId}`;
}

function roomFollowUpDefaultGoal(room, doctor, reason = "") {
  const roomId = room?.id || "ROOM_ID";
  const roomStatus = room?.status || "unknown";
  const title = String(room?.title || "").trim();
  const contractText = roomFollowUpContractText(doctor?.contract);
  const reasonText = String(reason || "").trim();
  const task = reasonText || (contractText
    ? `Resolve missing room contract items: ${contractText}.`
    : "Continue the unresolved work from the source room.");
  const titleText = title ? ` Source title: ${title}.` : "";
  return `Follow up on Agent Bus room ${roomId} (${roomStatus}).${titleText} ${task} Work from the latest available room context, provide concise REPORT lines, and emit DONE when complete.`;
}

function roomFollowUpContractText(contract = {}) {
  const parts = [];
  const missingAgents = Array.isArray(contract?.missing_agents) ? contract.missing_agents.filter(Boolean) : [];
  const missingReport = Array.isArray(contract?.missing_report_agents) ? contract.missing_report_agents.filter(Boolean) : [];
  const missingDone = Array.isArray(contract?.missing_done_agents) ? contract.missing_done_agents.filter(Boolean) : [];
  if (missingAgents.length) parts.push(`missing agents=${missingAgents.join(",")}`);
  if (missingReport.length) parts.push(`missing REPORT=${missingReport.join(",")}`);
  if (missingDone.length) parts.push(`missing DONE=${missingDone.join(",")}`);
  return parts.join("; ");
}

function uniqueStrings(items = []) {
  return Array.from(new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean)));
}

function roomHealthRunBuckets(runs = []) {
  const buckets = {};
  for (const run of Array.isArray(runs) ? runs : []) {
    const status = String(run?.status || "unknown").toLowerCase();
    buckets[status] = (buckets[status] || 0) + 1;
  }
  return buckets;
}

function roomHealthActiveRunsByAgent(runs = []) {
  const byAgent = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!roomHealthRunIsActive(run)) continue;
    const agentId = run?.agent_id || "";
    if (!agentId) continue;
    const list = byAgent.get(agentId) || [];
    list.push(run);
    byAgent.set(agentId, list);
  }
  for (const list of byAgent.values()) {
    list.sort((a, b) => roomRunSortTime(b) - roomRunSortTime(a));
  }
  return byAgent;
}

function roomHealthRunIsActive(run) {
  const status = String(run?.status || "queued").toLowerCase();
  if (roomHealthTerminalStatus(status)) return false;
  if (["replaced", "superseded"].includes(status)) return false;
  if (run?.replaced_by_run_id || run?.replacement_run_id || run?.superseded_by_run_id || run?.late_complete_ignored_at) return false;
  return true;
}

function latestRoomRunByAgent(runs = []) {
  const byAgent = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    const agentId = run?.agent_id || "";
    if (!agentId) continue;
    const existing = byAgent.get(agentId);
    if (!existing || roomRunSortTime(run) >= roomRunSortTime(existing)) byAgent.set(agentId, run);
  }
  return byAgent;
}

function latestRoomRun(runs = []) {
  return (Array.isArray(runs) ? runs : []).reduce((latest, run) => {
    if (!latest) return run;
    return roomRunSortTime(run) >= roomRunSortTime(latest) ? run : latest;
  }, null);
}

function roomRunSortTime(run) {
  const parsed = Date.parse(run?.completed_at || run?.started_at || run?.created_at || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function roomInspectionRunsById(inspection) {
  const map = new Map();
  const analysis = inspection?.analysis || {};
  const states = {
    live_running_runs: "live_running",
    live_queued_runs: "live_queued",
    stale_queued_runs: "stale_queued",
    stale_running_runs: "stale_running",
    orphaned_running_runs: "orphaned_running",
    other_non_terminal_runs: "other_non_terminal"
  };
  for (const [key, state] of Object.entries(states)) {
    for (const run of Array.isArray(analysis[key]) ? analysis[key] : []) {
      if (run?.id) map.set(run.id, { ...run, _health_state: state });
    }
  }
  return map;
}

function roomHealthStaleState(run) {
  if (!run || !run.id) return "";
  if (run._health_state) return run._health_state;
  return "";
}

function roomRunErrorSummary(run) {
  if (!run || !isTerminalRunStatus(run.status) || String(run.status || "").toLowerCase() === "completed") return "";
  return oneLine(run.stderr || run.summary || run.stdout || `run ${run.status}`, 500);
}

function runAttemptRecord(run) {
  if (!run || typeof run !== "object") return {};
  const attempts = Array.isArray(run.attempts) ? run.attempts.filter((item) => item && typeof item === "object") : [];
  if (attempts.length) return attempts[attempts.length - 1];
  return run.attempt && typeof run.attempt === "object" ? run.attempt : {};
}

function runFailureGuidance(failureClass) {
  switch (String(failureClass || "").trim().toLowerCase()) {
    case "rate_limited":
      return { failure_category: "rate_limit", recommended_action: "retry_after_backoff" };
    case "upstream_transient":
      return { failure_category: "model_gateway", recommended_action: "retry_failed_agents" };
    case "timeout":
      return { failure_category: "transient", recommended_action: "retry_failed_agents" };
    case "auth_config":
      return { failure_category: "auth_config", recommended_action: "fix_auth_or_model_config" };
    case "protocol_violation":
      return { failure_category: "contract", recommended_action: "inspect_agent_contract" };
    case "local_runtime":
      return { failure_category: "tool_runtime", recommended_action: "inspect_edge_runtime" };
    case "cancelled":
      return { failure_category: "operator_cancelled", recommended_action: "do_not_retry_cancelled" };
    case "superseded":
      return { failure_category: "superseded", recommended_action: "inspect_replacement_run" };
    case "run_failed":
    case "unknown":
      return { failure_category: "unknown", recommended_action: "inspect_failure" };
    default:
      return { failure_category: "", recommended_action: "" };
  }
}

function latestRoomMessageAt(room) {
  const messages = Array.isArray(room?.messages) ? room.messages : [];
  return messages.length ? messages[messages.length - 1]?.at || null : null;
}

function latestRoomReportAt(room) {
  const reports = Array.isArray(room?.reports) ? room.reports : [];
  return reports.length ? reports[reports.length - 1]?.at || null : null;
}

function formatRoomHealth(health) {
  const room = health?.room || {};
  const summary = health?.summary || {};
  const runStatuses = summary.run_statuses || {};
  const lines = [];
  lines.push(`Agent Bus room health: ${room.id || "-"}`);
  lines.push(`Status: ${room.status || "unknown"} (${health?.inspect_summary || "unknown"})`);
  lines.push(`Agents: ${Array.isArray(room.agents) && room.agents.length ? room.agents.join(", ") : "-"}`);
  lines.push(`Steps: ${room.steps || 0}/${room.max_steps || 0}`);
  lines.push(`Runs: queued=${runStatuses.queued || 0} running=${runStatuses.running || 0} completed=${runStatuses.completed || 0} failed=${(runStatuses.failed || 0) + (runStatuses.error || 0)} total=${summary.total_runs || 0}`);
  lines.push(`Contract: replied=${summary.replied_agents ?? 0}/${summary.expected_agents ?? 0} completed=${summary.completed_agents ?? 0} failed=${summary.failed_agents ?? 0}`);
  lines.push(`Duplicate active agents: ${formatInlineList(summary.duplicate_active_agents || [])}`);
  lines.push(`Missing REPORT: ${formatInlineList(summary.missing_report_agents || [])}`);
  lines.push(`Missing DONE: ${formatInlineList(summary.missing_done_agents || [])}`);
  if (summary.last_wake_reason) lines.push(`Last wake: ${oneLine(summary.last_wake_reason, 180)}`);
  lines.push(`Updated: ${room.updated_at || "-"}`);
  if (Array.isArray(health.agents) && health.agents.length) {
    lines.push("", "Agents:");
    for (const agent of health.agents) {
      const report = agent.has_report ? "REPORT" : "no-REPORT";
      const done = agent.has_done ? "DONE" : "no-DONE";
      const duration = Number.isFinite(agent.duration_seconds) ? ` duration=${formatAgeSeconds(agent.duration_seconds)}` : "";
      const stale = agent.stale_state ? ` ${agent.stale_state}` : "";
      const lease = agent.lease_state ? ` lease=${agent.lease_state}` : "";
      const attempt = agent.attempt_no ? ` attempt=${agent.attempt_no}` : "";
      const failure = agent.failure_class
        ? ` failure=${agent.failure_class}${agent.failure_category ? `:${agent.failure_category}` : ""}${agent.retryable === true ? "/retryable" : agent.retryable === false ? "/not-retryable" : ""}`
        : "";
      const edgeSession = agent.edge_session_id ? ` edge_session=${oneLine(agent.edge_session_id, 36)}` : "";
      const activeRuns = Number(agent.active_run_count || 0) > 1 ? ` active_runs=${agent.active_run_ids.join(",")}` : "";
      const wake = agent.wake_reason ? ` wake=${JSON.stringify(oneLine(agent.wake_reason, 100))}` : "";
      lines.push(`- ${agent.agent_id || "-"}: ${agent.status || "unknown"} run=${agent.run_id || "-"} ${report}/${done}${duration}${stale}${lease}${attempt}${failure}${edgeSession}${activeRuns}${wake}`);
      if (agent.recommended_action) lines.push(`  recommended_action: ${oneLine(agent.recommended_action, 120)}`);
      if (agent.retry_reason) lines.push(`  retry_reason: ${oneLine(agent.retry_reason, 180)}`);
      if (agent.retry_request_reason) lines.push(`  retry_request: ${oneLine(agent.retry_request_reason, 180)}`);
      if (agent.retry_of_run_id) lines.push(`  retry_of: ${agent.retry_of_run_id}`);
      if (agent.last_error || agent.last_error_excerpt) lines.push(`  error: ${oneLine(agent.last_error || agent.last_error_excerpt, 180)}`);
    }
  }
  if (Array.isArray(health.recovery_actions) && health.recovery_actions.length) {
    lines.push("", "Recovery actions:");
    for (const action of health.recovery_actions) {
      const agents = Array.isArray(action.agents) && action.agents.length ? ` agents=${action.agents.join(",")}` : "";
      lines.push(`- ${action.level || "info"} ${action.kind || "action"}${agents}: ${action.message || ""}`.trimEnd());
      if (action.command) lines.push(`  ${action.command}`);
    }
  }
  if (Array.isArray(health.operator_hints) && health.operator_hints.length) {
    lines.push("", "Operator hints:");
    for (const hint of health.operator_hints) {
      lines.push(`- ${hint.level || "info"}: ${hint.message || ""}`.trimEnd());
      if (hint.command) lines.push(`  ${hint.command}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatRoomDoctor(result) {
  const room = result?.room || {};
  const counts = result?.counts || {};
  const lines = [];
  lines.push(`Agent Bus room doctor: ${room.id || "-"}`);
  lines.push(`Status: ${room.status || "unknown"} (${result?.summary || "unknown"}, ${result?.severity || "info"})`);
  lines.push(`Agents: ${Array.isArray(room.agents) && room.agents.length ? room.agents.join(", ") : "-"}`);
  lines.push(`Runs: active=${counts.active_runs || 0} stale_queued=${counts.stale_queued_runs || 0} stale_running=${counts.stale_running_runs || 0} duplicate_active_agents=${counts.duplicate_active_agents || 0}`);
  lines.push(`Failed attempts: ${counts.failed_attempts || 0}; retryable=${counts.retryable_failed_agents || 0}; blocked=${counts.blocked_failed_agents || 0}`);
  lines.push(`Contract gaps: missing_report=${counts.missing_report_agents || 0} missing_done=${counts.missing_done_agents || 0} agents=${counts.contract_gap_agents || 0}`);
  const contract = result?.contract || {};
  if (Array.isArray(contract.missing_report_agents) && contract.missing_report_agents.length) {
    lines.push(`Missing REPORT: ${contract.missing_report_agents.join(", ")}`);
  }
  if (Array.isArray(contract.missing_done_agents) && contract.missing_done_agents.length) {
    lines.push(`Missing DONE: ${contract.missing_done_agents.join(", ")}`);
  }
  if (Array.isArray(result?.retryable_failed_agents) && result.retryable_failed_agents.length) {
    lines.push(`Retryable failed agents: ${result.retryable_failed_agents.join(", ")}`);
  }
  if (Array.isArray(result?.blocked_failed_agents) && result.blocked_failed_agents.length) {
    lines.push(`Blocked failed agents: ${result.blocked_failed_agents.join(", ")}`);
  }
  if (Array.isArray(result?.failed_attempts) && result.failed_attempts.length) {
    lines.push("", "Failed attempts:");
    for (const item of result.failed_attempts) {
      const state = item.retryable ? (item.forced_retry ? "forced-retryable" : "retryable") : (item.blocked_reason || "blocked");
      const failure = item.failure_class ? ` failure=${item.failure_class}${item.failure_category ? `:${item.failure_category}` : ""}${item.taxonomy_retryable ? "/auto" : "/manual"}` : "";
      const action = item.recommended_action ? ` action=${item.recommended_action}` : "";
      const error = item.latest_error ? ` error=${oneLine(item.latest_error, 120)}` : "";
      lines.push(`- ${item.agent_id || "-"}: ${state} run=${item.latest_run_id || "-"}${failure}${action}${error}`);
    }
  }
  if (Array.isArray(result?.actions) && result.actions.length) {
    lines.push("", "Actions:");
    for (const action of result.actions) {
      const agents = Array.isArray(action.agents) && action.agents.length ? ` agents=${action.agents.join(",")}` : "";
      lines.push(`- ${action.level || "info"} ${action.kind || "action"}${agents}: ${action.message || ""}`.trimEnd());
      if (action.command) lines.push(`  ${action.command}`);
      if (action.confirm_command) lines.push(`  confirm: ${action.confirm_command}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function inspectRoomState(room, {
  nodes = [],
  staleSeconds = 180,
  queuedRunStaleSeconds = 21600,
  runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS
} = {}) {
  const nodeLookupAvailable = Array.isArray(nodes) && nodes.length > 0;
  const heartbeatIntervalByAgentId = agentHeartbeatIntervalById(nodes);
  const nodeById = new Map(
    (Array.isArray(nodes) ? nodes : [])
      .map((node) => [String(node?.node_id || node?.id || "").trim(), node])
      .filter(([nodeId]) => nodeId)
  );
  const terminalRuns = [];
  const liveRunningRuns = [];
  const liveQueuedRuns = [];
  const staleQueuedRuns = [];
  const staleRunningRuns = [];
  const orphanedRunningRuns = [];
  const otherNonTerminalRuns = [];
  for (const rawRun of Array.isArray(room?.runs) ? room.runs : []) {
    if (isReplacedRun(rawRun)) {
      terminalRuns.push(statusRunRecord(rawRun, room?.id || "", { staleSeconds, nodeById, nodeLookupAvailable, heartbeatIntervalByAgentId }));
      continue;
    }
    const run = roomInspectRunRecord(rawRun, nodeById, staleSeconds, nodeLookupAvailable, heartbeatIntervalByAgentId);
    const status = String(run.status || "queued").toLowerCase();
    if (STATUS_TERMINAL_RUNS.has(status)) {
      terminalRuns.push(run);
      continue;
    }
    if (status === "queued") {
      if (isStaleQueuedRun(run, queuedRunStaleSeconds)) staleQueuedRuns.push(run);
      else liveQueuedRuns.push(run);
      continue;
    }
    if (status === "running") {
      if (isOrphanedRunningRun(run, nodeLookupAvailable)) {
        orphanedRunningRuns.push(run);
      } else if (isStaleRunningRun(run, runHeartbeatStaleSeconds)) {
        staleRunningRuns.push(run);
      } else {
        liveRunningRuns.push(run);
      }
      continue;
    }
    otherNonTerminalRuns.push(run);
  }
  const summary = summarizeRoomInspection({
    room,
    liveRunningRuns,
    liveQueuedRuns,
    staleQueuedRuns,
    staleRunningRuns,
    orphanedRunningRuns,
    otherNonTerminalRuns,
    queuedRunStaleSeconds
  });
  const nonTerminalRuns = [
    ...liveRunningRuns,
    ...liveQueuedRuns,
    ...staleRunningRuns,
    ...orphanedRunningRuns,
    ...otherNonTerminalRuns
  ];
  const counts = {
    total_runs: Array.isArray(room?.runs) ? room.runs.length : 0,
    non_terminal_runs: nonTerminalRuns.length + staleQueuedRuns.length,
    terminal_runs: terminalRuns.length,
    live_running_runs: liveRunningRuns.length,
    live_queued_runs: liveQueuedRuns.length,
    stale_queued_runs: staleQueuedRuns.length,
    stale_running_runs: staleRunningRuns.length,
    orphaned_running_runs: orphanedRunningRuns.length,
    other_non_terminal_runs: otherNonTerminalRuns.length
  };
  const recommendations = roomInspectionRecommendations({
    room,
    summary,
    liveRunningRuns,
    liveQueuedRuns,
    staleQueuedRuns,
    staleRunningRuns,
    orphanedRunningRuns,
    otherNonTerminalRuns,
    queuedRunStaleSeconds,
    runHeartbeatStaleSeconds
  });
  const operatorHints = roomInspectionOperatorHints(recommendations);
  return {
    room: {
      id: room?.id || "",
      title: room?.title || "",
      trace_id: room?.trace_id || "",
      status: room?.status || "unknown",
      agents: room?.agents || [],
      updated_at: room?.updated_at || null,
      created_at: room?.created_at || null
    },
    analysis: {
      summary,
      thresholds: {
        node_stale_seconds: staleSeconds,
        queued_run_stale_seconds: queuedRunStaleSeconds,
        run_heartbeat_stale_seconds: runHeartbeatStaleSeconds
      },
      counts,
      node_inventory_available: nodeLookupAvailable,
      live_running_runs: liveRunningRuns,
      live_queued_runs: liveQueuedRuns,
      stale_queued_runs: staleQueuedRuns,
      stale_running_runs: staleRunningRuns,
      orphaned_running_runs: orphanedRunningRuns,
      other_non_terminal_runs: otherNonTerminalRuns,
      recommendations,
      operator_hints: operatorHints
    },
    thresholds: {
      queued_run_stale_seconds: queuedRunStaleSeconds,
      node_stale_seconds: staleSeconds,
      run_heartbeat_stale_seconds: runHeartbeatStaleSeconds
    },
    counts: {
      runs: counts.total_runs,
      active_runs: nonTerminalRuns.length,
      stale_queued_runs: staleQueuedRuns.length,
      stale_running_runs: staleRunningRuns.length,
      orphaned_running_runs: orphanedRunningRuns.length
    },
    active_runs: nonTerminalRuns,
    stale_queued_runs: staleQueuedRuns,
    stale_running_runs: staleRunningRuns,
    recommendation: legacyRoomInspectionRecommendation(summary, nonTerminalRuns, staleQueuedRuns),
    operator_hints: operatorHints
  };
}

function roomInspectRunRecord(rawRun, nodeById, staleSeconds, nodeLookupAvailable, heartbeatIntervalByAgentId = new Map()) {
  const nodeId = String(rawRun?.node_id || "").trim();
  const agentId = String(rawRun?.agent_id || "").trim();
  const node = nodeById.get(nodeId);
  const seenAt = node?.last_seen_at || null;
  const lastHeartbeatAt = rawRun?.last_heartbeat_at || rawRun?.started_at || null;
  const attempt = runAttemptRecord(rawRun);
  const failureGuidance = runFailureGuidance(attempt.failure_class);
  return {
    id: rawRun?.id || "",
    room_id: rawRun?.room_id || rawRun?.thread_id || "",
    agent_id: agentId,
    node_id: nodeId,
    edge_session_id: rawRun?.edge_session_id || rawRun?.lease?.edge_session_id || "",
    lease_state: rawRun?.lease?.state || "",
    status: rawRun?.status || "queued",
    created_at: rawRun?.created_at || null,
    started_at: rawRun?.started_at || null,
    completed_at: rawRun?.completed_at || null,
    last_heartbeat_at: lastHeartbeatAt,
    attempt_no: attempt.attempt_no || rawRun?.attempt_no || null,
    failure_class: attempt.failure_class || "",
    failure_category: attempt.failure_category || failureGuidance.failure_category || "",
    recommended_action: attempt.recommended_action || failureGuidance.recommended_action || "",
    retryable: typeof attempt.retryable === "boolean" ? attempt.retryable : null,
    retry_reason: attempt.retry_reason || "",
    retry_request_reason: attempt.retry_request_reason || rawRun?.retry_request_reason || "",
    last_error_excerpt: attempt.last_error_excerpt || "",
    retry_of_run_id: attempt.retry_of_run_id || rawRun?.retry_of_run_id || "",
    source_failure_class: attempt.source_failure_class || "",
    attempt,
    run_heartbeat_interval_ms: heartbeatIntervalByAgentId.get(agentId) || null,
    node_status: node?.status || null,
    node_last_seen_at: seenAt,
    node_freshness: node
      ? statusFreshness(node.status, seenAt, staleSeconds)
      : (nodeLookupAvailable ? "unknown" : "unchecked"),
    age_seconds: elapsedSeconds(rawRun?.started_at || rawRun?.created_at || rawRun?.completed_at || null),
    heartbeat_age_seconds: elapsedSeconds(lastHeartbeatAt)
  };
}

function summarizeRoomInspection({ room, liveRunningRuns, liveQueuedRuns, staleQueuedRuns, staleRunningRuns, orphanedRunningRuns, otherNonTerminalRuns }) {
  const status = String(room?.status || "unknown").toLowerCase();
  if (status === "completed") return "completed";
  if (status === "paused") return "paused";
  if (orphanedRunningRuns.length) {
    return staleQueuedRuns.length ? "mixed_orphaned_running_and_stale_queued" : "orphaned_running_candidate";
  }
  if (staleRunningRuns.length) {
    if (staleQueuedRuns.length && !liveRunningRuns.length && !liveQueuedRuns.length && !otherNonTerminalRuns.length) {
      return "mixed_stale_running_and_stale_queued";
    }
    return (liveRunningRuns.length || liveQueuedRuns.length || otherNonTerminalRuns.length)
      ? "mixed_live_and_stale_running"
      : "stale_running_candidate";
  }
  if (staleQueuedRuns.length && !liveRunningRuns.length && !liveQueuedRuns.length && !otherNonTerminalRuns.length) {
    return "stale_queued_recovery_candidate";
  }
  if (liveRunningRuns.length || liveQueuedRuns.length || otherNonTerminalRuns.length) {
    return staleQueuedRuns.length ? "mixed_live_and_stale_queued" : "live";
  }
  if (status === "active") return "active_without_live_runs";
  return status || "unknown";
}

function legacyRoomInspectionRecommendation(summary, activeRuns, staleQueuedRuns) {
  if (staleQueuedRuns.length && !activeRuns.length) return "pause_recover_orphan_queued_runs";
  if (activeRuns.length) return "wait_or_inspect_running_agents";
  if (summary === "paused") return "room_paused";
  if (summary === "completed") return "room_completed";
  return "no_active_run_recovery_needed";
}

function roomInspectionRecommendations({
  room,
  summary,
  liveRunningRuns,
  liveQueuedRuns,
  staleQueuedRuns,
  staleRunningRuns,
  orphanedRunningRuns,
  otherNonTerminalRuns,
  queuedRunStaleSeconds = 21600,
  runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS
}) {
  const roomId = room?.id || "ROOM_ID";
  const thresholdFlag = queuedRunStaleThresholdFlag(queuedRunStaleSeconds);
  const heartbeatThresholdFlag = runHeartbeatStaleThresholdFlag(runHeartbeatStaleSeconds);
  const inspectCommand = `agent-bus room inspect ${roomId}${heartbeatThresholdFlag}${thresholdFlag ? `${thresholdFlag}` : ""}`.trim();
  const out = [];
  if (summary === "completed") {
    out.push({
      level: "info",
      message: "Room is already completed. Export it if you need an archive or handoff artifact.",
      command: `agent-bus room export ${roomId} --reports-only --out room-summary.md`
    });
    return out;
  }
  if (summary === "paused") {
    out.push({
      level: "warn",
      message: "Paused rooms are archival on current gateways. Start a follow-up room if work must continue."
    });
    out.push({
      level: "info",
      message: "Export the paused room before creating the follow-up room.",
      command: `agent-bus room export ${roomId} --reports-only --out room-summary.md`
    });
    return out;
  }
  if (summary === "stale_queued_recovery_candidate") {
    out.push({
      level: "warn",
      message: "Only stale queued runs remain. Safe recovery is to pause this room so abandoned queued work cannot wake later.",
      command: `agent-bus room recover ${roomId} --yes${thresholdFlag} --reason "orphan queued run recovery"`
    });
    out.push({
      level: "info",
      message: "If you prefer an explicit operator stop, `room pause` performs the same gateway-side pause without the recover guard.",
      command: `agent-bus room pause ${roomId} --reason "orphan queued run recovery"`
    });
    out.push({
      level: "info",
      message: "Export the room before or after the pause for a share-safe handoff.",
      command: `agent-bus room export ${roomId} --reports-only --out room-summary.md`
    });
    return out;
  }
  if (summary === "orphaned_running_candidate" || summary === "mixed_orphaned_running_and_stale_queued") {
    out.push({
      level: "warn",
      message: "At least one running task is attached to a stale or missing node. Inspect the edge service or local agent process before queueing more room work."
    });
    out.push({
      level: "warn",
      message: "Use pause only to stop future wakes and cancel queued follow-ups. Pause does not kill already-running OS processes.",
      command: `agent-bus room pause ${roomId} --reason "orphan running task investigation"`
    });
    return out;
  }
  if (summary === "stale_running_candidate" || summary === "mixed_live_and_stale_running" || summary === "mixed_stale_running_and_stale_queued") {
    const cadenceMismatchRuns = staleRunningRuns.filter((run) => runHeartbeatThresholdBelowCadence(run, runHeartbeatStaleSeconds));
    const recommendedThresholdSeconds = recommendedHeartbeatThresholdSecondsForRuns(cadenceMismatchRuns);
    const allCadenceMismatch = cadenceMismatchRuns.length > 0 && cadenceMismatchRuns.length === staleRunningRuns.length;
    if (cadenceMismatchRuns.length && recommendedThresholdSeconds) {
      out.push({
        kind: "adjust_stale_running_threshold",
        level: allCadenceMismatch ? "warn" : "info",
        message: `The current stale-running threshold (${runHeartbeatStaleSeconds}s) is lower than the configured heartbeat cadence for ${cadenceMismatchRuns.length} affected run${cadenceMismatchRuns.length === 1 ? "" : "s"}. Re-run inspect with at least ${recommendedThresholdSeconds}s before treating ${allCadenceMismatch ? "this room" : "those runs"} as heartbeat loss.`,
        command: `agent-bus room inspect ${roomId} --run-heartbeat-stale-seconds ${recommendedThresholdSeconds}${thresholdFlag ? `${thresholdFlag}` : ""}`.trim()
      });
    }
    if (allCadenceMismatch) {
      if (room?.trace_id) {
        out.push({
          kind: "inspect_trace",
          level: "info",
          message: "If the run still looks stuck after relaxing the stale-running threshold, inspect the room trace before pausing it.",
          command: `agent-bus trace show ${room.trace_id}`
        });
      }
      if (summary === "mixed_stale_running_and_stale_queued") {
        out.push({
          level: "info",
          message: "Do not recover the stale queued follow-up until the stale-running threshold is relaxed and the live run state is understood.",
          command: `agent-bus room inspect ${roomId} --run-heartbeat-stale-seconds ${recommendedThresholdSeconds}${thresholdFlag ? `${thresholdFlag}` : ""}`.trim()
        });
      }
      return out;
    }
    out.push({
      level: "warn",
      message: `At least one running task has not reported a run heartbeat for more than ${runHeartbeatStaleSeconds}s even though the node still looks reachable. Inspect the agent process or adapter session before waking the room again.`
    });
    if (room?.trace_id) {
      out.push({
        kind: "inspect_trace",
        level: "info",
        message: "Inspect the room trace before deciding whether to pause or replace the stale-running agent.",
        command: `agent-bus trace show ${room.trace_id}`
      });
    }
    out.push({
      level: "warn",
      message: "Pause stops future wakes and queued follow-ups, but it does not kill already-running OS processes.",
      command: `agent-bus room pause ${roomId} --reason "stale running task investigation"`
    });
    if (summary === "mixed_stale_running_and_stale_queued") {
      out.push({
        level: "info",
        message: "Do not recover the stale queued follow-up until the stale-running task is understood; otherwise the room can fork into duplicate work.",
        command: inspectCommand
      });
    }
    return out;
  }
  if (summary === "mixed_live_and_stale_queued") {
    out.push({
      level: "warn",
      message: "This room has live work and stale queued history at the same time. Do not issue a manual wake until the stale queued runs are understood."
    });
    out.push({
      level: "info",
      message: "If the stale queued entries are abandoned, pause or recover the room after live work settles and continue in a follow-up room."
    });
    return out;
  }
  if (summary === "active_without_live_runs") {
    out.push({
      level: "info",
      message: "Room is active but has no live non-terminal runs. A manual wake is the current recovery path if you want to continue it.",
      command: `agent-bus room wake ${roomId} --reason "operator recovery wake"`
    });
    out.push({
      level: "info",
      message: "If you need to add context before waking, post a room message and wake the next agent explicitly.",
      command: `agent-bus room message ${roomId} --message "Operator recovery context." --wake`
    });
    return out;
  }
  if (liveRunningRuns.length || liveQueuedRuns.length || otherNonTerminalRuns.length) {
    if (room?.trace_id) {
      out.push({
        kind: "inspect_trace",
        level: "info",
        message: "Inspect the room trace before pausing live work.",
        command: `agent-bus trace show ${room.trace_id}`
      });
    }
    out.push({
      kind: "wait_for_live_runs",
      level: "info",
      message: "Room still has live work. Prefer waiting or tracing the active run before intervening."
    });
  }
  if (!out.length && staleQueuedRuns.length) {
    out.push({
      level: "warn",
      message: "Stale queued runs are present. Inspect the run history before issuing a manual wake."
    });
  }
  return out;
}

function roomInspectionOperatorHints(recommendations) {
  return (Array.isArray(recommendations) ? recommendations : []).map((item) => ({
    kind: item.kind || roomInspectionHintKind(item),
    level: item.level || "info",
    message: item.message || "",
    ...(item.command ? { command: item.command } : {})
  }));
}

function roomInspectionHintKind(item) {
  const command = String(item?.command || "");
  if (command.includes(" trace show ")) return "inspect_trace";
  if (command.includes(" room recover ")) return "recover_room";
  if (command.includes(" room pause ")) return "pause_room";
  if (command.includes(" room inspect ") && command.includes("--run-heartbeat-stale-seconds")) return "adjust_stale_running_threshold";
  if (command.includes(" room export ")) return "export_room_summary";
  if (command.includes(" room wake ")) return "wake_room";
  if (command.includes(" room message ")) return "message_room";
  return "operator_note";
}

function formatRoomStateInspection(result) {
  const room = result?.room || {};
  const analysis = result?.analysis || {};
  const counts = analysis.counts || {};
  const lines = [];
  lines.push(`Agent Bus room inspect: ${room.id || "-"}`);
  lines.push(`Status: ${room.status || "unknown"} (${analysis.summary || "unknown"})`);
  lines.push(`Agents: ${Array.isArray(room.agents) && room.agents.length ? room.agents.join(", ") : "-"}`);
  lines.push(`Trace: ${room.trace_id || "-"}`);
  lines.push(`Created: ${room.created_at || "-"}`);
  lines.push(`Updated: ${room.updated_at || "-"}`);
  lines.push(`Runs: live_running=${counts.live_running_runs || 0} live_queued=${counts.live_queued_runs || 0} stale_queued=${counts.stale_queued_runs || 0} stale_running=${counts.stale_running_runs || 0} orphaned_running=${counts.orphaned_running_runs || 0} terminal=${counts.terminal_runs || 0}`);
  lines.push(`Thresholds: node_stale=${analysis.thresholds?.node_stale_seconds || 0}s queued_stale=${analysis.thresholds?.queued_run_stale_seconds || 0}s heartbeat_stale=${analysis.thresholds?.run_heartbeat_stale_seconds || 0}s`);
  const duplicateActiveRuns = analysis.duplicate_active_runs || result?.duplicate_active_runs || {};
  if (duplicateActiveRuns.duplicate_active_agent_count) {
    lines.push(`Duplicate active agents: ${formatInlineList(duplicateActiveRuns.duplicate_active_agents || [])}`);
    lines.push(`Duplicate queued runs safe to cancel: ${formatInlineList(duplicateActiveRuns.cancellable_queued_run_ids || [])}`);
  }
  appendRoomInspectionRuns(lines, "Live running runs", analysis.live_running_runs);
  appendRoomInspectionRuns(lines, "Live queued runs", analysis.live_queued_runs);
  appendRoomInspectionRuns(lines, "Stale queued runs", analysis.stale_queued_runs);
  appendRoomInspectionRuns(lines, "Stale running candidates", analysis.stale_running_runs);
  appendRoomInspectionRuns(lines, "Orphaned running candidates", analysis.orphaned_running_runs);
  appendRoomInspectionRuns(lines, "Other non-terminal runs", analysis.other_non_terminal_runs);
  if (Array.isArray(analysis.recommendations) && analysis.recommendations.length) {
    lines.push("", "Operator hints:");
    for (const item of analysis.recommendations) {
      lines.push(`- ${item.level || "info"}: ${item.message || ""}`.trimEnd());
      if (item.command) lines.push(`  ${item.command}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function appendRoomInspectionRuns(lines, label, runs) {
  if (!Array.isArray(runs) || !runs.length) return;
  lines.push("", `${label}:`);
  for (const run of runs) {
    const age = Number.isFinite(run.age_seconds) ? formatAgeSeconds(run.age_seconds) : "unknown";
    const heartbeat = Number.isFinite(run.heartbeat_age_seconds) ? ` heartbeat=${formatAgeSeconds(run.heartbeat_age_seconds)}` : "";
    const heartbeatAt = run.last_heartbeat_at ? ` last_heartbeat=${run.last_heartbeat_at}` : "";
    const heartbeatEvery = positiveHeartbeatIntervalMs(run.run_heartbeat_interval_ms)
      ? ` heartbeat_every=${formatHeartbeatCadence(run.run_heartbeat_interval_ms)}`
      : "";
    const lease = run.lease_state ? ` lease=${run.lease_state}` : "";
    const edgeSession = run.edge_session_id ? ` edge_session=${oneLine(run.edge_session_id, 36)}` : "";
    const attempt = run.attempt_no ? ` attempt=${run.attempt_no}` : "";
    const failure = run.failure_class
      ? ` failure=${run.failure_class}${run.failure_category ? `:${run.failure_category}` : ""}${run.retryable === true ? "/retryable" : run.retryable === false ? "/not-retryable" : ""}`
      : "";
    const action = run.recommended_action ? ` action=${run.recommended_action}` : "";
    const retry = run.retry_reason ? ` retry_reason=${JSON.stringify(oneLine(run.retry_reason, 80))}` : "";
    const retryRequest = run.retry_request_reason ? ` retry_request=${JSON.stringify(oneLine(run.retry_request_reason, 80))}` : "";
    const nodeNote = run.node_freshness && run.node_freshness !== "unchecked"
      ? ` node=${run.node_id || "-"} (${run.node_freshness})`
      : ` node=${run.node_id || "-"}`;
    lines.push(`- ${run.id || "-"}: ${run.status || "unknown"} agent=${run.agent_id || "-"}${nodeNote} age=${age}${heartbeat}${heartbeatAt}${heartbeatEvery}${lease}${edgeSession}${attempt}${failure}${action}${retry}${retryRequest} created=${run.created_at || "-"}`);
    if (run.retry_of_run_id) lines.push(`  retry_of: ${run.retry_of_run_id}`);
    if (run.last_error_excerpt) lines.push(`  error: ${oneLine(run.last_error_excerpt, 180)}`);
  }
}

function elapsedSeconds(timestamp) {
  const parsed = Date.parse(timestamp || "");
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

function formatAgeSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) return remSeconds ? `${minutes}m${remSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) return remMinutes ? `${hours}h${remMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d${remHours}h` : `${days}d`;
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

function roomAgentChecklist(room) {
  const checklist = room?.blackboard?.agent_checklist || room?.agent_checklist || null;
  return checklist && typeof checklist === "object" ? checklist : null;
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
    .replace(/\b((?:api[_-]?key|token|secret|password|authorization)\s*[:=]\s*)(["']?)(?:[A-Za-z]+\s+)?[^\s"',}]+/gi, "$1$2[REDACTED]")
    .replace(/:\/\/([^:/@\s]+):([^/@\s]+)@/g, "://[REDACTED]@");
}

function roomExportSummary(room) {
  const checklist = roomAgentChecklist(room);
  return {
    object: "agent_bus.room_reports_summary",
    reports_only: true,
    sharing_note: "Reports-only export omits the room goal, full messages, and run output by default. Review generated reports before sharing.",
    id: room.id,
    trace_id: room.trace_id,
    title: room.title,
    status: room.status,
    created_at: room.created_at,
    updated_at: room.updated_at,
    agents: room.agents || [],
    reports: room.reports || room.blackboard?.reports || [],
    blackboard: {
      notes: room.blackboard?.notes || [],
      next_actions: room.blackboard?.next_actions || [],
      open_questions: room.blackboard?.open_questions || [],
      ...(checklist ? { agent_checklist: checklist } : {})
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
    ...(reportsOnly ? { goal_omitted: true } : { goal: room.goal || "" }),
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
      const sequence = index + 1;
      return { ...clean, id: `${roomId || "room"}:event:${String(sequence).padStart(4, "0")}`, sequence };
    });
  const generatedAt = new Date().toISOString();
  const exportMetadata = {
    format: "events",
    source: "room.snapshot",
    generated_at: generatedAt,
    reports_only: reportsOnly,
    event_count: sorted.length,
    sequence_start: sorted.length ? 1 : 0,
    sequence_end: sorted.length
  };

  return {
    object: "agent_bus.room_event_bundle",
    protocol: "agent-bus.v1",
    generated_at: generatedAt,
    source: "room.snapshot",
    reports_only: reportsOnly,
    export_metadata: exportMetadata,
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

function validateRoomEventBundle(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.events)) {
    throw new Error("room replay requires a JSON event bundle with an events array.");
  }
  if (bundle.object && bundle.object !== "agent_bus.room_event_bundle") {
    throw new Error(`Expected agent_bus.room_event_bundle, got ${bundle.object}.`);
  }
  const metadata = bundle.export_metadata || {};
  const events = bundle.events;
  if (metadata.event_count !== undefined && metadata.event_count !== events.length) {
    throw new Error(`Event bundle metadata count ${metadata.event_count} does not match ${events.length} events.`);
  }
  if (events.length) {
    if (metadata.sequence_start !== undefined && metadata.sequence_start !== 1) {
      throw new Error(`Event bundle sequence_start must be 1, got ${metadata.sequence_start}.`);
    }
    if (metadata.sequence_end !== undefined && metadata.sequence_end !== events.length) {
      throw new Error(`Event bundle sequence_end must match event count, got ${metadata.sequence_end}.`);
    }
  }
  const ids = new Set();
  const knownTypes = new Set(options.knownTypes || ROOM_EVENT_TYPES);
  const strictTypes = options.strictTypes === true;
  const roomId = bundle.room?.id || "";
  const counts = { events: events.length };
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object") throw new Error(`Event ${index + 1} must be an object.`);
    if (!event.id) throw new Error(`Event ${index + 1} is missing id.`);
    if (ids.has(event.id)) throw new Error(`Duplicate event id: ${event.id}.`);
    ids.add(event.id);
    if (event.sequence !== undefined && event.sequence !== index + 1) {
      throw new Error(`Event ${event.id} has non-contiguous sequence ${event.sequence}; expected ${index + 1}.`);
    }
    if (!event.type) throw new Error(`Event ${event.id} is missing type.`);
    if (strictTypes && !knownTypes.has(event.type)) {
      throw new Error(`Event ${event.id} uses unknown type: ${event.type}.`);
    }
    if (!event.at) throw new Error(`Event ${event.id} is missing at timestamp.`);
    if (!event.actor) throw new Error(`Event ${event.id} is missing actor.`);
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      throw new Error(`Event ${event.id} payload must be an object.`);
    }
    if (roomId && event.room_id && event.room_id !== roomId) {
      throw new Error(`Event ${event.id} room_id ${event.room_id} does not match bundle room id ${roomId}.`);
    }
    counts[event.type] = (counts[event.type] || 0) + 1;
  }
  return {
    ok: true,
    room_id: roomId,
    event_count: events.length,
    sequence_start: events.length ? 1 : 0,
    sequence_end: events.length,
    counts
  };
}

function roomEventLog(bundle, options = {}) {
  const validation = validateRoomEventBundle(bundle);
  const generatedAt = new Date().toISOString();
  const allEntries = bundle.events.map((event) => roomEventLogEntry(event, {
    full: options.full === true
  }));
  const total = allEntries.length;
  const limit = Math.max(0, Number(options.limit || 0));
  const limited = limit > 0 && total > limit;
  let entries = limited
    ? options.tail === true ? allEntries.slice(-limit) : allEntries.slice(0, limit)
    : allEntries;
  if (options.reverse === true) entries = [...entries].reverse();
  return {
    object: "agent_bus.room_event_log",
    protocol: bundle.protocol || "agent-bus.v1",
    generated_at: generatedAt,
    source: bundle.object || "unknown",
    reports_only: bundle.reports_only === true,
    export_metadata: bundle.export_metadata || null,
    room: bundle.room || {},
    counts: bundle.counts || validation.counts,
    total_events: total,
    shown_events: entries.length,
    omitted_events: Math.max(0, total - entries.length),
    truncated: limited,
    window: limited ? options.tail === true ? "tail" : "head" : "all",
    order: options.reverse === true ? "reverse_chronological" : "chronological",
    entries
  };
}

function roomEventLogEntry(event, options = {}) {
  const payload = event.payload || {};
  const content = roomEventLogContent(event);
  const contentPreview = options.full === true ? content : truncateOneLine(content, 180);
  const entry = {
    sequence: event.sequence ?? null,
    at: event.at || "",
    type: event.type || "",
    actor: event.actor || "system",
    room_id: event.room_id || "",
    ...(event.run_id ? { run_id: event.run_id } : {}),
    ...(event.node_id ? { node_id: event.node_id } : {}),
    ...(event.agent_id ? { agent_id: event.agent_id } : {}),
    summary: roomEventLogSummary(event, contentPreview),
    payload_keys: Object.keys(payload).sort()
  };
  if (contentPreview) entry.content_preview = contentPreview;
  if (payload.agent_id && !entry.agent_id) entry.agent_id = payload.agent_id;
  if (payload.node_id && !entry.node_id) entry.node_id = payload.node_id;
  if (payload.status) entry.status = payload.status;
  if (payload.stream) entry.stream = payload.stream;
  if (payload.exit_code !== undefined) entry.exit_code = payload.exit_code;
  return entry;
}

function roomEventLogContent(event) {
  const payload = event?.payload || {};
  if (typeof payload.content === "string") return payload.content;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.goal === "string") return payload.goal;
  if (typeof payload.title === "string") return payload.title;
  return "";
}

function roomEventLogSummary(event, contentPreview = "") {
  const payload = event?.payload || {};
  const run = event?.run_id ? ` ${event.run_id}` : "";
  const agent = payload.agent_id || event?.agent_id || event?.actor || "";
  const node = payload.node_id || event?.node_id || "";
  if (event.type === "room.created") {
    const agents = Array.isArray(payload.agents) && payload.agents.length ? `; agents=${payload.agents.join(",")}` : "";
    return `created room "${payload.title || event.room_id || "untitled"}"${agents}`;
  }
  if (event.type === "room.message.added") {
    return `message from ${payload.speaker || event.actor || "unknown"}${contentPreview ? `: ${contentPreview}` : ""}`;
  }
  if (event.type === "room.report.added") {
    return `REPORT from ${event.actor || "unknown"}${contentPreview ? `: ${contentPreview}` : ""}`;
  }
  if (event.type === "room.blackboard.updated") {
    return `BLACKBOARD from ${event.actor || "unknown"}${contentPreview ? `: ${contentPreview}` : ""}`;
  }
  if (event.type === "room.status.changed") {
    return `room status -> ${payload.status || "unknown"}`;
  }
  if (event.type === "run.queued") {
    return `queued run${run} for ${agent || "unknown"}${node ? ` on ${node}` : ""}`;
  }
  if (event.type === "run.started") {
    return `started run${run} for ${agent || "unknown"}${node ? ` on ${node}` : ""}`;
  }
  if (event.type === "run.output") {
    const bytes = Buffer.byteLength(payload.text || "", "utf8");
    return `${payload.stream || "output"} ${bytes}B from ${agent || event.actor || "unknown"}${contentPreview ? `: ${contentPreview}` : ""}`;
  }
  if (event.type === "run.completed" || event.type === "run.failed") {
    const status = payload.status || (event.type === "run.completed" ? "completed" : "failed");
    const stdoutBytes = payload.stdout_bytes ?? 0;
    const stderrBytes = payload.stderr_bytes ?? 0;
    return `${status} run${run} for ${agent || "unknown"} exit=${payload.exit_code ?? "unknown"} stdout=${stdoutBytes}B stderr=${stderrBytes}B`;
  }
  return `${event.type || "event"} by ${event.actor || "system"}${contentPreview ? `: ${contentPreview}` : ""}`;
}

function formatRoomEventLog(log) {
  const room = log.room || {};
  const lines = [];
  lines.push(`Agent Bus room event log: ${room.id || "-"}`);
  lines.push(`Title: ${room.title || "untitled"}`);
  lines.push(`Status: ${room.status || "unknown"}; events: ${log.shown_events}/${log.total_events}; reports-only: ${log.reports_only ? "yes" : "no"}; order: ${log.order || "chronological"}`);
  if (log.truncated) {
    lines.push(`Window: ${log.window}; omitted: ${log.omitted_events}. Use --all for the full log or --tail N for the latest events.`);
  }
  lines.push("");
  for (const entry of log.entries || []) {
    const seq = entry.sequence === null || entry.sequence === undefined ? "----" : String(entry.sequence).padStart(4, "0");
    const run = entry.run_id ? ` run=${entry.run_id}` : "";
    lines.push(`${seq} ${entry.at || "-"} ${entry.type || "event"} actor=${entry.actor || "system"}${run} :: ${entry.summary || ""}`);
  }
  if (!log.entries?.length) lines.push("(no events)");
  lines.push("");
  lines.push(`Export bundle: agent-bus room export ${room.id || "ROOM_ID"} --format events --out room-events.json`);
  lines.push("Replay bundle: agent-bus room replay --in room-events.json --format markdown");
  return `${lines.join("\n")}\n`;
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
    export_metadata: bundle.export_metadata || null,
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
  const checklist = roomAgentChecklist(room);
  const reportsOnly = options.reportsOnly === true;
  const messages = reportsOnly ? [] : (room.messages || []);
  const runs = room.runs || [];
  const lines = [];
  lines.push(`# Agent Bus Room: ${room.title || room.id || "untitled"}`);
  lines.push("");
  lines.push(`- id: \`${room.id || "-"}\``);
  lines.push(`- status: \`${room.status || "unknown"}\``);
  lines.push(`- agents: ${formatInlineList(room.agents)}`);
  lines.push(`- created: ${room.created_at || "-"}`);
  lines.push(`- updated: ${room.updated_at || "-"}`);
  if (reportsOnly) {
    lines.push("- reports-only: goal, full messages, and run output omitted; review reports before sharing");
  }
  lines.push("");
  if (!reportsOnly && room.goal) {
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
  if (checklist) {
    appendRoomAgentChecklistMarkdown(lines, checklist);
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

function appendRoomAgentChecklistMarkdown(lines, checklist) {
  const summary = checklist.summary || {};
  const agents = checklist.agents && typeof checklist.agents === "object" ? checklist.agents : {};
  lines.push("## Agent Checklist");
  lines.push("");
  lines.push(`- expected: ${summary.expected_agents ?? 0}`);
  lines.push(`- replied: ${summary.replied_agents ?? 0}`);
  lines.push(`- completed: ${summary.completed_agents ?? 0}`);
  lines.push(`- failed: ${summary.failed_agents ?? 0}`);
  const missingReport = Array.isArray(summary.missing_report_agents) ? summary.missing_report_agents : [];
  const missingDone = Array.isArray(summary.missing_done_agents) ? summary.missing_done_agents : [];
  if (missingReport.length) lines.push(`- missing REPORT: ${formatInlineList(missingReport)}`);
  if (missingDone.length) lines.push(`- missing DONE: ${formatInlineList(missingDone)}`);
  const agentIds = Object.keys(agents).sort();
  if (agentIds.length) {
    lines.push("");
    for (const agentId of agentIds) {
      const item = agents[agentId] || {};
      const duration = Number.isFinite(item.duration_seconds) ? ` duration=${item.duration_seconds}s` : "";
      const report = item.has_report === undefined ? "" : ` report=${item.has_report ? "yes" : "no"}`;
      const done = item.has_done === undefined ? "" : ` done=${item.has_done ? "yes" : "no"}`;
      lines.push(`- ${agentId}: ${item.status || "unknown"} run=${item.run_id || "-"}${report}${done}${duration}`);
      if (item.error) lines.push(`  error: ${oneLine(item.error, 180)}`);
    }
  }
  lines.push("");
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
  const request = resolveGatewayRequestContext(args);
  const token = request.token;
  const health = await gatewayJson("/health", { auth: false, args });
  let agents = [];
  let rooms = [];
  let nodes = [];
  let authWarning = "";
  let roomAccess = "full";
  let roomAccessWarning = "";
  let hydrationMeta = null;

  if (token) {
    agents = await gatewayJson("/agents", { auth: true, args });
    nodes = await optionalGatewayJson("/nodes", { auth: true, args }, []);
    try {
      rooms = await gatewayJson("/rooms", { auth: true, args });
      const hydrated = await hydrateStatusRooms(rooms, args);
      rooms = hydrated.rooms;
      hydrationMeta = hydrated.meta;
    } catch (err) {
      if (!isUnauthorizedGatewayError(err)) throw err;
      roomAccess = "limited";
      roomAccessWarning = "This token can read agents and nodes, but room inventory is admin-only; pass an admin token for room and recovery details.";
    }
  } else {
    authWarning = "Pass --token, set AGENT_BUS_TOKEN, or use --config with a token-bearing config to include agents, nodes, and rooms.";
  }

  const staleSeconds = positiveIntegerOption(optionValue(args, "--stale-seconds") || process.env.AGENT_BUS_STATUS_STALE_SECONDS, 180, 86400);
  const queuedRunStaleSeconds = positiveIntegerOption(optionValue(args, "--queued-run-stale-seconds") || process.env.AGENT_BUS_STATUS_QUEUED_RUN_STALE_SECONDS, 21600, 604800);
  const runHeartbeatStaleSeconds = positiveIntegerOption(runHeartbeatStaleOption(args), DEFAULT_RUN_HEARTBEAT_STALE_SECONDS, 86400);
  const result = summarizeStatus({
    health,
    agents,
    rooms,
    nodes,
    authWarning,
    roomAccess,
    roomAccessWarning,
    staleSeconds,
    queuedRunStaleSeconds,
    runHeartbeatStaleSeconds
  });
  if (hydrationMeta || roomAccess !== "full") {
    result.status_meta = {
      ...(result.status_meta || {}),
      ...(hydrationMeta ? { room_details: hydrationMeta } : {}),
      room_access: roomAccess
    };
  }
  applyStatusRoomDetailCoverage(result);
  if (jsonOut) {
    printJson(result);
    return;
  }
  printStatus(result);
}

async function plugin(args) {
  const action = args[0] || "status";
  if (action === "status" || action === "list" || action === "ls") {
    return printJson(await gatewayJson("/v1/agent-bus/plugins", { auth: true, args }));
  }
  if (action === "telegram") {
    const subcommand = args[1] || "status";
    const rest = args.slice(2);
    if (subcommand === "status") {
      const plugins = await gatewayJson("/v1/agent-bus/plugins", { auth: true, args });
      return printJson(plugins.telegramBot || {});
    }
    if (subcommand === "test") {
      const dryRun = booleanOption(rest, "--dry-run", "--live");
      const body = {
        message: optionValue(rest, "--message") || optionValue(rest, "-m") || "Agent Bus Telegram plugin test.",
        ...(dryRun === undefined ? {} : { dryRun })
      };
      return printJson(await gatewayJson("/v1/agent-bus/plugins/telegram/test", {
        auth: true,
        args,
        method: "POST",
        body
      }));
    }
    if (subcommand === "doctor" || subcommand === "diagnose") {
      await telegramDoctor(rest);
      return;
    }
    if (subcommand === "poll" || subcommand === "poller") {
      await runScript("scripts/telegram-poller.mjs", stripCliOnlyArgs(rest));
      return;
    }
    if (subcommand === "commands" || subcommand === "command-menu") {
      await runScript("scripts/telegram-commands.mjs", stripCliOnlyArgs(rest));
      return;
    }
  }
  throw new Error("Usage: agent-bus plugin status | agent-bus plugin telegram status | agent-bus plugin telegram doctor [--transport poller|webhook|auto] | agent-bus plugin telegram test [--message text] [--dry-run|--live] | agent-bus plugin telegram commands set|list|delete | agent-bus plugin telegram poll");
}

async function telegramDoctor(args) {
  const checks = [];
  const jsonOut = args.includes("--json");
  const localOnly = args.includes("--local-only");
  const transport = telegramTransport(args);
  const apiBaseUrl = optionValue(args, "--api-base-url") || process.env.AGENT_BUS_TELEGRAM_API_BASE_URL || "https://api.telegram.org";
  const botToken = optionValue(args, "--bot-token") || process.env.AGENT_BUS_TELEGRAM_BOT_TOKEN || "";
  const chatId = optionValue(args, "--chat-id") || process.env.AGENT_BUS_TELEGRAM_CHAT_ID || "";
  const webhookSecret = optionValue(args, "--secret-token") || process.env.AGENT_BUS_TELEGRAM_WEBHOOK_SECRET || "";
  const timeoutMs = positiveIntegerOption(optionValue(args, "--timeout-ms") || process.env.AGENT_BUS_TELEGRAM_DOCTOR_TIMEOUT_MS, 10000, 120000);

  addCheck(checks, "pass", "telegram doctor", transport);
  if (botToken) {
    addCheck(checks, "pass", "telegram bot token", "configured");
  } else {
    addCheck(checks, "fail", "telegram bot token", "missing", "Set AGENT_BUS_TELEGRAM_BOT_TOKEN or pass --bot-token.");
  }
  addCheck(checks, chatId ? "pass" : "warn", "telegram chat id", chatId ? "configured" : "missing", "Set AGENT_BUS_TELEGRAM_CHAT_ID or pass --chat-id so Central can send operator notifications.");
  addCheck(checks, webhookSecret ? "pass" : "warn", "telegram webhook secret", webhookSecret ? "configured" : "missing", "Set AGENT_BUS_TELEGRAM_WEBHOOK_SECRET so poller/webhook callbacks can be authenticated.");

  const centralStatus = await checkTelegramGatewayStatus(checks, args);
  await checkTelegramWebhookProbe(checks, args, { chatId, webhookSecret, centralStatus, timeoutMs });
  if (!localOnly && botToken) {
    await checkTelegramBotApi(checks, { botToken, apiBaseUrl, transport, timeoutMs });
  } else if (localOnly) {
    addCheck(checks, "pass", "telegram Bot API checks skipped", "--local-only");
  }

  printDoctorResult(checks, jsonOut);
  if (checks.some((item) => item.status === "fail")) {
    process.exitCode = 1;
  }
}

async function checkTelegramGatewayStatus(checks, args) {
  const token = optionValue(args, "--token") || process.env.AGENT_BUS_TOKEN || "";
  if (!token) {
    addCheck(checks, "warn", "telegram central plugin status", "skipped", "Pass --token or AGENT_BUS_TOKEN to verify Central plugin wiring.");
    return;
  }
  try {
    const plugins = await gatewayJson("/v1/agent-bus/plugins", { auth: true, args });
    const status = plugins.telegramBot || {};
    addCheck(checks, status.enabled ? "pass" : "warn", "telegram central plugin", status.enabled ? "enabled" : "disabled", "Set AGENT_BUS_TELEGRAM_ENABLED=true for the Central service.");
    addCheck(checks, status.configured ? "pass" : "warn", "telegram central notification config", status.configured ? "bot token and chat id visible to Central" : "incomplete", "Load the Telegram env file into the Central service environment.");
    const control = status.control || {};
    addCheck(checks, control.enabled ? "pass" : "warn", "telegram central control", control.enabled ? "enabled" : "disabled", "Set AGENT_BUS_TELEGRAM_CONTROL_ENABLED=true to accept /status, /run, /room, and callbacks.");
    addCheck(checks, control.secret_configured ? "pass" : "warn", "telegram central control secret", control.secret_configured ? "configured" : "missing", "Set AGENT_BUS_TELEGRAM_WEBHOOK_SECRET in Central.");
    addCheck(checks, Number(control.allowed_chat_count || 0) > 0 ? "pass" : "warn", "telegram central allowed chats", `${Number(control.allowed_chat_count || 0)} configured`, "Restrict production control bots to your Telegram chat id.");
    const conversation = control.conversation || {};
    addCheck(checks, conversation.enabled ? "pass" : "warn", "telegram central conversation", conversation.enabled ? `enabled (${(conversation.agents || []).join(", ") || "default routing"})` : "disabled", "Set AGENT_BUS_TELEGRAM_CONVERSATION_ENABLED=true for persistent Telegram processes.");
    return status;
  } catch (err) {
    addCheck(checks, "warn", "telegram central plugin status", trimOneLine(err.message || String(err)), "Check --gateway, --token, and whether Central is running.");
    return null;
  }
}

async function checkTelegramWebhookProbe(checks, args, options = {}) {
  if (args.includes("--no-webhook-probe")) {
    addCheck(checks, "pass", "telegram webhook probe", "skipped by --no-webhook-probe");
    return;
  }
  const control = options.centralStatus?.control || {};
  if (!control.enabled) {
    addCheck(checks, "warn", "telegram webhook probe", "skipped; Central control is disabled", "Enable Telegram control before probing the webhook handler.");
    return;
  }
  if (control.diagnostic_dry_run_header !== true) {
    addCheck(checks, "warn", "telegram webhook probe", "skipped; Central does not advertise diagnostic dry-run support", "Upgrade Central before running a no-notification webhook probe.");
    return;
  }
  if (!options.chatId) {
    addCheck(checks, "warn", "telegram webhook probe", "skipped; chat id missing", "Pass --chat-id or set AGENT_BUS_TELEGRAM_CHAT_ID.");
    return;
  }
  if (!options.webhookSecret && control.secret_configured) {
    addCheck(checks, "warn", "telegram webhook probe", "skipped; webhook secret missing", "Pass --secret-token or set AGENT_BUS_TELEGRAM_WEBHOOK_SECRET.");
    return;
  }

  const gateway = optionValue(args, "--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "http://127.0.0.1:8788";
  const timeoutMs = options.timeoutMs || 10000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "content-type": "application/json",
      "x-agent-bus-telegram-dry-run": "true"
    };
    if (options.webhookSecret) headers["x-telegram-bot-api-secret-token"] = options.webhookSecret;
    const res = await fetch(gatewayEndpoint(gateway, "/v1/agent-bus/plugins/telegram/webhook"), {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        update_id: Math.floor(Date.now() / 1000),
        message: {
          message_id: 1,
          chat: { id: options.chatId, type: "private" },
          text: "/status"
        }
      })
    });
    const text = await res.text();
    const body = parseJsonText(text);
    if (!res.ok) {
      addCheck(checks, "fail", "telegram webhook probe", `${res.status} ${res.statusText}: ${trimOneLine(text)}`, "Check webhook secret, allowed chat id, and Central Telegram control settings.");
      return;
    }
    const command = body?.command || "";
    if (body?.ok === true && command === "status" && body?.diagnostic_dry_run === true) {
      addCheck(checks, "pass", "telegram webhook probe", "dry-run /status accepted");
    } else if (body?.ok === true && command === "status") {
      addCheck(checks, "warn", "telegram webhook probe", "accepted but dry-run flag was not echoed", "Upgrade Central so doctor probes cannot emit live Telegram replies.");
    } else {
      addCheck(checks, "warn", "telegram webhook probe", `unexpected response: ${trimOneLine(JSON.stringify(body))}`, "Expected the webhook handler to accept a diagnostic /status command.");
    }
  } catch (err) {
    addCheck(checks, "warn", "telegram webhook probe", trimOneLine(err.message || String(err)), "Check --gateway and whether Central is reachable from this host.");
  } finally {
    clearTimeout(timer);
  }
}

async function checkTelegramBotApi(checks, options) {
  try {
    const me = await telegramApi(options.botToken, "getMe", {}, options.apiBaseUrl, options.timeoutMs);
    const user = me.result || {};
    addCheck(checks, "pass", "telegram getMe", user.username ? `@${user.username}` : (user.first_name || "bot reachable"));
  } catch (err) {
    addCheck(checks, "fail", "telegram getMe", trimOneLine(err.message || String(err)), "Verify the bot token and outbound network access to Telegram.");
    return;
  }

  try {
    const commands = await telegramApi(options.botToken, "getMyCommands", {}, options.apiBaseUrl, options.timeoutMs);
    const installed = Array.isArray(commands.result) ? commands.result.map((item) => item.command).filter(Boolean) : [];
    const missing = defaultTelegramCommands().map((item) => item.command).filter((command) => !installed.includes(command));
    addCheck(checks, missing.length ? "warn" : "pass", "telegram command menu", missing.length ? `missing: ${missing.join(", ")}` : `${installed.length} command(s) installed`, "Run agent-bus plugin telegram commands set or agent-bus setup telegram --set-commands.");
  } catch (err) {
    addCheck(checks, "warn", "telegram command menu", trimOneLine(err.message || String(err)), "Command menu checks use Telegram getMyCommands.");
  }

  try {
    const webhook = await telegramApi(options.botToken, "getWebhookInfo", {}, options.apiBaseUrl, options.timeoutMs);
    const info = webhook.result || {};
    const url = String(info.url || "");
    const lastError = trimOneLine(info.last_error_message || "");
    if (options.transport === "poller") {
      addCheck(checks, url ? "warn" : "pass", "telegram update transport", url ? "webhook still configured" : "poller-ready (no webhook URL)", "Run agent-bus plugin telegram poll --delete-webhook before using poller mode.");
    } else if (options.transport === "webhook") {
      addCheck(checks, url ? "pass" : "fail", "telegram update transport", url ? `webhook ${url}` : "no webhook URL", "Set a Telegram webhook to /v1/agent-bus/plugins/telegram/webhook or use --transport poller.");
    } else {
      addCheck(checks, "pass", "telegram update transport", url ? `webhook ${url}` : "no webhook URL; poller mode is available");
    }
    if (lastError) {
      addCheck(checks, "warn", "telegram webhook last error", lastError);
    }
    if (Number(info.pending_update_count || 0) > 0) {
      addCheck(checks, "warn", "telegram pending updates", `${info.pending_update_count} pending`, "Start the poller or fix the webhook to drain updates.");
    } else {
      addCheck(checks, "pass", "telegram pending updates", "0 pending");
    }
  } catch (err) {
    addCheck(checks, "warn", "telegram webhook info", trimOneLine(err.message || String(err)), "Webhook info checks use Telegram getWebhookInfo.");
  }
}

function summarizeStatus({
  health,
  agents,
  rooms,
  nodes,
  authWarning,
  roomAccess = "full",
  roomAccessWarning = "",
  staleSeconds = 180,
  queuedRunStaleSeconds = 21600,
  runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS
}) {
  const agentList = Array.isArray(agents) ? agents : [];
  const roomList = Array.isArray(rooms) ? rooms : [];
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const agentConflicts = agentIdConflicts(agentList);
  const onlineAgents = agentList.filter((agent) => agent.status === "online");
  const reachableAgents = agentList.filter((agent) => agent.ping_status === "reachable");
  const permissionObservations = permissionObservationSummary(agentList);
  const activeRooms = roomList.filter(isActiveRoom);
  const heartbeatIntervalByAgentId = agentHeartbeatIntervalById(nodeList);
  const nodeById = new Map(
    nodeList
      .map((node) => [String(node?.node_id || node?.id || "").trim(), node])
      .filter(([nodeId]) => nodeId)
  );
  const nodeLookupAvailable = nodeById.size > 0;
  const runSummary = activeRoomRunSummary(activeRooms, {
    queuedRunStaleSeconds,
    staleSeconds,
    nodeById,
    nodeLookupAvailable,
    heartbeatIntervalByAgentId,
    runHeartbeatStaleSeconds
  });
  const recoveryHints = staleRoomRecoveryHints(runSummary.staleQueuedRuns, { queuedRunStaleSeconds });
  const staleRunningHints = staleRunningRoomHints(runSummary.staleRunningRuns, { runHeartbeatStaleSeconds });
  const orphanedRunningHints = orphanedRunningRoomHints(runSummary.orphanedRunningRuns, { staleSeconds });
  const activeRunsByAgent = runSummary.liveByAgent;
  const fallbackBusyAgentIds = new Set(activeRooms
    .filter((room) => !Array.isArray(room.runs))
    .flatMap((room) => Array.isArray(room.agents) ? room.agents : []));
  const busyAgentIds = new Set([...activeRunsByAgent.keys(), ...fallbackBusyAgentIds]);
  const result = {
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
      stale_running_runs: runSummary.staleRunningRuns.length,
      stale_queued_runs: runSummary.staleQueuedRuns.length,
      orphaned_running_runs: runSummary.orphanedRunningRuns.length,
      duplicate_agent_ids: agentConflicts.length
    },
    permission_observations: permissionObservations,
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
      const staleRunningRuns = runSummary.staleRunningByAgent.get(agent.id) || [];
      const staleQueuedRuns = runSummary.staleQueuedByAgent.get(agent.id) || [];
      const orphanedRunningRuns = runSummary.orphanedRunningByAgent.get(agent.id) || [];
      const activeRoomIds = unique([
        ...activeRuns.map((run) => run.room_id).filter(Boolean),
        ...staleRunningRuns.map((run) => run.room_id).filter(Boolean),
        ...orphanedRunningRuns.map((run) => run.room_id).filter(Boolean),
        ...activeRooms
          .filter((room) => !Array.isArray(room.runs) && Array.isArray(room.agents) && room.agents.includes(agent.id))
          .map((room) => room.id)
          .filter(Boolean)
      ]);
      const latestRun = activeRuns[0] || staleRunningRuns[0] || orphanedRunningRuns[0] || null;
      return {
        id: agent.id,
        status: agent.status || "unknown",
        node_id: agent.node_id || agent.nodeId || null,
        kind: agent.kind || null,
        role: agent.role || null,
        capabilities: Array.isArray(agent.capabilities) ? agent.capabilities : [],
        ...agentObservationFields(agent),
        ping_status: pingStatus,
        last_run_status: lastRunStatus,
        last_seen_at: lastSeenAt,
        run_heartbeat_interval_ms: positiveHeartbeatIntervalMs(agent.run_heartbeat_interval_ms),
        freshness: statusFreshness(agent.status, lastSeenAt, staleSeconds),
        activity: agentActivity(activeRuns, activeRoomIds, orphanedRunningRuns, staleRunningRuns),
        active_rooms: activeRoomIds,
        active_runs: activeRuns,
        stale_running_runs: staleRunningRuns,
        stale_queued_runs: staleQueuedRuns,
        orphaned_running_runs: orphanedRunningRuns,
        current_run: latestRun?.id || null,
        ping_label: pingLabel(pingStatus),
        last_run_health: lastRunHealth(lastRunStatus)
      };
    }),
    agent_id_conflicts: agentConflicts,
    recovery_hints: recoveryHints,
    stale_running_hints: staleRunningHints,
    orphaned_running_hints: orphanedRunningHints,
    rooms: roomList.slice(0, 8).map((room) => ({
      id: room.id,
      status: room.status,
      agents: room.agents || [],
      updated_at: room.updated_at,
      reports: room.report_count ?? null,
      messages: room.message_count ?? null,
      active_runs: activeRunsForRoom(room, { queuedRunStaleSeconds, staleSeconds, nodeById, nodeLookupAvailable, heartbeatIntervalByAgentId, runHeartbeatStaleSeconds })
        .map((run) => run.id),
      stale_running_runs: staleRunningRunsForRoom(room, { queuedRunStaleSeconds, staleSeconds, nodeById, nodeLookupAvailable, heartbeatIntervalByAgentId, runHeartbeatStaleSeconds })
        .map((run) => run.id),
      stale_queued_runs: staleQueuedRunsForRoom(room, { queuedRunStaleSeconds, staleSeconds, nodeById, nodeLookupAvailable, heartbeatIntervalByAgentId })
        .map((run) => run.id),
      orphaned_running_runs: orphanedRunningRunsForRoom(room, { queuedRunStaleSeconds, staleSeconds, nodeById, nodeLookupAvailable, heartbeatIntervalByAgentId })
        .map((run) => run.id)
    })),
    warnings: statusWarnings({
      authWarning,
      roomAccessWarning,
      staleRunningRuns: runSummary.staleRunningRuns,
      staleQueuedRuns: runSummary.staleQueuedRuns,
      orphanedRunningRuns: runSummary.orphanedRunningRuns,
      runHeartbeatStaleSeconds,
      queuedRunStaleSeconds,
      staleSeconds,
      health,
      staleRunningHints,
      recoveryHints,
      orphanedRunningHints,
      agentIdConflicts: agentConflicts
    })
  };
  result.readiness = statusReadiness(result, { authWarning });
  result.next_actions = statusNextActions(result, { authWarning, roomAccess });
  return result;
}

function statusReadiness(result, { authWarning = "" } = {}) {
  const s = result.summary || {};
  if (!result.health?.ok) {
    return {
      level: "critical",
      status: "central-unhealthy",
      message: "Central health did not report ok."
    };
  }
  if (authWarning) {
    return {
      level: "limited",
      status: "token-needed",
      message: "Gateway is reachable, but authenticated agent/node/room details are hidden."
    };
  }
  if (Number(s.nodes || 0) === 0 || Number(s.online_agents || 0) === 0) {
    return {
      level: "setup",
      status: "waiting-for-edge",
      message: "Central is up, but no online edge agents are ready to receive work."
    };
  }
  if (Number(s.duplicate_agent_ids || 0) > 0) {
    return {
      level: "attention",
      status: "duplicate-agent-ids",
      message: "Central has duplicate online agent ids. Rename duplicates before routing work to those agents."
    };
  }
  if (Number(s.orphaned_running_runs || 0) > 0) {
    return {
      level: "attention",
      status: "orphaned-running-runs",
      message: "Central is reachable, but at least one running room task is attached to a stale or missing node."
    };
  }
  if (Number(s.stale_running_runs || 0) > 0) {
    return {
      level: "attention",
      status: "stale-running-runs",
      message: "Central is reachable, but at least one running room task has not reported a run heartbeat within the current threshold while its node still looks online."
    };
  }
  if (Number(s.stale_queued_runs || 0) > 0) {
    return {
      level: "attention",
      status: "stale-room-runs",
      message: "Central is usable, but old queued room runs need operator review."
    };
  }
  if (Number(s.queued || 0) > 0 && Number(s.busy_agents || 0) === 0) {
    return {
      level: "attention",
      status: "queue-needs-agent",
      message: "Central has queued work, but no agent is currently marked busy."
    };
  }
  if (Number(s.busy_agents || 0) > 0 || Number(s.active_rooms || 0) > 0) {
    return {
      level: "active",
      status: "working",
      message: "Agents are connected and work is currently active."
    };
  }
  return {
    level: "ready",
    status: "ready",
    message: "Central and edge agents are ready for work."
  };
}

function statusNextActions(result, { authWarning = "", roomAccess = "full" } = {}) {
  const s = result.summary || {};
  const actions = [];
  if (!result.health?.ok) {
    actions.push("Check the Central service logs and restart the central process.");
  }
  if (authWarning) {
    actions.push("Pass --token or set AGENT_BUS_TOKEN to show agents, nodes, rooms, and recovery hints.");
  }
  if (!authWarning && Number(s.registered_nodes || 0) === 0) {
    actions.push("Create the first edge join command with agent-bus setup central or the Web Console Edge Join panel.");
  }
  if (!authWarning && Number(s.nodes || 0) === 0 && Number(s.registered_nodes || 0) > 0) {
    actions.push("Start or restart an edge with agent-bus connect --config edge.config.json.");
  }
  if (!authWarning && Number(s.nodes || 0) > 0 && Number(s.online_agents || 0) === 0) {
    actions.push("Run agent-bus doctor --config edge.config.json on the edge host and restart its service.");
  }
  if (!authWarning && Number(s.registered_agents || 0) > Number(s.agents || 0)) {
    actions.push("Some registered agents are offline or stale; inspect the Nodes section before routing work to them.");
  }
  if (!authWarning && Number(s.duplicate_agent_ids || 0) > 0) {
    actions.push("Rename duplicate agent ids in edge.config.json, then restart the affected edge services.");
  }
  if (!authWarning && roomAccess !== "full") {
    actions.push("Pass an admin token to inspect rooms, export room history, or recover stale queued work.");
  }
  if (Number(s.queued || 0) > 0 && Number(s.busy_agents || 0) === 0) {
    actions.push("Poll or restart edge services so queued runs can be claimed.");
  }
  if (result.orphaned_running_hints?.length) {
    const hint = result.orphaned_running_hints[0];
    actions.push(`Inspect orphaned running room work: ${hint.inspect_command}`);
  }
  if (result.stale_running_hints?.length) {
    const hint = result.stale_running_hints[0];
    if (hint.adjust_threshold_command) {
      actions.push(`If this edge heartbeats more slowly than your stale-running threshold, re-check with: ${hint.adjust_threshold_command}`);
    }
    actions.push(`Inspect stale-running room work: ${hint.inspect_command}`);
  }
  if (result.recovery_hints?.length) {
    const hint = result.recovery_hints[0];
    actions.push(`Inspect stale room work: ${hint.inspect_command}`);
  }
  if (!authWarning && Number(s.online_agents || 0) > 0 && Number(s.active_rooms || 0) === 0 && Number(s.queued || 0) === 0) {
    actions.push("Try a live room with agent-bus room create --goal \"...\" --agents agent-a,agent-b.");
  }
  const permissionObservations = result.permission_observations || {};
  const missingProfiles = Array.isArray(permissionObservations.missing_permission_profile)
    ? permissionObservations.missing_permission_profile
    : [];
  if (!authWarning && missingProfiles.length) {
    actions.push(`Add permission_profile observation fields to edge configs for ${missingProfiles.slice(0, 3).join(", ")}${missingProfiles.length > 3 ? ", ..." : ""}.`);
  }
  return unique(actions).slice(0, 6);
}

async function hydrateStatusRooms(rooms, args) {
  const activeRooms = Array.isArray(rooms) ? rooms.filter(isActiveRoom).filter((room) => room.id) : [];
  const baseMeta = {
    active_total: activeRooms.length,
    requested: 0,
    hydrated: 0,
    failed: 0,
    omitted: 0,
    skipped: false,
    concurrency: 0,
    limit: 0
  };
  if (!Array.isArray(rooms)) return { rooms, meta: finalizeStatusRoomDetailMeta({ ...baseMeta, skipped: true }) };
  if (args.includes("--no-room-details")) {
    return {
      rooms,
      meta: finalizeStatusRoomDetailMeta({ ...baseMeta, skipped: true, omitted: activeRooms.length })
    };
  }
  const limit = positiveIntegerOption(optionValue(args, "--room-detail-limit"), 25, 100);
  const concurrency = positiveIntegerOption(optionValue(args, "--room-detail-concurrency"), 6, 25);
  const active = activeRooms.slice(0, limit);
  const meta = {
    ...baseMeta,
    requested: active.length,
    omitted: Math.max(0, activeRooms.length - active.length),
    concurrency,
    limit
  };
  if (!active.length) return { rooms, meta: finalizeStatusRoomDetailMeta(meta) };
  const details = new Map();
  let index = 0;
  async function worker() {
    while (index < active.length) {
      const room = active[index++];
      try {
        const detail = await gatewayJson(`/rooms/${pathPart(room.id)}`, { auth: true, args });
        details.set(room.id, detail);
        meta.hydrated += 1;
      } catch {
        // Status should remain useful even if an old gateway cannot hydrate room details.
        meta.failed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, active.length) }, () => worker()));
  const finalizedMeta = finalizeStatusRoomDetailMeta(meta);
  if (!details.size) return { rooms, meta: finalizedMeta };
  return {
    rooms: rooms.map((room) => details.has(room.id) ? { ...room, ...details.get(room.id) } : room),
    meta: finalizedMeta
  };
}

function finalizeStatusRoomDetailMeta(meta = {}) {
  const activeTotal = Number(meta.active_total || 0);
  if (!activeTotal) return { ...meta, coverage: "not_needed" };
  if (meta.skipped) return { ...meta, coverage: "skipped" };
  if (Number(meta.failed || 0) > 0 || Number(meta.omitted || 0) > 0 || Number(meta.hydrated || 0) < Number(meta.requested || 0)) {
    return { ...meta, coverage: "partial" };
  }
  return { ...meta, coverage: "full" };
}

function isActiveRoom(room) {
  return ["active", "running", "finishing"].includes(String(room?.status || "").toLowerCase());
}

const STATUS_TERMINAL_RUNS = new Set(["completed", "failed", "error", "cancelled", "canceled", "skipped", "replaced", "superseded"]);

function isReplacedRun(run) {
  return Boolean(run?.replaced_by_run_id || run?.replacement_run_id || run?.superseded_by_run_id || run?.late_complete_ignored_at);
}

function activeRunsForRoom(room, options = {}) {
  return activeRunBucketsForRoom(room, options).liveRuns;
}

function staleQueuedRunsForRoom(room, options = {}) {
  return activeRunBucketsForRoom(room, options).staleQueuedRuns;
}

function staleRunningRunsForRoom(room, options = {}) {
  return activeRunBucketsForRoom(room, options).staleRunningRuns;
}

function orphanedRunningRunsForRoom(room, options = {}) {
  return activeRunBucketsForRoom(room, options).orphanedRunningRuns;
}

function activeRunBucketsForRoom(room, {
  queuedRunStaleSeconds = 21600,
  staleSeconds = 180,
  nodeById = new Map(),
  nodeLookupAvailable = nodeById instanceof Map && nodeById.size > 0,
  heartbeatIntervalByAgentId = new Map(),
  runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS
} = {}) {
  const roomId = room?.id || "";
  const liveRuns = [];
  const staleRunningRuns = [];
  const staleQueuedRuns = [];
  const orphanedRunningRuns = [];
  for (const rawRun of Array.isArray(room?.runs) ? room.runs : []) {
    if (isReplacedRun(rawRun)) continue;
    const run = statusRunRecord(rawRun, roomId, { staleSeconds, nodeById, nodeLookupAvailable, heartbeatIntervalByAgentId });
    const status = String(run.status || "queued").toLowerCase();
    if (STATUS_TERMINAL_RUNS.has(status)) continue;
    if (isStaleQueuedRun(run, queuedRunStaleSeconds)) {
      staleQueuedRuns.push(run);
    } else if (isOrphanedRunningRun(run, nodeLookupAvailable)) {
      orphanedRunningRuns.push(run);
    } else if (isStaleRunningRun(run, runHeartbeatStaleSeconds)) {
      staleRunningRuns.push(run);
    } else {
      liveRuns.push(run);
    }
  }
  return { liveRuns, staleRunningRuns, staleQueuedRuns, orphanedRunningRuns };
}

function activeRoomRunSummary(rooms, options = {}) {
  const liveRuns = [];
  const staleRunningRuns = [];
  const staleQueuedRuns = [];
  const orphanedRunningRuns = [];
  const liveByAgent = new Map();
  const staleRunningByAgent = new Map();
  const staleQueuedByAgent = new Map();
  const orphanedRunningByAgent = new Map();
  for (const room of rooms) {
    const buckets = activeRunBucketsForRoom(room, options);
    liveRuns.push(...buckets.liveRuns);
    staleRunningRuns.push(...buckets.staleRunningRuns);
    staleQueuedRuns.push(...buckets.staleQueuedRuns);
    orphanedRunningRuns.push(...buckets.orphanedRunningRuns);
    addRunsByAgent(liveByAgent, buckets.liveRuns);
    addRunsByAgent(staleRunningByAgent, buckets.staleRunningRuns);
    addRunsByAgent(staleQueuedByAgent, buckets.staleQueuedRuns);
    addRunsByAgent(orphanedRunningByAgent, buckets.orphanedRunningRuns);
  }
  sortRunsByNewest(liveByAgent);
  sortRunsByNewest(staleRunningByAgent);
  sortRunsByNewest(staleQueuedByAgent);
  sortRunsByNewest(orphanedRunningByAgent);
  return {
    liveRuns,
    staleRunningRuns,
    staleQueuedRuns,
    orphanedRunningRuns,
    liveByAgent,
    staleRunningByAgent,
    staleQueuedByAgent,
    orphanedRunningByAgent
  };
}

function staleRunningRoomHints(staleRunningRuns, { runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS } = {}) {
  const byRoom = new Map();
  const thresholdFlag = runHeartbeatStaleThresholdFlag(runHeartbeatStaleSeconds);
  for (const run of staleRunningRuns) {
    const roomId = run.room_id || "";
    if (!roomId) continue;
    const hint = byRoom.get(roomId) || {
      room_id: roomId,
      stale_running_runs: [],
      agents: [],
      inspect_command: `agent-bus room inspect ${roomId}${thresholdFlag}`,
      cadence_mismatch_runs: [],
      pause_command: `agent-bus room pause ${roomId} --reason "stale running task investigation"`
    };
    if (run.id && !hint.stale_running_runs.includes(run.id)) hint.stale_running_runs.push(run.id);
    if (run.agent_id && !hint.agents.includes(run.agent_id)) hint.agents.push(run.agent_id);
    if (runHeartbeatThresholdBelowCadence(run, runHeartbeatStaleSeconds)) {
      if (run.id && !hint.cadence_mismatch_runs.includes(run.id)) hint.cadence_mismatch_runs.push(run.id);
      const recommendedThresholdSeconds = recommendedHeartbeatThresholdSecondsForRun(run);
      if (recommendedThresholdSeconds) {
        hint.recommended_run_heartbeat_stale_seconds = Math.max(Number(hint.recommended_run_heartbeat_stale_seconds || 0), recommendedThresholdSeconds);
        hint.adjust_threshold_command = `agent-bus room inspect ${roomId} --run-heartbeat-stale-seconds ${hint.recommended_run_heartbeat_stale_seconds}`;
      }
    }
    byRoom.set(roomId, hint);
  }
  return [...byRoom.values()]
    .map((hint) => {
      if (!hint.cadence_mismatch_runs.length) {
        delete hint.cadence_mismatch_runs;
        delete hint.recommended_run_heartbeat_stale_seconds;
        delete hint.adjust_threshold_command;
      } else if (hint.cadence_mismatch_runs.length === hint.stale_running_runs.length) {
        delete hint.pause_command;
      }
      return hint;
    })
    .sort((left, right) => left.room_id.localeCompare(right.room_id));
}

function staleRoomRecoveryHints(staleQueuedRuns, { queuedRunStaleSeconds = 21600 } = {}) {
  const byRoom = new Map();
  const thresholdFlag = queuedRunStaleThresholdFlag(queuedRunStaleSeconds);
  for (const run of staleQueuedRuns) {
    const roomId = run.room_id || "";
    if (!roomId) continue;
    const hint = byRoom.get(roomId) || {
      room_id: roomId,
      stale_queued_runs: [],
      agents: [],
      inspect_command: `agent-bus room inspect ${roomId}${thresholdFlag}`,
      pause_command: `agent-bus room pause ${roomId} --reason "orphan queued run recovery"`,
      recover_command: `agent-bus room recover ${roomId} --yes${thresholdFlag}`
    };
    if (run.id) hint.stale_queued_runs.push(run.id);
    if (run.agent_id && !hint.agents.includes(run.agent_id)) hint.agents.push(run.agent_id);
    byRoom.set(roomId, hint);
  }
  return [...byRoom.values()].sort((left, right) => left.room_id.localeCompare(right.room_id));
}

function orphanedRunningRoomHints(orphanedRunningRuns, { staleSeconds = 180 } = {}) {
  const byRoom = new Map();
  const thresholdFlag = staleThresholdFlag(staleSeconds);
  for (const run of orphanedRunningRuns) {
    const roomId = run.room_id || "";
    if (!roomId) continue;
    const hint = byRoom.get(roomId) || {
      room_id: roomId,
      orphaned_running_runs: [],
      agents: [],
      inspect_command: `agent-bus room inspect ${roomId}${thresholdFlag}`,
      pause_command: `agent-bus room pause ${roomId} --reason "orphan running task investigation"`
    };
    if (run.id && !hint.orphaned_running_runs.includes(run.id)) hint.orphaned_running_runs.push(run.id);
    if (run.agent_id && !hint.agents.includes(run.agent_id)) hint.agents.push(run.agent_id);
    byRoom.set(roomId, hint);
  }
  return [...byRoom.values()].sort((left, right) => left.room_id.localeCompare(right.room_id));
}

function queuedRunStaleThresholdFlag(queuedRunStaleSeconds = 21600) {
  return queuedRunStaleSeconds === 21600 ? "" : ` --queued-run-stale-seconds ${queuedRunStaleSeconds}`;
}

function staleThresholdFlag(staleSeconds = 180) {
  return staleSeconds === 180 ? "" : ` --stale-seconds ${staleSeconds}`;
}

function runHeartbeatStaleThresholdFlag(runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS) {
  return runHeartbeatStaleSeconds === DEFAULT_RUN_HEARTBEAT_STALE_SECONDS
    ? ""
    : ` --run-heartbeat-stale-seconds ${runHeartbeatStaleSeconds}`;
}

function positiveHeartbeatIntervalMs(value) {
  const intervalMs = Number(value);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return null;
  return Math.round(intervalMs);
}

function agentHeartbeatIntervalById(nodes = []) {
  const byAgent = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    for (const agent of Array.isArray(node?.agents) ? node.agents : []) {
      if (!agent || typeof agent !== "object") continue;
      const agentId = String(agent.id || "").trim();
      const intervalMs = positiveHeartbeatIntervalMs(agent.run_heartbeat_interval_ms || agent.runHeartbeatIntervalMs);
      if (!agentId || !intervalMs) continue;
      byAgent.set(agentId, intervalMs);
    }
  }
  return byAgent;
}

function runHeartbeatThresholdBelowCadence(run, runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS) {
  const intervalMs = positiveHeartbeatIntervalMs(run?.run_heartbeat_interval_ms);
  if (!intervalMs) return false;
  return runHeartbeatStaleSeconds * 1000 < intervalMs;
}

function recommendedHeartbeatThresholdSecondsForRun(run) {
  const intervalMs = positiveHeartbeatIntervalMs(run?.run_heartbeat_interval_ms);
  if (!intervalMs) return 0;
  return Math.max(1, Math.ceil(intervalMs / 1000) + 1);
}

function recommendedHeartbeatThresholdSecondsForRuns(runs = []) {
  return (Array.isArray(runs) ? runs : []).reduce((max, run) => Math.max(max, recommendedHeartbeatThresholdSecondsForRun(run)), 0);
}

function formatHeartbeatCadence(value) {
  const intervalMs = positiveHeartbeatIntervalMs(value);
  if (!intervalMs) return "unknown";
  if (intervalMs < 1000) return `${intervalMs}ms`;
  if (intervalMs % 1000) return `${(intervalMs / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  return formatAgeSeconds(intervalMs / 1000);
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

function statusRunRecord(rawRun, roomId, {
  staleSeconds = 180,
  nodeById = new Map(),
  nodeLookupAvailable = nodeById instanceof Map && nodeById.size > 0,
  heartbeatIntervalByAgentId = new Map()
} = {}) {
  const nodeId = String(rawRun?.node_id || "").trim();
  const agentId = String(rawRun?.agent_id || "").trim();
  const node = nodeById.get(nodeId);
  const seenAt = node?.last_seen_at || null;
  const lastHeartbeatAt = rawRun?.last_heartbeat_at || rawRun?.started_at || null;
  const attempt = runAttemptRecord(rawRun);
  const failureGuidance = runFailureGuidance(attempt.failure_class);
  return {
    id: rawRun?.id || "",
    room_id: rawRun?.room_id || roomId,
    agent_id: agentId,
    node_id: nodeId,
    edge_session_id: rawRun?.edge_session_id || rawRun?.lease?.edge_session_id || "",
    lease_state: rawRun?.lease?.state || "",
    status: rawRun?.status || "queued",
    created_at: rawRun?.created_at || null,
    started_at: rawRun?.started_at || null,
    completed_at: rawRun?.completed_at || null,
    last_heartbeat_at: lastHeartbeatAt,
    attempt_no: attempt.attempt_no || rawRun?.attempt_no || null,
    failure_class: attempt.failure_class || "",
    failure_category: attempt.failure_category || failureGuidance.failure_category || "",
    recommended_action: attempt.recommended_action || failureGuidance.recommended_action || "",
    retryable: typeof attempt.retryable === "boolean" ? attempt.retryable : null,
    retry_reason: attempt.retry_reason || "",
    retry_request_reason: attempt.retry_request_reason || rawRun?.retry_request_reason || "",
    last_error_excerpt: attempt.last_error_excerpt || "",
    retry_of_run_id: attempt.retry_of_run_id || rawRun?.retry_of_run_id || "",
    run_heartbeat_interval_ms: heartbeatIntervalByAgentId.get(agentId) || null,
    heartbeat_age_seconds: elapsedSeconds(lastHeartbeatAt),
    node_status: node?.status || null,
    node_last_seen_at: seenAt,
    node_freshness: node
      ? statusFreshness(node.status, seenAt, staleSeconds)
      : (nodeLookupAvailable ? "unknown" : "unchecked")
  };
}

function isOrphanedRunningRun(run, nodeLookupAvailable) {
  if (String(run.status || "").toLowerCase() !== "running") return false;
  return run.node_freshness.startsWith("stale") || (nodeLookupAvailable && run.node_freshness === "unknown");
}

function isStaleRunningRun(run, runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS) {
  if (String(run.status || "").toLowerCase() !== "running") return false;
  const heartbeatAgeSeconds = Number(run.heartbeat_age_seconds);
  if (!Number.isFinite(heartbeatAgeSeconds)) return false;
  return heartbeatAgeSeconds > runHeartbeatStaleSeconds;
}

function statusWarnings({
  authWarning,
  roomAccessWarning,
  staleRunningRuns = [],
  staleQueuedRuns,
  orphanedRunningRuns = [],
  runHeartbeatStaleSeconds = DEFAULT_RUN_HEARTBEAT_STALE_SECONDS,
  queuedRunStaleSeconds,
  staleSeconds = 180,
  health,
  staleRunningHints = [],
  recoveryHints,
  orphanedRunningHints = [],
  agentIdConflicts = []
}) {
  const warnings = authWarning ? [authWarning] : [];
  if (roomAccessWarning) warnings.push(roomAccessWarning);
  if (agentIdConflicts.length) {
    const detail = agentIdConflicts
      .slice(0, 5)
      .map((item) => `${item.id} on ${(item.nodes || []).join(",") || item.count}`)
      .join("; ");
    warnings.push(`Duplicate online agent ids are registered; routing to those ids is blocked until each agent id is unique. ${detail}`);
  }
  const staleRunningCount = staleRunningRuns.length;
  if (staleRunningCount) {
    const cadenceMismatchRuns = staleRunningRuns.filter((run) => runHeartbeatThresholdBelowCadence(run, runHeartbeatStaleSeconds));
    const mismatchCount = cadenceMismatchRuns.length;
    const recommendedThresholdSeconds = recommendedHeartbeatThresholdSecondsForRuns(cadenceMismatchRuns);
    const roomNote = staleRunningHints?.length
      ? ` Example: ${staleRunningHints[0].inspect_command}`
      : "";
    if (mismatchCount && mismatchCount === staleRunningCount) {
      warnings.push(`Detected ${staleRunningCount} stale running room run${staleRunningCount === 1 ? "" : "s"} older than ${runHeartbeatStaleSeconds}s while the node still looks reachable, but the current stale-running threshold is lower than the configured heartbeat cadence for the affected edge${staleRunningCount === 1 ? "" : "s"}. Re-run status or room inspect with at least ${recommendedThresholdSeconds}s before treating this as heartbeat loss.${roomNote}`);
    } else {
      warnings.push(`Detected ${staleRunningCount} stale running room run${staleRunningCount === 1 ? "" : "s"} that has not reported a run heartbeat within ${runHeartbeatStaleSeconds}s while the node still looks reachable. Inspect the agent process or adapter session before waking that room again.${roomNote}`);
      if (mismatchCount) {
        warnings.push(`The current stale-running threshold (${runHeartbeatStaleSeconds}s) is lower than the configured heartbeat cadence for ${mismatchCount} affected run${mismatchCount === 1 ? "" : "s"}. Re-run status or room inspect with at least ${recommendedThresholdSeconds}s before treating those runs as heartbeat loss.`);
      }
    }
  }
  const orphanedCount = orphanedRunningRuns.length;
  if (orphanedCount) {
    const roomNote = orphanedRunningHints?.length
      ? ` Example: ${orphanedRunningHints[0].inspect_command}`
      : "";
    warnings.push(`Detected ${orphanedCount} orphaned running room run${orphanedCount === 1 ? "" : "s"} at the current ${staleSeconds}s node threshold. Inspect the stale or missing edge before waking that room again.${roomNote}`);
  }
  const count = staleQueuedRuns.length;
  if (count) {
    const queueNote = Number(health?.queued || 0) === 0 ? "; gateway queue is empty" : "";
    const roomNote = recoveryHints?.length
      ? ` Example: ${recoveryHints[0].inspect_command}`
      : "";
    warnings.push(`Ignored ${count} stale queued room run${count === 1 ? "" : "s"} older than ${queuedRunStaleSeconds}s${queueNote}. Inspect the old room before recovering or pausing it.${roomNote}`);
  }
  return warnings;
}

function applyStatusRoomDetailCoverage(result) {
  const meta = result?.status_meta?.room_details;
  if (!meta || Number(meta.active_total || 0) <= 0) return result;
  const warnings = Array.isArray(result.warnings) ? [...result.warnings] : [];
  const actions = Array.isArray(result.next_actions) ? [...result.next_actions] : [];
  const activeTotal = Number(meta.active_total || 0);
  const requested = Number(meta.requested || 0);
  const failed = Number(meta.failed || 0);
  const omitted = Number(meta.omitted || 0);
  const limit = Number(meta.limit || 0);
  if (meta.coverage === "skipped") {
    warnings.push(`Active room detail hydration was skipped for ${activeTotal} active room${activeTotal === 1 ? "" : "s"}. Busy/stale queued analysis falls back to summary-only room data until you rerun status without --no-room-details.`);
    actions.unshift("Rerun agent-bus status without --no-room-details before pausing or recovering an active room.");
  }
  if (meta.coverage !== "skipped" && omitted > 0) {
    const recommendedLimit = Math.min(activeTotal, 100);
    warnings.push(`Status inspected ${requested}/${activeTotal} active room detail${requested === 1 ? "" : "s"} because --room-detail-limit is ${limit}. Busy/stale queued analysis may be incomplete for ${omitted} active room${omitted === 1 ? "" : "s"}.`);
    actions.unshift(recommendedLimit > limit
      ? `Rerun agent-bus status with --room-detail-limit ${recommendedLimit} or inspect the omitted active rooms individually.`
      : "Inspect the omitted active rooms individually with agent-bus room inspect ROOM_ID.");
  }
  if (failed > 0) {
    warnings.push(`Status could not hydrate ${failed}/${requested} active room detail${requested === 1 ? "" : "s"} from the gateway. Busy/stale queued analysis may be incomplete for those rooms.`);
    actions.unshift("Inspect active rooms individually with agent-bus room inspect ROOM_ID if per-room status fetches keep failing.");
  }
  result.warnings = unique(warnings);
  result.next_actions = unique(actions).slice(0, 6);
  return result;
}

function agentActivity(activeRuns, activeRoomIds, orphanedRunningRuns = [], staleRunningRuns = []) {
  if (activeRuns.some((run) => String(run.status || "").toLowerCase() === "running")) return "running";
  if (activeRuns.some((run) => String(run.status || "").toLowerCase() === "queued")) return "queued";
  if (orphanedRunningRuns.length) return "orphaned-running";
  if (staleRunningRuns.length) return "stale-running";
  return activeRoomIds.length ? "busy/room-active" : "idle";
}

function unique(values) {
  return Array.from(new Set(values));
}

function agentObservationFields(agent) {
  const out = {};
  for (const [snake, camel] of [
    ["owner", "owner"],
    ["runtime", "runtime"],
    ["permission_profile", "permissionProfile"],
    ["cost_class", "costClass"],
    ["latency_class", "latencyClass"]
  ]) {
    const value = observationText(agent?.[snake] ?? agent?.[camel]);
    if (value) out[snake] = value;
  }
  for (const [snake, camel] of [
    ["allowed_rooms", "allowedRooms"],
    ["allowed_wake_targets", "allowedWakeTargets"]
  ]) {
    if (!hasObservationField(agent, snake, camel)) continue;
    out[snake] = observationList(agent?.[snake] ?? agent?.[camel]);
  }
  return out;
}

function hasObservationField(agent, snake, camel) {
  if (!agent || typeof agent !== "object") return false;
  return Object.prototype.hasOwnProperty.call(agent, snake) || Object.prototype.hasOwnProperty.call(agent, camel);
}

function permissionObservationSummary(agents = []) {
  const list = Array.isArray(agents) ? agents : [];
  const missingPermissionProfile = [];
  const unscopedWakeTargets = [];
  let withPermissionProfile = 0;
  let withAllowedWakeTargets = 0;
  for (const agent of list) {
    const id = String(agent?.id || "").trim();
    if (!id) continue;
    const profile = observationText(agent?.permission_profile ?? agent?.permissionProfile);
    const hasWakeTargets = hasObservationField(agent, "allowed_wake_targets", "allowedWakeTargets");
    if (profile) withPermissionProfile += 1;
    else missingPermissionProfile.push(id);
    if (hasWakeTargets) withAllowedWakeTargets += 1;
    else unscopedWakeTargets.push(id);
  }
  return {
    total_agents: list.filter((agent) => String(agent?.id || "").trim()).length,
    with_permission_profile: withPermissionProfile,
    missing_permission_profile: missingPermissionProfile,
    with_allowed_wake_targets: withAllowedWakeTargets,
    unscoped_wake_targets: unscopedWakeTargets
  };
}

function observationText(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 160) : "";
}

function observationList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return unique(raw.map(observationText).filter(Boolean)).slice(0, 64);
}

function agentIdConflicts(agents = []) {
  const byId = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    const id = String(agent?.id || "").trim();
    if (!id) continue;
    const item = byId.get(id) || { id, nodes: [], count: 0 };
    item.count += 1;
    const nodeId = String(agent?.node_id || agent?.nodeId || "").trim();
    if (nodeId && !item.nodes.includes(nodeId)) item.nodes.push(nodeId);
    byId.set(id, item);
  }
  return [...byId.values()]
    .filter((item) => item.count > 1)
    .map((item) => ({ ...item, nodes: item.nodes.sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
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
  console.log(`Gateway: nodes ${s.nodes}/${s.registered_nodes}, agents ${s.agents}/${s.registered_agents}, online ${s.online_agents}, busy ${s.busy_agents || 0}, duplicate_agents ${s.duplicate_agent_ids || 0}, stale_running ${s.stale_running_runs || 0}, orphaned_running ${s.orphaned_running_runs || 0}, queued ${s.queued}`);
  if (result.readiness) {
    console.log(`Readiness: ${result.readiness.status} (${result.readiness.level}) - ${result.readiness.message}`);
  }
  if (result.warnings?.length) {
    for (const warning of result.warnings) console.log(`Warning: ${warning}`);
  }
  if (result.next_actions?.length) {
    console.log("\nNext actions:");
    for (const action of result.next_actions) console.log(`- ${action}`);
  }
  if (result.orphaned_running_hints?.length) {
    console.log("\nOrphaned running hints:");
    for (const hint of result.orphaned_running_hints) {
      const pause = hint.pause_command ? `, pause=\`${hint.pause_command}\`` : "";
      console.log(`- ${hint.room_id}: inspect=\`${hint.inspect_command}\`${pause}, orphaned_runs=${hint.orphaned_running_runs.join(",") || "-"}`);
    }
  }
  if (result.stale_running_hints?.length) {
    console.log("\nStale running hints:");
    for (const hint of result.stale_running_hints) {
      const pause = hint.pause_command ? `, pause=\`${hint.pause_command}\`` : "";
      const adjust = hint.adjust_threshold_command ? `, threshold=\`${hint.adjust_threshold_command}\`` : "";
      const cadenceMismatch = hint.cadence_mismatch_runs?.length ? `, cadence_mismatch=${hint.cadence_mismatch_runs.join(",")}` : "";
      console.log(`- ${hint.room_id}: inspect=\`${hint.inspect_command}\`${pause}${adjust}, stale_running=${hint.stale_running_runs.join(",") || "-"}${cadenceMismatch}`);
    }
  }
  if (result.recovery_hints?.length) {
    console.log("\nRecovery hints:");
    for (const hint of result.recovery_hints) {
      const pause = hint.pause_command ? `, pause=\`${hint.pause_command}\`` : "";
      console.log(`- ${hint.room_id}: inspect=\`${hint.inspect_command}\`, recover=\`${hint.recover_command}\`${pause}, stale_runs=${hint.stale_queued_runs.join(",") || "-"}`);
    }
  }
  if (result.agent_id_conflicts?.length) {
    console.log("\nDuplicate agent ids:");
    for (const conflict of result.agent_id_conflicts) {
      console.log(`- ${conflict.id}: nodes=${(conflict.nodes || []).join(",") || "-"} count=${conflict.count || 0}`);
    }
  }
  if (result.permission_observations?.total_agents) {
    const p = result.permission_observations;
    console.log("\nPermission observations:");
    console.log(`- permission_profile: ${p.with_permission_profile || 0}/${p.total_agents || 0} agents`);
    console.log(`- allowed_wake_targets: ${p.with_allowed_wake_targets || 0}/${p.total_agents || 0} agents`);
    if (p.missing_permission_profile?.length) {
      console.log(`- missing permission_profile: ${p.missing_permission_profile.slice(0, 8).join(",")}${p.missing_permission_profile.length > 8 ? ",..." : ""}`);
    }
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
      const heartbeatEvery = positiveHeartbeatIntervalMs(agent.run_heartbeat_interval_ms) && (agent.activity === "running" || agent.activity === "stale-running")
        ? ` heartbeat_every=${formatHeartbeatCadence(agent.run_heartbeat_interval_ms)}`
        : "";
      const staleRunning = agent.stale_running_runs?.length ? ` stale_running=${agent.stale_running_runs.map((item) => item.id).join(",")}` : "";
      const staleQueued = agent.stale_queued_runs?.length ? ` stale_queued=${agent.stale_queued_runs.map((item) => item.id).join(",")}` : "";
      const orphanedRunning = agent.orphaned_running_runs?.length ? ` orphaned_running=${agent.orphaned_running_runs.map((item) => item.id).join(",")}` : "";
      const profile = ` profile=${agent.permission_profile || "unprofiled"}`;
      const wakeTargetValues = Array.isArray(agent.allowed_wake_targets)
        ? agent.allowed_wake_targets
        : Array.isArray(agent.allowedWakeTargets)
          ? agent.allowedWakeTargets
          : [];
      const wakeTargets = hasObservationField(agent, "allowed_wake_targets", "allowedWakeTargets")
        ? ` wake_targets=${wakeTargetValues.length ? wakeTargetValues.join(",") : "none"}`
        : "";
      console.log(`- ${agent.id}: node=${agent.freshness}, activity=${agent.activity}, ping=${agent.ping_label}, last_run=${agent.last_run_health}${profile}${wakeTargets}${seen}${active}${run}${heartbeatEvery}${staleRunning}${staleQueued}${orphanedRunning}`);
    }
  }
  if (result.rooms.length) {
    console.log("\nRecent rooms:");
    for (const room of result.rooms) {
      const activeRuns = room.active_runs?.length ? ` active_runs=${room.active_runs.join(",")}` : "";
      const staleRunning = room.stale_running_runs?.length ? ` stale_running=${room.stale_running_runs.join(",")}` : "";
      const staleQueued = room.stale_queued_runs?.length ? ` stale_queued=${room.stale_queued_runs.join(",")}` : "";
      const orphanedRunning = room.orphaned_running_runs?.length ? ` orphaned_running=${room.orphaned_running_runs.join(",")}` : "";
      console.log(`- ${room.id}: ${room.status}, agents=${room.agents.join(",") || "-"}, updated=${room.updated_at || "-"}${activeRuns}${staleRunning}${staleQueued}${orphanedRunning}`);
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
    permission_profile: "local-model",
    allowed_wake_targets: [],
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

function defaultClaudeCodeCommand() {
  return "claude";
}

function commonHermesPaths() {
  const paths = [path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "hermes.exe" : "hermes")];
  if (process.platform !== "win32") paths.push("/root/.local/bin/hermes");
  return paths;
}

function commonClaudeCodePaths() {
  const binary = process.platform === "win32" ? "claude.cmd" : "claude";
  const home = os.homedir();
  const paths = [
    path.join(home, ".local", "bin", binary),
    path.join(home, ".claude", "bin", binary)
  ];
  if (process.platform !== "win32") {
    paths.push("/usr/local/bin/claude");
    const npmGlobal = process.env.NPM_CONFIG_PREFIX || path.join(home, ".npm-global");
    paths.push(path.join(npmGlobal, "bin", "claude"));
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    paths.push(path.join(appData, "npm", "claude.cmd"));
  }
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

function shellCommandTokens(commandText) {
  return String(commandText || "").match(/"[^"]+"|'[^']+'|\S+/g) || [];
}

function configuredExecutable(commandText) {
  const tokens = shellCommandTokens(commandText);
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

function resolveGatewayRequestContext(args = []) {
  const config = loadGatewayQueryConfig(optionValue(args, "--config"));
  return {
    config,
    gateway: optionValue(args, "--gateway")
      || process.env.AGENT_BUS_GATEWAY_URL
      || config?.gatewayUrl
      || "http://127.0.0.1:8788",
    token: optionValue(args, "--token")
      || process.env.AGENT_BUS_TOKEN
      || config?.token
      || ""
  };
}

function loadGatewayQueryConfig(configPath) {
  if (!configPath) return null;
  const resolved = path.resolve(expandHome(configPath));
  if (gatewayQueryConfigCache.has(resolved)) return gatewayQueryConfigCache.get(resolved);
  let config;
  try {
    config = readJsonFile(resolved);
  } catch (err) {
    throw new Error(`Failed to read --config ${resolved}: ${err.message || String(err)}`);
  }
  if (!isPlainObject(config)) {
    throw new Error(`Failed to read --config ${resolved}: config must be a JSON object.`);
  }
  const mode = inferDoctorMode(config);
  const context = {
    path: resolved,
    mode,
    gatewayUrl: String(config.gatewayUrl || (mode === "central" ? localCentralGatewayUrl(config) : "") || "").trim(),
    token: String(config.token || "").trim(),
    tokenScope: String(config.tokenScope || config.token_scope || "").trim()
  };
  gatewayQueryConfigCache.set(resolved, context);
  return context;
}

async function gatewayJson(pathname, options = {}) {
  const args = options.args || argv;
  const request = resolveGatewayRequestContext(args);
  const gateway = request.gateway;
  const token = request.token;
  if (options.auth && !token) {
    throw new Error("This endpoint requires --token, AGENT_BUS_TOKEN, or --config with a token-bearing config.");
  }
  const url = gatewayEndpoint(gateway, pathname);
  const timeoutMs = positiveIntegerOption(
    optionValue(args, "--gateway-timeout-ms") || process.env.AGENT_BUS_GATEWAY_TIMEOUT_MS,
    10000,
    120000
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" })
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Gateway request timed out after ${timeoutMs}ms: ${url}. Check --gateway, AGENT_BUS_GATEWAY_URL, firewall/NAT, or run agent-bus doctor --local-only for offline checks.`);
    }
    throw new Error(`Gateway request failed: ${url}. ${err?.message || err}. Check --gateway, AGENT_BUS_GATEWAY_URL, and whether Central is running.`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}${text ? `: ${trimOneLine(text)}` : ""}`);
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

function isUnauthorizedGatewayError(err) {
  return [401, 403].includes(httpStatusFromError(err?.message || err));
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
  const rawPath = String(pathname || "");
  const queryIndex = rawPath.indexOf("?");
  const pathOnly = queryIndex === -1 ? rawPath : rawPath.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : rawPath.slice(queryIndex + 1);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${pathOnly}`.replace(/\/{2,}/g, "/");
  if (query) url.search = query;
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

function runHeartbeatStaleOption(args) {
  return optionValue(args, "--run-heartbeat-stale-seconds")
    || optionValue(args, "--running-run-stale-seconds")
    || process.env.AGENT_BUS_STATUS_RUN_HEARTBEAT_STALE_SECONDS
    || process.env.AGENT_BUS_RUNNING_RUN_STALE_SECONDS;
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

function hasAnyOption(args, names) {
  return names.some((name) => args.includes(name));
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
