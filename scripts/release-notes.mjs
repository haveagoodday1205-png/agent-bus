import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const version = valueAfter("--version") || readPackageVersion();
const outPath = valueAfter("--out");
const notes = buildReleaseNotes(version);

if (outPath) {
  const resolved = path.resolve(process.cwd(), outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, notes, "utf8");
  console.log(resolved);
} else {
  process.stdout.write(notes);
}

function buildReleaseNotes(version) {
  const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const section = changelogSection(changelog, version);
  const tag = version.startsWith("v") ? version : `v${version}`;
  const npmPackage = readPackageName();
  return `${section.trim()}\n\n## Install\n\n| User path | Command or artifact | Verify | Smoke |\n| --- | --- | --- | --- |\n| npm on Linux/macOS/Ubuntu/Windows | \`npm install -g ${npmPackage}\` | \`agent-bus --help\` | \`agent-bus smoke --offline\` |\n| Portable Linux/macOS/Ubuntu | \`agent-bus-${tag}-portable.tar.gz\` | \`sha256sum -c SHA256SUMS\` then \`./agent-bus --help\` | \`./agent-bus smoke --offline\` |\n| Portable Windows | \`agent-bus-${tag}-portable.zip\` | compare with \`SHA256SUMS\`, then \`.\\agent-bus.cmd --help\` | \`.\\agent-bus.cmd smoke --offline\` |\n| Contributor checkout | \`npm install -g .\` | \`agent-bus --help\` | \`agent-bus smoke --offline\` |\n\n## First-run room demo\n\nFrom a contributor checkout, run \`npm run demo:room\` to start a private local gateway, connect two fake command agents, exercise \`@agent-id\` delegation plus \`REPORT\`/\`BLACKBOARD\`/\`DONE\`, and write \`agent-bus-room-demo-report.md\` with \`room export --reports-only\`. The demo is model-free and the generated Markdown is intended to be share-safe by omitting the room goal, full messages, and run output.\n\n## Trust and safety\n\n- Edge nodes connect outward; private edge machines should not need inbound public ports.\n- Prefer pairing codes and scoped edge tokens over sharing the admin token.\n- Health and ping status are shallow reachability signals, not proof that a real model call succeeded.\n- Room participants can read room state; avoid posting secrets, private logs, private prompts, or real config files.\n- Offline smoke, room demo, and packaging checks do not call paid model providers.\n`;
}

function changelogSection(changelog, version) {
  const escaped = escapeRegExp(version.replace(/^v/, ""));
  const heading = new RegExp(`^##\\s+v?${escaped}(?:\\s|$).*`, "im");
  const match = heading.exec(changelog);
  if (!match) throw new Error(`CHANGELOG.md does not contain a section for ${version}`);
  const start = match.index;
  const rest = changelog.slice(start + match[0].length);
  const next = /^##\s+/m.exec(rest);
  return changelog.slice(start, next ? start + match[0].length + next.index : changelog.length).trimEnd() + "\n";
}

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!pkg.version) throw new Error("package.json is missing version");
  return pkg.version;
}

function readPackageName() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!pkg.name) throw new Error("package.json is missing name");
  return pkg.name;
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
