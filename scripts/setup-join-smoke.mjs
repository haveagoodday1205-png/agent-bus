#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-setup-join-"));

try {
  const centralConfig = path.join(tempDir, "central.config.json");
  const centralService = path.join(tempDir, "agent-bus-central.service");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const gateway = "https://central.example/agent-bus";
  const central = run([
    "setup",
    "central",
    "--gateway",
    gateway,
    "--out",
    centralConfig,
    "--service",
    "systemd",
    "--service-out",
    centralService,
    "--preset",
    "echo"
  ]);
  const centralJson = JSON.parse(fs.readFileSync(centralConfig, "utf8"));
  const edgeToken = centralJson.edgeTokens?.[0]?.token || "";
  assert(centralJson.gatewayUrl === gateway, "central setup did not persist gatewayUrl");
  assert(String(centralJson.token || "").startsWith("abt_admin_"), "central setup did not generate admin token");
  assert(edgeToken.startsWith("abt_edge_"), "central setup did not generate first edge token");
  assert(central.stdout.includes("first edge token:"), "central setup did not print first edge token");
  assert(central.stdout.includes(`agent-bus setup edge --gateway ${gateway} --token ${edgeToken}`), "central setup did not print direct edge join command");
  const centralServiceText = fs.readFileSync(centralService, "utf8");
  assert(/ExecStart=/.test(centralServiceText), "central setup did not write a service ExecStart");
  const centralExecStart = serviceExecStart(centralServiceText);
  assert(/agent-bus\.mjs/.test(centralExecStart), "central setup service should use the current CLI script when --agent-bus-path is omitted");
  assert(!/[/\\]agent-bus(\s|")/.test(centralExecStart.replace(/agent-bus\.mjs/g, "")), "central setup service should not point at a guessed agent-bus executable");

  const edgeSetup = run([
    "setup",
    "edge",
    "--gateway",
    gateway,
    "--token",
    edgeToken,
    "--node-id",
    "setup-smoke-edge",
    "--preset",
    "echo",
    "--out",
    edgeConfig,
    "--skip-doctor"
  ]);
  const edgeJson = JSON.parse(fs.readFileSync(edgeConfig, "utf8"));
  assert(edgeJson.gatewayUrl === gateway, "edge setup did not persist gatewayUrl");
  assert(edgeJson.token === edgeToken, "edge setup did not persist edge token");
  assert(edgeJson.nodeId === "setup-smoke-edge", "edge setup did not honor --node-id");
  assert(edgeJson.tokenScope === "edge", "edge setup should mark tokenScope=edge");
  assert(edgeJson.agents?.[0]?.permission_profile === "local-demo", "edge setup did not include a permission_profile observation field");
  assert(edgeJson.agents?.[0]?.allowed_wake_targets?.includes("local-echo"), "edge setup did not include allowed_wake_targets observation field");
  assert(edgeSetup.stdout.includes("Node id: setup-smoke-edge"), "edge setup did not print the configured node id");
  assert(edgeSetup.stdout.includes(`agent-bus status --config ${edgeConfig}`), "edge setup did not print the local status checklist command");
  assert(edgeSetup.stdout.includes(`agent-bus status --gateway ${gateway} --token ADMIN_TOKEN`), "edge setup did not print the Central status checklist command");

  const result = {
    ok: true,
    quota: "no_model_calls",
    central_config: path.relative(root, centralConfig).replace(/\\/g, "/"),
    central_service: path.relative(root, centralService).replace(/\\/g, "/"),
    edge_config: path.relative(root, edgeConfig).replace(/\\/g, "/"),
    gateway,
    edge_token_prefix: edgeToken.slice(0, 12)
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("setup join smoke ok");
  }
} catch (err) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function run(args) {
  const result = spawnSync(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_BUS_TOKEN: "",
      AGENT_BUS_GATEWAY_URL: ""
    }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-bus ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function serviceExecStart(text) {
  return String(text || "").split(/\r?\n/).find((line) => line.startsWith("ExecStart=")) || "";
}
