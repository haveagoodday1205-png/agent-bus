import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-openclaw-bridge-smoke-"));

try {
  if (process.platform === "win32") {
    console.log("openclaw bridge smoke skipped on Windows");
    process.exit(0);
  }
  const bash = resolveCommand("bash");
  if (!bash) {
    console.log("openclaw bridge smoke skipped: bash unavailable");
    process.exit(0);
  }

  const binDir = path.join(tempDir, "bin");
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const argvFile = path.join(tempDir, "openclaw-argv.json");
  const fakeOpenClaw = path.join(binDir, "custom-openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
console.log('{"result":{"payloads":[{"text":"OPENCLAW_BRIDGE_OK"}]}}');
`
  );
  fs.chmodSync(fakeOpenClaw, 0o755);


  const missingBin = path.join(tempDir, "missing-openclaw");
  const missingBinResult = spawnSync(bash, [path.join(root, "scripts", "openclaw-agent-bus.sh")], {
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_BIN: missingBin,
      AGENT_MESSAGE: "diagnostic smoke"
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (missingBinResult.status !== 127) {
    throw new Error(`missing OpenClaw executable should exit 127, got ${missingBinResult.status}: ${missingBinResult.stderr || missingBinResult.stdout}`);
  }
  if (!missingBinResult.stderr.includes("OpenClaw executable does not exist") || !missingBinResult.stderr.includes("OPENCLAW_BIN")) {
    throw new Error(`missing OpenClaw executable diagnostic was not actionable: ${missingBinResult.stderr}`);
  }

  const missingMessageFile = path.join(tempDir, "missing-message.txt");
  const missingMessageResult = spawnSync(bash, [path.join(root, "scripts", "openclaw-agent-bus.sh")], {
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_BIN: fakeOpenClaw,
      AGENT_MESSAGE_FILE: missingMessageFile
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (missingMessageResult.status !== 64) {
    throw new Error(`missing message file should exit 64, got ${missingMessageResult.status}: ${missingMessageResult.stderr || missingMessageResult.stdout}`);
  }
  if (!missingMessageResult.stderr.includes("AGENT_MESSAGE_FILE") || !missingMessageResult.stderr.includes("not readable")) {
    throw new Error(`missing message file diagnostic was not actionable: ${missingMessageResult.stderr}`);
  }

  const agentId = "agent bus/weird \"id";
  const safeAgentId = sanitize(agentId);
  const sessionId = "room weird \"session";
  const safeSessionId = sanitize(sessionId);
  const sessionDir = path.join(stateDir, "agents", safeAgentId, "sessions");
  fs.mkdirSync(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${safeSessionId}.jsonl`);
  fs.writeFileSync(sessionFile, "oversized session state");

  const messageFile = path.join(tempDir, "message.txt");
  fs.writeFileSync(messageFile, "openclaw bridge smoke message");
  const result = spawnSync(bash, [path.join(root, "scripts", "openclaw-agent-bus.sh")], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      OPENCLAW_AGENT_ID: agentId,
      OPENCLAW_BIN: fakeOpenClaw,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_AGENT_BUS_MAX_SESSION_BYTES: "1",
      OPENCLAW_AGENT_BUS_MAX_ARG_BYTES: "not-a-number",
      AGENT_SESSION_ID: sessionId,
      AGENT_MESSAGE: "",
      AGENT_MESSAGE_FILE: messageFile
    },
    encoding: "utf8",
    windowsHide: true
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bridge exited ${result.status}: ${result.stderr || result.stdout}`);
  if (!result.stdout.includes("OPENCLAW_BRIDGE_OK")) throw new Error(`unexpected bridge stdout: ${result.stdout}`);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  if (!argv.includes("--session-id") || argv[argv.indexOf("--session-id") + 1] !== safeSessionId) {
    throw new Error(`sanitized session id was not passed to OpenClaw: ${JSON.stringify(argv)}`);
  }
  if (!argv.includes("--agent") || argv[argv.indexOf("--agent") + 1] !== agentId) {
    throw new Error(`agent id was not passed to OpenClaw: ${JSON.stringify(argv)}`);
  }
  const backups = fs.readdirSync(sessionDir).filter((name) => name.includes(".bak-agent-bus-pruned-"));
  if (!backups.length) throw new Error("oversized OpenClaw session file was not pruned");
  console.log("openclaw bridge smoke ok");
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function sanitize(value) {
  const safe = String(value || "").replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 180);
  return safe || "main";
}

function resolveCommand(command) {
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}
