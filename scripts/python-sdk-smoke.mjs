import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");

try {
  const python = findPython();
  if (!python) throw new Error("Python 3.10+ is required for python SDK smoke.");
  const result = spawnSync(python, ["-c", pythonSmokeSource()], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, AGENT_BUS_SDK_ROOT: root }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`python SDK smoke failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  const payload = JSON.parse(result.stdout);
  if (jsonOut) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("python sdk smoke ok");
    console.log(`Bundle events: ${payload.bundle_events}`);
  }
} catch (error) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  } else {
    console.error(error.stack || error.message || String(error));
  }
  process.exitCode = 1;
}

function pythonSmokeSource() {
  return String.raw`
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.environ["AGENT_BUS_SDK_ROOT"])

from sdk.python.agent_bus_sdk import AgentBusClient, agent_model, replay_room_events, room_event_bundle

TOKEN = "sdk-smoke-token"


class Handler(BaseHTTPRequestHandler):
    def _json(self, value, status=200):
        data = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self):
        return self.headers.get("authorization") == "Bearer " + TOKEN

    def _body(self):
        length = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(length).decode("utf-8") or "{}")

    def do_GET(self):
        if self.path == "/health":
            return self._json({"ok": True, "nodes": 1, "agents": 1, "queued": 0})
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)
        if self.path == "/agents":
            return self._json([{"id": "py-agent", "status": "online"}])
        if self.path == "/nodes":
            return self._json([{"node_id": "py-node", "status": "online", "agents": [{"id": "py-agent"}]}])
        if self.path == "/rooms":
            return self._json([])
        if self.path == "/v1/models":
            return self._json({"object": "list", "data": [{"id": "agent:py-agent"}]})
        return self._json({"error": "not_found"}, 404)

    def do_POST(self):
        if not self._authorized():
            return self._json({"error": "unauthorized"}, 401)
        body = self._body()
        if self.path == "/rooms":
            return self._json({"id": "room_sdk", "status": "active", "goal": body.get("goal"), "agents": body.get("agents", [])}, 201)
        if self.path == "/v1/responses":
            return self._json({"id": "resp_sdk", "output_text": "ok", "agent_bus": {"agent_id": "py-agent"}})
        return self._json({"error": "not_found"}, 404)

    def log_message(self, *_args):
        return


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
gateway = f"http://127.0.0.1:{server.server_port}"

try:
    client = AgentBusClient(gateway_url=gateway, token=TOKEN)
    assert client.health()["ok"] is True
    assert client.agents()[0]["id"] == "py-agent"
    assert client.nodes()[0]["node_id"] == "py-node"
    assert client.models()["data"][0]["id"] == "agent:py-agent"
    created = client.create_room({"goal": "SDK smoke", "agents": ["py-agent"]})
    assert created["id"] == "room_sdk"
    assert client.agent_response("py-agent", "hello")["agent_bus"]["agent_id"] == "py-agent"
    assert agent_model("py-agent") == "agent:py-agent"

    room = {
        "id": "room_sdk",
        "title": "SDK smoke",
        "goal": "Check SDK bundle",
        "status": "completed",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:03Z",
        "agents": ["py-agent"],
        "messages": [{"speaker": "user", "role": "user", "content": "go", "at": "2026-01-01T00:00:00Z"}],
        "runs": [{
            "id": "run_sdk",
            "agent_id": "py-agent",
            "node_id": "py-node",
            "kind": "python",
            "role": "worker",
            "status": "completed",
            "created_at": "2026-01-01T00:00:01Z",
            "started_at": "2026-01-01T00:00:02Z",
            "completed_at": "2026-01-01T00:00:03Z",
            "exit_code": 0,
            "stdout": "REPORT: ok",
            "stderr": "",
        }],
        "reports": [{"speaker": "py-agent", "content": "ok", "at": "2026-01-01T00:00:03Z"}],
        "blackboard": {"notes": [{"speaker": "py-agent", "content": "state", "at": "2026-01-01T00:00:03Z"}]},
    }
    bundle = room_event_bundle(room, reports_only=True)
    replay = replay_room_events(bundle)
    assert bundle["counts"]["run.completed"] == 1
    assert bundle["export_metadata"]["event_count"] == len(bundle["events"])
    assert [event["sequence"] for event in bundle["events"]] == list(range(1, len(bundle["events"]) + 1))
    assert replay["export_metadata"]["format"] == "events"
    assert replay["counts"]["completed_runs"] == 1
    assert replay["counts"]["reports"] == 1

    print(json.dumps({"ok": True, "gateway": gateway, "bundle_events": bundle["counts"]["events"]}))
finally:
    server.shutdown()
`;
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
  for (const candidate of unique(candidates)) {
    const result = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
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

function unique(values) {
  return [...new Set(values)];
}
