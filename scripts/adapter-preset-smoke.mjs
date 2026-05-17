import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-adapter-preset-smoke-"));

try {
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ["codex", "openclaw", "hermes", "ollama", "claude"]) {
    writeFakeExecutable(binDir, name);
  }

  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    AGENT_BUS_OLLAMA_MODEL: "adapter-smoke-llama",
    OPENCLAW_AGENT_COMMAND: ""
  };
  delete env.AGENT_BUS_GATEWAY_URL;
  delete env.AGENT_BUS_TOKEN;

  const detect = runJson(["detect", "--json"], env);
  const detected = new Map((detect.tools || []).map((tool) => [tool.id, tool]));
  for (const id of ["codex", "openclaw", "hermes", "claudecode", "ollama"]) {
    assert(detected.get(id)?.available === true, `detect did not find fake ${id}`);
  }
  if (process.platform !== "win32") {
    assert(/bundled Codex Agent Bus bridge/.test(detected.get("codex")?.note || ""), "codex detection did not prefer the bridge script");
  }
  assert(/Using bundled\/openclaw bridge script/.test(detected.get("openclaw")?.note || ""), "openclaw detection did not prefer the bridge script");
  if (process.platform !== "win32") {
    assert(/bundled Hermes Agent Bus bridge/.test(detected.get("hermes")?.note || ""), "hermes detection did not prefer the bridge script");
    assert(/bundled Claude Code Agent Bus bridge/.test(detected.get("claudecode")?.note || ""), "claudecode detection did not prefer the bridge script");
  }

  const out = path.join(tempDir, "edge.config.json");
  runCli([
    "init",
    "edge",
    "--auto",
    "--tools",
    "codex,openclaw,hermes,claudecode,ollama",
    "--gateway",
    "https://example.test/agent-bus",
    "--token",
    "abt_edge_adapter_preset_smoke_token_000000",
    "--out",
    out
  ], env);

  const config = JSON.parse(fs.readFileSync(out, "utf8"));
  assert(config.tokenScope === "edge", "generated edge config did not declare edge token scope");
  assert(config.gatewayUrl === "https://example.test/agent-bus", "generated edge config did not preserve gateway URL");
  assert(config.token === "abt_edge_adapter_preset_smoke_token_000000", "generated edge config did not preserve token");
  const agents = new Map(config.agents.map((agent) => [agent.kind, agent]));
  for (const kind of ["codex", "openclaw", "hermes", "claudecode", "ollama"]) {
    assert(agents.has(kind), `generated config missing ${kind} agent`);
  }

  const codex = agents.get("codex");
  assert(codex.role === "coder", "codex preset has wrong role");
  assertPresetObservations(codex, "coder", "codex-cli");
  if (process.platform === "win32") {
    assert(codex.runCommand.includes(" exec "), "codex Windows preset must use codex exec");
    assert(codex.runCommand.includes("--color never"), "codex Windows preset should disable color");
    assert(codex.runCommand.includes("AGENT_MESSAGE"), "codex Windows preset must pass AGENT_MESSAGE");
  } else {
    assert(codex.runCommand.includes("CODEX_COMMAND="), "codex preset must bind CODEX_COMMAND");
    assert(codex.runCommand.includes("codex-agent-bus.sh"), "codex preset must use the bridge script when available");
  }

  const openclaw = agents.get("openclaw");
  assert(openclaw.role === "executor", "openclaw preset has wrong role");
  assertPresetObservations(openclaw, "operator-browser", "openclaw-cli");
  assert(openclaw.runCommand.includes("OPENCLAW_AGENT_ID=agent-bus"), "openclaw preset must use the dedicated Agent Bus agent id");
  assert(openclaw.runCommand.includes("openclaw-agent-bus.sh"), "openclaw preset must use the bridge script when available");
  assert(openclaw.capabilities.includes("browser"), "openclaw preset should advertise browser capability");

  const hermes = agents.get("hermes");
  assert(hermes.role === "researcher", "hermes preset has wrong role");
  assertPresetObservations(hermes, "research-readonly", "hermes-cli");
  if (process.platform === "win32") {
    assert(hermes.runCommand.includes(" chat -q "), "hermes Windows preset must use hermes chat");
    assert(hermes.runCommand.includes("AGENT_MESSAGE"), "hermes Windows preset must pass AGENT_MESSAGE");
  } else {
    assert(hermes.runCommand.includes("HERMES_COMMAND="), "hermes preset must bind HERMES_COMMAND");
    assert(hermes.runCommand.includes("hermes-agent-bus.sh"), "hermes preset must use the bridge script when available");
  }
  assert(hermes.capabilities.includes("memory"), "hermes preset should advertise memory capability");

  const claudecode = agents.get("claudecode");
  assert(claudecode.role === "coder", "claudecode preset has wrong role");
  assertPresetObservations(claudecode, "coder", "claude-code-cli");
  assert(claudecode.healthCommand.includes("--version"), "claudecode preset should include a shallow CLI health command");
  if (process.platform === "win32") {
    assert(claudecode.runCommand.includes(" --print "), "claudecode Windows preset must use claude --print");
    assert(claudecode.runCommand.includes("--permission-mode acceptEdits"), "claudecode Windows preset must use a noninteractive edit-friendly mode");
    assert(claudecode.runCommand.includes("AGENT_MESSAGE"), "claudecode Windows preset must pass AGENT_MESSAGE");
  } else {
    assert(claudecode.runCommand.includes("CLAUDECODE_COMMAND="), "claudecode preset must bind CLAUDECODE_COMMAND");
    assert(claudecode.runCommand.includes("claudecode-agent-bus.sh"), "claudecode preset must use the bridge script when available");
  }
  assert(claudecode.capabilities.includes("agent"), "claudecode preset should advertise agent capability");

  const ollama = agents.get("ollama");
  assert(ollama.role === "model", "ollama preset has wrong role");
  assertPresetObservations(ollama, "local-model", "ollama");
  assert(ollama.runCommand.includes(" run "), "ollama preset must call ollama run");
  assert(ollama.runCommand.includes("adapter-smoke-llama"), "ollama preset did not use AGENT_BUS_OLLAMA_MODEL");
  assert(ollama.pingUrl === "http://127.0.0.1:11434/api/tags", "ollama preset must use a shallow tags ping URL");

  const presets = {};
  for (const preset of ["echo", "codex", "openclaw", "hermes", "claudecode", "ollama"]) {
    const presetOut = path.join(tempDir, `${preset}.config.json`);
    runCli(["init", "edge", "--preset", preset, "--out", presetOut], env);
    const presetConfig = JSON.parse(fs.readFileSync(presetOut, "utf8"));
    presets[preset] = presetConfig.agents?.[0]?.kind || "";
  }
  assert(presets.echo === "echo", "echo preset changed kind");
  assert(presets.codex === "codex", "codex preset changed kind");
  assert(presets.openclaw === "openclaw", "openclaw preset changed kind");
  assert(presets.hermes === "hermes", "hermes preset changed kind");
  assert(presets.claudecode === "claudecode", "claudecode preset changed kind");
  assert(presets.ollama === "ollama", "ollama preset changed kind");

  const result = {
    ok: true,
    quota: "no_model_calls",
    detected: [...detected.values()].filter((tool) => tool.available).map((tool) => tool.id),
    generated_agents: config.agents.map((agent) => ({ id: agent.id, kind: agent.kind, role: agent.role })),
    presets
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("adapter preset smoke ok");
    console.log(`Generated agents: ${result.generated_agents.map((agent) => `${agent.kind}:${agent.id}`).join(", ")}`);
  }
} catch (error) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  } else {
    console.error(error.stack || error.message || String(error));
  }
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function assertPresetObservations(agent, permissionProfile, runtime) {
  assert(agent.owner === "edge-operator", `${agent.id} preset should include owner observation`);
  assert(agent.runtime === runtime, `${agent.id} preset should include runtime observation`);
  assert(agent.permission_profile === permissionProfile, `${agent.id} preset should include permission_profile observation`);
  assert(agent.cost_class, `${agent.id} preset should include cost_class observation`);
  assert(agent.latency_class === "interactive", `${agent.id} preset should include latency_class observation`);
  assert(Array.isArray(agent.allowed_rooms) && agent.allowed_rooms.includes("room_*"), `${agent.id} preset should include allowed_rooms observation`);
  assert(Array.isArray(agent.allowed_wake_targets), `${agent.id} preset should include allowed_wake_targets observation`);
}

function writeFakeExecutable(binDir, name) {
  if (process.platform === "win32") {
    const file = path.join(binDir, `${name}.cmd`);
    fs.writeFileSync(file, `@echo off\r\nif "%1"=="--version" echo ${name} adapter-smoke 0.0.0\r\n`);
    return file;
  }
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/usr/bin/env sh\nif [ "$1" = "--version" ]; then echo "${name} adapter-smoke 0.0.0"; fi\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runCli(args, env) {
  const result = spawnSync(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-bus ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function runJson(args, env) {
  const stdout = runCli(args, env);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`agent-bus ${args.join(" ")} did not return JSON: ${error.message}\n${stdout}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
