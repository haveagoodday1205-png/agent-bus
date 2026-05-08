import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-room-memory-smoke-"));

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
  if (!python) throw new Error("room memory cache smoke requires Python 3.10+.");

  const port = await freePort();
  const token = "sk-room-memory-smoke-token-000000";
  const gateway = `http://127.0.0.1:${port}`;
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "memory-agent.mjs");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 500
    },
    modelRouter: {
      enabled: false,
      backends: []
    },
    edgeTokens: [{
      token,
      nodeId: "memory-edge",
      label: "room memory cache smoke"
    }]
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, `import fs from "node:fs";\nconst file = process.env.AGENT_MESSAGE_FILE || "";\nconst message = file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : process.env.AGENT_MESSAGE || "";\nconst memory = message.includes("Local compressed room memory cache");\nconst toc = message.includes("table_of_contents") && message.includes("messages[");\nconst needle = message.includes("vectorish-memory-cache");\nconst recentOnly = message.includes("Recent room messages");\nconsole.log(\`REPORT: memory_present=\${memory} toc_present=\${toc} needle_present=\${needle} recent_section=\${recentOnly} prompt_bytes=\${Buffer.byteLength(message, "utf8")}\`);\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "memory-edge",
    gatewayUrl: gateway,
    token,
    pollTimeoutMs: 500,
    idleDelayMs: 50,
    defaultTimeoutMs: 10000,
    agents: [{
      id: "memory-agent",
      kind: "smoke",
      role: "worker",
      enabled: true,
      adapter: "command",
      capabilities: ["room", "memory-cache"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(agentScript)}`
    }]
  }, null, 2)}\n`);

  start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data"),
    AGENT_BUS_ROOM_MEMORY_CACHE_ENABLED: "true",
    AGENT_BUS_ROOM_PROMPT_MESSAGE_COUNT: "1",
    AGENT_BUS_ROOM_MEMORY_SNIPPETS: "6",
    AGENT_BUS_ROOM_MEMORY_PROMPT_SNIPPETS: "4",
    AGENT_BUS_ROOM_MEMORY_INDEX_ENTRIES: "8",
    AGENT_BUS_ROOM_MEMORY_PROMPT_INDEX_ENTRIES: "6"
  });
  await waitForJson(`${gateway}/health`);

  start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig,
    AGENT_BUS_GATEWAY_URL: gateway,
    AGENT_BUS_TOKEN: token
  });
  await waitForAgents(gateway, token, ["memory-agent"]);

  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Room memory cache smoke",
      goal: "Verify older room context survives via local compressed memory cache.",
      agents: ["memory-agent"],
      wakeAgents: ["memory-agent"],
      auto_rotate: false,
      max_steps: 4
    })
  });
  await waitForRunCount(gateway, token, room.id, 1);

  for (let i = 0; i < 9; i += 1) {
    await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}/messages`, {
      method: "POST",
      headers: authJsonHeaders(token),
      body: JSON.stringify({
        speaker: i === 2 ? "planner" : `history-${i}`,
        message: i === 2
          ? "REPORT: decision vectorish-memory-cache should be used for old room context. Path: docs/architecture.md Command: npm run smoke:room-memory"
          : `background-${i} ${"low-signal filler ".repeat(200)}`,
        wake: false
      })
    });
  }

  await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}/messages`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      speaker: "latest-user",
      message: "Latest tiny message; older decision should come from memory cache.",
      wake: false
    })
  });

  await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}/wake`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ agent: "memory-agent", reason: "Check whether the old cache design decision survived compaction." })
  });
  const finalRoom = await waitForRunCount(gateway, token, room.id, 2);
  const lastRun = finalRoom.runs?.filter((run) => run.agent_id === "memory-agent").at(-1);
  const output = String(lastRun?.stdout || "");
  assert(/memory_present=true/.test(output), "room prompt did not include local memory cache section");
  assert(/toc_present=true/.test(output), "room prompt did not include memory table of contents");
  assert(/needle_present=true/.test(output), "older high-signal decision was not available in prompt");
  assert(finalRoom.memory_cache?.source_count >= 1, "room snapshot did not persist memory_cache source_count");
  assert((finalRoom.memory_cache?.table_of_contents || []).some((item) => String(item.ref?.label || "").startsWith("messages[")), "memory_cache did not store source positions in table_of_contents");
  assert((finalRoom.memory_cache?.snippets || []).some((item) => String(item.content || "").includes("vectorish-memory-cache")), "memory_cache did not store the high-signal snippet");
  const memoryApi = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}/memory?q=vectorish-memory-cache`, { headers: authHeaders(token) });
  const memoryRef = (memoryApi.memory?.table_of_contents || []).find((item) => String(item.preview || "").includes("vectorish-memory-cache"))?.ref?.label || "";
  assert(memoryRef.startsWith("messages["), "memory API did not expose a source ref for the high-signal message");
  const expanded = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}/memory/expand?ref=${encodeURIComponent(memoryRef)}&around=1&chars=1200`, { headers: authHeaders(token) });
  assert((expanded.items || []).some((item) => item.selected && String(item.content || "").includes("vectorish-memory-cache")), "memory expand API did not return the selected source content");

  const bytes = Number.parseInt(output.match(/prompt_bytes=(\d+)/)?.[1] || "0", 10);
  const result = {
    ok: true,
    quota: "no_model_calls",
    room_id: finalRoom.id,
    memory_source_count: finalRoom.memory_cache?.source_count || 0,
    memory_index_entries: finalRoom.memory_cache?.table_of_contents?.length || 0,
    memory_expand_items: expanded.items?.length || 0,
    memory_snippets: finalRoom.memory_cache?.snippets?.length || 0,
    prompt_bytes: bytes
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Agent Bus room memory cache smoke passed");
    console.log(`Prompt bytes: ${bytes}`);
  }
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!jsonOut) {
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  procs.push(child);
  return child;
}

async function waitForRunCount(gateway, token, roomId, count, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${gateway}/rooms/${encodeURIComponent(roomId)}`, { headers: authHeaders(token) });
    const completed = (room.runs || []).filter((run) => run.status === "completed").length;
    if (completed >= count) return room;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${count} completed room runs`);
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
    await delay(200);
  }
  throw new Error(`Timed out waiting for agents: ${agentIds.join(", ")}`);
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await delay(200);
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

function assert(condition, message) {
  if (!condition) throw new Error(message);
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
    try {
      const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
        cwd: root,
        windowsHide: true,
        stdio: "ignore"
      });
      if (result.status === 0) return command;
    } catch {
      // Try the next candidate.
    }
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

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}
