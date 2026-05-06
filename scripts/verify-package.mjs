import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-pack-check-"));
const defaultNpmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npmCommand = process.env.NPM_COMMAND || resolveCommand(defaultNpmCommand) || defaultNpmCommand;

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert(pkg.bin?.["agent-bus"] === "./agent-bus.mjs", "package.json must expose the agent-bus bin");
  assert(resolveCommand(npmCommand), "npm is required for package verification. Install npm or set NPM_COMMAND to the npm executable path.");

  const pack = run(npmCommand, ["pack", "--json", "--pack-destination", tempDir], { cwd: root });
  const packed = JSON.parse(pack.stdout)[0];
  assert(packed?.filename, "npm pack did not return an artifact filename");

  const files = new Map((packed.files || []).map((file) => [file.path, file]));
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "agent-bus.mjs",
    "central-gateway.mjs",
    "central_gateway.py",
    "edge-node.mjs",
    "edge_node.py",
    "scripts/offline-smoke.mjs",
    "scripts/make-portable-release.mjs",
    "scripts/release-check.mjs",
    "docs/cli.md",
    "docs/ai-to-ai.md",
    "central.config.example.json",
    "edge.config.example.json"
  ];
  for (const file of required) {
    assert(files.has(file), `npm package is missing required file: ${file}`);
  }

  const bin = files.get("agent-bus.mjs");
  assert((bin.mode & 0o111) !== 0, "agent-bus.mjs must remain executable in the npm package");

  const forbiddenPatterns = [
    /^\.git(?:\/|$)/,
    /^\.github(?:\/|$)/,
    /^data(?:\/|$)/,
    /(?:^|\/)node_modules(?:\/|$)/,
    /(?:^|\/)dist(?:\/|$)/,
    /(?:^|\/)\.openclaw(?:\/|$)/,
    /(?:^|\/)\.env$/,
    /(?:^|\/)(?:central|edge)\.config\.json$/
  ];
  for (const file of files.keys()) {
    assert(!forbiddenPatterns.some((pattern) => pattern.test(file)), `npm package includes forbidden/private path: ${file}`);
  }

  const archive = path.join(tempDir, packed.filename);
  assert(fs.existsSync(archive), `npm package artifact was not written: ${archive}`);
  run("tar", ["-xzf", archive, "-C", tempDir]);

  const extractedPkg = JSON.parse(fs.readFileSync(path.join(tempDir, "package", "package.json"), "utf8"));
  assert(extractedPkg.bin?.["agent-bus"] === "./agent-bus.mjs", "extracted package has incorrect bin mapping");

  const help = run(process.execPath, [path.join(tempDir, "package", "agent-bus.mjs"), "--help"]);
  assert(help.stdout.includes("agent-bus"), "extracted CLI did not print help text");
  assert(help.stdout.includes("agent-bus smoke --offline"), "extracted CLI help is missing smoke command");

  console.log(JSON.stringify({
    ok: true,
    package: `${pkg.name}@${pkg.version}`,
    artifact: packed.filename,
    files: files.size,
    unpackedSize: packed.unpackedSize
  }, null, 2));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, npm_config_loglevel: "error" }
  });
  if (result.error) {
    if (result.error.code === "ENOENT" && command === npmCommand) {
      throw new Error(`npm is required for package verification. Install npm or set NPM_COMMAND to the npm executable path. Original error: ${result.error.message}`);
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function commandInvocation(command, args) {
  if (process.platform === "win32" && /\.cmd$/i.test(String(command))) {
    return {
      command: "cmd.exe",
      args: ["/d", "/c", command, ...args]
    };
  }
  return { command, args };
}

function resolveCommand(command) {
  const text = String(command || "");
  if (!text) return "";
  if (path.isAbsolute(text) || text.includes("/") || text.includes("\\")) {
    return fs.existsSync(text) ? text : "";
  }
  const pathDirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" && !path.extname(text)
    ? String(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of pathDirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${text}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
