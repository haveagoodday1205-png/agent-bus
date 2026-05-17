import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const node = process.execPath;
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-issue-demo-"));
const FEEDBACK_URL = "https://github.com/haveagoodday1205-png/agent-bus/issues/new?template=issue_demo_feedback.yml";
const TRY_DOCS_URL = "https://github.com/haveagoodday1205-png/agent-bus/blob/main/docs/try-agent-bus.md";

main().catch((err) => {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}).finally(() => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const python = findPython();
  if (!python) throw new Error("Issue-to-PR demo requires Python 3.10+ for the room gateway.");

  const port = await freePort();
  const token = "sk-issue-demo-token-000000";
  const gateway = `http://127.0.0.1:${port}`;
  const outDir = uniqueOutputDir(path.resolve(optionValue(args, "--out-dir") || "agent-bus-issue-demo"));
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "issue-demo-agent.mjs");
  const issue = loadIssue(args);
  const artifacts = {
    issue: path.join(outDir, "issue.md"),
    report: path.join(outDir, "agent-bus-issue-demo-report.md"),
    events: path.join(outDir, "agent-bus-issue-demo-events.json"),
    replay: path.join(outDir, "agent-bus-issue-demo-replay.md"),
    patch: path.join(outDir, "agent-bus-issue-demo.patch"),
    prDraft: path.join(outDir, "agent-bus-issue-demo-pr.md"),
    manifest: path.join(outDir, "agent-bus-issue-demo-manifest.json"),
    summary: path.join(outDir, "README.md")
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(artifacts.issue, issue.markdown);
  fs.writeFileSync(artifacts.patch, demoPatch(issue));
  fs.writeFileSync(artifacts.prDraft, demoPrDraft(issue));

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 2000
    },
    modelRouter: {
      enabled: false,
      backends: []
    },
    edgeTokens: [{
      token,
      nodeId: "issue-demo-edge",
      label: "local issue-to-pr demo"
    }]
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, demoAgentSource());
  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "issue-demo-edge",
    gatewayUrl: gateway,
    token,
    pollTimeoutMs: 2000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [
      demoAgent("demo-planner", "planner", ["planning", "github-issue", "demo"], agentScript),
      demoAgent("demo-coder", "coder", ["code", "patch", "demo"], agentScript),
      demoAgent("demo-reviewer", "reviewer", ["review", "qa", "demo"], agentScript)
    ]
  }, null, 2)}\n`);

  step("Agent Bus issue-to-PR flagship demo");
  step("Maturity note: proves local room handoffs plus report/event replay/patch/PR-draft artifacts; does not contact GitHub, create branches/commits, open a real PR, or run real model tools yet.");
  step("1. Starting a private local gateway");
  start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${gateway}/health`);

  step("2. Starting a local edge with planner/coder/reviewer demo agents");
  start(node, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig,
    AGENT_BUS_GATEWAY_URL: gateway,
    AGENT_BUS_TOKEN: token
  });
  await waitForAgents(gateway, token, ["demo-planner", "demo-coder", "demo-reviewer"]);

  step("3. Creating an issue room and waking the planner");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: `Issue-to-PR demo: ${issue.title}`,
      goal: [
        "Turn this GitHub-style issue into a PR-ready patch draft using Agent Bus room coordination.",
        "",
        issue.markdown,
        "",
        "Expected demo artifacts are already staged locally: issue.md, agent-bus-issue-demo.patch, agent-bus-issue-demo-pr.md.",
        "Planner should triage, coder should describe the patch, reviewer should verify and mark DONE."
      ].join("\n"),
      agents: ["demo-planner", "demo-coder", "demo-reviewer"],
      wakeAgents: ["demo-planner"],
      auto_rotate: false,
      max_steps: 6
    })
  });

  const completed = await waitForRoomComplete(gateway, token, room.id);
  step(`4. Room completed: ${completed.id}`);
  if (!jsonOut) {
    for (const report of completed.reports || []) {
      console.log(`   REPORT from ${report.speaker}: ${report.content}`);
    }
  }

  step("5. Writing shareable room artifacts");
  await runCli(["room", "export", completed.id, "--reports-only", "--out", artifacts.report, "--gateway", gateway, "--token", token]);
  await runCli(["room", "export", completed.id, "--format", "events", "--out", artifacts.events, "--gateway", gateway, "--token", token]);
  await runCli(["room", "replay", "--in", artifacts.events, "--format", "markdown", "--out", artifacts.replay]);

  writeDemoSummary(artifacts.summary, {
    artifacts,
    completed,
    issue,
    outDir
  });
  writeDemoManifest(artifacts.manifest, {
    artifacts,
    completed,
    issue,
    outDir
  });

  const result = issueDemoResult({ artifacts, completed, issue, outDir });
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`   wrote ${outDir}`);
  console.log(`   summary: ${artifacts.summary}`);
  console.log(`   manifest: ${artifacts.manifest}`);
  console.log(`   feedback: ${FEEDBACK_URL}`);
  console.log("Demo complete. The directory contains a README, issue, report, event replay, patch, PR draft, and manifest artifacts.");
}

function demoAgent(id, role, capabilities, agentScript) {
  return {
    id,
    kind: "demo",
    role,
    enabled: true,
    adapter: "command",
    capabilities,
    runCommand: `${quoteCommandArg(node)} ${quoteCommandArg(agentScript)}`
  };
}

function demoAgentSource() {
  return `
const id = process.env.AGENT_ID || "demo-agent";

if (id === "demo-planner") {
  console.log("REPORT: Planner triaged the GitHub-style issue, identified docs/demo onboarding as the patch surface, and delegated implementation to demo-coder.");
  console.log("BLACKBOARD: issue-to-pr-demo priority=docs-first patch=agent-bus-issue-demo.patch pr_draft=agent-bus-issue-demo-pr.md");
  console.log("@demo-coder: Produce the PR-ready patch narrative for the staged artifact agent-bus-issue-demo.patch, then ask demo-reviewer to verify the demo artifact set.");
} else if (id === "demo-coder") {
  console.log("REPORT: Coder prepared a PR-ready patch artifact that documents the issue-to-PR demo path without touching live GitHub or model providers.");
  console.log("BLACKBOARD: patch artifact adds an Issue-to-PR flagship demo section and keeps the path no-secret/no-quota.");
  console.log("@demo-reviewer: Review the staged patch and PR draft conceptually, confirm the room export and event replay artifacts are suitable for a public demo, then mark DONE if accepted.");
} else {
  console.log("REPORT: Reviewer accepted the issue-to-PR demo artifact set: issue.md, reports-only room export, event bundle, replay summary, patch draft, and PR draft.");
  console.log("BLACKBOARD: flagship demo minimum is ready; next increment can swap fake agents for real Codex/Hermes/OpenClaw and optionally open a GitHub PR.");
  console.log("DONE");
}
`;
}

function loadIssue(args) {
  const title = optionValue(args, "--title") || "Document the issue-to-PR demo path";
  const issueFile = optionValue(args, "--issue-file");
  const issueText = issueFile
    ? fs.readFileSync(path.resolve(issueFile), "utf8")
    : optionValue(args, "--issue") || [
      "New users understand rooms after reading the docs, but they do not yet see the bigger promise:",
      "multiple agents turning an issue into a patch or PR artifact.",
      "",
      "Please add a no-secret demo path that starts from a GitHub-style issue, coordinates planner/coder/reviewer agents,",
      "and leaves behind shareable report, replay, patch, and PR draft artifacts."
    ].join("\n");
  return {
    title,
    body: issueText,
    markdown: [`# ${title}`, "", issueText.trim(), ""].join("\n")
  };
}

function demoPatch(issue) {
  return [
    "diff --git a/docs/demo-local.md b/docs/demo-local.md",
    "index 0000000..1111111 100644",
    "--- a/docs/demo-local.md",
    "+++ b/docs/demo-local.md",
    "@@",
    "+## Issue-to-PR flagship demo",
    "+",
    "+Run `agent-bus demo issue` to simulate a GitHub issue moving through an Agent Bus room.",
    "+The demo starts a private local gateway, connects planner/coder/reviewer agents, exports a",
    "+reports-only room summary, writes a redacted event bundle, replays it offline, and leaves a",
    "+patch plus PR draft artifact in `agent-bus-issue-demo/`.",
    "+",
    `+Demo issue: ${issue.title}`,
    "+"
  ].join("\n");
}

function demoPrDraft(issue) {
  return [
    "# PR Draft: Add issue-to-PR flagship demo",
    "",
    "## Summary",
    "",
    "- Adds a no-secret Agent Bus demo that turns a GitHub-style issue into a PR-ready artifact set.",
    "- Produces a room report, event bundle, replay summary, patch draft, and PR draft.",
    "- Keeps the path local and model-free so contributors can run it from npm or a checkout.",
    "",
    "## Source Issue",
    "",
    issue.markdown.trim(),
    "",
    "## Verification",
    "",
    "- `agent-bus demo issue`",
    "- review `agent-bus-issue-demo-report.md`",
    "- replay `agent-bus-issue-demo-events.json`",
    "",
    "## Notes",
    "",
    "This is a draft artifact generated by the local flagship demo. It proves the no-quota room handoff, report/export/replay, patch artifact, and PR draft path. It does not contact GitHub, create branches or commits, open a real PR, run real model tools, or replace maintainer approval. A later increment can connect to the GitHub API and open a real PR after human approval.",
    ""
  ].join("\n");
}

function writeDemoSummary(file, { artifacts, completed, issue, outDir }) {
  const reports = Array.isArray(completed.reports) ? completed.reports : [];
  const notes = Array.isArray(completed.blackboard?.notes) ? completed.blackboard.notes : [];
  const nextCommands = issueDemoNextCommands(outDir);
  const artifactRows = [
    ["Demo index", artifacts.summary],
    ["Source issue", artifacts.issue],
    ["Reports-only room export", artifacts.report],
    ["Room event bundle", artifacts.events],
    ["Offline replay", artifacts.replay],
    ["Patch draft", artifacts.patch],
    ["PR draft", artifacts.prDraft],
    ["Machine-readable manifest", artifacts.manifest]
  ];
  const lines = [
    "# Agent Bus Issue-to-PR Demo",
    "",
    "This directory was generated by `agent-bus demo issue`. It is designed as a share-safe local proof that a GitHub-style issue can move through an Agent Bus room from planner to coder to reviewer and leave patch/PR artifacts behind without contacting GitHub or a model provider.",
    "",
    "## Result",
    "",
    "| Check | Result |",
    "| --- | --- |",
    `| Mode | ${tableValue("local no-quota demo")} |`,
    `| Output directory | ${tableValue(path.basename(outDir))} |`,
    `| Room status | ${tableValue(completed.status || "unknown")} |`,
    `| Agents | ${tableValue("demo-planner -> demo-coder -> demo-reviewer")} |`,
    `| Reports captured | ${reports.length} |`,
    `| Blackboard notes | ${notes.length} |`,
    `| Patch draft | ${fs.existsSync(artifacts.patch) ? "written" : "missing"} |`,
    `| PR draft | ${fs.existsSync(artifacts.prDraft) ? "written" : "missing"} |`,
    "",
    "## Source Issue",
    "",
    issue.markdown.trim(),
    "",
    "## Demo Evidence",
    "",
    ...reports.map((report) => `- REPORT from ${report.speaker || "agent"}: ${oneLine(report.content)}`),
    ...notes.map((note) => `- BLACKBOARD from ${note.speaker || "agent"}: ${oneLine(note.content)}`),
    "",
    "## Artifacts",
    "",
    ...artifactRows.map(([label, target]) => `- ${label}: [${path.basename(target)}](${path.basename(target)})`),
    "",
    "## Next Commands",
    "",
    ...nextCommands.map((item) => `- ${item.label}: \`${item.command}\``),
    "",
    "## What This Proves",
    "",
    "- A private local Central and Edge can coordinate three room agents.",
    "- Planner, coder, and reviewer handoffs work through `@agent-id` directives.",
    "- `REPORT`, `BLACKBOARD`, and `DONE` directives become inspectable room evidence.",
    "- Room export, event replay, patch draft, and PR draft artifacts can be generated without model quota.",
    "",
    "## Current Boundary",
    "",
    "This demo does not read live GitHub issues, create branches or commits, open a real PR, run real model tools, or replace maintainer review. If you used `--issue-file` or `--issue` with private text, review the generated artifacts before sharing them.",
    "",
    "## Feedback",
    "",
    `Open issue-to-PR demo feedback: ${FEEDBACK_URL}`,
    `Try Agent Bus guide: ${TRY_DOCS_URL}`,
    ""
  ];
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function writeDemoManifest(file, { artifacts, completed, issue, outDir }) {
  const reports = Array.isArray(completed.reports) ? completed.reports : [];
  const notes = Array.isArray(completed.blackboard?.notes) ? completed.blackboard.notes : [];
  const manifest = {
    object: "agent_bus.issue_to_pr_demo_manifest",
    version: 1,
    generated_at: new Date().toISOString(),
    share_safe_default: true,
    mode: "issue-to-pr-demo",
    quota: "no_model_calls",
    github: "not_contacted",
    model_provider: "not_contacted",
    title: issue.title,
    out_dir: outDir,
    room: {
      id: completed.id,
      status: completed.status,
      reports: reports.length,
      blackboard_notes: notes.length
    },
    agents: ["demo-planner", "demo-coder", "demo-reviewer"],
    artifacts: artifactBasenames(artifacts),
    next_commands: issueDemoNextCommands(outDir),
    proves: [
      "local Central/Edge startup",
      "planner -> coder -> reviewer room handoff",
      "REPORT/BLACKBOARD/DONE capture",
      "reports-only export, event replay, patch draft, and PR draft artifacts"
    ],
    does_not_prove: [
      "real GitHub issue ingestion",
      "branch creation, commits, or live PR opening",
      "real model/provider tool execution",
      "production auth policy readiness"
    ],
    feedback_url: FEEDBACK_URL,
    try_docs_url: TRY_DOCS_URL
  };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

function artifactBasenames(artifacts) {
  return Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, path.basename(value)]));
}

function issueDemoNextCommands(outDir) {
  return [
    {
      label: "Re-run this demo into a fresh folder",
      command: "agent-bus demo issue --out-dir agent-bus-issue-demo"
    },
    {
      label: "Run the smallest no-secret room proof",
      command: "agent-bus demo zero-token --out-dir agent-bus-demo-output"
    },
    {
      label: "Open the generated demo index",
      command: `cd ${shellPath(outDir)} && ${openFileCommand("README.md")}`
    }
  ];
}

function shellPath(value) {
  const text = String(value || "");
  return /[\s"'`$\\]/.test(text) ? JSON.stringify(text) : text;
}

function openFileCommand(file) {
  if (process.platform === "win32") return `start ${file}`;
  if (process.platform === "darwin") return `open ${file}`;
  return `xdg-open ${file}`;
}

function issueDemoResult({ artifacts, completed, issue, outDir }) {
  const reports = Array.isArray(completed.reports) ? completed.reports : [];
  const notes = Array.isArray(completed.blackboard?.notes) ? completed.blackboard.notes : [];
  return {
    ok: true,
    mode: "issue-to-pr-demo",
    quota: "no_model_calls",
    github: "not_contacted",
    model_provider: "not_contacted",
    title: issue.title,
    out_dir: outDir,
    room_id: completed.id,
    room_status: completed.status,
    agents: ["demo-planner", "demo-coder", "demo-reviewer"],
    reports: reports.length,
    blackboard_notes: notes.length,
    feedback_url: FEEDBACK_URL,
    try_docs_url: TRY_DOCS_URL,
    artifacts: {
      summary: artifacts.summary,
      issue: artifacts.issue,
      report: artifacts.report,
      events: artifacts.events,
      replay: artifacts.replay,
      patch: artifacts.patch,
      pr_draft: artifacts.prDraft,
      manifest: artifacts.manifest
    },
    next_commands: issueDemoNextCommands(outDir)
  };
}

function step(message) {
  if (!jsonOut) console.log(message);
}

function oneLine(value, limit = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function tableValue(value) {
  return String(value || "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: demoChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    if (!jsonOut && /listening|connected/.test(text)) process.stdout.write(`   ${text}`);
  });
  child.stderr.on("data", (chunk) => {
    if (!jsonOut) process.stderr.write(chunk);
  });
  procs.push(child);
  return child;
}

function runCli(args, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(node, [path.join(root, "agent-bus.mjs"), ...args], {
      cwd: root,
      env: demoChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-bus ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(new Error(`agent-bus ${args.join(" ")} exited with ${code}\n${stderr || stdout}`));
    });
  });
}

async function waitForAgents(gateway, token, agentIds, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const agents = await requestJson(`${gateway}/agents`, { headers: authHeaders(token) });
      const online = new Set(agents.filter((agent) => agent.status === "online").map((agent) => agent.id));
      if (agentIds.every((id) => online.has(id))) return;
    } catch {
      // Retry until the edge registers.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForRoomComplete(gateway, token, roomId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    if (room.status === "completed") return room;
    if (room.status === "paused") throw new Error(`Room paused before completion: ${roomId}`);
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId}`);
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const command of candidates) {
    const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore"
    });
    if (!result.error && result.status === 0) return command;
  }
  return "";
}

function commonBundledPythonPaths() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python"),
    path.join(home, ".codex", "runtimes", "codex-primary-runtime", "dependencies", "python")
  ];
  const names = process.platform === "win32"
    ? ["python.exe"]
    : ["bin/python3", "bin/python", "python3", "python"];
  return roots.flatMap((rootDir) => names.map((name) => path.join(rootDir, name)));
}

function uniqueOutputDir(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${basePath}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find an unused output directory near ${basePath}`);
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return "";
  return args[index + 1] || "";
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}

function demoChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];
