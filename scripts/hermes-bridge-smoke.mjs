import { spawn, spawnSync } from "node:child_process";
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
  if (!result.stderr.includes("normalized session id for Hermes compatibility")) {
    throw new Error(`missing session normalization diagnostic in stderr: ${result.stderr}`);
  }
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

  const missingMessageFile = path.join(tempDir, "missing-message.txt");
  const missingFileResult = spawnSync(bash, [path.join(root, "scripts", "hermes-agent-bus.sh")], {
    cwd: root,
    env: {
      ...env,
      AGENT_MESSAGE: "message after missing file",
      AGENT_MESSAGE_FILE: missingMessageFile
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (missingFileResult.error) throw missingFileResult.error;
  if (missingFileResult.status !== 0) throw new Error(`missing-file bridge exited ${missingFileResult.status}: ${missingFileResult.stderr || missingFileResult.stdout}`);
  if (!missingFileResult.stderr.includes("AGENT_MESSAGE_FILE is not readable")) {
    throw new Error(`missing unreadable message-file diagnostic in stderr: ${missingFileResult.stderr}`);
  }
  if (!missingFileResult.stdout.includes("fallback hermes argv: <chat> <-q> <message after missing file> <-Q>")) {
    throw new Error(`fallback hermes command did not use AGENT_MESSAGE after missing file: ${missingFileResult.stdout}`);
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

  const lockRoot = path.join(tempDir, "hermes-session-locks");
  const staleLockDir = path.join(lockRoot, "hermes-lock-stale.lock");
  fs.mkdirSync(staleLockDir, { recursive: true });
  const oldLockTime = new Date(Date.now() - 5000);
  fs.utimesSync(staleLockDir, oldLockTime, oldLockTime);
  const staleLockResult = spawnSync(bash, [path.join(root, "scripts", "hermes-agent-bus.sh")], {
    cwd: root,
    env: {
      ...env,
      HERMES_AGENT_ROOT: bootstrapRoot,
      HERMES_AGENT_BUS_LOCK_DIR: lockRoot,
      HERMES_AGENT_BUS_SESSION_LOCK_STALE_SECONDS: "1",
      AGENT_SESSION_ID: "hermes-lock-stale",
      AGENT_MESSAGE: "stale lock cleanup"
    },
    encoding: "utf8",
    windowsHide: true
  });
  if (staleLockResult.error) throw staleLockResult.error;
  if (staleLockResult.status !== 0) throw new Error(`stale-lock bridge exited ${staleLockResult.status}: ${staleLockResult.stderr || staleLockResult.stdout}`);
  if (!staleLockResult.stderr.includes("removing stale Hermes session lock")) {
    throw new Error(`missing stale Hermes session lock diagnostic: ${staleLockResult.stderr}`);
  }

  const lockingRoot = path.join(tempDir, "hermes-locking-root");
  fs.mkdirSync(lockingRoot, { recursive: true });
  fs.writeFileSync(
    path.join(lockingRoot, "cli.py"),
    `import time

class HermesCLI:
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
        print("lock child ready", flush=True)
        while True:
            time.sleep(0.1)
`
  );
  const firstLockedBridge = await spawnBridgeUntilStdout(bash, path.join(root, "scripts", "hermes-agent-bus.sh"), root, {
    ...env,
    HERMES_AGENT_ROOT: lockingRoot,
    HERMES_AGENT_BUS_LOCK_DIR: lockRoot,
    HERMES_AGENT_BUS_SESSION_LOCK_STALE_SECONDS: "1",
    HERMES_AGENT_BUS_SESSION_LOCK_TOUCH_SECONDS: "1",
    AGENT_SESSION_ID: "hermes-lock-shared",
    AGENT_MESSAGE: "hold lock"
  }, "lock child ready");
  await delay(1500);
  const secondLockedResult = spawnSync(bash, [path.join(root, "scripts", "hermes-agent-bus.sh")], {
    cwd: root,
    env: {
      ...env,
      HERMES_AGENT_ROOT: lockingRoot,
      HERMES_AGENT_BUS_LOCK_DIR: lockRoot,
      HERMES_AGENT_BUS_SESSION_LOCK_TIMEOUT_SECONDS: "0",
      HERMES_AGENT_BUS_SESSION_LOCK_STALE_SECONDS: "1",
      AGENT_SESSION_ID: "hermes-lock-shared",
      AGENT_MESSAGE: "contend lock"
    },
    encoding: "utf8",
    windowsHide: true
  });
  firstLockedBridge.child.kill("SIGTERM");
  await firstLockedBridge.closed;
  if (secondLockedResult.error) throw secondLockedResult.error;
  if (secondLockedResult.status !== 75) {
    throw new Error(`contended lock bridge exited ${secondLockedResult.status} instead of 75: ${secondLockedResult.stderr || secondLockedResult.stdout}`);
  }
  if (!secondLockedResult.stderr.includes("another run is using session id hermes-lock-shared")) {
    throw new Error(`missing contended Hermes session lock diagnostic: ${secondLockedResult.stderr}`);
  }
  const signalRoot = path.join(tempDir, "hermes-signal-root");
  fs.mkdirSync(signalRoot, { recursive: true });
  fs.writeFileSync(
    path.join(signalRoot, "cli.py"),
    `import signal
import sys
import time

class HermesCLI:
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
        def handle_term(signum, frame):
            print("fake hermes child saw SIGTERM", file=sys.stderr, flush=True)
            raise SystemExit(143)
        signal.signal(signal.SIGTERM, handle_term)
        print("signal child ready", flush=True)
        while True:
            time.sleep(0.1)
`
  );
  const signalResult = await runBridgeUntilReadyThenSignal(bash, path.join(root, "scripts", "hermes-agent-bus.sh"), root, {
    ...env,
    HERMES_AGENT_ROOT: signalRoot,
    AGENT_SESSION_ID: "room/signal-test",
    AGENT_MESSAGE: "wait for signal"
  });
  if (signalResult.code !== 143) {
    throw new Error(`signal bridge exited ${signalResult.code} instead of 143: ${signalResult.stderr || signalResult.stdout}`);
  }
  if (!signalResult.stderr.includes("received SIGTERM; forwarding to Hermes child process")) {
    throw new Error(`signal bridge did not log SIGTERM forwarding diagnostic: ${signalResult.stderr}`);
  }
  if (!signalResult.stderr.includes("fake hermes child saw SIGTERM")) {
    throw new Error(`signal bridge did not forward SIGTERM to child: ${signalResult.stderr}`);
  }

  const hupRoot = path.join(tempDir, "hermes-hup-signal-root");
  fs.mkdirSync(hupRoot, { recursive: true });
  fs.writeFileSync(
    path.join(hupRoot, "cli.py"),
    `import signal
import sys
import time

class HermesCLI:
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
        def handle_hup(signum, frame):
            print("fake hermes child saw SIGHUP", file=sys.stderr, flush=True)
            raise SystemExit(129)
        signal.signal(signal.SIGHUP, handle_hup)
        print("signal child ready", flush=True)
        while True:
            time.sleep(0.1)
`
  );
  const hupResult = await runBridgeUntilReadyThenSignal(bash, path.join(root, "scripts", "hermes-agent-bus.sh"), root, {
    ...env,
    HERMES_AGENT_ROOT: hupRoot,
    AGENT_SESSION_ID: "room/hup-signal-test",
    AGENT_MESSAGE: "wait for hup signal"
  }, "SIGHUP");
  if (hupResult.code !== 129) {
    throw new Error(`SIGHUP bridge exited ${hupResult.code} instead of 129: ${hupResult.stderr || hupResult.stdout}`);
  }
  if (!hupResult.stderr.includes("received SIGHUP; forwarding to Hermes child process")) {
    throw new Error(`signal bridge did not log SIGHUP forwarding diagnostic: ${hupResult.stderr}`);
  }
  if (!hupResult.stderr.includes("fake hermes child saw SIGHUP")) {
    throw new Error(`signal bridge did not forward SIGHUP to child: ${hupResult.stderr}`);
  }

  const stubbornRoot = path.join(tempDir, "hermes-stubborn-signal-root");
  fs.mkdirSync(stubbornRoot, { recursive: true });
  fs.writeFileSync(
    path.join(stubbornRoot, "cli.py"),
    `import signal
import time

class HermesCLI:
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
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        print("signal child ready", flush=True)
        while True:
            time.sleep(0.1)
`
  );
  const stubbornSignalResult = await runBridgeUntilReadyThenSignal(bash, path.join(root, "scripts", "hermes-agent-bus.sh"), root, {
    ...env,
    HERMES_AGENT_ROOT: stubbornRoot,
    HERMES_AGENT_BUS_SIGNAL_GRACE_SECONDS: "1",
    AGENT_SESSION_ID: "room/stubborn-signal-test",
    AGENT_MESSAGE: "ignore signal"
  });
  if (stubbornSignalResult.code !== 143) {
    throw new Error(`stubborn signal bridge exited ${stubbornSignalResult.code} instead of 143: ${stubbornSignalResult.stderr || stubbornSignalResult.stdout}`);
  }
  if (!stubbornSignalResult.stderr.includes("did not exit within 1s after SIGTERM; sending SIGKILL")) {
    throw new Error(`signal bridge did not escalate stubborn child to SIGKILL: ${stubbornSignalResult.stderr}`);
  }

  console.log("hermes bridge smoke ok");
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveCommand(command) {
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function spawnBridgeUntilStdout(command, script, cwd, env, readyText) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [script], {
      cwd,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    const timeout = setTimeout(() => {
      if (!ready) {
        child.kill("SIGKILL");
        reject(new Error(`bridge did not emit ${readyText} before timeout; stdout=${stdout}; stderr=${stderr}`));
      }
    }, 5000);
    const closedPromise = new Promise((closedResolve) => {
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        const result = { code, signal, stdout, stderr };
        if (!ready) {
          reject(new Error(`bridge closed before ready: code=${code} signal=${signal} stdout=${stdout} stderr=${stderr}`));
        }
        closedResolve(result);
      });
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!ready && stdout.includes(readyText)) {
        ready = true;
        clearTimeout(timeout);
        resolve({ child, closed: closedPromise, get stdout() { return stdout; }, get stderr() { return stderr; } });
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function runBridgeUntilReadyThenSignal(command, script, cwd, env, signalName = "SIGTERM") {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [script], {
      cwd,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
        reject(new Error(`signal bridge did not become ready before timeout; stdout=${stdout}; stderr=${stderr}`));
      }
    }, 5000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!ready && stdout.includes("signal child ready")) {
        ready = true;
        child.kill(signalName);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}
