import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-claudecode-bridge-smoke-"));

try {
  const bash = process.env.BASH || resolveCommand("bash");
  if (!bash || process.platform === "win32") {
    console.log("claudecode bridge smoke skipped on Windows");
    process.exit(0);
  }

  const workDir = path.join(tempDir, "work");
  fs.mkdirSync(workDir, { recursive: true });
  const argvFile = path.join(tempDir, "claude-argv.json");
  const cwdFile = path.join(tempDir, "claude-cwd.txt");
  const fakeClaude = path.join(tempDir, "claude");
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(cwdFile)}, process.cwd());
console.log("CLAUDECODE_BRIDGE_OK");
`
  );
  fs.chmodSync(fakeClaude, 0o755);

  const messageFile = path.join(tempDir, "message.txt");
  fs.writeFileSync(messageFile, "message from claudecode file", "utf8");
  const result = spawnSync(bash, [path.join(root, "scripts", "claudecode-agent-bus.sh")], {
    cwd: root,
    env: {
      ...cleanEnv(),
      CLAUDECODE_COMMAND: fakeClaude,
      CLAUDECODE_CWD: workDir,
      CLAUDECODE_VERBOSE: "1",
      AGENT_CACHE_KEY: "room:claudecode bridge smoke",
      AGENT_MESSAGE: "stale env message",
      AGENT_MESSAGE_FILE: messageFile
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bridge exited ${result.status}: ${result.stderr || result.stdout}`);
  if (!result.stdout.includes("CLAUDECODE_BRIDGE_OK")) throw new Error(`unexpected bridge stdout: ${result.stdout}`);
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));
  assert(argv.includes("--print"), "claude --print was not used");
  assert(argv.includes("--permission-mode") && argv[argv.indexOf("--permission-mode") + 1] === "acceptEdits", "acceptEdits permission mode was not passed");
  assert(argv.includes("--session-id"), "session id was not passed");
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(argv[argv.indexOf("--session-id") + 1] || ""), "derived session id is not UUID-shaped");
  assert(argv.at(-1) === "message from claudecode file", "readable AGENT_MESSAGE_FILE was not preferred over AGENT_MESSAGE");
  assert(fs.readFileSync(cwdFile, "utf8") === workDir, "CLAUDECODE_CWD was not applied before invoking claude");

  const badCwd = spawnSync(bash, [path.join(root, "scripts", "claudecode-agent-bus.sh")], {
    cwd: root,
    env: {
      ...cleanEnv(),
      CLAUDECODE_COMMAND: fakeClaude,
      CLAUDECODE_CWD: path.join(tempDir, "missing"),
      AGENT_MESSAGE: "hello"
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert(badCwd.status === 2, "invalid CLAUDECODE_CWD should fail before invoking claude");
  assert(/CLAUDECODE_CWD does not exist/.test(badCwd.stderr || ""), "invalid CLAUDECODE_CWD error should be actionable");

  const missingCmd = spawnSync(bash, [path.join(root, "scripts", "claudecode-agent-bus.sh")], {
    cwd: root,
    env: {
      ...cleanEnv(),
      CLAUDECODE_COMMAND: "/nonexistent/path/to/claude-fake-binary",
      AGENT_MESSAGE: "hello"
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert(missingCmd.status === 3, "missing claude command should exit 3");
  assert(/claude command not found/.test(missingCmd.stderr || ""), "missing command error should be actionable");

  const emptyMsg = spawnSync(bash, [path.join(root, "scripts", "claudecode-agent-bus.sh")], {
    cwd: root,
    env: {
      ...cleanEnv(),
      CLAUDECODE_COMMAND: fakeClaude
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert(emptyMsg.status === 4, "empty message should exit 4");
  assert(/No message provided/.test(emptyMsg.stderr || ""), "empty message error should be actionable");

  const allowEmpty = spawnSync(bash, [path.join(root, "scripts", "claudecode-agent-bus.sh")], {
    cwd: root,
    env: {
      ...cleanEnv(),
      CLAUDECODE_COMMAND: fakeClaude,
      CLAUDECODE_ALLOW_EMPTY_MESSAGE: "1"
    },
    encoding: "utf8",
    windowsHide: true
  });
  assert(allowEmpty.status === 0, "CLAUDECODE_ALLOW_EMPTY_MESSAGE=1 should bypass empty message guard");

  console.log("claudecode bridge smoke ok");
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("AGENT_BUS_") || key.startsWith("AGENT_") || key.startsWith("CLAUDECODE_") || key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  return env;
}

function resolveCommand(command) {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
