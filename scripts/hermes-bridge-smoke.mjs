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
