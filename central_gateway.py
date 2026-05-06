#!/usr/bin/env python3
import json
import mimetypes
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError


STATE = {
    "nodes": {},
    "queues": {},
    "runs": {},
    "threads": {},
    "conditions": {},
}


def main():
    config = load_config()
    ensure_dirs(config)
    server = ThreadingHTTPServer((config["host"], int(config["port"])), Handler)
    server.config = config
    print(f"central-gateway.py listening on http://{config['host']}:{config['port']}", flush=True)
    server.serve_forever()


def load_config():
    config_path = Path(os.environ.get("AGENT_BUS_CONFIG", "central.config.json"))
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
    else:
        config = {}
    config["host"] = os.environ.get("AGENT_BUS_HOST", config.get("host", "127.0.0.1"))
    config["port"] = int(os.environ.get("AGENT_BUS_PORT", config.get("port", 8788)))
    config["token"] = os.environ.get("AGENT_BUS_TOKEN", config.get("token", ""))
    config["dataDir"] = str(Path(config.get("dataDir", "./data/central")).resolve())
    config.setdefault("defaults", {})
    config["defaults"]["mode"] = config["defaults"].get("mode", "orchestrate")
    config["defaults"]["pollTimeoutMs"] = int(config["defaults"].get("pollTimeoutMs", 25000))
    config.setdefault("modelRouter", {})
    config["modelRouter"].setdefault("enabled", True)
    config["modelRouter"].setdefault("backends", [])
    return config


def ensure_dirs(config):
    root = Path(config["dataDir"])
    (root / "threads").mkdir(parents=True, exist_ok=True)
    (root / "runs").mkdir(parents=True, exist_ok=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentBusPython/0.1"

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/health":
                return self.json({
                    "ok": True,
                    "nodes": len(STATE["nodes"]),
                    "agents": len(public_agents()),
                    "queued": sum(len(q) for q in STATE["queues"].values()),
                })
            if path == "/console" or path.startswith("/console/"):
                return self.console_asset(path)
            self.require_auth()
            if path == "/agents":
                return self.json(public_agents())
            if path == "/v1/models":
                return self.json(openai_models(self.config))
            if path.startswith("/threads/"):
                item = read_snapshot(self.config, "threads", path.rsplit("/", 1)[-1])
                return self.json(item or {"error": "not_found"}, 200 if item else 404)
            if path.startswith("/runs/"):
                item = read_snapshot(self.config, "runs", path.rsplit("/", 1)[-1])
                return self.json(item or {"error": "not_found"}, 200 if item else 404)
            return self.json({"error": "not_found"}, 404)
        except Exception as exc:
            return self.json({"error": str(exc)}, getattr(exc, "status_code", 500))

    def do_POST(self):
        try:
            self.require_auth()
            path = urlparse(self.path).path
            body = self.read_json()
            if path == "/route":
                selection = select_agents(body.get("message", ""), body)
                return self.json(public_selection(selection))
            if path == "/v1/chat/completions":
                return self.proxy_chat_completions(body)
            if path == "/threads":
                return self.json(create_thread(self.config, body), 201)
            if path == "/edge/register":
                return self.json(register_node(self.config, body))
            if path == "/edge/poll":
                return self.json(poll_node(body.get("node_id"), int(body.get("timeout_ms") or self.config["defaults"]["pollTimeoutMs"])))
            if path == "/edge/events":
                record_event(self.config, body)
                return self.json({"ok": True})
            if path == "/edge/complete":
                return self.json(complete_run(self.config, body))
            return self.json({"error": "not_found"}, 404)
        except Exception as exc:
            return self.json({"error": str(exc)}, getattr(exc, "status_code", 500))

    @property
    def config(self):
        return self.server.config

    def require_auth(self):
        token = self.config.get("token")
        if not token:
            return
        auth = self.headers.get("authorization", "")
        header_token = self.headers.get("x-agent-bus-token", "")
        got = auth[7:] if auth.lower().startswith("bearer ") else header_token
        if got != token:
            err = Exception("unauthorized")
            err.status_code = 401
            raise err

    def read_json(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        return json.loads(raw) if raw.strip() else {}

    def json(self, value, status=200):
        data = json.dumps(redact(value), ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def console_asset(self, request_path):
        root = Path(__file__).resolve().parent / "console"
        relative = "index.html" if request_path in ("/console", "/console/") else request_path.replace("/console/", "", 1)
        file_path = (root / relative).resolve()
        if not str(file_path).startswith(str(root.resolve())) or not file_path.exists() or file_path.is_dir():
            return self.json({"error": "not_found"}, 404)
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        if file_path.suffix == ".js":
            content_type = "text/javascript"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("content-type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
        self.send_header("cache-control", "no-store" if file_path.name == "index.html" else "public, max-age=60")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def proxy_chat_completions(self, body):
        backend, routed_model = select_model_backend(self.config, body.get("model"))
        proxied = dict(body)
        proxied["model"] = routed_model
        data = json.dumps(proxied, ensure_ascii=False).encode("utf-8")
        req = Request(join_url(backend["baseUrl"], "/chat/completions"), data=data, method="POST")
        req.add_header("content-type", "application/json")
        req.add_header("accept", "text/event-stream" if body.get("stream") else "application/json")
        api_key = backend_api_key(backend)
        if api_key:
            req.add_header("authorization", "Bearer " + api_key)
        elif backend.get("passClientAuthorization"):
            auth = self.headers.get("authorization")
            if auth:
                req.add_header("authorization", auth)
        try:
            with urlopen(req, timeout=int(backend.get("timeoutSeconds", 600))) as res:
                content_type = res.headers.get("content-type", "application/json")
                self.send_response(res.status)
                self.send_header("content-type", content_type)
                self.send_header("cache-control", "no-store")
                self.send_header("x-agent-bus-backend", backend["id"])
                self.end_headers()
                while True:
                    chunk = res.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            self.send_header("content-type", exc.headers.get("content-type", "application/json"))
            self.send_header("cache-control", "no-store")
            self.send_header("x-agent-bus-backend", backend["id"])
            self.end_headers()
            self.wfile.write(payload or json.dumps({"error": {"message": str(exc)}}).encode("utf-8"))
        except Exception as exc:
            self.json({
                "error": {
                    "message": str(exc),
                    "type": "agent_bus_upstream_error",
                    "backend": backend.get("id", "backend"),
                }
            }, 502)

    def log_message(self, fmt, *args):
        return


def register_node(config, body):
    node_id = body.get("node_id")
    if not node_id:
        err = Exception("node_id is required")
        err.status_code = 400
        raise err
    agents = []
    for agent in body.get("agents") or []:
        if not agent.get("id"):
            continue
        agents.append({
            "id": agent["id"],
            "node_id": node_id,
            "kind": agent.get("kind", "agent"),
            "role": agent.get("role", "worker"),
            "enabled": agent.get("enabled", True) is not False,
            "capabilities": agent.get("capabilities") or [],
        })
    old = STATE["nodes"].get(node_id, {})
    node = {
        "node_id": node_id,
        "hostname": body.get("hostname"),
        "version": body.get("version"),
        "status": "online",
        "registered_at": old.get("registered_at") or now(),
        "last_seen_at": now(),
        "agents": agents,
    }
    STATE["nodes"][node_id] = node
    STATE["queues"].setdefault(node_id, [])
    STATE["conditions"].setdefault(node_id, threading.Condition())
    append_jsonl(config, "nodes.jsonl", node)
    return node


def public_agents():
    out = []
    for node in STATE["nodes"].values():
        for agent in node.get("agents", []):
            if agent.get("enabled") is False:
                continue
            item = dict(agent)
            item["node_status"] = node.get("status")
            item["node_last_seen_at"] = node.get("last_seen_at")
            out.append(item)
    return sorted(out, key=lambda item: item["id"])


def openai_models(config):
    models = []
    for backend in model_backends(config):
        for model in backend.get("models") or []:
            models.append({
                "id": model,
                "object": "model",
                "created": 0,
                "owned_by": backend.get("id", "agent-bus"),
            })
        for alias in (backend.get("modelAliases") or {}).keys():
            models.append({
                "id": alias,
                "object": "model",
                "created": 0,
                "owned_by": backend.get("id", "agent-bus"),
            })
    seen = {}
    for model in models:
        seen[model["id"]] = model
    return {"object": "list", "data": sorted(seen.values(), key=lambda item: item["id"])}


def select_model_backend(config, requested_model):
    backends = model_backends(config)
    if not backends:
        err = Exception("no model backends configured")
        err.status_code = 503
        raise err
    requested = requested_model or config.get("modelRouter", {}).get("defaultModel")
    default_id = config.get("modelRouter", {}).get("defaultBackend")

    for backend in backends:
        aliases = backend.get("modelAliases") or {}
        if requested in aliases:
            return backend, aliases[requested]
        if requested in (backend.get("models") or []):
            return backend, requested

    if default_id:
        for backend in backends:
            if backend.get("id") == default_id:
                aliases = backend.get("modelAliases") or {}
                return backend, aliases.get(requested, requested or backend.get("defaultModel") or (backend.get("models") or [""])[0])

    backend = backends[0]
    aliases = backend.get("modelAliases") or {}
    return backend, aliases.get(requested, requested or backend.get("defaultModel") or (backend.get("models") or [""])[0])


def model_backends(config):
    if config.get("modelRouter", {}).get("enabled") is False:
        return []
    out = []
    for backend in config.get("modelRouter", {}).get("backends") or []:
        if backend.get("enabled", True) is False:
            continue
        if backend.get("baseUrl"):
            item = dict(backend)
            item["baseUrl"] = item["baseUrl"].rstrip("/")
            out.append(item)
    return out


def backend_api_key(backend):
    if backend.get("apiKeyEnv") and os.environ.get(backend["apiKeyEnv"]):
        return os.environ[backend["apiKeyEnv"]]
    return backend.get("apiKey")


def join_url(base_url, suffix):
    return base_url.rstrip("/") + "/" + suffix.lstrip("/")


def select_agents(message, body):
    agents = public_agents()
    if not agents:
        err = Exception("no registered edge agents")
        err.status_code = 409
        raise err
    wanted = body.get("agents")
    if wanted:
        selected = [agent for agent in agents if agent["id"] in wanted]
        missing = [agent_id for agent_id in wanted if agent_id not in {agent["id"] for agent in selected}]
        if missing:
            err = Exception("unknown registered agents: " + ", ".join(missing))
            err.status_code = 400
            raise err
        return {"mode": "explicit", "reason": "Explicit agent selector was provided.", "matched": ["agents"], "agents": selected}
    if body.get("mode") != "orchestrate":
        return {"mode": "broadcast", "reason": "Broadcast selected all registered agents.", "matched": ["all"], "agents": agents}

    text = (message or "").lower()
    rules = [
        ("code", r"code|repo|bug|test|patch|commit|review|typescript|javascript|node|python|实现|代码|修复|测试|仓库|重构",
         lambda a: a["kind"] == "codex" or a["role"] == "coder" or has_any(a, ["code", "review"])),
        ("ops", r"shell|terminal|file|deploy|browser|cron|ssh|server|机器|服务器|终端|命令|文件|部署|浏览器|定时",
         lambda a: a["kind"] == "openclaw" or a["role"] == "executor"),
        ("research", r"research|plan|design|compare|investigate|web|browser|调研|研究|设计|方案|浏览器|搜索|资料",
         lambda a: a["kind"] == "hermes" or a["role"] == "researcher" or (re.search(r"web|browser|浏览器|搜索", text) and has_any(a, ["browser"]))),
        ("gateway", r"model|api|gateway|proxy|sub2api|cliproxyapi|token|key|openai|模型|网关|代理|接口|密钥",
         lambda a: a["kind"] == "gateway" or a["role"] == "model-gateway" or has_any(a, ["models", "sub2api", "cliproxyapi"])),
    ]
    selected = {}
    matched = []
    for token, pattern, predicate in rules:
        if re.search(pattern, text, re.I):
            matched.append(token)
            for agent in agents:
                if predicate(agent):
                    selected[agent["id"]] = agent
    if not selected:
        matched = ["default-executor-coder"]
        for agent in agents:
            if agent["role"] in ("coder", "executor"):
                selected[agent["id"]] = agent
    return {
        "mode": "orchestrate",
        "reason": "Selected agents by message intent: " + ", ".join(matched) + ".",
        "matched": matched,
        "agents": list(selected.values()) or agents,
    }


def public_selection(selection):
    return {
        "mode": selection["mode"],
        "reason": selection["reason"],
        "matched": selection["matched"],
        "agents": [{
            "id": agent["id"],
            "node_id": agent["node_id"],
            "kind": agent["kind"],
            "role": agent["role"],
            "capabilities": agent.get("capabilities") or [],
        } for agent in selection["agents"]],
    }


def create_thread(config, body):
    if not body.get("message"):
        err = Exception("message is required")
        err.status_code = 400
        raise err
    selection = select_agents(body["message"], {"mode": body.get("mode", config["defaults"]["mode"]), "agents": body.get("agents")})
    thread = {
        "id": "thread_" + str(uuid.uuid4()),
        "created_at": now(),
        "source": body.get("source", "http"),
        "mode": selection["mode"],
        "message": body["message"],
        "selection": {
            "reason": selection["reason"],
            "matched": selection["matched"],
            "agents": [agent["id"] for agent in selection["agents"]],
        },
        "runs": [],
    }
    for agent in selection["agents"]:
        run = {
            "id": "run_" + str(uuid.uuid4()),
            "thread_id": thread["id"],
            "agent_id": agent["id"],
            "node_id": agent["node_id"],
            "kind": agent["kind"],
            "role": agent["role"],
            "status": "queued",
            "created_at": now(),
            "started_at": None,
            "completed_at": None,
            "message": body["message"],
            "stdout": "",
            "stderr": "",
            "events": [],
        }
        thread["runs"].append(run)
        STATE["runs"][run["id"]] = run
        write_snapshot(config, "runs", run["id"], run)
        append_jsonl(config, "runs.jsonl", run)
        enqueue(agent["node_id"], {
            "type": "task.run",
            "run_id": run["id"],
            "thread_id": thread["id"],
            "agent_id": agent["id"],
            "message": body["message"],
            "created_at": run["created_at"],
        })
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)
    append_jsonl(config, "threads.jsonl", thread)
    return thread


def enqueue(node_id, task):
    STATE["queues"].setdefault(node_id, []).append(task)
    cond = STATE["conditions"].setdefault(node_id, threading.Condition())
    with cond:
        cond.notify()


def poll_node(node_id, timeout_ms):
    if node_id not in STATE["nodes"]:
        err = Exception("unknown node_id")
        err.status_code = 404
        raise err
    node = STATE["nodes"][node_id]
    node["last_seen_at"] = now()
    node["status"] = "online"
    queue = STATE["queues"].setdefault(node_id, [])
    if queue:
        return {"type": "task", "task": queue.pop(0)}
    cond = STATE["conditions"].setdefault(node_id, threading.Condition())
    with cond:
        cond.wait(timeout=max(1, min(timeout_ms, 60000)) / 1000)
    if queue:
        return {"type": "task", "task": queue.pop(0)}
    return {"type": "idle"}


def record_event(config, body):
    run = STATE["runs"].get(body.get("run_id")) or read_snapshot(config, "runs", body.get("run_id"))
    if not run:
        return
    event = {"at": now(), "node_id": body.get("node_id") or run.get("node_id"), **(body.get("event") or {})}
    if event.get("type") == "run.started":
        run["status"] = "running"
        run["started_at"] = run.get("started_at") or event["at"]
    if event.get("stream") == "stdout" and event.get("text"):
        run["stdout"] = run.get("stdout", "") + event["text"]
    if event.get("stream") == "stderr" and event.get("text"):
        run["stderr"] = run.get("stderr", "") + event["text"]
    run.setdefault("events", []).append(event)
    STATE["runs"][run["id"]] = run
    write_snapshot(config, "runs", run["id"], run)
    update_thread_run(config, run)
    append_jsonl(config, "events.jsonl", {"run_id": run["id"], **event})


def complete_run(config, body):
    run = STATE["runs"].get(body.get("run_id")) or read_snapshot(config, "runs", body.get("run_id"))
    if not run:
        err = Exception("unknown run_id")
        err.status_code = 404
        raise err
    result = body.get("result") or {}
    exit_code = result.get("exit_code")
    run["status"] = result.get("status") or ("completed" if exit_code == 0 else "failed")
    run["completed_at"] = now()
    run["exit_code"] = exit_code
    run["stdout"] = trim(redact_text(result.get("stdout", run.get("stdout", ""))))
    run["stderr"] = trim(redact_text(result.get("stderr", run.get("stderr", ""))))
    run["summary"] = trim(redact_text(result.get("summary", "")))
    STATE["runs"][run["id"]] = run
    write_snapshot(config, "runs", run["id"], run)
    update_thread_run(config, run)
    append_jsonl(config, "runs.jsonl", run)
    return run


def update_thread_run(config, run):
    thread = STATE["threads"].get(run.get("thread_id")) or read_snapshot(config, "threads", run.get("thread_id"))
    if not thread:
        return
    thread["runs"] = [run if item["id"] == run["id"] else item for item in thread.get("runs", [])]
    thread["updated_at"] = now()
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)


def has_any(agent, values):
    caps = set(agent.get("capabilities") or [])
    return any(value in caps for value in values)


def append_jsonl(config, name, value):
    with open(Path(config["dataDir"]) / name, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(redact(value), ensure_ascii=False) + "\n")


def write_snapshot(config, folder, item_id, value):
    (Path(config["dataDir"]) / folder / f"{item_id}.json").write_text(
        json.dumps(redact(value), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def read_snapshot(config, folder, item_id):
    if not item_id:
        return None
    path = Path(config["dataDir"]) / folder / f"{item_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def redact(value):
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


def redact_text(text):
    text = str(text or "")
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", "sk-[REDACTED]", text)
    text = re.sub(r"\b(org|proj)_[A-Za-z0-9_-]{12,}\b", r"\1_[REDACTED]", text)
    text = re.sub(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b", "Bearer [REDACTED]", text, flags=re.I)
    return re.sub(r"\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*[\"']?[^\"'\s]+", r"\1=[REDACTED]", text, flags=re.I)


def trim(text):
    text = str(text or "")
    limit = 120000
    return text if len(text) <= limit else text[:limit] + f"\n...[truncated {len(text) - limit} chars]"


def now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


if __name__ == "__main__":
    main()
