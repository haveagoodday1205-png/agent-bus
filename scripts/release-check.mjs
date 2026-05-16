import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const steps = [];
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

const jsFiles = [
  "agent-bus.mjs",
  "central-gateway.mjs",
  "edge-node.mjs",
  "console/app.js",
  "mock-openai-backend.mjs",
  "windows-openai-proxy.mjs",
  "sdk/js/agent-bus-sdk.mjs",
  "scripts/demo-zero-token.mjs",
  "scripts/demo-local.mjs",
  "scripts/demo-starter.mjs",
  "scripts/demo-agent-model.mjs",
  "scripts/demo-room.mjs",
  "scripts/demo-issue-pr.mjs",
  "scripts/compatibility-smoke.mjs",
  "scripts/doctor-smoke.mjs",
  "scripts/diagnostics-redaction-smoke.mjs",
  "scripts/telegram-plugin-smoke.mjs",
  "scripts/telegram-commands.mjs",
  "scripts/telegram-poller.mjs",
  "scripts/compose-smoke.mjs",
  "scripts/conformance-ci-smoke.mjs",
  "scripts/adapter-preset-smoke.mjs",
  "scripts/setup-join-smoke.mjs",
  "scripts/edge-token-api-smoke.mjs",
  "scripts/edge-completion-outbox-smoke.mjs",
  "scripts/python-edge-completion-outbox-smoke.mjs",
  "scripts/edge-poll-disconnect-smoke.mjs",
  "scripts/node-poll-disconnect-smoke.mjs",
  "scripts/edge-poll-timeout-smoke.mjs",
  "scripts/trace-smoke.mjs",
  "scripts/central-restart-smoke.mjs",
  "scripts/duplicate-complete-smoke.mjs",
  "scripts/python-edge-heartbeat-smoke.mjs",
  "scripts/python-sdk-smoke.mjs",
  "scripts/python-room-agent-smoke.mjs",
  "scripts/room-replay-fixture-check.mjs",
  "scripts/room-autonomy-stale-smoke.mjs",
  "scripts/room-supervisor-smoke.mjs",
  "scripts/room-prompt-compaction-smoke.mjs",
  "scripts/room-memory-cache-smoke.mjs",
  "scripts/cache-session-smoke.mjs",
  "scripts/claudecode-bridge-smoke.mjs",
  "scripts/hermes-bridge-smoke.mjs",
  "scripts/openclaw-bridge-smoke.mjs",
  "scripts/make-portable-release.mjs",
  "scripts/offline-smoke.mjs",
  "scripts/npm-install-smoke.mjs",
  "scripts/verify-protocol-v1.mjs",
  "scripts/protocol-conformance.mjs",
  "scripts/verify-conformance-result-schema.mjs",
  "scripts/verify-package.mjs",
  "scripts/verify-portable-release.mjs",
  "scripts/release-check.mjs",
  "scripts/release-notes.mjs",
  "scripts/release-preflight.mjs",
  "examples/js-room-replay/room_replay_example.mjs",
  "examples/no-quota-room-replay/run.mjs"
];

try {
  for (const file of jsFiles) {
    step(`node --check ${file}`, process.execPath, ["--check", file]);
  }

  const bash = process.env.BASH || resolveCommand("bash");
  if (bash) {
    step("bash wrapper syntax", bash, ["-n", "scripts/hermes-agent-bus.sh", "scripts/openclaw-agent-bus.sh", "scripts/claudecode-agent-bus.sh"]);
  }

  const python = process.env.AGENT_BUS_PYTHON || process.env.PYTHON || resolveCommand("python3") || resolveCommand("python") || (process.platform === "win32" ? "python" : "python3");
  step("python py_compile", python, ["-m", "py_compile", "central_gateway.py", "edge_node.py", "sdk/python/agent_bus_sdk.py", "sdk/python/__init__.py", "examples/room-agent-python/room_agent.py", "examples/python-agent-model/agent_model_example.py"]);
  step("protocol v1 verification", process.execPath, ["scripts/verify-protocol-v1.mjs"]);
  const conformanceArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-conformance-artifacts-"));
  step("protocol conformance", process.execPath, ["scripts/protocol-conformance.mjs", "--json", "--artifact-dir", conformanceArtifactDir]);
  requireFile(path.join(conformanceArtifactDir, "agent-bus-conformance.json"));
  requireFile(path.join(conformanceArtifactDir, "agent-bus-conformance.md"));
  requireFile(path.join(conformanceArtifactDir, "agent-bus-conformance-badge.json"));
  step("conformance result schema", process.execPath, ["scripts/verify-conformance-result-schema.mjs", "--artifact-dir", conformanceArtifactDir, "--json"]);
  fs.rmSync(conformanceArtifactDir, { recursive: true, force: true });
  const helloAgentCommand = `${quoteCommandArg(process.execPath)} ${quoteCommandArg(path.join(root, "examples", "hello-agent", "hello-agent.mjs"))}`;
  step("protocol adapter-command conformance", process.execPath, ["scripts/protocol-conformance.mjs", "--json", "--profile", "adapter-command", "--agent-command", helloAgentCommand, "--agent-id", "adapter-conformance"]);
  step("zero-token local demo", process.execPath, ["scripts/demo-zero-token.mjs", "--json"]);
  step("starter kit demo", process.execPath, ["scripts/demo-starter.mjs", "--json"]);
  step("doctor smoke", process.execPath, ["scripts/doctor-smoke.mjs", "--json"]);
  step("diagnostics redaction smoke", process.execPath, ["scripts/diagnostics-redaction-smoke.mjs", "--json"]);
  step("telegram plugin smoke", process.execPath, ["scripts/telegram-plugin-smoke.mjs", "--json"]);
  step("compose preflight smoke", process.execPath, ["scripts/compose-smoke.mjs", "--json"]);
  step("conformance CI smoke", process.execPath, ["scripts/conformance-ci-smoke.mjs", "--json"]);
  step("adapter preset smoke", process.execPath, ["scripts/adapter-preset-smoke.mjs", "--json"]);
  step("setup join smoke", process.execPath, ["scripts/setup-join-smoke.mjs", "--json"]);
  step("edge token API smoke", process.execPath, ["scripts/edge-token-api-smoke.mjs", "--json"]);
  step("edge completion outbox smoke", process.execPath, ["scripts/edge-completion-outbox-smoke.mjs", "--json"]);
  step("python edge completion outbox smoke", process.execPath, ["scripts/python-edge-completion-outbox-smoke.mjs", "--json"]);
  step("edge poll disconnect smoke", process.execPath, ["scripts/edge-poll-disconnect-smoke.mjs", "--json"]);
  step("Node edge poll disconnect smoke", process.execPath, ["scripts/node-poll-disconnect-smoke.mjs", "--json"]);
  step("edge poll timeout smoke", process.execPath, ["scripts/edge-poll-timeout-smoke.mjs", "--json"]);
  step("trace smoke", process.execPath, ["scripts/trace-smoke.mjs", "--json"]);
  step("central restart smoke", process.execPath, ["scripts/central-restart-smoke.mjs", "--json"]);
  step("duplicate complete smoke", process.execPath, ["scripts/duplicate-complete-smoke.mjs", "--json"]);
  step("python edge heartbeat smoke", process.execPath, ["scripts/python-edge-heartbeat-smoke.mjs", "--json"]);
  step("python SDK smoke", process.execPath, ["scripts/python-sdk-smoke.mjs", "--json"]);
  step("python room-agent smoke", process.execPath, ["scripts/python-room-agent-smoke.mjs", "--json"]);
  step("python agent-model example", python, ["examples/python-agent-model/agent_model_example.py"]);
  step("room replay fixture compatibility", process.execPath, ["scripts/room-replay-fixture-check.mjs", "--json"]);
  step("JS room replay example", process.execPath, ["examples/js-room-replay/room_replay_example.mjs", "--json"]);
  step("no-quota room replay golden path", process.execPath, ["examples/no-quota-room-replay/run.mjs", "--json"]);
  step("hello-agent compatibility smoke", process.execPath, ["scripts/compatibility-smoke.mjs", "--json"]);
  step("agent-backed model demo", process.execPath, ["scripts/demo-agent-model.mjs", "--json"]);
  step("offline room smoke", process.execPath, ["scripts/offline-smoke.mjs", "--json"]);
  step("stale room autonomy smoke", process.execPath, ["scripts/room-autonomy-stale-smoke.mjs", "--json"]);
  step("room supervisor smoke", process.execPath, ["scripts/room-supervisor-smoke.mjs", "--json"]);
  step("room prompt compaction smoke", process.execPath, ["scripts/room-prompt-compaction-smoke.mjs", "--json"]);
  step("room memory cache smoke", process.execPath, ["scripts/room-memory-cache-smoke.mjs", "--json"]);
  step("cache session smoke", process.execPath, ["scripts/cache-session-smoke.mjs", "--json"]);
  step("claudecode bridge smoke", process.execPath, ["scripts/claudecode-bridge-smoke.mjs"]);
  step("hermes bridge smoke", process.execPath, ["scripts/hermes-bridge-smoke.mjs"]);
  step("openclaw bridge smoke", process.execPath, ["scripts/openclaw-bridge-smoke.mjs"]);
  step("npm package verification", process.execPath, ["scripts/verify-package.mjs"]);
  step("portable bundle verification", process.execPath, ["scripts/verify-portable-release.mjs"]);
  step("release notes generation", process.execPath, ["scripts/release-notes.mjs"]);

  printResult({ ok: true, steps });
} catch (error) {
  printResult({ ok: false, error: error.message, steps });
  process.exitCode = 1;
}

function step(name, command, args) {
  const started = Date.now();
  const result = run(command, args);
  steps.push({
    name,
    ok: true,
    ms: Date.now() - started,
    stdout: compact(result.stdout)
  });
  if (!jsonOut) console.log(`ok ${name}`);
}

function run(command, args) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: releaseStepEnv({ npm_config_loglevel: "error" })
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function commandInvocation(command, args) {
  if (process.platform === "win32" && /\.cmd$/i.test(String(command))) {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", command, ...args]
    };
  }
  return { command, args };
}

function resolveCommand(command) {
  const text = String(command || "");
  if (!text) return "";
  if (path.isAbsolute(text) || text.includes("/") || text.includes("\\")) {
    return fs.existsSync(text) ? text : "";
  }
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" && !path.extname(text)
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of pathDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${text}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function requireFile(file) {
  if (!fs.existsSync(file)) throw new Error(`Expected release artifact was not created: ${file}`);
}

function releaseStepEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

function compact(text) {
  const value = String(text || "").trim();
  return value.length > 800 ? `${value.slice(0, 800)}...` : value;
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  if (/^[A-Za-z0-9_/:=.,+@%-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function printResult(result) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.ok) {
    console.log(`release check ok (${result.steps.length} steps)`);
  } else {
    console.error(`release check failed: ${result.error}`);
  }
}
