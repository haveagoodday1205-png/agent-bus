import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
  "AGENT_BUS_DATA_DIR"
];

const jsFiles = [
  "agent-bus.mjs",
  "central-gateway.mjs",
  "edge-node.mjs",
  "mock-openai-backend.mjs",
  "windows-openai-proxy.mjs",
  "sdk/js/agent-bus-sdk.mjs",
  "scripts/demo-local.mjs",
  "scripts/demo-starter.mjs",
  "scripts/demo-agent-model.mjs",
  "scripts/demo-room.mjs",
  "scripts/demo-issue-pr.mjs",
  "scripts/compatibility-smoke.mjs",
  "scripts/doctor-smoke.mjs",
  "scripts/diagnostics-redaction-smoke.mjs",
  "scripts/compose-smoke.mjs",
  "scripts/adapter-preset-smoke.mjs",
  "scripts/trace-smoke.mjs",
  "scripts/central-restart-smoke.mjs",
  "scripts/python-sdk-smoke.mjs",
  "scripts/python-room-agent-smoke.mjs",
  "scripts/room-autonomy-stale-smoke.mjs",
  "scripts/room-prompt-compaction-smoke.mjs",
  "scripts/make-portable-release.mjs",
  "scripts/offline-smoke.mjs",
  "scripts/npm-install-smoke.mjs",
  "scripts/verify-protocol-v1.mjs",
  "scripts/verify-package.mjs",
  "scripts/verify-portable-release.mjs",
  "scripts/release-check.mjs",
  "scripts/release-notes.mjs",
  "scripts/release-preflight.mjs",
  "examples/js-room-replay/room_replay_example.mjs"
];

try {
  for (const file of jsFiles) {
    step(`node --check ${file}`, process.execPath, ["--check", file]);
  }

  const python = process.env.AGENT_BUS_PYTHON || process.env.PYTHON || resolveCommand("python3") || resolveCommand("python") || (process.platform === "win32" ? "python" : "python3");
  step("python py_compile", python, ["-m", "py_compile", "central_gateway.py", "edge_node.py", "sdk/python/agent_bus_sdk.py", "sdk/python/__init__.py", "examples/room-agent-python/room_agent.py", "examples/python-agent-model/agent_model_example.py"]);
  step("protocol v1 verification", process.execPath, ["scripts/verify-protocol-v1.mjs"]);
  step("starter kit demo", process.execPath, ["scripts/demo-starter.mjs", "--json"]);
  step("doctor smoke", process.execPath, ["scripts/doctor-smoke.mjs", "--json"]);
  step("diagnostics redaction smoke", process.execPath, ["scripts/diagnostics-redaction-smoke.mjs", "--json"]);
  step("compose preflight smoke", process.execPath, ["scripts/compose-smoke.mjs", "--json"]);
  step("adapter preset smoke", process.execPath, ["scripts/adapter-preset-smoke.mjs", "--json"]);
  step("trace smoke", process.execPath, ["scripts/trace-smoke.mjs", "--json"]);
  step("central restart smoke", process.execPath, ["scripts/central-restart-smoke.mjs", "--json"]);
  step("python SDK smoke", process.execPath, ["scripts/python-sdk-smoke.mjs", "--json"]);
  step("python room-agent smoke", process.execPath, ["scripts/python-room-agent-smoke.mjs", "--json"]);
  step("python agent-model example", python, ["examples/python-agent-model/agent_model_example.py"]);
  step("JS room replay example", process.execPath, ["examples/js-room-replay/room_replay_example.mjs", "--json"]);
  step("hello-agent compatibility smoke", process.execPath, ["scripts/compatibility-smoke.mjs", "--json"]);
  step("agent-backed model demo", process.execPath, ["scripts/demo-agent-model.mjs", "--json"]);
  step("offline room smoke", process.execPath, ["scripts/offline-smoke.mjs", "--json"]);
  step("stale room autonomy smoke", process.execPath, ["scripts/room-autonomy-stale-smoke.mjs", "--json"]);
  step("room prompt compaction smoke", process.execPath, ["scripts/room-prompt-compaction-smoke.mjs", "--json"]);
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

function releaseStepEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

function compact(text) {
  const value = String(text || "").trim();
  return value.length > 800 ? `${value.slice(0, 800)}...` : value;
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
