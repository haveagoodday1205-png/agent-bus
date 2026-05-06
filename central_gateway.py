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
    "rooms": {},
    "reminders": {},
    "conditions": {},
}


def main():
    config = load_config()
    ensure_dirs(config)
    threading.Thread(target=reminder_loop, args=(config,), daemon=True).start()
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
    (root / "rooms").mkdir(parents=True, exist_ok=True)


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
            if path == "/rooms":
                return self.json([room_summary(room) for room in STATE["rooms"].values()])
            if path.startswith("/rooms/"):
                room_id = path.rsplit("/", 1)[-1]
                item = STATE["rooms"].get(room_id) or read_snapshot(self.config, "rooms", room_id)
                return self.json(item or {"error": "not_found"}, 200 if item else 404)
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
            if path == "/rooms":
                return self.json(create_room(self.config, body), 201)
            if path.startswith("/rooms/"):
                parts = path.strip("/").split("/")
                if len(parts) == 3 and parts[2] == "messages":
                    return self.json(add_room_message(self.config, parts[1], body), 201)
                if len(parts) == 3 and parts[2] == "wake":
                    return self.json(wake_room(self.config, parts[1], body))
                if len(parts) == 3 and parts[2] == "reminders":
                    return self.json(add_room_reminder(self.config, parts[1], body), 201)
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


def room_summary(room):
    return {
        "id": room["id"],
        "title": room.get("title"),
        "goal": room.get("goal"),
        "status": room.get("status"),
        "agents": room.get("agents") or [],
        "steps": room.get("autonomy", {}).get("steps", 0),
        "max_steps": room.get("autonomy", {}).get("max_steps", 0),
        "message_count": len(room.get("messages") or []),
        "report_count": len(room.get("reports") or []),
        "updated_at": room.get("updated_at"),
    }


def create_room(config, body):
    goal = body.get("goal") or body.get("message")
    if not goal:
        err = Exception("goal is required")
        err.status_code = 400
        raise err
    selection = select_agents(goal, {
        "mode": "orchestrate" if body.get("agents") else body.get("mode", config["defaults"]["mode"]),
        "agents": body.get("agents"),
    })
    agents = selection["agents"]
    if not agents:
        err = Exception("room requires at least one agent")
        err.status_code = 400
        raise err
    max_steps = int(body.get("max_steps") if body.get("max_steps") is not None else body.get("maxSteps", 0))
    max_steps = max(0, max_steps)
    room = {
        "id": "room_" + str(uuid.uuid4()),
        "title": body.get("title") or goal[:80],
        "goal": goal,
        "status": "active",
        "created_at": now(),
        "updated_at": now(),
        "agents": [agent["id"] for agent in agents],
        "selection": {
            "reason": selection["reason"],
            "matched": selection["matched"],
        },
        "autonomy": {
            "steps": 0,
            "max_steps": max_steps,
            "budget": "unlimited",
            "permissions": "all",
            "auto_rotate": body.get("auto_rotate", body.get("autoRotate", True)) is not False,
            "next_index": 0,
        },
        "blackboard": {
            "goal": goal,
            "permissions": "all",
            "budget": "unlimited",
            "open_questions": [],
            "next_actions": [],
        },
        "messages": [{
            "speaker": "user",
            "role": "user",
            "content": goal,
            "at": now(),
        }],
        "runs": [],
        "reports": [],
        "reminders": [],
    }
    STATE["rooms"][room["id"]] = room
    wake_ids = body.get("wakeAgents") or body.get("wake_agents") or [room["agents"][0]]
    wake_room_agents(config, room, wake_ids, body.get("reason") or "Initial room wake.")
    write_room(config, room)
    append_jsonl(config, "rooms.jsonl", room)
    return room


def add_room_message(config, room_id, body):
    room = get_room(config, room_id)
    content = body.get("content") or body.get("message")
    if not content:
        err = Exception("message content is required")
        err.status_code = 400
        raise err
    room.setdefault("messages", []).append({
        "speaker": body.get("speaker") or "user",
        "role": body.get("role") or "user",
        "content": content,
        "at": now(),
    })
    room["updated_at"] = now()
    if body.get("wake", True) is not False:
        wake_ids = body.get("agents") or [next_room_agent(room)]
        wake_room_agents(config, room, wake_ids, body.get("reason") or "New room message.")
    write_room(config, room)
    return room


def wake_room(config, room_id, body):
    room = get_room(config, room_id)
    agents = body.get("agents")
    if not agents and body.get("agent"):
        agents = [body.get("agent")]
    if not agents:
        agents = [next_room_agent(room)]
    wake_room_agents(config, room, agents, body.get("reason") or "Manual wake.")
    write_room(config, room)
    return room


def wake_room_agents(config, room, agent_ids, reason):
    if isinstance(agent_ids, str):
        agent_ids = [agent_ids]
    out = []
    for agent_id in agent_ids:
        if not agent_id:
            continue
        if room.get("status") in ("completed", "paused"):
            continue
        autonomy = room.setdefault("autonomy", {})
        steps = int(autonomy.get("steps") or 0)
        max_steps = int(autonomy.get("max_steps") or 0)
        if max_steps > 0 and steps >= max_steps:
            room["status"] = "paused"
            room.setdefault("reports", []).append({"at": now(), "speaker": "system", "content": "Paused: max autonomous steps reached."})
            break
        agent = next((item for item in public_agents() if item["id"] == agent_id), None)
        if not agent:
            room.setdefault("reports", []).append({"at": now(), "speaker": "system", "content": "Agent offline or unknown: " + agent_id})
            continue
        message = autonomous_prompt(room, agent, reason)
        run = create_room_run(config, room, agent, message)
        autonomy["steps"] = steps + 1
        if agent_id in (room.get("agents") or []):
            autonomy["next_index"] = (room.get("agents") or []).index(agent_id) + 1
        room["autonomy"] = autonomy
        room["status"] = "active"
        out.append(run)
    room["updated_at"] = now()
    return out


def autonomous_prompt(room, agent, reason):
    lines = [
        "You are an autonomous agent inside an Agent Bus room.",
        f"Room: {room.get('title') or room['id']}",
        f"Your identity: {agent['id']} ({agent.get('kind')}/{agent.get('role')}).",
        f"Wake reason: {reason}",
        "",
        "Goal:",
        room.get("goal", ""),
        "",
        "Shared blackboard:",
        json.dumps(room.get("blackboard") or {}, ensure_ascii=False, indent=2),
        "",
        "Recent room messages:",
    ]
    for item in (room.get("messages") or [])[-18:]:
        speaker = item.get("speaker") or item.get("role") or "unknown"
        content = str(item.get("content") or "").strip()
        if content:
            lines.append(f"{speaker}: {content}")
    lines.extend([
        "",
        "Autonomy protocol:",
        "- Permissions are open by default in this room. You may ask capable agents to execute, inspect, code, deploy, browse, or verify as needed.",
        "- There is no budget ceiling configured for this room. Continue until the goal is complete or you need the user.",
        "- Reply with your useful update to the room.",
        "- To call another agent, include a line like: @agent-id: task for that agent",
        "- To write a user-facing report, include a line like: REPORT: concise report",
        "- To wake an agent later, include a line like: WAKE agent-id IN 5m: reason",
        "- To update shared state, include a line like: BLACKBOARD: concise state update",
        "- If the room goal is complete, include: DONE",
        "- Be concise. Do not repeat the full protocol.",
    ])
    return "\n".join(lines)


def create_room_run(config, room, agent, message):
    run = {
        "id": "run_" + str(uuid.uuid4()),
        "thread_id": room["id"],
        "room_id": room["id"],
        "agent_id": agent["id"],
        "node_id": agent["node_id"],
        "kind": agent["kind"],
        "role": agent["role"],
        "status": "queued",
        "created_at": now(),
        "started_at": None,
        "completed_at": None,
        "message": message,
        "stdout": "",
        "stderr": "",
        "events": [],
    }
    room.setdefault("runs", []).append(run)
    STATE["runs"][run["id"]] = run
    write_snapshot(config, "runs", run["id"], run)
    append_jsonl(config, "runs.jsonl", run)
    enqueue(agent["node_id"], {
        "type": "task.run",
        "run_id": run["id"],
        "thread_id": room["id"],
        "room_id": room["id"],
        "agent_id": agent["id"],
        "message": message,
        "created_at": run["created_at"],
    })
    return run


def create_thread(config, body):
    if not body.get("message"):
        err = Exception("message is required")
        err.status_code = 400
        raise err
    selection = select_agents(body["message"], {"mode": body.get("mode", config["defaults"]["mode"]), "agents": body.get("agents")})
    if body.get("mode") == "group":
        return create_group_thread(config, body, selection)
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
        create_run(config, thread, agent, body["message"])
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)
    append_jsonl(config, "threads.jsonl", thread)
    return thread


def create_group_thread(config, body, selection):
    agents = selection["agents"]
    if len(agents) < 2:
        err = Exception("group mode requires at least two agents")
        err.status_code = 400
        raise err
    rounds = max(1, min(int(body.get("rounds") or 2), 8))
    thread = {
        "id": "thread_" + str(uuid.uuid4()),
        "created_at": now(),
        "source": body.get("source", "http"),
        "mode": "group",
        "message": body["message"],
        "selection": {
            "reason": "Group conversation across selected agents.",
            "matched": ["group"],
            "agents": [agent["id"] for agent in agents],
        },
        "group": {
            "rounds": rounds,
            "turn_index": 0,
            "max_turns": rounds * len(agents),
        },
        "conversation": [{
            "speaker": "user",
            "role": "user",
            "content": body["message"],
            "at": now(),
        }],
        "runs": [],
    }
    STATE["threads"][thread["id"]] = thread
    schedule_group_turn(config, thread)
    write_snapshot(config, "threads", thread["id"], thread)
    append_jsonl(config, "threads.jsonl", thread)
    return thread


def schedule_group_turn(config, thread):
    group = thread.get("group") or {}
    agent_ids = thread.get("selection", {}).get("agents") or []
    if not agent_ids:
        return False
    turn_index = int(group.get("turn_index") or 0)
    max_turns = int(group.get("max_turns") or len(agent_ids))
    if turn_index >= max_turns:
        thread["status"] = "completed"
        return False
    agent_id = agent_ids[turn_index % len(agent_ids)]
    agent = next((item for item in public_agents() if item["id"] == agent_id), None)
    if not agent:
        err = Exception("group agent is no longer online: " + agent_id)
        err.status_code = 409
        raise err
    message = group_prompt(thread, agent_id, turn_index)
    create_run(config, thread, agent, message, turn_index=turn_index)
    group["turn_index"] = turn_index + 1
    thread["group"] = group
    thread["status"] = "running"
    thread["updated_at"] = now()
    return True


def group_prompt(thread, agent_id, turn_index):
    lines = [
        "You are participating in an Agent Bus group conversation.",
        f"You are speaking as: {agent_id}.",
        "Read the conversation so far, then add your next message.",
        "Be direct, useful, and concise. Build on prior agent messages instead of repeating them.",
        "Do not claim to be another agent. Return only your message to the group.",
        "",
        "Original user request:",
        thread.get("message", ""),
        "",
        "Conversation so far:",
    ]
    for item in thread.get("conversation") or []:
        speaker = item.get("speaker") or item.get("role") or "unknown"
        content = str(item.get("content") or "").strip()
        if content:
            lines.append(f"{speaker}: {content}")
    lines.extend(["", f"Turn {turn_index + 1}: {agent_id}, reply now."])
    return "\n".join(lines)


def create_run(config, thread, agent, message, turn_index=None):
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
        "message": message,
        "stdout": "",
        "stderr": "",
        "events": [],
    }
    if turn_index is not None:
        run["turn_index"] = turn_index
    thread.setdefault("runs", []).append(run)
    STATE["runs"][run["id"]] = run
    write_snapshot(config, "runs", run["id"], run)
    append_jsonl(config, "runs.jsonl", run)
    enqueue(agent["node_id"], {
        "type": "task.run",
        "run_id": run["id"],
        "thread_id": thread["id"],
        "agent_id": agent["id"],
        "message": message,
        "created_at": run["created_at"],
    })
    return run


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
    continue_group_thread(config, run)
    continue_room_run(config, run)
    append_jsonl(config, "runs.jsonl", run)
    return run


def continue_room_run(config, run):
    room_id = run.get("room_id") or run.get("thread_id")
    room = STATE["rooms"].get(room_id) or read_snapshot(config, "rooms", room_id)
    if not room:
        return
    if any(item.get("run_id") == run["id"] for item in room.get("messages") or []):
        return
    content = (run.get("stdout") or run.get("summary") or run.get("stderr") or "").strip()
    room.setdefault("messages", []).append({
        "speaker": run.get("agent_id"),
        "role": run.get("kind") or "agent",
        "run_id": run["id"],
        "status": run.get("status"),
        "content": content,
        "at": run.get("completed_at") or now(),
    })
    actions = process_room_directives(config, room, run, content)
    scheduled_actions = {"wake", "reminder", "done"}
    if not any(action in scheduled_actions for action in actions) and room.get("status") == "active" and room.get("autonomy", {}).get("auto_rotate", True):
        wake_room_agents(config, room, [next_room_agent(room)], "Continue the room from the latest message.")
    room["updated_at"] = now()
    write_room(config, room)


def process_room_directives(config, room, run, content):
    actions = []
    agent_ids = set(room.get("agents") or [])
    for raw_line in str(content or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if re.match(r"^DONE\b", line, re.I):
            room["status"] = "completed"
            actions.append("done")
            continue
        match = re.match(r"^REPORT\s*:\s*(.+)", line, re.I)
        if match:
            report = {"at": now(), "speaker": run.get("agent_id"), "content": match.group(1).strip(), "run_id": run["id"]}
            room.setdefault("reports", []).append(report)
            room.setdefault("blackboard", {}).setdefault("reports", []).append(report)
            actions.append("report")
            continue
        match = re.match(r"^BLACKBOARD\s*:\s*(.+)", line, re.I)
        if match:
            note = {"at": now(), "speaker": run.get("agent_id"), "content": match.group(1).strip(), "run_id": run["id"]}
            room.setdefault("blackboard", {}).setdefault("notes", []).append(note)
            actions.append("blackboard")
            continue
        match = re.match(r"^WAKE\s+@?([A-Za-z0-9_.-]+)\s+IN\s+([0-9]+)\s*([smhd]?)\s*:\s*(.+)", line, re.I)
        if match:
            agent_id, amount, unit, reason = match.groups()
            if agent_id.lower() in ("self", "me"):
                agent_id = run.get("agent_id")
            if agent_id in agent_ids:
                add_room_reminder(config, room["id"], {
                    "agent": agent_id,
                    "delay_seconds": parse_delay_seconds(amount, unit),
                    "reason": reason.strip(),
                })
                actions.append("reminder")
            continue
        match = re.match(r"^@([A-Za-z0-9_.-]+)\s*:\s*(.+)", line)
        if match:
            agent_id, task = match.groups()
            if agent_id in agent_ids:
                wake_room_agents(config, room, [agent_id], task.strip())
                actions.append("wake")
            continue
    return actions


def continue_group_thread(config, run):
    thread = STATE["threads"].get(run.get("thread_id")) or read_snapshot(config, "threads", run.get("thread_id"))
    if not thread or thread.get("mode") != "group":
        return
    if any(item.get("run_id") == run["id"] for item in thread.get("conversation") or []):
        return
    content = (run.get("stdout") or run.get("summary") or run.get("stderr") or "").strip()
    thread.setdefault("conversation", []).append({
        "speaker": run.get("agent_id"),
        "role": run.get("kind") or "agent",
        "run_id": run["id"],
        "status": run.get("status"),
        "content": content,
        "at": run.get("completed_at") or now(),
    })
    schedule_group_turn(config, thread)
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)


def update_thread_run(config, run):
    thread = STATE["threads"].get(run.get("thread_id")) or read_snapshot(config, "threads", run.get("thread_id"))
    if not thread:
        return
    thread["runs"] = [run if item["id"] == run["id"] else item for item in thread.get("runs", [])]
    thread["updated_at"] = now()
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)


def get_room(config, room_id):
    room = STATE["rooms"].get(room_id) or read_snapshot(config, "rooms", room_id)
    if not room:
        err = Exception("unknown room_id")
        err.status_code = 404
        raise err
    STATE["rooms"][room_id] = room
    return room


def next_room_agent(room):
    agents = room.get("agents") or []
    if not agents:
        err = Exception("room has no agents")
        err.status_code = 409
        raise err
    autonomy = room.setdefault("autonomy", {})
    index = int(autonomy.get("next_index") or 0)
    agent_id = agents[index % len(agents)]
    autonomy["next_index"] = index + 1
    return agent_id


def add_room_reminder(config, room_id, body):
    room = get_room(config, room_id)
    agent_id = body.get("agent") or body.get("agent_id")
    if not agent_id:
        err = Exception("agent is required")
        err.status_code = 400
        raise err
    delay_seconds = int(body.get("delay_seconds") or body.get("delaySeconds") or 60)
    reminder = {
        "id": "reminder_" + str(uuid.uuid4()),
        "room_id": room_id,
        "agent_id": agent_id,
        "reason": body.get("reason") or "Scheduled room wake.",
        "due_at": time.time() + max(1, delay_seconds),
        "due_at_text": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + max(1, delay_seconds))),
        "status": "scheduled",
        "created_at": now(),
    }
    STATE["reminders"][reminder["id"]] = reminder
    room.setdefault("reminders", []).append(reminder)
    room["updated_at"] = now()
    write_room(config, room)
    append_jsonl(config, "reminders.jsonl", reminder)
    return reminder


def reminder_loop(config):
    while True:
        try:
            current = time.time()
            for reminder in list(STATE["reminders"].values()):
                if reminder.get("status") != "scheduled" or float(reminder.get("due_at", 0)) > current:
                    continue
                room = get_room(config, reminder["room_id"])
                reminder["status"] = "fired"
                reminder["fired_at"] = now()
                wake_room_agents(config, room, [reminder["agent_id"]], reminder.get("reason") or "Scheduled room wake.")
                write_room(config, room)
        except Exception as exc:
            append_jsonl(config, "errors.jsonl", {"at": now(), "source": "reminder_loop", "error": str(exc)})
        time.sleep(5)


def parse_delay_seconds(amount, unit):
    value = int(amount)
    unit = (unit or "s").lower()
    if unit == "d":
        return value * 86400
    if unit == "h":
        return value * 3600
    if unit == "m":
        return value * 60
    return value


def write_room(config, room):
    STATE["rooms"][room["id"]] = room
    write_snapshot(config, "rooms", room["id"], room)


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
