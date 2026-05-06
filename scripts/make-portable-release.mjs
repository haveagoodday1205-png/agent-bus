import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const name = `agent-bus-v${pkg.version}-portable`;
const outRoot = path.join(root, "dist");
const outDir = path.join(outRoot, name);

const files = [
  ".dockerignore",
  ".env.example",
  ".gitignore",
  "agent-bus.mjs",
  "central-gateway.mjs",
  "central_gateway.py",
  "central.config.example.json",
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
set DIR=%~dp0
node "%DIR%agent-bus.mjs" %*
`);

writeText("INSTALL.md", `# Agent Bus Portable Bundle

Requirements:

- Node.js 20+
- Python 3.10+ only if you use the Python gateway or edge node

Quick start:

\`\`\`bash
./agent-bus --help
./agent-bus init edge --preset codex --out edge.config.json
./agent-bus doctor --config edge.config.json
./agent-bus connect --config edge.config.json
\`\`\`

Windows:

\`\`\`powershell
.\\agent-bus.cmd --help
.\\agent-bus.cmd init edge --preset codex --out edge.config.json
\`\`\`
`);

console.log(outDir);

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
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      if (entry === "__pycache__") continue;
      copyRecursive(path.join(from, entry), path.join(to, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function writeText(relative, text, mode) {
  const to = path.join(outDir, relative);
  fs.writeFileSync(to, text, mode ? { mode } : undefined);
}
