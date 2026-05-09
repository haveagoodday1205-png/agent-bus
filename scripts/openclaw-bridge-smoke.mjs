import { spawn, spawnSync } from "node:child_process";
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

  const failingOpenClaw = path.join(binDir, "failing-openclaw");
  fs.writeFileSync(
    failingOpenClaw,
    `#!/usr/bin/env node
console.log('{"result":{"payloads":[{"text":"OPENCLAW_PARTIAL_BEFORE_FAILURE"}]}}');
process.exit(42);
`
  );
  fs.chmodSync(failingOpenClaw, 0o755);
  const failingResult = spawnSync(bash, [path.join(root, "scripts", "openclaw-agent-bus.sh")], {
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_BIN: failingOpenClaw,
      AGENT_MESSAGE: "partial output smoke"
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (failingResult.status !== 42) {
    throw new Error(`failing OpenClaw status should be preserved as 42, got ${failingResult.status}: ${failingResult.stderr || failingResult.stdout}`);
  }
  if (!failingResult.stdout.includes("OPENCLAW_PARTIAL_BEFORE_FAILURE")) {
    throw new Error(`failing OpenClaw partial stdout was not preserved: ${failingResult.stdout}`);
  }

  const signalFile = path.join(tempDir, "openclaw-signal.txt");
  const readyFile = path.join(tempDir, "openclaw-ready.txt");
  const signalOpenClaw = path.join(binDir, "signal-openclaw");
  fs.writeFileSync(
    signalOpenClaw,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(readyFile)}, "ready");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(signalFile)}, "SIGTERM");
  process.exit(0);
});
setInterval(() => {}, 1000);
`
  );
  fs.chmodSync(signalOpenClaw, 0o755);
  const signalResult = await runAndTerminateWrapper({
    bash,
    wrapper: path.join(root, "scripts", "openclaw-agent-bus.sh"),
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_BIN: signalOpenClaw,
      OPENCLAW_AGENT_BUS_SIGNAL_GRACE_SECONDS: "1",
      AGENT_MESSAGE: "signal forwarding smoke"
    },
    readyFile
  });
  if (signalResult.status !== 143) {
    throw new Error(`terminated wrapper should exit 143, got ${signalResult.status}: ${signalResult.stderr || signalResult.stdout}`);
  }
  if (!fs.existsSync(signalFile) || fs.readFileSync(signalFile, "utf8") !== "SIGTERM") {
    throw new Error("OpenClaw child did not receive forwarded SIGTERM");
  }

  const stubbornSignalFile = path.join(tempDir, "openclaw-stubborn-signal.txt");
  const stubbornReadyFile = path.join(tempDir, "openclaw-stubborn-ready.txt");
  const stubbornOpenClaw = path.join(binDir, "stubborn-openclaw");
  fs.writeFileSync(
    stubbornOpenClaw,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(stubbornReadyFile)}, "ready");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(stubbornSignalFile)}, "SIGTERM");
});
setInterval(() => {}, 1000);
`
  );
  fs.chmodSync(stubbornOpenClaw, 0o755);
  const stubbornResult = await runAndTerminateWrapper({
    bash,
    wrapper: path.join(root, "scripts", "openclaw-agent-bus.sh"),
    cwd: root,
    env: {
      ...process.env,
      OPENCLAW_BIN: stubbornOpenClaw,
      OPENCLAW_AGENT_BUS_SIGNAL_GRACE_SECONDS: "1",
      AGENT_MESSAGE: "stubborn signal forwarding smoke"
    },
    readyFile: stubbornReadyFile
  });
  if (stubbornResult.status !== 143) {
    throw new Error(`stubborn terminated wrapper should exit 143, got ${stubbornResult.status}: ${stubbornResult.stderr || stubbornResult.stdout}`);
  }
  if (!fs.existsSync(stubbornSignalFile) || fs.readFileSync(stubbornSignalFile, "utf8") !== "SIGTERM") {
    throw new Error("stubborn OpenClaw child did not receive forwarded SIGTERM before SIGKILL watchdog");
  }
  if (!stubbornResult.stderr.includes("sending SIGKILL")) {
    throw new Error(`stubborn OpenClaw watchdog diagnostic missing: ${stubbornResult.stderr}`);
  }

  const lockLogFile = path.join(tempDir, "openclaw-session-lock-log.jsonl");
  const lockingOpenClaw = path.join(binDir, "locking-openclaw");
  fs.writeFileSync(
    lockingOpenClaw,
    `#!/usr/bin/env node
import fs from "node:fs";
const id = process.env.AGENT_MESSAGE || "unknown";
const delayMs = Number(process.env.OPENCLAW_LOCK_SMOKE_DELAY_MS || 350);
fs.appendFileSync(${JSON.stringify(lockLogFile)}, JSON.stringify({ id, event: "start", at: Date.now() }) + "\\n");
setTimeout(() => {
  fs.appendFileSync(${JSON.stringify(lockLogFile)}, JSON.stringify({ id, event: "end", at: Date.now() }) + "\\n");
  console.log('{"result":{"payloads":[{"text":"LOCK_OK_' + id + '"}]}}');
}, delayMs);
`
  );
  fs.chmodSync(lockingOpenClaw, 0o755);
  const lockEnv = {
    ...process.env,
    OPENCLAW_BIN: lockingOpenClaw,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_ID: "lock-agent",
    OPENCLAW_AGENT_BUS_SESSION_LOCK_STALE_SECONDS: "2",
    OPENCLAW_AGENT_BUS_SESSION_LOCK_TOUCH_SECONDS: "1",
    OPENCLAW_LOCK_SMOKE_DELAY_MS: "2500",
    AGENT_SESSION_ID: "shared-lock-session"
  };
  const [lockFirst, lockSecond] = await Promise.all([
    runWrapper({ bash, wrapper: path.join(root, "scripts", "openclaw-agent-bus.sh"), cwd: root, env: { ...lockEnv, AGENT_MESSAGE: "first" } }),
    runWrapper({ bash, wrapper: path.join(root, "scripts", "openclaw-agent-bus.sh"), cwd: root, env: { ...lockEnv, AGENT_MESSAGE: "second" } })
  ]);
  if (lockFirst.status !== 0 || lockSecond.status !== 0) {
    throw new Error(`session lock smoke wrappers failed: first=${lockFirst.status} ${lockFirst.stderr}; second=${lockSecond.status} ${lockSecond.stderr}`);
  }
  const lockEvents = fs.readFileSync(lockLogFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const firstEndIndex = lockEvents.findIndex((event) => event.id === "first" && event.event === "end");
  const secondStartIndex = lockEvents.findIndex((event) => event.id === "second" && event.event === "start");
  const secondEndIndex = lockEvents.findIndex((event) => event.id === "second" && event.event === "end");
  const firstStartIndex = lockEvents.findIndex((event) => event.id === "first" && event.event === "start");
  if (firstStartIndex === -1 || firstEndIndex === -1 || secondStartIndex === -1 || secondEndIndex === -1) {
    throw new Error(`session lock smoke missing events: ${JSON.stringify(lockEvents)}`);
  }
  if (!(firstEndIndex < secondStartIndex || secondEndIndex < firstStartIndex)) {
    throw new Error(`session lock did not serialize concurrent same-session runs: ${JSON.stringify(lockEvents)}`);
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

function runWrapper({ bash, wrapper, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, [wrapper], { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function runAndTerminateWrapper({ bash, wrapper, cwd, env, readyFile }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bash, [wrapper], { cwd, env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      clearInterval(poll);
      fn(value);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish(reject, error));
    child.on("close", (status, signal) => finish(resolve, { status, signal, stdout, stderr }));
    const timeout = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      finish(reject, new Error(`timed out waiting for signal forwarding smoke; stdout=${stdout} stderr=${stderr}`));
    }, 5000);
    let signalSent = false;
    const poll = setInterval(() => {
      if (!signalSent && fs.existsSync(readyFile)) {
        signalSent = true;
        child.kill("SIGTERM");
      }
    }, 25);
  });
}

function resolveCommand(command) {
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}
