import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const jsonOut = process.argv.includes("--json");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-diagnostics-redaction-"));
const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];

try {
  const result = main();
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("diagnostics redaction smoke ok");
    console.log(`Bundle: ${result.default_bundle}`);
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

function main() {
  const fixtureRoot = path.join(tempDir, "private-workspace");
  const configPath = path.join(fixtureRoot, "configs", "edge.config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({
    nodeId: "diag-redaction-node",
    gatewayUrl: "https://ops.example.com/agent-bus?token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    token: "abt_edge_redaction_smoke_token_12345678901234567890",
    tokenScope: "edge",
    agents: [
      {
        id: "unix-agent",
        kind: "codex",
        role: "assistant",
        enabled: true,
        adapter: "command",
        runCommand: "/tmp/agent-bus-diag-redaction/bin/unix-agent --model test",
        cwd: "/tmp/agent-bus-diag-redaction/workspace",
        pingUrl: "https://models.example.com/v1/health?api_key=sk-test-diagnostics-secret-000000000000000000"
      },
      {
        id: "windows-agent",
        kind: "codex",
        role: "assistant",
        enabled: true,
        adapter: "command",
        runCommand: "\"C:\\Users\\Alice\\Agent Bus\\agent.exe\" --model test",
        cwd: "C:\\Users\\Alice\\Projects\\agent-bus-private",
        pingUrl: "https://windows.example.com/v1/health?authorization=Bearer ghp_windowsdiagnosticssecret1234567890"
      }
    ]
  }, null, 2)}\n`);

  const defaultBundlePath = path.join(tempDir, "diagnostics-default.json");
  const includeHostsBundlePath = path.join(tempDir, "diagnostics-include-hosts.json");
  const includePathsBundlePath = path.join(tempDir, "diagnostics-include-paths.json");

  const defaultBundle = runDiagnosticsBundle(configPath, defaultBundlePath, []);
  const includeHostsBundle = runDiagnosticsBundle(configPath, includeHostsBundlePath, ["--include-hosts"]);
  const includePathsBundle = runDiagnosticsBundle(configPath, includePathsBundlePath, ["--include-paths"]);

  const defaultText = JSON.stringify(defaultBundle);
  const includeHostsText = JSON.stringify(includeHostsBundle);
  const includePathsText = JSON.stringify(includePathsBundle);

  assert(defaultBundle.schema === "agent_bus.diagnostics.v1", "default diagnostics bundle has the wrong schema");
  assert(defaultBundle.command?.config_path === "[REDACTED_PATH]", "default diagnostics bundle leaked config_path");
  assert(defaultBundle.command?.cwd === "[REDACTED_PATH]", "default diagnostics bundle leaked cwd");
  assert(defaultBundle.config?.gatewayUrl === "https://[REDACTED_HOST]/agent-bus?[REDACTED_QUERY]", "default diagnostics bundle did not redact gateway host");
  assert(defaultBundle.config?.agents?.[0]?.cwd === "[REDACTED_PATH]", "default diagnostics bundle leaked unix cwd");
  assert(defaultBundle.config?.agents?.[1]?.cwd === "[REDACTED_PATH]", "default diagnostics bundle leaked Windows cwd");
  assert(!defaultText.includes("ops.example.com"), "default diagnostics bundle leaked a hostname");
  assert(!defaultText.includes("models.example.com"), "default diagnostics bundle leaked a model hostname");
  assert(!defaultText.includes("windows.example.com"), "default diagnostics bundle leaked a Windows hostname");
  assert(!defaultText.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), "default diagnostics bundle leaked a GitHub token");
  assert(!defaultText.includes("sk-test-diagnostics-secret-000000000000000000"), "default diagnostics bundle leaked an API key");
  assert(!defaultText.includes("ghp_windowsdiagnosticssecret1234567890"), "default diagnostics bundle leaked a bearer token secret");
  assert(!defaultText.includes("/tmp/agent-bus-diag-redaction"), "default diagnostics bundle leaked a Unix path");
  assert(!defaultText.includes("C:\\Users\\Alice"), "default diagnostics bundle leaked a Windows path");
  assert(!defaultText.includes(configPath), "default diagnostics bundle leaked the temporary config path");
  assert(defaultBundle.doctor?.checks?.some((item) => item.name === "Read edge config" && item.detail === "[REDACTED_PATH]"), "default diagnostics bundle leaked the read-config check path");
  assert(defaultBundle.doctor?.checks?.some((item) => item.name === "agent unix-agent cwd" && item.detail === "[REDACTED_PATH] not found"), "default diagnostics bundle leaked the unix cwd check");
  assert(defaultBundle.doctor?.checks?.some((item) => item.name === "agent windows-agent cwd" && item.detail === "[REDACTED_PATH] not found"), "default diagnostics bundle leaked the Windows cwd check");

  assert(includeHostsBundle.command?.config_path === "[REDACTED_PATH]", "include-hosts bundle should still redact paths");
  assert(includeHostsBundle.config?.gatewayUrl === "https://ops.example.com/agent-bus?token=[REDACTED]", "include-hosts bundle should preserve host but redact query secrets");
  assert(includeHostsBundle.config?.agents?.[0]?.pingUrl === "https://models.example.com/v1/health?api_key=[REDACTED]", "include-hosts bundle should preserve ping host but redact query secrets");
  assert(includeHostsBundle.config?.agents?.[1]?.pingUrl === "https://windows.example.com/v1/health?authorization=[REDACTED]", "include-hosts bundle should preserve bearer host but redact the bearer secret");
  assert(!includeHostsText.includes("/tmp/agent-bus-diag-redaction"), "include-hosts bundle leaked a Unix path");
  assert(!includeHostsText.includes("C:\\Users\\Alice"), "include-hosts bundle leaked a Windows path");

  assert(includePathsBundle.command?.config_path === configPath, "include-paths bundle should preserve config_path");
  assert(includePathsBundle.command?.cwd === root, "include-paths bundle should preserve cwd");
  assert(includePathsBundle.config?.agents?.[0]?.cwd === "/tmp/agent-bus-diag-redaction/workspace", "include-paths bundle should preserve unix cwd");
  assert(includePathsBundle.config?.agents?.[1]?.cwd === "C:\\Users\\Alice\\Projects\\agent-bus-private", "include-paths bundle should preserve Windows cwd");
  assert(includePathsBundle.config?.gatewayUrl === "https://[REDACTED_HOST]/agent-bus?[REDACTED_QUERY]", "include-paths bundle should still redact hosts");
  assert(includePathsBundle.doctor?.checks?.some((item) => item.name === "Read edge config" && item.detail === configPath), "include-paths bundle should preserve the read-config path");
  assert(!includePathsText.includes("ops.example.com"), "include-paths bundle leaked a hostname");
  assert(!includePathsText.includes("models.example.com"), "include-paths bundle leaked a model hostname");
  assert(!includePathsText.includes("windows.example.com"), "include-paths bundle leaked a Windows hostname");
  assert(!includePathsText.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), "include-paths bundle leaked a GitHub token");
  assert(!includePathsText.includes("sk-test-diagnostics-secret-000000000000000000"), "include-paths bundle leaked an API key");
  assert(!includePathsText.includes("ghp_windowsdiagnosticssecret1234567890"), "include-paths bundle leaked a bearer token secret");

  return {
    ok: true,
    quota: "no_model_calls",
    default_bundle: path.basename(defaultBundlePath),
    include_hosts_bundle: path.basename(includeHostsBundlePath),
    include_paths_bundle: path.basename(includePathsBundlePath),
    checks: {
      default_redacted: true,
      include_hosts: true,
      include_paths: true
    }
  };
}

function runDiagnosticsBundle(configPath, outPath, extraArgs) {
  const result = spawnSync(node, [
    path.join(root, "agent-bus.mjs"),
    "diagnostics",
    "bundle",
    "--config",
    configPath,
    "--out",
    outPath,
    "--json",
    ...extraArgs
  ], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: smokeChildEnv()
  });
  if (result.error) throw result.error;
  const summary = parseJson(result.stdout);
  if (!summary?.ok) {
    throw new Error(`diagnostics bundle did not report success: ${result.stderr || result.stdout}`);
  }
  if (!fs.existsSync(outPath)) {
    throw new Error(`diagnostics bundle failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(fs.readFileSync(outPath, "utf8"));
}

function smokeChildEnv() {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return env;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || ""));
  } catch {
    return null;
  }
}
