#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const args = process.argv.slice(2);
const json = args.includes("--json");
const keep = args.includes("--keep");
const packageSpec = optionValue(args, "--package") || `${pkg.name}@${pkg.version}`;
const timeoutMs = Number(optionValue(args, "--timeout-ms") || 180000);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-npm-install-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const binName = process.platform === "win32" ? "agent-bus.cmd" : "agent-bus";
const binPath = process.platform === "win32" ? path.join(tempDir, binName) : path.join(tempDir, "bin", binName);
const results = [];

try {
  step("npm install -g", npm, ["install", "-g", "--prefix", tempDir, "--no-audit", "--no-fund", packageSpec]);
  assert(fs.existsSync(binPath), `installed agent-bus binary was not found at ${binPath}`);
  const help = step("agent-bus --help", binPath, ["--help"]);
  assert(help.stdout.includes("agent-bus smoke --offline"), "installed CLI help is missing smoke command");
  const smoke = step("agent-bus smoke --offline", binPath, ["smoke", "--offline", "--json"]);
  const smokeJson = parseLastJson(smoke.stdout);
  assert(smokeJson?.ok === true, "installed CLI offline smoke did not report ok=true");
  const summary = { ok: true, package: packageSpec, prefix: keep ? tempDir : undefined, checks: results };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`Agent Bus npm install smoke passed for ${packageSpec}`);
} catch (err) {
  const summary = { ok: false, package: packageSpec, prefix: keep ? tempDir : undefined, error: err.message || String(err), checks: results };
  if (json) console.log(JSON.stringify(summary, null, 2));
  else console.error(`Agent Bus npm install smoke failed: ${summary.error}`);
  process.exitCode = 1;
} finally {
  if (!keep) fs.rmSync(tempDir, { recursive: true, force: true });
}

function step(name, command, stepArgs) {
  const startedAt = Date.now();
  const result = spawnSync(command, stepArgs, {
    cwd: repoRoot,
    env: smokeEnv(),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 20
  });
  const entry = {
    name,
    command: displayCommand(command, stepArgs),
    status: result.status,
    signal: result.signal,
    duration_ms: Date.now() - startedAt
  };
  results.push(entry);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`${name} exited ${result.status}${stderr ? `: ${stderr.slice(0, 2000)}` : ""}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

function smokeEnv() {
  return {
    ...process.env,
    AGENT_BUS_TOKEN: "",
    AGENT_BUS_GATEWAY_URL: "",
    OPENAI_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    AGENT_BUS_SMOKE_NO_MODEL_CALLS: "1"
  };
}

function optionValue(values, name) {
  const index = values.indexOf(name);
  if (index === -1) return "";
  return values[index + 1] || "";
}

function parseLastJson(text) {
  const trimmed = text.trim();
  const start = trimmed.lastIndexOf("{\n");
  if (start === -1) return null;
  return JSON.parse(trimmed.slice(start));
}

function displayCommand(command, stepArgs) {
  return [command, ...stepArgs].map((part) => String(part).includes(" ") ? JSON.stringify(part) : String(part)).join(" ");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
