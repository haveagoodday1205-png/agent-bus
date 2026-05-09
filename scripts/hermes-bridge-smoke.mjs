import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-hermes-bridge-smoke-"));

try {
  if (process.platform === "win32") {
    console.log("hermes bridge smoke skipped on Windows");
    process.exit(0);
  }
  const bash = resolveCommand("bash");
  const python = process.env.HERMES_PYTHON || process.env.AGENT_BUS_PYTHON || process.env.PYTHON || resolveCommand("python3") || resolveCommand("python");
  if (!bash || !python) {
    console.log("hermes bridge smoke skipped: bash or python unavailable");
    process.exit(0);
  }

  const fakeRoot = path.join(tempDir, "hermes-root");
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(fakeRoot, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeRoot, "cli.py"),
    "class HermesCLI:\n    def __init__(self, *args, **kwargs):\n        pass\n"
  );

  const fakeHermes = path.join(binDir, "hermes");
  fs.writeFileSync(
    fakeHermes,
    "#!/usr/bin/env sh\nprintf 'fallback hermes argv:'\nprintf ' <%s>' \"$@\"\nprintf '\\n'\n"
  );
  fs.chmodSync(fakeHermes, 0o755);

  const env = {
    ...process.env,
    HERMES_AGENT_ROOT: fakeRoot,
    HERMES_COMMAND: fakeHermes,
    HERMES_PYTHON: python,
    AGENT_SESSION_ID: "room/test session",
    AGENT_MESSAGE: "bridge smoke message"
  };
  delete env.AGENT_MESSAGE_FILE;

  const result = spawnSync(bash, [path.join(root, "scripts", "hermes-agent-bus.sh")], {
    cwd: root,
    env,
    encoding: "utf8",
    windowsHide: true
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`bridge exited ${result.status}: ${result.stderr || result.stdout}`);
  if (!result.stderr.includes("HermesCLI is missing")) {
    throw new Error(`missing bootstrap fallback diagnostic in stderr: ${result.stderr}`);
  }
  if (!result.stdout.includes("fallback hermes argv: <chat> <-q> <bridge smoke message> <-Q>")) {
    throw new Error(`fallback hermes command did not receive expected args: ${result.stdout}`);
  }

  const smallMessageFile = path.join(tempDir, "small-message.txt");
  fs.writeFileSync(smallMessageFile, "message from readable file", "utf8");
  const fileResult = spawnSync(bash, [path.join(root, "scripts", "hermes-agent-bus.sh")], {
    cwd: root,
    env: {
      ...env,
      AGENT_MESSAGE: "stale env message",
      AGENT_MESSAGE_FILE: smallMessageFile,
      HERMES_AGENT_BUS_MAX_ARG_BYTES: "1000"
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (fileResult.error) throw fileResult.error;
  if (fileResult.status !== 0) throw new Error(`file bridge exited ${fileResult.status}: ${fileResult.stderr || fileResult.stdout}`);
  if (!fileResult.stdout.includes("fallback hermes argv: <chat> <-q> <message from readable file> <-Q>")) {
    throw new Error(`fallback hermes command did not prefer readable message file: ${fileResult.stdout}`);
  }

  const largeMessageFile = path.join(tempDir, "large-message.txt");
  fs.writeFileSync(largeMessageFile, "x".repeat(256), "utf8");
  const largeResult = spawnSync(bash, [path.join(root, "scripts", "hermes-agent-bus.sh")], {
    cwd: root,
    env: {
      ...env,
      AGENT_MESSAGE: "",
      AGENT_MESSAGE_FILE: largeMessageFile,
      HERMES_AGENT_BUS_MAX_ARG_BYTES: "32"
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (largeResult.error) throw largeResult.error;
  if (largeResult.status !== 0) throw new Error(`large bridge exited ${largeResult.status}: ${largeResult.stderr || largeResult.stdout}`);
  if (!largeResult.stdout.includes(`Read the full UTF-8 task from: ${largeMessageFile}`)) {
    throw new Error(`fallback hermes command did not convert large message file to file pointer: ${largeResult.stdout}`);
  }
  if (largeResult.stdout.includes("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")) {
    throw new Error("fallback hermes command leaked a large prompt into argv output");
  }

  const bootstrapRoot = path.join(tempDir, "hermes-bootstrap-root");
  fs.mkdirSync(bootstrapRoot, { recursive: true });
  fs.writeFileSync(
    path.join(bootstrapRoot, "cli.py"),
    `class HermesCLI:
    def __init__(self, *args, **kwargs):
        self._active_agent_route_signature = None
        self.session_id = ""
        self.agent = None
    def _ensure_runtime_credentials(self):
        return True
    def _resolve_turn_agent_config(self, message):
        return {"signature": "test", "model": None, "runtime": None, "request_overrides": None}
    def _init_agent(self, *args, **kwargs):
        self.agent = FakeAgent()
        return True
class FakeAgent:
    def __setattr__(self, name, value):
        object.__setattr__(self, name, value)
    def run_conversation(self, user_message, conversation_history):
        return {"final_response": "bootstrap message: " + user_message, "failed": False}
`
  );
  const bootstrapMessageFile = path.join(tempDir, "bootstrap-message.txt");
  fs.writeFileSync(bootstrapMessageFile, "bootstrap file content", "utf8");
  const bootstrapResult = spawnSync(bash, [path.join(root, "scripts", "hermes-agent-bus.sh")], {
    cwd: root,
    env: {
      ...env,
      HERMES_AGENT_ROOT: bootstrapRoot,
      AGENT_MESSAGE: "stale bootstrap env message",
      AGENT_MESSAGE_FILE: bootstrapMessageFile
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (bootstrapResult.error) throw bootstrapResult.error;
  if (bootstrapResult.status !== 0) throw new Error(`bootstrap bridge exited ${bootstrapResult.status}: ${bootstrapResult.stderr || bootstrapResult.stdout}`);
  if (!bootstrapResult.stdout.includes("bootstrap message: bootstrap file content")) {
    throw new Error(`bootstrap path did not read message file content: ${bootstrapResult.stdout}`);
  }
  if (bootstrapResult.stdout.includes("stale bootstrap env message")) {
    throw new Error("bootstrap path used stale AGENT_MESSAGE despite readable AGENT_MESSAGE_FILE");
  }
  console.log("hermes bridge smoke ok");
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function resolveCommand(command) {
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}
