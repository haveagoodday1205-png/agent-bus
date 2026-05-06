import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-pack-check-"));

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert(pkg.bin?.["agent-bus"] === "./agent-bus.mjs", "package.json must expose the agent-bus bin");

  const pack = run("npm", ["pack", "--json", "--pack-destination", tempDir], { cwd: root });
  const packed = JSON.parse(pack.stdout)[0];
  assert(packed?.filename, "npm pack did not return an artifact filename");

  const files = new Map((packed.files || []).map((file) => [file.path, file]));
  const required = [
    "package.json",
    "README.md",
    "LICENSE",
    "agent-bus.mjs",
    "central-gateway.mjs",
    "central_gateway.py",
    "edge-node.mjs",
    "edge_node.py",
    "scripts/offline-smoke.mjs",
    "scripts/make-portable-release.mjs",
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
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, npm_config_loglevel: "error" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
