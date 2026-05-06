import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const steps = [];

const jsFiles = [
  "agent-bus.mjs",
  "central-gateway.mjs",
  "edge-node.mjs",
  "mock-openai-backend.mjs",
  "windows-openai-proxy.mjs",
  "scripts/demo-local.mjs",
  "scripts/demo-room.mjs",
  "scripts/make-portable-release.mjs",
  "scripts/offline-smoke.mjs",
  "scripts/verify-package.mjs",
  "scripts/verify-portable-release.mjs",
  "scripts/release-check.mjs"
];

try {
  for (const file of jsFiles) {
    step(`node --check ${file}`, process.execPath, ["--check", file]);
  }

  const python = process.env.PYTHON || resolveCommand("python3") || resolveCommand("python") || (process.platform === "win32" ? "python" : "python3");
  step("python py_compile", python, ["-m", "py_compile", "central_gateway.py", "edge_node.py"]);
  step("offline room smoke", process.execPath, ["scripts/offline-smoke.mjs", "--json"]);
  step("npm package verification", process.execPath, ["scripts/verify-package.mjs"]);
  step("portable bundle verification", process.execPath, ["scripts/verify-portable-release.mjs"]);

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
    env: { ...process.env, npm_config_loglevel: "error" }
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
