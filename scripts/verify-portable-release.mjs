import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-portable-check-"));

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const bundleName = `agent-bus-v${pkg.version}-portable-check`;
  const bundleDir = path.join(tempDir, bundleName);
  const launcherName = process.platform === "win32" ? "agent-bus.cmd" : "agent-bus";
  const tarPath = path.join(tempDir, `${bundleName}.tar.gz`);
  const releaseManifestPath = path.join(tempDir, `${bundleName}.manifest.json`);
  const sumsPath = path.join(tempDir, "SHA256SUMS");

  run(process.execPath, [
    path.join(root, "scripts", "make-portable-release.mjs"),
    "--archive",
    "--no-zip",
    "--out",
    tempDir,
    "--name",
    bundleName
  ]);

  for (const file of [bundleDir, tarPath, releaseManifestPath, sumsPath]) {
    assert(fs.existsSync(file), `portable release output missing: ${file}`);
  }

  const required = [
    "agent-bus",
    "agent-bus.cmd",
    "agent-bus.mjs",
    "INSTALL.md",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "central-gateway.mjs",
    "central_gateway.py",
    "edge-node.mjs",
    "edge_node.py",
    "docs/cli.md",
    "scripts/offline-smoke.mjs",
    "scripts/release-check.mjs",
    "manifest.json"
  ];
  for (const relative of required) {
    assert(fs.existsSync(path.join(bundleDir, relative)), `portable bundle missing required file: ${relative}`);
  }

  if (process.platform !== "win32") {
    const unixLauncher = fs.statSync(path.join(bundleDir, "agent-bus"));
    assert((unixLauncher.mode & 0o111) !== 0, "portable Unix launcher must be executable");
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8"));
  assert(manifest.name === pkg.name, "bundle manifest has wrong package name");
  assert(manifest.version === pkg.version, "bundle manifest has wrong version");
  assert(manifest.bundle === bundleName, "bundle manifest has wrong bundle name");
  const manifestFiles = new Map((manifest.files || []).map((file) => [file.path, file]));
  for (const relative of required.filter((item) => item !== "manifest.json")) {
    assert(manifestFiles.has(relative), `bundle manifest missing file entry: ${relative}`);
    const entry = manifestFiles.get(relative);
    const fullPath = path.join(bundleDir, relative);
    assert(entry.bytes === fs.statSync(fullPath).size, `bundle manifest size mismatch: ${relative}`);
    assert(entry.sha256 === sha256File(fullPath), `bundle manifest sha256 mismatch: ${relative}`);
  }

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
  for (const relative of manifestFiles.keys()) {
    assert(!forbiddenPatterns.some((pattern) => pattern.test(relative)), `portable bundle includes forbidden/private path: ${relative}`);
  }

  const releaseManifest = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
  const tarEntry = releaseManifest.artifacts?.find((artifact) => artifact.file === path.basename(tarPath));
  assert(tarEntry, "release manifest missing tar.gz artifact");
  assert(tarEntry.bytes === fs.statSync(tarPath).size, "release manifest tar.gz size mismatch");
  assert(tarEntry.sha256 === sha256File(tarPath), "release manifest tar.gz sha256 mismatch");

  const sums = fs.readFileSync(sumsPath, "utf8");
  assert(sums.includes(`${sha256File(tarPath)}  ${path.basename(tarPath)}`), "SHA256SUMS missing tar.gz checksum");

  const extractDir = path.join(tempDir, "extract");
  fs.mkdirSync(extractDir);
  run("tar", ["-xzf", tarPath, "-C", extractDir]);
  const extractedLauncher = path.join(extractDir, bundleName, launcherName);
  assert(fs.existsSync(extractedLauncher), `tar.gz did not extract the ${launcherName} launcher`);
  const help = run(extractedLauncher, ["--help"]);
  assert(help.stdout.includes("agent-bus"), "portable launcher did not print help text");
  assert(help.stdout.includes("agent-bus setup edge"), "portable launcher help is missing setup edge command");

  console.log(JSON.stringify({
    ok: true,
    package: `${pkg.name}@${pkg.version}`,
    bundle: bundleName,
    artifact: path.basename(tarPath),
    files: manifestFiles.size,
    bytes: fs.statSync(tarPath).size
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
  if (result.error) throw result.error;
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

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
