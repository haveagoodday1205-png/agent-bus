import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const network = args.includes("--network");
const checks = [];

try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const version = valueAfter("--version") || pkg.version;
  const tag = version.startsWith("v") ? version : `v${version}`;
  const head = git(["rev-parse", "--short=12", "HEAD"], { required: false }).stdout.trim();
  const branch = git(["branch", "--show-current"], { required: false }).stdout.trim();

  check("package version", Boolean(pkg.version), `package.json version ${pkg.version || "missing"}`);
  check("requested version", /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version), version);
  check("package version matches preflight version", pkg.version === version.replace(/^v/, ""), `package=${pkg.version} preflight=${version}`);
  check("changelog section", changelogHasVersion(version), `CHANGELOG.md contains ${version.replace(/^v/, "")}`);
  check("release notes generation", runNode(["scripts/release-notes.mjs", "--version", version]).status === 0, "npm run release:notes can render notes");

  const status = git(["status", "--short"], { required: false }).stdout.trim();
  check("git working tree clean", status.length === 0, status ? "uncommitted changes present" : "clean");
  check("git branch", branch === "main", branch ? `current branch ${branch}` : "detached or unknown branch");
  check("git head", Boolean(head), head || "unknown");

  const localTag = git(["tag", "--list", tag], { required: false }).stdout.trim();
  check("local release tag not already present", !localTag, localTag ? `${tag} already exists locally` : `${tag} absent locally`);

  const remoteUrl = git(["remote", "get-url", "origin"], { required: false }).stdout.trim();
  check("origin remote configured", Boolean(remoteUrl), remoteUrl ? "origin configured" : "origin missing");

  let remoteTag = "skipped";
  let npmStatus = "skipped";
  if (network) {
    remoteTag = git(["ls-remote", "--tags", "origin", tag], { required: false }).stdout.trim();
    check("remote release tag not already present", !remoteTag, remoteTag ? `${tag} already exists on origin` : `${tag} absent on origin`);
    const npm = spawnSync("npm", ["view", `agent-bus@${version.replace(/^v/, "")}`, "version"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, npm_config_loglevel: "error" }
    });
    npmStatus = npm.status === 0 ? npm.stdout.trim() : "not published or npm unavailable";
    check("npm package not already published", npm.status !== 0, npm.status === 0 ? `agent-bus@${npm.stdout.trim()} already published` : npmStatus);
  }

  const result = {
    ok: checks.every((item) => item.ok),
    version: version.replace(/^v/, ""),
    tag,
    branch,
    head,
    network_checks: network,
    checks,
    next_steps: [
      "git checkout main && git pull --ff-only",
      "npm run release:check",
      "npm run release:notes -- --out dist/release-notes.md",
      `git tag ${tag}`,
      `git push origin ${tag}`,
      "npm publish --access public",
      "npm view agent-bus version",
      "verify GitHub Release assets and smoke npm/portable install paths"
    ]
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result, { remoteTag, npmStatus });
  }
  if (!result.ok) process.exitCode = 1;
} catch (err) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err), checks }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: String(detail || "") });
}

function changelogHasVersion(version) {
  const text = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const escaped = escapeRegExp(version.replace(/^v/, ""));
  return new RegExp(`^##\\s+v?${escaped}(?:\\s|$)`, "im").test(text);
}

function runNode(commandArgs) {
  return spawnSync(process.execPath, commandArgs, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, npm_config_loglevel: "error" }
  });
}

function git(commandArgs, options = {}) {
  const result = spawnSync("git", commandArgs, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true
  });
  if (options.required !== false && result.status !== 0) {
    throw new Error(`git ${commandArgs.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function printText(result) {
  console.log(`Agent Bus release preflight for ${result.tag}`);
  console.log(`Commit: ${result.head || "unknown"} (${result.branch || "unknown branch"})`);
  for (const item of result.checks) {
    console.log(`${item.ok ? "ok" : "FAIL"} ${item.name}: ${item.detail}`);
  }
  console.log("");
  console.log(result.network_checks ? "Network checks: enabled" : "Network checks: skipped (pass --network to check origin tag and npm publish state)");
  console.log("");
  console.log("Next release steps:");
  for (const [index, step] of result.next_steps.entries()) {
    console.log(`${index + 1}. ${step}`);
  }
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
