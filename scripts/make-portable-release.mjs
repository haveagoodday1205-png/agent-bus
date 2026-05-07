import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const bundleName = optionValue("--name") || `agent-bus-v${pkg.version}-portable`;
const outRoot = path.resolve(root, optionValue("--out") || "dist");
const outDir = path.join(outRoot, bundleName);
const archive = args.includes("--archive");
const includeZip = !args.includes("--no-zip");

const files = [
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "agent-bus.mjs",
  "central-gateway.mjs",
  "central_gateway.py",
  "central.config.example.json",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "compose.yaml",
  "config.example.json",
  "CONTRIBUTING.md",
  "Dockerfile",
  "edge-node.mjs",
  "edge_node.py",
  "edge.120.example.json",
  "edge.178.example.json",
  "edge.config.example.json",
  "edge.hk.example.json",
  "GOVERNANCE.md",
  "LICENSE",
  "mock-openai-backend.mjs",
  "package.json",
  "README.md",
  "SECURITY.md",
  "server.mjs",
  "smoke-test.mjs",
  "start-windows-openai-proxy.ps1",
  "windows-openai-proxy.mjs"
];

const directories = [
  "console",
  "docs",
  "examples",
  "sdk",
  "scripts"
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

for (const file of files) {
  copyFile(file);
}
for (const directory of directories) {
  copyDirectory(directory);
}

writeText("agent-bus", `#!/usr/bin/env sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$DIR/agent-bus.mjs" "$@"
`, 0o755);

writeText("agent-bus.cmd", `@echo off
set "DIR=%~dp0"
node "%DIR%agent-bus.mjs" %*
`);

writeText("INSTALL.md", `# Agent Bus Portable Bundle

Bundle: ${bundleName}
Version: ${pkg.version}

Requirements:

- Node.js 20+
- Python 3.10+ for \`agent-bus smoke --offline\`, the Python gateway, or the Python edge node
- Codex, OpenClaw, Hermes, Ollama, or another local/model adapter if this machine should execute AI work

Quick start:

\`\`\`bash
./agent-bus --help
./agent-bus detect
./agent-bus smoke --offline
./agent-bus init edge --auto --out edge.config.json
./agent-bus doctor --config edge.config.json
./agent-bus connect --config edge.config.json
\`\`\`

Windows:

\`\`\`powershell
.\\agent-bus.cmd --help
.\\agent-bus.cmd detect
.\\agent-bus.cmd init edge --auto --out edge.config.json
\`\`\`

Pair a new remote assistant node without pasting the central admin token:

\`\`\`bash
# Central/admin machine
agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ... --preset codex

# New edge machine
./agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --out edge.config.json --auto --service auto
\`\`\`

Generate a long-running service template:

\`\`\`bash
./agent-bus service systemd --mode edge --config /opt/agent-bus/edge.config.json --cwd /opt/agent-bus --agent-bus-path /opt/agent-bus/agent-bus --out agent-bus-edge.service
./agent-bus service launchd --mode edge --config /opt/agent-bus/edge.config.json --cwd /opt/agent-bus --agent-bus-path /opt/agent-bus/agent-bus --out com.agent-bus.edge.plist
./agent-bus.cmd service windows --mode edge --config C:\\agent-bus\\edge.config.json --cwd C:\\agent-bus --agent-bus-path C:\\agent-bus\\agent-bus.cmd
\`\`\`

Security:

- Do not commit real \`edge.config.json\`, \`central.config.json\`, tokens, or API keys.
- Use \`SHA256SUMS\` from the release to verify downloaded archives.
- The portable CLI does not bundle paid model runtimes or API keys. Configure model URLs and keys on each machine.
`);

writeBundleManifest();

const artifacts = archive ? writeArchives() : [];
writeReleaseFiles(artifacts);

console.log(outDir);
for (const artifact of artifacts) {
  console.log(artifact);
}

function writeBundleManifest() {
  const entries = listFiles(outDir)
    .filter((file) => path.basename(file) !== "manifest.json")
    .map((file) => {
      const relative = slash(path.relative(outDir, file));
      return {
        path: relative,
        bytes: fs.statSync(file).size,
        sha256: sha256File(file)
      };
    });
  const manifest = {
    manifestVersion: 1,
    name: pkg.name,
    version: pkg.version,
    bundle: bundleName,
    createdAt: new Date().toISOString(),
    files: entries
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeArchives() {
  fs.mkdirSync(outRoot, { recursive: true });
  const artifacts = [];
  const tarName = `${bundleName}.tar.gz`;
  const tarPath = path.join(outRoot, tarName);
  fs.rmSync(tarPath, { force: true });
  runRequired("tar", ["-czf", tarName, bundleName], { cwd: outRoot });
  artifacts.push(tarPath);

  if (includeZip) {
    const zipName = `${bundleName}.zip`;
    const zipPath = path.join(outRoot, zipName);
    fs.rmSync(zipPath, { force: true });
    makeZip(zipName, zipPath);
    artifacts.push(zipPath);
  }

  return artifacts;
}

function writeReleaseFiles(artifacts) {
  const manifestPath = path.join(outRoot, `${bundleName}.manifest.json`);
  const releaseManifest = {
    manifestVersion: 1,
    name: pkg.name,
    version: pkg.version,
    bundle: bundleName,
    createdAt: new Date().toISOString(),
    bundleDirectory: slash(path.relative(outRoot, outDir)),
    artifacts: artifacts.map((artifact) => ({
      file: path.basename(artifact),
      bytes: fs.statSync(artifact).size,
      sha256: sha256File(artifact)
    }))
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`);

  if (artifacts.length) {
    const sums = artifacts
      .map((artifact) => `${sha256File(artifact)}  ${path.basename(artifact)}`)
      .join("\n");
    fs.writeFileSync(path.join(outRoot, "SHA256SUMS"), `${sums}\n`);
  }
}

function makeZip(zipName, zipPath) {
  if (runOptional("zip", ["-qr", zipName, bundleName], { cwd: outRoot })) return;

  const ps = process.platform === "win32" ? "powershell.exe" : "pwsh";
  const command = `Compress-Archive -LiteralPath ${powerShellQuote(outDir)} -DestinationPath ${powerShellQuote(zipPath)} -Force`;
  if (runOptional(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command])) return;

  throw new Error("Could not create zip archive. Install zip or PowerShell, or run with --no-zip.");
}

function copyFile(relative) {
  const from = path.join(root, relative);
  if (!fs.existsSync(from)) return;
  const to = path.join(outDir, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDirectory(relative) {
  const from = path.join(root, relative);
  if (!fs.existsSync(from)) return;
  const to = path.join(outDir, relative);
  copyRecursive(from, to);
}

function copyRecursive(from, to) {
  const stat = fs.statSync(from);
  if (stat.isDirectory()) {
    if (shouldSkipDirectory(path.basename(from))) return;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function shouldSkipDirectory(name) {
  return name === "__pycache__" || name === "node_modules" || name === ".git";
}

function writeText(relative, text, mode) {
  const to = path.join(outDir, relative);
  fs.writeFileSync(to, text, mode ? { mode } : undefined);
}

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir)) {
    const file = path.join(dir, entry);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      out.push(...listFiles(file));
    } else {
      out.push(file);
    }
  }
  return out.sort((a, b) => slash(path.relative(dir, a)).localeCompare(slash(path.relative(dir, b))));
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runRequired(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    windowsHide: true,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

function runOptional(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "ignore",
    windowsHide: true,
    ...options
  });
  return !result.error && result.status === 0;
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function slash(value) {
  return String(value || "").replace(/\\/g, "/");
}

function powerShellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
