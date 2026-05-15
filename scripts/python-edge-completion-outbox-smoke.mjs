import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const python = findPython();
  if (!python) throw new Error("python edge completion outbox smoke requires Python 3.6+.");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-python-edge-outbox-"));
  const dataDir = path.join(tempDir, "edge-data");
  const configPath = path.join(tempDir, "edge.config.json");
  const edgeConfig = {
    nodeId: "python-edge-outbox-smoke-node",
    gatewayUrl: "http://127.0.0.1:0",
    token: "python-edge-outbox-smoke-token",
    dataDir,
    pollTimeoutMs: 50,
    pollRequestGraceMs: 50,
    requestTimeoutMs: 1000,
    idleDelayMs: 10,
    completeRetryAttempts: 1,
    completeRetryBaseDelayMs: 100,
    agents: [{
      id: "python-outbox-agent",
      kind: "smoke",
      role: "tester",
      enabled: true,
      adapter: "echo",
      capabilities: ["outbox", "python"]
    }]
  };

  try {
    const first = await withGateway({ failComplete: true, sendTask: true }, async ({ url, completions }) => {
      fs.writeFileSync(configPath, `${JSON.stringify({ ...edgeConfig, gatewayUrl: url }, null, 2)}\n`);
      const result = await runPythonEdgeOnce(python, configPath);
      assert(result.code !== 0, "python edge should fail when complete is unavailable in once mode");
      assert(completions.length === 1, "gateway did not receive the first python completion attempt");
      const pending = pendingCompletionFiles(dataDir);
      assert(pending.length === 1, "python edge did not persist a pending completion after complete failure");
      const record = JSON.parse(fs.readFileSync(pending[0], "utf8"));
      assert(record.body?.run_id === "run_python_outbox_smoke", "pending completion stored the wrong run id");
      assert(/python outbox smoke task/.test(record.body?.result?.stdout || ""), "pending completion did not store agent stdout");
      return { pendingFile: pending[0], stderr: result.stderr };
    });

    const second = await withGateway({ failComplete: false, sendTask: false }, async ({ url, completions }) => {
      fs.writeFileSync(configPath, `${JSON.stringify({ ...edgeConfig, gatewayUrl: url }, null, 2)}\n`);
      const result = await runPythonEdgeOnce(python, configPath);
      assert(result.code === 0, `python edge replay failed: ${result.stderr || result.stdout}`);
      assert(completions.length === 1, "gateway did not receive replayed python pending completion");
      assert(completions[0].run_id === "run_python_outbox_smoke", "replayed completion had the wrong run id");
      assert(/python outbox smoke task/.test(completions[0].result?.stdout || ""), "replayed completion lost stdout");
      assert(pendingCompletionFiles(dataDir).length === 0, "python edge did not delete pending completion after replay");
      return { stdout: result.stdout };
    });

    await withGateway({ failComplete: false, failOutputEvents: true, sendTask: true }, async ({ url, completions }) => {
      fs.writeFileSync(configPath, `${JSON.stringify({ ...edgeConfig, gatewayUrl: url }, null, 2)}\n`);
      const result = await runPythonEdgeOnce(python, configPath);
      assert(result.code === 0, `python edge should complete when only output events fail: ${result.stderr || result.stdout}`);
      assert(completions.length === 1, "gateway did not receive completion after output event failure");
      assert(/python outbox smoke task/.test(completions[0].result?.stdout || ""), "completion lost stdout after output event failure");
    });

    console.log(JSON.stringify({
      ok: true,
      quota: "no_model_calls",
      runtime: "python_edge",
      pending_file: path.basename(first.pendingFile),
      first_complete_attempt_persisted: true,
      replayed_completion: true,
      output_events_best_effort: true,
      first_stderr: first.stderr.trim().slice(0, 240),
      second_stdout: second.stdout.trim().slice(0, 240)
    }, null, 2));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function withGateway(options, fn) {
  const state = {
    taskSent: false,
    completions: []
  };
  const server = http.createServer(async (req, res) => {
    const body = await readJson(req);
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    if (req.url === "/edge/register") return send(res, 200, { ok: true });
    if (req.url === "/edge/events") {
      if (options.failOutputEvents && body.event?.type === "run.output") {
        return send(res, 503, { error: "temporary output event outage" });
      }
      return send(res, 200, { ok: true });
    }
    if (req.url === "/edge/poll") {
      if (options.sendTask && !state.taskSent) {
        state.taskSent = true;
        return send(res, 200, {
          type: "task",
          task: {
            id: "task_python_outbox_smoke",
            run_id: "run_python_outbox_smoke",
            trace_id: "trace_python_outbox_smoke",
            agent_id: "python-outbox-agent",
            message: "python outbox smoke task"
          }
        });
      }
      return send(res, 200, { type: "idle", node_id: body.node_id || "" });
    }
    if (req.url === "/edge/complete") {
      state.completions.push(body);
      if (options.failComplete) return send(res, 503, { error: "temporary complete outage" });
      return send(res, 200, { ok: true, run_id: body.run_id });
    }
    return send(res, 404, { error: "not found" });
  });
  await listen(server);
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ url, completions: state.completions });
  } finally {
    await close(server);
  }
}

function runPythonEdgeOnce(python, configPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ["edge_node.py", "connect", "--once", "--config", configPath], {
      cwd: root,
      windowsHide: true,
      env: smokeEnv()
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function pendingCompletionFiles(dataDir) {
  const dir = path.join(dataDir, "edge-completions");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
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
  for (const candidate of [...new Set(candidates)]) {
    const result = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 6) else 1)"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore"
    });
    if (!result.error && result.status === 0) return candidate;
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

function smokeEnv() {
  const env = { ...process.env };
  for (const name of [
    "AGENT_BUS_GATEWAY_URL",
    "AGENT_BUS_TOKEN",
    "AGENT_BUS_NODE_ID",
    "AGENT_BUS_CONFIG",
    "AGENT_BUS_DATA_DIR",
    "AGENT_BUS_COMPLETION_OUTBOX_DIR"
  ]) {
    delete env[name];
  }
  return env;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
