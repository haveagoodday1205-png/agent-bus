#!/usr/bin/env python3
import calendar
import hashlib
import json
import mimetypes
import os
import re
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError

TELEGRAM_DEFAULT_EVENTS = {
    "central.started",
    "edge.registered",
    "run.completed",
    "run.failed",
    "room.completed",
}

STATE = {
    "nodes": {},
    "queues": {},
    "runs": {},
    "threads": {},
    "rooms": {},
    "reminders": {},
    "conditions": {},
    "pair_codes": {},
    "edge_tokens": {},
}


def int_env(name, default):
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


NODE_STALE_SECONDS = max(1, int_env("AGENT_BUS_NODE_STALE_SECONDS", 180))


class AgentBusHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True

    def server_bind(self):
        TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = host
        self.server_port = port


def main():
    config = load_config()
    ensure_dirs(config)
    load_edge_tokens(config)
    load_persistent_state(config)
    threading.Thread(target=reminder_loop, args=(config,), daemon=True).start()
    server = AgentBusHTTPServer((config["host"], int(config["port"])), Handler)
    server.config = config
    print(f"central-gateway.py listening on http://{config['host']}:{config['port']}", flush=True)
    print(f"Agent Bus join endpoint: {public_gateway_url(config)}", flush=True)
    notify_plugin(config, "central.started", {
        "gateway": public_gateway_url(config),
        "runtime": "python",
    })
    server.serve_forever()


def load_config():
    config_path = Path(os.environ.get("AGENT_BUS_CONFIG", "central.config.json"))
    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
    else:
        config = {}
    config["host"] = os.environ.get("AGENT_BUS_HOST", config.get("host", "127.0.0.1"))
    config["port"] = int(os.environ.get("AGENT_BUS_PORT", config.get("port", 8788)))
    config["gatewayUrl"] = os.environ.get("AGENT_BUS_GATEWAY_URL", config.get("gatewayUrl", ""))
    config["token"] = os.environ.get("AGENT_BUS_TOKEN", config.get("token", ""))
    config["dataDir"] = os.environ.get("AGENT_BUS_DATA_DIR", str(Path(config.get("dataDir", "./data/central")).resolve()))
    config.setdefault("defaults", {})
    config["defaults"]["mode"] = config["defaults"].get("mode", "orchestrate")
    config["defaults"]["pollTimeoutMs"] = int(config["defaults"].get("pollTimeoutMs", 25000))
    config.setdefault("modelRouter", {})
    config["modelRouter"].setdefault("enabled", True)
    config["modelRouter"].setdefault("agentModels", True)
    config["modelRouter"].setdefault("allowEdgeAgentModels", False)
    config["modelRouter"].setdefault("agentModelTimeoutSeconds", 600)
    config["modelRouter"].setdefault("backends", [])
    config.setdefault("plugins", {})
    config["plugins"].setdefault("telegramBot", {})
    config.setdefault("edgeTokens", [])
    return config


def ensure_dirs(config):
    root = Path(config["dataDir"])
    (root / "threads").mkdir(parents=True, exist_ok=True)
    (root / "runs").mkdir(parents=True, exist_ok=True)
    (root / "rooms").mkdir(parents=True, exist_ok=True)


def load_edge_tokens(config):
    STATE["edge_tokens"] = {}
    for item in config.get("edgeTokens") or []:
        record = edge_token_record_from_config(item)
        if record:
            STATE["edge_tokens"][record["token_hash"]] = record
    path = edge_tokens_path(config)
    if path.exists():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            data = []
        for item in data if isinstance(data, list) else []:
            if item.get("token_hash"):
                STATE["edge_tokens"][item["token_hash"]] = item


def load_persistent_state(config):
    STATE["nodes"] = load_nodes(config)
    STATE["runs"] = load_snapshots_by_id(config, "runs")
    STATE["threads"] = load_snapshots_by_id(config, "threads")
    STATE["rooms"] = load_snapshots_by_id(config, "rooms")
    STATE["queues"] = {}
    STATE["conditions"] = {}
    STATE["reminders"] = {}

    for node_id in STATE["nodes"]:
        STATE["queues"].setdefault(node_id, [])
        STATE["conditions"].setdefault(node_id, threading.Condition())

    recover_embedded_runs()
    recover_agent_run_health()
    sync_recovered_containers(config)
    load_room_reminders()
    recover_queued_runs()


def load_nodes(config):
    nodes = {}
    for record in read_jsonl(config, "nodes.jsonl"):
        node_id = record.get("node_id")
        if not node_id:
            continue
        node = dict(record)
        node.setdefault("status", "online")
        node.setdefault("agents", [])
        nodes[node_id] = node
    return nodes


def load_snapshots_by_id(config, folder):
    out = {}
    for item in read_snapshots(config, folder):
        if isinstance(item, dict) and item.get("id"):
            out[item["id"]] = item
    return out


def recover_embedded_runs():
    for container in [*STATE["threads"].values(), *STATE["rooms"].values()]:
        for run in container.get("runs") or []:
            if isinstance(run, dict) and run.get("id"):
                STATE["runs"].setdefault(run["id"], run)


def recover_agent_run_health():
    runs = sorted(STATE["runs"].values(), key=lambda item: item.get("completed_at") or item.get("created_at") or "")
    for run in runs:
        if str(run.get("status") or "").lower() in TERMINAL_RUN_STATUSES:
            update_agent_run_health(run)


def sync_recovered_containers(config):
    for thread_id, thread in list(STATE["threads"].items()):
        if sync_container_runs(thread):
            write_snapshot(config, "threads", thread_id, thread)
    for room_id, room in list(STATE["rooms"].items()):
        if sync_container_runs(room):
            write_snapshot(config, "rooms", room_id, room)


def sync_container_runs(container):
    changed = False
    synced = []
    for run in container.get("runs") or []:
        latest = STATE["runs"].get(run.get("id"))
        if latest:
            synced.append(latest)
            changed = changed or latest is not run
        else:
            synced.append(run)
    if changed:
        container["runs"] = synced
        container["updated_at"] = container.get("updated_at") or now()
    return changed


def load_room_reminders():
    for room in STATE["rooms"].values():
        for reminder in room.get("reminders") or []:
            if isinstance(reminder, dict) and reminder.get("id") and reminder.get("status") == "scheduled":
                STATE["reminders"][reminder["id"]] = reminder


def recover_queued_runs():
    for run in STATE["runs"].values():
        if str(run.get("status") or "queued").lower() != "queued":
            continue
        node_id = run.get("node_id")
        if not node_id:
            continue
        STATE["queues"].setdefault(node_id, [])
        STATE["conditions"].setdefault(node_id, threading.Condition())
        if any(task.get("run_id") == run.get("id") for task in STATE["queues"][node_id]):
            continue
        task = {
            "type": "task.run",
            "run_id": run["id"],
            "thread_id": run.get("thread_id"),
            "trace_id": run.get("trace_id"),
            "agent_id": run.get("agent_id"),
            "message": run.get("message", ""),
            "created_at": run.get("created_at") or now(),
            "recovered_at": now(),
        }
        if run.get("room_id"):
            task["room_id"] = run.get("room_id")
        if run.get("cache_scope"):
            task["cache_scope"] = run.get("cache_scope")
        STATE["queues"][node_id].append(task)


def edge_token_record_from_config(item):
    if isinstance(item, str):
        token = item.strip()
        if not token:
            return None
        return {
            "id": "edge_config_" + token_hash(token)[:12],
            "token_hash": token_hash(token),
            "scope": "edge",
            "source": "config",
            "status": "active",
            "created_at": now(),
        }
    if not isinstance(item, dict):
        return None
    token = str(item.get("token") or "").strip()
    token_hash_value = str(item.get("tokenHash") or item.get("token_hash") or "").strip()
    if not token_hash_value and token:
        token_hash_value = token_hash(token)
    if not token_hash_value:
        return None
    return {
        "id": item.get("id") or "edge_config_" + token_hash_value[:12],
        "token_hash": token_hash_value,
        "scope": "edge",
        "source": "config",
        "status": item.get("status", "active"),
        "created_at": item.get("created_at") or item.get("createdAt") or now(),
        "node_id": item.get("node_id") or item.get("nodeId") or "",
        "label": item.get("label") or "",
    }


def edge_tokens_path(config):
    return Path(config["dataDir"]) / "edge_tokens.json"


def persist_edge_tokens(config):
    records = sorted(STATE["edge_tokens"].values(), key=lambda item: item.get("created_at", ""))
    edge_tokens_path(config).write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def create_edge_token(config, node_id="", label="", source="pairing"):
    token = "abt_edge_" + secrets.token_urlsafe(32)
    record = {
        "id": "edge_" + uuid.uuid4().hex,
        "token_hash": token_hash(token),
        "scope": "edge",
        "source": clean_pair_value(source) or "pairing",
        "status": "active",
        "created_at": now(),
        "node_id": clean_pair_value(node_id),
        "label": clean_pair_value(label),
    }
    STATE["edge_tokens"][record["token_hash"]] = record
    persist_edge_tokens(config)
    append_jsonl(config, "edge_tokens.jsonl", {
        "event": "created",
        "id": record["id"],
        "scope": "edge",
        "source": record["source"],
        "node_id": record["node_id"],
        "label": record["label"],
        "created_at": record["created_at"],
    })
    return token, record


def public_edge_token(record):
    return {
        "id": record.get("id"),
        "scope": record.get("scope", "edge"),
        "source": record.get("source", ""),
        "status": record.get("status", "active"),
        "created_at": record.get("created_at"),
        "revoked_at": record.get("revoked_at"),
        "node_id": record.get("node_id", ""),
        "label": record.get("label", ""),
    }


def list_edge_tokens():
    records = sorted(STATE["edge_tokens"].values(), key=lambda item: item.get("created_at", ""))
    return [public_edge_token(record) for record in records]


def create_manual_edge_token(config, body):
    token, record = create_edge_token(
        config,
        node_id=body.get("nodeId") or body.get("node_id"),
        label=body.get("label") or "manual",
        source="admin",
    )
    return {
        "ok": True,
        "token": token,
        "tokenScope": "edge",
        "edgeToken": public_edge_token(record),
    }


def revoke_edge_token(config, body):
    token_id = clean_pair_value(body.get("id") or body.get("tokenId") or body.get("token_id"))
    if not token_id:
        err = Exception("edge token id is required")
        err.status_code = 400
        raise err
    for record in STATE["edge_tokens"].values():
        if record.get("id") == token_id:
            record["status"] = "revoked"
            record["revoked_at"] = now()
            persist_edge_tokens(config)
            append_jsonl(config, "edge_tokens.jsonl", {
                "event": "revoked",
                "id": token_id,
                "revoked_at": record["revoked_at"],
            })
            return {"ok": True, "edgeToken": public_edge_token(record)}
    err = Exception("edge token not found")
    err.status_code = 404
    raise err


def token_scope(config, token):
    token = str(token or "")
    if config.get("token") and token == config.get("token"):
        return "admin"
    record = STATE["edge_tokens"].get(token_hash(token))
    if record and record.get("status", "active") != "revoked":
        return "edge"
    return ""


def token_hash(token):
    return hashlib.sha256(str(token or "").encode("utf-8")).hexdigest()


class Handler(BaseHTTPRequestHandler):
    server_version = "AgentBusPython/0.1"

    def do_GET(self):
        try:
            path = urlparse(self.path).path
            if path == "/health":
                agents = public_agents()
                nodes = public_nodes()
                return self.json({
                    "ok": True,
                    "nodes": len(nodes),
                    "agents": len(agents),
                    "registered_nodes": len(STATE["nodes"]),
                    "registered_agents": sum(len(node.get("agents", [])) for node in STATE["nodes"].values()),
                    "queued": sum(len(q) for q in STATE["queues"].values()),
                })
            if path == "/.well-known/agent-bus.json":
                return self.json(agent_bus_well_known())
            if path == "/console":
                self.send_response(308)
                self.send_header("location", "console/")
                self.send_header("cache-control", "no-store")
                self.end_headers()
                return
            if path.startswith("/console/"):
                return self.console_asset(path)
            if path == "/agents":
                self.require_auth(("admin", "edge"))
                return self.json(public_agents())
            if path == "/nodes":
                self.require_auth(("admin", "edge"))
                return self.json(public_registered_nodes())
            if path in ("/manifest", "/v1/agent-bus/manifest"):
                self.require_auth(("admin", "edge"))
                return self.json(agent_bus_manifest(self.config))
            if path in ("/edge/tokens", "/v1/agent-bus/edge-tokens"):
                self.require_auth(("admin",))
                return self.json(list_edge_tokens())
            if path == "/v1/models":
                scope = self.require_auth(("admin", "edge") if allow_edge_agent_models(self.config) else ("admin",))
                return self.json(openai_models(self.config, agent_only=scope == "edge"))
            self.require_auth(("admin",))
            if path == "/rooms":
                return self.json(list_rooms(self.config))
            if path.startswith("/rooms/"):
                room_id = path.rsplit("/", 1)[-1]
                item = STATE["rooms"].get(room_id) or read_snapshot(self.config, "rooms", room_id)
                return self.json(item or {"error": "not_found"}, 200 if item else 404)
            if path.startswith("/traces/"):
                trace_id = path.rsplit("/", 1)[-1]
                return self.json(trace_lookup(self.config, trace_id))
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
            path = urlparse(self.path).path
            if path == "/edge/pair":
                body = self.read_json()
                return self.json(redeem_pair_code(self.config, body), redact_value=False)

            body = self.read_json()
            if path in ("/pair-codes", "/v1/agent-bus/pair-codes"):
                self.require_auth(("admin",))
                return self.json(create_pair_code(self.config, body, self), 201)
            if path in ("/edge/tokens", "/v1/agent-bus/edge-tokens"):
                self.require_auth(("admin",))
                return self.json(create_manual_edge_token(self.config, body), 201, redact_value=False)
            if path in ("/edge/tokens/revoke", "/v1/agent-bus/edge-tokens/revoke"):
                self.require_auth(("admin",))
                return self.json(revoke_edge_token(self.config, body))
            if path in ("/edge/register", "/edge/poll", "/edge/events", "/edge/complete"):
                self.require_auth(("admin", "edge"))
                if path == "/edge/register":
                    return self.json(register_node(self.config, body))
                if path == "/edge/poll":
                    return self.json(poll_node(self.config, body, int(body.get("timeout_ms") or self.config["defaults"]["pollTimeoutMs"])))
                if path == "/edge/events":
                    record_event(self.config, body)
                    return self.json({"ok": True})
                if path == "/edge/complete":
                    return self.json(complete_run(self.config, body))
            if path == "/v1/chat/completions":
                self.require_auth(chat_completion_scopes(self.config, body))
                return self.proxy_chat_completions(body)
            if path == "/v1/responses":
                self.require_auth(responses_scopes(self.config, body))
                return self.proxy_responses(body)
            self.require_auth(("admin",))
            if path == "/route":
                selection = select_agents(body.get("message", ""), body)
                return self.json(public_selection(selection))
            if path == "/threads":
                return self.json(create_thread(self.config, body, self.request_trace_id(body)), 201)
            if path == "/rooms":
                return self.json(create_room(self.config, body, self.request_trace_id(body)), 201)
            if path.startswith("/rooms/"):
                parts = path.strip("/").split("/")
                if len(parts) == 3 and parts[2] == "messages":
                    return self.json(add_room_message(self.config, parts[1], body, self.request_trace_id(body)), 201)
                if len(parts) == 3 and parts[2] == "wake":
                    return self.json(wake_room(self.config, parts[1], body, self.request_trace_id(body)))
                if len(parts) == 3 and parts[2] == "pause":
                    return self.json(pause_room(self.config, parts[1], body))
                if len(parts) == 3 and parts[2] == "reminders":
                    return self.json(add_room_reminder(self.config, parts[1], body), 201)
            return self.json({"error": "not_found"}, 404)
        except Exception as exc:
            return self.json({"error": str(exc)}, getattr(exc, "status_code", 500))

    @property
    def config(self):
        return self.server.config

    def require_auth(self, allowed_scopes=("admin",)):
        if not self.config.get("token") and not STATE["edge_tokens"]:
            return "admin"
        auth = self.headers.get("authorization", "")
        header_token = self.headers.get("x-agent-bus-token", "")
        got = auth[7:] if auth.lower().startswith("bearer ") else header_token
        scope = token_scope(self.config, got)
        if scope not in allowed_scopes:
            err = Exception("unauthorized")
            err.status_code = 401
            raise err
        return scope

    def request_trace_id(self, body):
        header_value = self.headers.get("x-agent-bus-trace-id") or self.headers.get("x-request-id") or ""
        return trace_id_from_body(body) or sanitize_trace_id(header_value) or new_trace_id()

    def read_json(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        return json.loads(raw) if raw.strip() else {}

    def json(self, value, status=200, redact_value=True):
        payload = redact(value) if redact_value else value
        data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"
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
        trace_id = self.request_trace_id(body)
        agent_id = agent_model_id(body.get("model"))
        if agent_id:
            payload, status = create_agent_chat_completion(self.config, body, agent_id, trace_id)
            return self.json(payload, status)
        backend, routed_model = select_model_backend(self.config, body.get("model"))
        proxied = dict(body)
        proxied["model"] = routed_model
        data = json.dumps(proxied, ensure_ascii=False).encode("utf-8")
        req = Request(join_url(backend["baseUrl"], "/chat/completions"), data=data, method="POST")
        req.add_header("content-type", "application/json")
        req.add_header("accept", "text/event-stream" if body.get("stream") else "application/json")
        req.add_header("x-agent-bus-trace-id", trace_id)
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

    def proxy_responses(self, body):
        trace_id = self.request_trace_id(body)
        agent_id = agent_model_id(body.get("model"))
        if agent_id:
            payload, status = create_agent_response(self.config, body, agent_id, trace_id)
            return self.json(payload, status)
        backend, routed_model = select_model_backend(self.config, body.get("model"))
        proxied = dict(body)
        proxied["model"] = routed_model
        data = json.dumps(proxied, ensure_ascii=False).encode("utf-8")
        req = Request(join_url(backend["baseUrl"], "/responses"), data=data, method="POST")
        req.add_header("content-type", "application/json")
        req.add_header("accept", "text/event-stream" if body.get("stream") else "application/json")
        req.add_header("x-agent-bus-trace-id", trace_id)
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
    agents = normalize_agents(node_id, body.get("agents") or [])
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
    notify_plugin(config, "edge.registered", {
        "node_id": node_id,
        "hostname": node.get("hostname"),
        "agents": [agent.get("id") for agent in agents],
        "agent_count": len(agents),
        "was_registered": bool(old),
    })
    return node


def normalize_agents(node_id, agents):
    out = []
    for agent in agents or []:
        if not agent.get("id"):
            continue
        item = {
            "id": agent["id"],
            "node_id": node_id,
            "kind": agent.get("kind", "agent"),
            "role": agent.get("role", "worker"),
            "enabled": agent.get("enabled", True) is not False,
            "capabilities": agent.get("capabilities") or [],
        }
        if agent.get("adapter"):
            item["adapter"] = agent.get("adapter")
        if isinstance(agent.get("health"), dict):
            item["health"] = agent["health"]
        out.append(item)
    return out


def public_nodes():
    return [node for node in STATE["nodes"].values() if node_is_online(node)]


def public_registered_nodes():
    return sorted((public_node(node) for node in STATE["nodes"].values()), key=lambda item: item.get("node_id") or "")


def public_node(node):
    return {
        "node_id": node.get("node_id"),
        "hostname": node.get("hostname"),
        "status": node.get("status"),
        "last_seen_at": node.get("last_seen_at"),
        "agents": [public_node_agent(agent) for agent in node.get("agents", [])],
    }


def public_node_agent(agent):
    return {
        "id": agent.get("id"),
        "kind": agent.get("kind"),
        "role": agent.get("role"),
        "enabled": agent.get("enabled") is not False,
        "capabilities": agent.get("capabilities") or [],
    }


def node_is_online(node):
    if node.get("status") != "online":
        return False
    last_seen_at = node.get("last_seen_at")
    if not last_seen_at:
        return False
    try:
        last_seen = calendar.timegm(time.strptime(last_seen_at, "%Y-%m-%dT%H:%M:%SZ"))
    except Exception:
        return False
    return time.time() - last_seen <= NODE_STALE_SECONDS


def public_agents():
    out = []
    for node in public_nodes():
        for agent in node.get("agents", []):
            if agent.get("enabled") is False:
                continue
            item = dict(agent)
            health = item.get("health") if isinstance(item.get("health"), dict) else {}
            item["status"] = "online"
            item["last_seen_at"] = node.get("last_seen_at")
            item["node_status"] = node.get("status")
            item["node_last_seen_at"] = node.get("last_seen_at")
            item["node_online"] = True
            if health:
                item["ping_status"] = health.get("ping_status")
                item["ping_target"] = health.get("ping_target")
                item["ping_checked_at"] = health.get("checked_at")
                item["ping_latency_ms"] = health.get("latency_ms")
                item["last_run_status"] = health.get("last_run_status")
                item["last_run_at"] = health.get("last_run_at")
            out.append(item)
    return sorted(out, key=lambda item: item["id"])


def agent_bus_manifest(config):
    return {
        "name": "agent-bus",
        "protocol": "agent-bus.v1",
        "description": "A lightweight AI-to-AI bus for discovering agents, routing tasks, and coordinating shared rooms.",
        "auth": {
            "type": "bearer",
            "health_public": True,
            "scopes": {
                "admin": "Full gateway, model router, room, thread, and pairing access.",
                "edge": "Edge registration, polling, run reporting, and read-only discovery.",
            },
        },
        "endpoints": {
            "health": "GET /health",
            "manifest": "GET /v1/agent-bus/manifest",
            "nodes": "GET /nodes",
            "agents": "GET /agents",
            "route": "POST /route",
            "threads": "POST /threads",
            "rooms": "POST /rooms",
            "room": "GET /rooms/{room_id}",
            "room_message": "POST /rooms/{room_id}/messages",
            "room_wake": "POST /rooms/{room_id}/wake",
            "trace": "GET /traces/{trace_id}",
            "models": "GET /v1/models",
            "chat_completions": "POST /v1/chat/completions",
            "responses": "POST /v1/responses",
            "pair_create": "POST /pair-codes",
            "pair_join": "POST /edge/pair",
            "edge_tokens": "GET /edge/tokens, POST /edge/tokens, POST /edge/tokens/revoke",
        },
        "agent_contract": {
            "identity": ["id", "node_id", "kind", "role"],
            "capabilities": "Free-form strings that describe what the agent can do.",
            "health": {
                "node_status": "Edge process is polling the central gateway.",
                "ping_status": "Optional shallow URL reachability check; it does not run model inference.",
                "last_run_status": "Most recent real task outcome, when available.",
            },
        },
        "room_protocol": {
            "mention": "@agent-id: task for that agent",
            "report": "REPORT: concise user-facing report",
            "blackboard": "BLACKBOARD: concise shared state update",
            "wake_later": "WAKE agent-id IN 5m: reason",
            "done": "DONE",
        },
        "agents": public_agents(),
        "model_router": {
            "enabled": config.get("modelRouter", {}).get("enabled", True) is not False,
            "models": [item["id"] for item in openai_models(config)["data"]],
        },
        "plugins": {
            "telegramBot": public_telegram_plugin_status(config),
        },
    }


def agent_bus_well_known():
    return {
        "name": "agent-bus",
        "protocol": "agent-bus.v1",
        "manifest": "/v1/agent-bus/manifest",
        "health": "/health",
        "pair": "/edge/pair",
        "auth": {
            "type": "bearer",
            "manifest_required": True,
        },
    }


def openai_models(config, agent_only=False):
    models = []
    if not agent_only:
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
    if agent_models_enabled(config):
        for agent in public_agents():
            models.append({
                "id": "agent:" + agent["id"],
                "object": "model",
                "created": 0,
                "owned_by": "agent-bus-edge",
            })
    seen = {}
    for model in models:
        seen[model["id"]] = model
    return {"object": "list", "data": sorted(seen.values(), key=lambda item: item["id"])}


def chat_completion_scopes(config, body):
    if agent_model_id(body.get("model")) and allow_edge_agent_models(config):
        return ("admin", "edge")
    return ("admin",)


def responses_scopes(config, body):
    if agent_model_id(body.get("model")) and allow_edge_agent_models(config):
        return ("admin", "edge")
    return ("admin",)


def agent_models_enabled(config):
    router = config.get("modelRouter", {})
    return router.get("enabled", True) is not False and router.get("agentModels", True) is not False


def allow_edge_agent_models(config):
    return agent_models_enabled(config) and config.get("modelRouter", {}).get("allowEdgeAgentModels", False) is True


def agent_model_id(model):
    text = str(model or "").strip()
    if text.startswith("agent:"):
        return text[6:].strip()
    if text.startswith("agent/"):
        return text[6:].strip()
    return ""


def sanitize_trace_id(value):
    text = str(value or "").strip()
    if not text:
        return ""
    text = re.sub(r"[^A-Za-z0-9._:-]+", "-", text).strip("-")
    return text[:128]


def new_trace_id():
    return "trace_" + str(uuid.uuid4())


def trace_id_from_body(body):
    if not isinstance(body, dict):
        return ""
    direct = sanitize_trace_id(body.get("trace_id") or body.get("traceId") or body.get("request_id") or body.get("requestId"))
    if direct:
        return direct
    metadata = body.get("metadata")
    if isinstance(metadata, dict):
        value = sanitize_trace_id(metadata.get("agent_bus_trace_id") or metadata.get("trace_id") or metadata.get("traceId") or metadata.get("request_id"))
        if value:
            return value
    agent_bus = body.get("agent_bus")
    if isinstance(agent_bus, dict):
        value = sanitize_trace_id(agent_bus.get("trace_id") or agent_bus.get("traceId") or agent_bus.get("request_id"))
        if value:
            return value
    return ""


def create_agent_chat_completion(config, body, agent_id, trace_id=None):
    if not agent_models_enabled(config):
        return openai_error("agent-backed models are disabled", "agent_bus_agent_models_disabled", "model"), 503
    if body.get("stream"):
        return openai_error("agent-backed models do not support stream=true yet", "unsupported_feature", "stream"), 400
    agent = next((item for item in public_agents() if item["id"] == agent_id), None)
    if not agent:
        return openai_error("agent model is not online: agent:" + agent_id, "agent_bus_agent_not_online", "model"), 404

    messages = body.get("messages")
    if not chat_messages_have_content(messages):
        return openai_error("messages are required for agent-backed chat completions", "invalid_request_error", "messages"), 400
    prompt = chat_messages_to_agent_prompt(messages)
    cache_scope = agent_model_cache_scope(body)

    thread = {
        "id": "thread_" + str(uuid.uuid4()),
        "created_at": now(),
        "source": "chat.completions.agent",
        "mode": "agent-model",
        "trace_id": trace_id or new_trace_id(),
        "message": prompt,
        "model": "agent:" + agent_id,
        "selection": {
            "reason": "OpenAI-compatible chat completion routed to an Agent Bus edge agent.",
            "matched": ["agent-model"],
            "agents": [agent["id"]],
        },
        "runs": [],
    }
    if cache_scope:
        thread["cache_scope"] = cache_scope
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)
    run = create_run(config, thread, agent, prompt)
    write_snapshot(config, "threads", thread["id"], thread)
    append_jsonl(config, "threads.jsonl", thread)

    timeout_seconds = agent_model_timeout_seconds(config, body)
    final_run = wait_for_run_terminal(config, run["id"], timeout_seconds)
    if (final_run.get("status") or "").lower() != "completed":
        message = final_run.get("stderr") or final_run.get("summary") or final_run.get("stdout") or "agent model run did not complete"
        status = 504 if (final_run.get("status") or "").lower() not in TERMINAL_RUN_STATUSES else 502
        error = openai_error(trim(message), "agent_bus_agent_run_failed", "model")
        error["error"]["run_id"] = run["id"]
        error["error"]["thread_id"] = thread["id"]
        error["error"]["trace_id"] = thread["trace_id"]
        error["error"]["agent_id"] = agent_id
        error["error"]["status"] = final_run.get("status", "timeout")
        return error, status

    content = (final_run.get("stdout") or final_run.get("summary") or "").strip()
    return {
        "id": "chatcmpl-agentbus-" + run["id"].replace("run_", ""),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": "agent:" + agent_id,
        "choices": [{
            "index": 0,
            "message": {
                "role": "assistant",
                "content": content,
            },
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
        "agent_bus": {
            "thread_id": thread["id"],
            "run_id": run["id"],
            "trace_id": thread["trace_id"],
            "agent_id": agent_id,
            "node_id": agent.get("node_id"),
        },
    }, 200


def create_agent_response(config, body, agent_id, trace_id=None):
    if not agent_models_enabled(config):
        return openai_error("agent-backed models are disabled", "agent_bus_agent_models_disabled", "model"), 503
    if body.get("stream"):
        return openai_error("agent-backed responses do not support stream=true yet", "unsupported_feature", "stream"), 400
    agent = next((item for item in public_agents() if item["id"] == agent_id), None)
    if not agent:
        return openai_error("agent model is not online: agent:" + agent_id, "agent_bus_agent_not_online", "model"), 404
    input_value = body.get("input")
    if not response_input_has_content(input_value):
        return openai_error("input is required for agent-backed responses", "invalid_request_error", "input"), 400

    prompt = response_input_to_agent_prompt(input_value, body.get("instructions"))
    cache_scope = agent_model_cache_scope(body)
    thread = {
        "id": "thread_" + str(uuid.uuid4()),
        "created_at": now(),
        "source": "responses.agent",
        "mode": "agent-model",
        "trace_id": trace_id or new_trace_id(),
        "message": prompt,
        "model": "agent:" + agent_id,
        "selection": {
            "reason": "OpenAI-compatible Responses request routed to an Agent Bus edge agent.",
            "matched": ["agent-model", "responses"],
            "agents": [agent["id"]],
        },
        "runs": [],
    }
    if cache_scope:
        thread["cache_scope"] = cache_scope
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)
    run = create_run(config, thread, agent, prompt)
    write_snapshot(config, "threads", thread["id"], thread)
    append_jsonl(config, "threads.jsonl", thread)

    timeout_seconds = agent_model_timeout_seconds(config, body)
    final_run = wait_for_run_terminal(config, run["id"], timeout_seconds)
    if (final_run.get("status") or "").lower() != "completed":
        message = final_run.get("stderr") or final_run.get("summary") or final_run.get("stdout") or "agent response run did not complete"
        status = 504 if (final_run.get("status") or "").lower() not in TERMINAL_RUN_STATUSES else 502
        error = openai_error(trim(message), "agent_bus_agent_run_failed", "model")
        error["error"]["run_id"] = run["id"]
        error["error"]["thread_id"] = thread["id"]
        error["error"]["trace_id"] = thread["trace_id"]
        error["error"]["agent_id"] = agent_id
        error["error"]["status"] = final_run.get("status", "timeout")
        return error, status

    content = (final_run.get("stdout") or final_run.get("summary") or "").strip()
    return agent_response_payload(agent_id, agent, thread, run, content, body), 200


def agent_response_payload(agent_id, agent, thread, run, content, body):
    response_id = "resp_agentbus_" + run["id"].replace("run_", "")
    output_id = "msg_agentbus_" + run["id"].replace("run_", "")
    return {
        "id": response_id,
        "object": "response",
        "created_at": int(time.time()),
        "status": "completed",
        "model": "agent:" + agent_id,
        "output": [{
            "id": output_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{
                "type": "output_text",
                "text": content,
                "annotations": [],
            }],
        }],
        "output_text": content,
        "metadata": body.get("metadata") if isinstance(body.get("metadata"), dict) else {},
        "usage": {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
        },
        "agent_bus": {
            "thread_id": thread["id"],
            "run_id": run["id"],
            "trace_id": thread.get("trace_id"),
            "agent_id": agent_id,
            "node_id": agent.get("node_id"),
        },
    }


def agent_model_cache_scope(body):
    value = explicit_cache_scope_value(body)
    if not value:
        return ""
    digest = hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:16]
    return "request-cache-" + digest


def explicit_cache_scope_value(body):
    metadata = body.get("metadata")
    if isinstance(metadata, dict):
        for key in ("agent_bus_cache_scope", "cache_scope"):
            value = str(metadata.get(key) or "").strip()
            if value:
                return value
    agent_bus = body.get("agent_bus")
    if isinstance(agent_bus, dict):
        value = str(agent_bus.get("cache_scope") or "").strip()
        if value:
            return value
    return str(body.get("prompt_cache_key") or "").strip()


def chat_messages_to_agent_prompt(messages):
    lines = [
        "You are being invoked through Agent Bus as an OpenAI-compatible chat completion model.",
        "Return the assistant response for the latest user request. Be direct and useful.",
        "",
        "Conversation:",
    ]
    for message in messages if isinstance(messages, list) else []:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role") or "user")
        name = str(message.get("name") or "").strip()
        label = role + (f" ({name})" if name else "")
        content = chat_message_content_to_text(message.get("content"))
        if content:
            lines.append(f"[{label}]")
            lines.append(content)
            lines.append("")
    lines.append("Assistant:")
    return "\n".join(lines).strip()


def chat_messages_have_content(messages):
    if not isinstance(messages, list):
        return False
    for message in messages:
        if isinstance(message, dict) and chat_message_content_to_text(message.get("content")).strip():
            return True
    return False


def chat_message_content_to_text(content):
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                part_type = str(part.get("type") or "")
                if part_type in ("text", "input_text", "output_text"):
                    parts.append(str(part.get("text") or ""))
                elif "text" in part:
                    parts.append(str(part.get("text") or ""))
                elif part_type:
                    parts.append(f"[{part_type} omitted]")
            elif part is not None:
                parts.append(str(part))
        return "\n".join(item for item in parts if item)
    return str(content or "")


def response_input_has_content(input_value):
    return bool(response_input_to_text(input_value).strip())


def response_input_to_agent_prompt(input_value, instructions=None):
    lines = [
        "You are being invoked through Agent Bus as an OpenAI-compatible Responses API model.",
        "Return the assistant response for the user input. Be direct and useful.",
    ]
    if instructions:
        lines.extend(["", "Instructions:", str(instructions).strip()])
    lines.extend(["", "Input:", response_input_to_text(input_value), "", "Assistant:"])
    return "\n".join(lines).strip()


def response_input_to_text(input_value):
    if isinstance(input_value, str):
        return input_value
    if isinstance(input_value, list):
        parts = []
        for item in input_value:
            if isinstance(item, dict):
                item_type = str(item.get("type") or "")
                role = str(item.get("role") or "").strip()
                content = item.get("content")
                text = chat_message_content_to_text(content) if content is not None else chat_message_content_to_text([item])
                if text:
                    parts.append((f"[{role or item_type}]\n" if (role or item_type) else "") + text)
            elif item is not None:
                parts.append(str(item))
        return "\n\n".join(part for part in parts if part)
    if isinstance(input_value, dict):
        return response_input_to_text([input_value])
    return str(input_value or "")


def agent_model_timeout_seconds(config, body):
    router = config.get("modelRouter", {})
    raw = body.get("timeout_seconds", body.get("timeoutSeconds", router.get("agentModelTimeoutSeconds", 600)))
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        value = 600
    return max(1, min(value, 3600))


def wait_for_run_terminal(config, run_id, timeout_seconds):
    deadline = time.time() + timeout_seconds
    last_run = STATE["runs"].get(run_id) or {}
    while time.time() < deadline:
        last_run = STATE["runs"].get(run_id) or read_snapshot(config, "runs", run_id) or last_run
        if (last_run.get("status") or "").lower() in TERMINAL_RUN_STATUSES:
            return last_run
        time.sleep(0.25)
    return {**last_run, "status": "timeout"}


def openai_error(message, error_type, param=None):
    payload = {
        "error": {
            "message": str(message or ""),
            "type": error_type,
            "code": error_type,
        }
    }
    if param:
        payload["error"]["param"] = param
    return payload


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


PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"


def create_pair_code(config, body, handler):
    purge_expired_pair_codes()
    ttl_seconds = parse_pair_ttl(body.get("ttlSeconds") or body.get("ttl_seconds") or body.get("ttl") or 600)
    code = None
    normalized = None
    for _ in range(10):
        code = format_pair_code("".join(secrets.choice(PAIR_CODE_ALPHABET) for _ in range(8)))
        normalized = normalize_pair_code(code)
        if normalized not in STATE["pair_codes"]:
            break
    if not normalized or normalized in STATE["pair_codes"]:
        err = Exception("could not allocate pair code")
        err.status_code = 503
        raise err

    gateway_url = body.get("gatewayUrl") or body.get("gateway_url") or config.get("publicUrl") or infer_public_gateway(handler, config)
    expires_at_ts = time.time() + ttl_seconds
    record = {
        "code": normalized,
        "display_code": code,
        "gateway_url": str(gateway_url).rstrip("/"),
        "node_id": clean_pair_value(body.get("nodeId") or body.get("node_id")),
        "agent_preset": clean_pair_value(body.get("agentPreset") or body.get("agent_preset") or body.get("preset")),
        "label": clean_pair_value(body.get("label")),
        "created_at": now(),
        "expires_at_ts": expires_at_ts,
        "expires_at": iso_from_timestamp(expires_at_ts),
    }
    STATE["pair_codes"][normalized] = record
    append_jsonl(config, "pair_codes.jsonl", {
        "event": "created",
        "label": record.get("label"),
        "agent_preset": record.get("agent_preset"),
        "created_at": record["created_at"],
        "expires_at": record["expires_at"],
    })
    join_hint = f"agent-bus pair join --gateway {record['gateway_url']} --code {code} --out edge.config.json"
    if record.get("agent_preset"):
        join_hint += f" --preset {record['agent_preset']}"
    return {
        "ok": True,
        "code": code,
        "ttl_seconds": ttl_seconds,
        "expires_at": record["expires_at"],
        "gatewayUrl": record["gateway_url"],
        "agentPreset": record.get("agent_preset") or None,
        "join_hint": join_hint,
    }


def redeem_pair_code(config, body):
    purge_expired_pair_codes()
    code = normalize_pair_code(body.get("code"))
    if not code:
        err = Exception("code is required")
        err.status_code = 400
        raise err
    record = STATE["pair_codes"].pop(code, None)
    if not record:
        err = Exception("pair code not found or already used")
        err.status_code = 404
        raise err
    if float(record.get("expires_at_ts") or 0) < time.time():
        err = Exception("pair code expired")
        err.status_code = 410
        raise err
    node_id = clean_pair_value(body.get("nodeId") or body.get("node_id") or record.get("node_id"))
    edge_token, edge_record = create_edge_token(config, node_id=node_id, label=record.get("label") or "pair-code")
    append_jsonl(config, "pair_codes.jsonl", {
        "event": "redeemed",
        "label": record.get("label"),
        "agent_preset": record.get("agent_preset"),
        "edge_token_id": edge_record["id"],
        "redeemed_at": now(),
    })
    return {
        "ok": True,
        "gatewayUrl": record.get("gateway_url"),
        "token": edge_token,
        "tokenScope": "edge",
        "nodeId": node_id,
        "agentPreset": clean_pair_value(body.get("preset") or body.get("agentPreset") or record.get("agent_preset")),
    }


def purge_expired_pair_codes():
    current = time.time()
    for code, record in list(STATE["pair_codes"].items()):
        if float(record.get("expires_at_ts") or 0) < current:
            STATE["pair_codes"].pop(code, None)


def parse_pair_ttl(value):
    try:
        ttl = int(value)
    except (TypeError, ValueError):
        ttl = 600
    return max(30, min(ttl, 86400))


def format_pair_code(raw):
    return raw[:4] + "-" + raw[4:]


def normalize_pair_code(value):
    return re.sub(r"[^A-Za-z0-9]", "", str(value or "")).upper()


def clean_pair_value(value):
    text = str(value or "").strip()
    if not text:
        return ""
    return re.sub(r"[^A-Za-z0-9._:@/-]", "-", text)[:120]


def infer_public_gateway(handler, config):
    host = handler.headers.get("x-forwarded-host") or handler.headers.get("host")
    if not host:
        host = f"127.0.0.1:{config.get('port', 8788)}"
    proto = handler.headers.get("x-forwarded-proto") or ("https" if handler.headers.get("x-forwarded-ssl") == "on" else "http")
    prefix = (handler.headers.get("x-forwarded-prefix") or "").rstrip("/")
    return f"{proto}://{host}{prefix}".rstrip("/")


def iso_from_timestamp(value):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(value))


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


def list_rooms(config):
    by_id = {}
    for room in read_snapshots(config, "rooms"):
        if isinstance(room, dict) and room.get("id"):
            by_id[room["id"]] = room
    for room in STATE["rooms"].values():
        if room.get("id"):
            by_id[room["id"]] = room
    return sorted(
        [room_summary(room) for room in by_id.values()],
        key=lambda item: item.get("updated_at") or "",
        reverse=True,
    )


def create_room(config, body, trace_id=None):
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
    room_trace_id = trace_id or trace_id_from_body(body) or new_trace_id()
    room = {
        "id": "room_" + str(uuid.uuid4()),
        "trace_id": room_trace_id,
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
            "trace_id": room_trace_id,
            "at": now(),
        }],
        "runs": [],
        "reports": [],
        "reminders": [],
    }
    STATE["rooms"][room["id"]] = room
    wake_ids = body.get("wakeAgents") or body.get("wake_agents") or [room["agents"][0]]
    wake_room_agents(config, room, wake_ids, body.get("reason") or "Initial room wake.", room_trace_id)
    write_room(config, room)
    append_jsonl(config, "rooms.jsonl", room)
    return room


def add_room_message(config, room_id, body, trace_id=None):
    room = get_room(config, room_id)
    trace_id = trace_id or trace_id_from_body(body) or room.get("trace_id") or new_trace_id()
    content = body.get("content") or body.get("message")
    if not content:
        err = Exception("message content is required")
        err.status_code = 400
        raise err
    room.setdefault("messages", []).append({
        "speaker": body.get("speaker") or "user",
        "role": body.get("role") or "user",
        "content": content,
        "trace_id": trace_id,
        "at": now(),
    })
    room["updated_at"] = now()
    if body.get("wake", True) is not False:
        wake_ids = body.get("agents") or [next_room_agent(room)]
        wake_room_agents(config, room, wake_ids, body.get("reason") or "New room message.", trace_id)
    write_room(config, room)
    return room


def wake_room(config, room_id, body, trace_id=None):
    room = get_room(config, room_id)
    trace_id = trace_id or trace_id_from_body(body) or room.get("trace_id") or new_trace_id()
    agents = body.get("agents")
    if not agents and body.get("agent"):
        agents = [body.get("agent")]
    if not agents:
        agents = [next_room_agent(room)]
    wake_room_agents(config, room, agents, body.get("reason") or "Manual wake.", trace_id)
    write_room(config, room)
    return room



def pause_room(config, room_id, body):
    room = get_room(config, room_id)
    if room.get("status") == "paused":
        return room
    if room.get("status") == "completed":
        return room
    reason = (body.get("reason") or "Operator paused room.").strip() or "Operator paused room."
    paused_at = now()
    cancelled_run_ids = []
    for run in room.get("runs", []):
        if (run.get("status") or "queued").lower() != "queued":
            continue
        run["status"] = "cancelled"
        run["completed_at"] = paused_at
        run["summary"] = "Cancelled by room pause."
        cancelled_run_ids.append(run.get("id"))
        if run.get("id"):
            STATE["runs"][run["id"]] = run
            write_snapshot(config, "runs", run["id"], run)
    remove_queued_tasks(cancelled_run_ids)
    room["status"] = "paused"
    room["updated_at"] = paused_at
    room["pause"] = {
        "paused_at": paused_at,
        "reason": reason,
        "cancelled_queued_runs": [run_id for run_id in cancelled_run_ids if run_id],
    }
    room.setdefault("reports", []).append({
        "at": paused_at,
        "speaker": "system",
        "content": "Paused by operator: " + reason,
    })
    write_room(config, room)
    return room


def remove_queued_tasks(run_ids):
    run_ids = {run_id for run_id in run_ids if run_id}
    if not run_ids:
        return 0
    removed = 0
    for node_id, queue in STATE["queues"].items():
        kept = []
        for task in queue:
            if task.get("run_id") in run_ids:
                removed += 1
            else:
                kept.append(task)
        if len(kept) != len(queue):
            STATE["queues"][node_id] = kept
    return removed

def wake_room_agents(config, room, agent_ids, reason, trace_id=None):
    if isinstance(agent_ids, str):
        agent_ids = [agent_ids]
    trace_id = trace_id or room.get("trace_id") or new_trace_id()
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
        run = create_room_run(config, room, agent, message, trace_id)
        autonomy["steps"] = steps + 1
        if agent_id in (room.get("agents") or []):
            autonomy["next_index"] = (room.get("agents") or []).index(agent_id) + 1
        room["autonomy"] = autonomy
        room["status"] = "active"
        out.append(run)
    room["updated_at"] = now()
    return out


def room_prompt_limit(name, default, lower, upper):
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        value = default
    return max(lower, min(value, upper))


def truncate_for_room_prompt(value, limit):
    text = str(value or "")
    if len(text) <= limit:
        return text
    omitted = len(text) - limit
    return text[:limit].rstrip() + f"\n[truncated {omitted} chars]"


def compact_room_item(item, per_item_limit):
    content = truncate_for_room_prompt(item.get("content") or item.get("message") or item.get("text") or "", per_item_limit)
    out = {
        "at": item.get("at") or item.get("created_at"),
        "speaker": item.get("speaker") or item.get("agent_id") or item.get("role") or "unknown",
        "content": content,
    }
    run_id = item.get("run_id")
    if run_id:
        out["run_id"] = run_id
    return out


def compact_room_blackboard(room):
    board = room.get("blackboard") if isinstance(room.get("blackboard"), dict) else {}
    item_limit = room_prompt_limit("AGENT_BUS_ROOM_PROMPT_ITEM_CHARS", 1200, 200, 8000)
    item_count = room_prompt_limit("AGENT_BUS_ROOM_PROMPT_ITEM_COUNT", 6, 1, 20)
    compact = {
        "permissions": board.get("permissions"),
        "budget": board.get("budget"),
        "open_questions": board.get("open_questions") or [],
        "next_actions": board.get("next_actions") or [],
    }
    notes = board.get("notes") if isinstance(board.get("notes"), list) else []
    reports = board.get("reports") if isinstance(board.get("reports"), list) else room.get("reports") or []
    if notes:
        compact["recent_notes"] = [compact_room_item(item, item_limit) for item in notes[-item_count:] if isinstance(item, dict)]
    if reports:
        compact["recent_reports"] = [compact_room_item(item, item_limit) for item in reports[-item_count:] if isinstance(item, dict)]
    return {key: value for key, value in compact.items() if value not in (None, "", [])}


def compact_recent_room_messages(room):
    item_limit = room_prompt_limit("AGENT_BUS_ROOM_PROMPT_MESSAGE_CHARS", 1000, 200, 8000)
    item_count = room_prompt_limit("AGENT_BUS_ROOM_PROMPT_MESSAGE_COUNT", 8, 1, 20)
    messages = room.get("messages") or []
    return [compact_room_item(item, item_limit) for item in messages[-item_count:] if isinstance(item, dict)]


def autonomous_prompt(room, agent, reason):
    autonomy = room.get("autonomy") or {}
    lines = [
        "You are an autonomous agent inside an Agent Bus room.",
        f"Room: {room.get('title') or room['id']}",
        f"Your identity: {agent['id']} ({agent.get('kind')}/{agent.get('role')}).",
        "",
        "Goal:",
        truncate_for_room_prompt(room.get("goal", ""), room_prompt_limit("AGENT_BUS_ROOM_PROMPT_GOAL_CHARS", 12000, 1000, 50000)),
        "",
        "Cache-stable room contract:",
        "Agent Bus rooms are shared AI-to-AI workspaces. Treat the room goal, agent identity, and autonomy protocol as durable context for this room. Work from the latest state, but keep the beginning of your reasoning anchored in the stable room contract so model gateways can reuse cached prompt prefixes across repeated wakes. Your job is to advance the room goal, report useful findings, and delegate work only when another listed agent is better positioned to inspect, code, browse, deploy, or verify. Prefer concrete outcomes over commentary. When you need another agent, address that agent with an @agent-id directive and a self-contained task. When you produce a user-facing update, use REPORT with the important result. When shared state should persist for the next wake, use BLACKBOARD with the shortest useful note. When the goal is genuinely complete, include DONE. Do not mark DONE just because your own subtask is complete if other queued or running work remains relevant. Keep responses compact enough for room history to stay readable, but include paths, commands, endpoints, IDs, or error text when those details are needed for another agent to continue. Do not repeat this contract back to the room.",
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
        "",
        "Current room state follows. These sections may change between wakes.",
        "",
        "Room progress:",
        f"steps={autonomy.get('steps', 0)} max_steps={autonomy.get('max_steps', 0)} status={room.get('status', 'active')}",
        "",
        "Shared blackboard summary:",
        json.dumps(compact_room_blackboard(room), ensure_ascii=False, indent=2),
        "",
        "Latest wake reason:",
        str(reason or "").strip(),
        "",
        "Recent room messages (compact, newest kept):",
    ]
    for item in compact_recent_room_messages(room):
        speaker = item.get("speaker") or "unknown"
        content = str(item.get("content") or "").strip()
        if content:
            lines.append(f"{speaker}: {content}")
    return "\n".join(lines)


def create_room_run(config, room, agent, message, trace_id=None):
    trace_id = trace_id or room.get("trace_id") or new_trace_id()
    run = {
        "id": "run_" + str(uuid.uuid4()),
        "thread_id": room["id"],
        "room_id": room["id"],
        "trace_id": trace_id,
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
        "trace_id": trace_id,
        "agent_id": agent["id"],
        "message": message,
        "created_at": run["created_at"],
    })
    return run


def create_thread(config, body, trace_id=None):
    if not body.get("message"):
        err = Exception("message is required")
        err.status_code = 400
        raise err
    trace_id = trace_id or trace_id_from_body(body) or new_trace_id()
    selection = select_agents(body["message"], {"mode": body.get("mode", config["defaults"]["mode"]), "agents": body.get("agents")})
    if body.get("mode") == "group":
        return create_group_thread(config, body, selection, trace_id)
    thread = {
        "id": "thread_" + str(uuid.uuid4()),
        "trace_id": trace_id,
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
        create_run(config, thread, agent, body["message"], trace_id=trace_id)
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)
    append_jsonl(config, "threads.jsonl", thread)
    return thread


def create_group_thread(config, body, selection, trace_id=None):
    agents = selection["agents"]
    if len(agents) < 2:
        err = Exception("group mode requires at least two agents")
        err.status_code = 400
        raise err
    rounds = max(1, min(int(body.get("rounds") or 2), 8))
    trace_id = trace_id or trace_id_from_body(body) or new_trace_id()
    thread = {
        "id": "thread_" + str(uuid.uuid4()),
        "trace_id": trace_id,
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
            "trace_id": trace_id,
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
    create_run(config, thread, agent, message, turn_index=turn_index, trace_id=thread.get("trace_id"))
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


def create_run(config, thread, agent, message, turn_index=None, trace_id=None):
    trace_id = trace_id or thread.get("trace_id") or new_trace_id()
    run = {
        "id": "run_" + str(uuid.uuid4()),
        "thread_id": thread["id"],
        "trace_id": trace_id,
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
    if thread.get("cache_scope"):
        run["cache_scope"] = thread["cache_scope"]
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
        "trace_id": trace_id,
        "agent_id": agent["id"],
        "message": message,
        **({"cache_scope": run["cache_scope"]} if run.get("cache_scope") else {}),
        "created_at": run["created_at"],
    })
    return run


def enqueue(node_id, task):
    STATE["queues"].setdefault(node_id, []).append(task)
    cond = STATE["conditions"].setdefault(node_id, threading.Condition())
    with cond:
        cond.notify()


def poll_node(config, body, timeout_ms):
    node_id = body.get("node_id")
    if node_id not in STATE["nodes"]:
        err = Exception("unknown node_id")
        err.status_code = 404
        raise err
    node = STATE["nodes"][node_id]
    node["last_seen_at"] = now()
    node["status"] = "online"
    if "agents" in body:
        node["agents"] = merge_agent_updates(node_id, node.get("agents") or [], body.get("agents") or [])
    queue = STATE["queues"].setdefault(node_id, [])
    if queue:
        return {"type": "task", "task": queue.pop(0)}
    cond = STATE["conditions"].setdefault(node_id, threading.Condition())
    with cond:
        cond.wait(timeout=max(1, min(timeout_ms, 60000)) / 1000)
    if queue:
        return {"type": "task", "task": queue.pop(0)}
    return {"type": "idle"}


def touch_node_seen(node_id):
    node = STATE["nodes"].get(node_id)
    if not node:
        return
    node["last_seen_at"] = now()
    node["status"] = "online"


def merge_agent_updates(node_id, current, updates):
    by_id = {agent.get("id"): dict(agent) for agent in current if agent.get("id")}
    for update in normalize_agents(node_id, updates):
        existing = by_id.get(update["id"], {})
        existing.update(update)
        by_id[update["id"]] = existing
    return list(by_id.values())


def record_event(config, body):
    run = STATE["runs"].get(body.get("run_id")) or read_snapshot(config, "runs", body.get("run_id"))
    if not run:
        return
    touch_node_seen(body.get("node_id") or run.get("node_id"))
    event = {"at": now(), "node_id": body.get("node_id") or run.get("node_id"), **(body.get("event") or {})}
    event["trace_id"] = sanitize_trace_id(body.get("trace_id") or event.get("trace_id") or run.get("trace_id"))
    if event["trace_id"] and not run.get("trace_id"):
        run["trace_id"] = event["trace_id"]
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
    touch_node_seen(body.get("node_id") or run.get("node_id"))
    if body.get("trace_id") and not run.get("trace_id"):
        run["trace_id"] = sanitize_trace_id(body.get("trace_id"))
    result = body.get("result") or {}
    exit_code = result.get("exit_code")
    run["status"] = result.get("status") or ("completed" if exit_code == 0 else "failed")
    run["completed_at"] = now()
    run["exit_code"] = exit_code
    run["stdout"] = trim(redact_text(result.get("stdout", run.get("stdout", ""))))
    run["stderr"] = trim(redact_text(result.get("stderr", run.get("stderr", ""))))
    run["summary"] = trim(redact_text(result.get("summary", "")))
    update_agent_run_health(run)
    STATE["runs"][run["id"]] = run
    write_snapshot(config, "runs", run["id"], run)
    update_thread_run(config, run)
    continue_group_thread(config, run)
    continue_room_run(config, run)
    append_jsonl(config, "runs.jsonl", run)
    notify_plugin(config, "run.completed" if run.get("status") == "completed" else "run.failed", {
        "run_id": run.get("id"),
        "thread_id": run.get("thread_id"),
        "room_id": run.get("room_id"),
        "agent_id": run.get("agent_id"),
        "node_id": run.get("node_id"),
        "status": run.get("status"),
        "exit_code": run.get("exit_code"),
    })
    return run


def update_agent_run_health(run):
    node = STATE["nodes"].get(run.get("node_id"))
    if not node:
        return
    for agent in node.get("agents") or []:
        if agent.get("id") != run.get("agent_id"):
            continue
        health = dict(agent.get("health") or {})
        health["last_run_status"] = run.get("status")
        health["last_run_at"] = run.get("completed_at") or now()
        if run.get("status") == "completed":
            health["last_success_at"] = health["last_run_at"]
        else:
            health["last_error_at"] = health["last_run_at"]
            health["last_error"] = trim(run.get("stderr") or run.get("summary") or "run failed")[:2000]
        agent["health"] = health
        return


def continue_room_run(config, run):
    room_id = run.get("room_id") or run.get("thread_id")
    room = STATE["rooms"].get(room_id) or read_snapshot(config, "rooms", room_id)
    if not room:
        return
    sync_room_run(room, run)
    if any(item.get("run_id") == run["id"] for item in room.get("messages") or []):
        return
    content = (run.get("stdout") or run.get("summary") or run.get("stderr") or "").strip()
    room.setdefault("messages", []).append({
        "speaker": run.get("agent_id"),
        "role": run.get("kind") or "agent",
        "run_id": run["id"],
        "trace_id": run.get("trace_id") or room.get("trace_id"),
        "status": run.get("status"),
        "content": content,
        "at": run.get("completed_at") or now(),
    })
    previous_status = room.get("status")
    actions = process_room_directives(config, room, run, content)
    finalize_room_completion(room)
    if previous_status != "completed" and room.get("status") == "completed":
        notify_plugin(config, "room.completed", {
            "room_id": room.get("id"),
            "title": room.get("title"),
            "agents": room.get("agents") or [],
            "reports": len(room.get("reports") or []),
            "runs": len(room.get("runs") or []),
        })
    scheduled_actions = {"wake", "reminder", "done"}
    if not any(action in scheduled_actions for action in actions) and room.get("status") == "active" and room.get("autonomy", {}).get("auto_rotate", True):
        wake_room_agents(config, room, [next_room_agent(room)], "Continue the room from the latest message.", run.get("trace_id") or room.get("trace_id"))
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
            request_room_completion(room, run)
            actions.append("done")
            continue
        match = re.match(r"^REPORT\s*:\s*(.+)", line, re.I)
        if match:
            report = {"at": now(), "speaker": run.get("agent_id"), "content": match.group(1).strip(), "run_id": run["id"], "trace_id": run.get("trace_id") or room.get("trace_id")}
            room.setdefault("reports", []).append(report)
            room.setdefault("blackboard", {}).setdefault("reports", []).append(report)
            actions.append("report")
            continue
        match = re.match(r"^BLACKBOARD\s*:\s*(.+)", line, re.I)
        if match:
            note = {"at": now(), "speaker": run.get("agent_id"), "content": match.group(1).strip(), "run_id": run["id"], "trace_id": run.get("trace_id") or room.get("trace_id")}
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
                    "trace_id": run.get("trace_id") or room.get("trace_id"),
                })
                actions.append("reminder")
            continue
        match = re.match(r"^@([A-Za-z0-9_.-]+)\s*:\s*(.+)", line)
        if match:
            agent_id, task = match.groups()
            if agent_id in agent_ids:
                wake_room_agents(config, room, [agent_id], task.strip(), run.get("trace_id") or room.get("trace_id"))
                actions.append("wake")
            continue
    return actions


TERMINAL_RUN_STATUSES = {"completed", "failed", "error", "cancelled", "canceled", "skipped"}


def sync_room_run(room, run):
    room["runs"] = [run if item.get("id") == run.get("id") else item for item in room.get("runs", [])]


def active_room_runs(room):
    return [
        item for item in room.get("runs", [])
        if (item.get("status") or "queued").lower() not in TERMINAL_RUN_STATUSES
    ]


def request_room_completion(room, run):
    completion = room.setdefault("completion", {})
    completion["requested"] = True
    requests = completion.setdefault("requests", [])
    if not any(item.get("run_id") == run.get("id") for item in requests):
        requests.append({
            "at": now(),
            "speaker": run.get("agent_id"),
            "run_id": run.get("id"),
        })
    finalize_room_completion(room)


def finalize_room_completion(room):
    if room.get("status") in ("completed", "paused"):
        return
    completion = room.get("completion") or {}
    if not completion.get("requested"):
        return
    if active_room_runs(room):
        room["status"] = "finishing"
        return
    completion["completed_at"] = completion.get("completed_at") or now()
    room["completion"] = completion
    room["status"] = "completed"


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
        "trace_id": run.get("trace_id") or thread.get("trace_id"),
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
        "trace_id": body.get("trace_id") or room.get("trace_id"),
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
                wake_room_agents(config, room, [reminder["agent_id"]], reminder.get("reason") or "Scheduled room wake.", reminder.get("trace_id") or room.get("trace_id"))
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


def public_gateway_url(config):
    configured = str(config.get("gatewayUrl") or "").strip()
    if configured:
        return configured.rstrip("/")
    host = config.get("host") or "127.0.0.1"
    port = config.get("port") or 8788
    return f"http://{host}:{port}".rstrip("/")


def telegram_plugin_config(config):
    plugins = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
    plugin = dict(plugins.get("telegramBot") or {})
    env_enabled = os.environ.get("AGENT_BUS_TELEGRAM_ENABLED")
    if env_enabled:
        plugin["enabled"] = env_enabled.strip().lower() in ("1", "true", "yes", "on")
    plugin.setdefault("enabled", False)
    plugin.setdefault("botTokenEnv", "AGENT_BUS_TELEGRAM_BOT_TOKEN")
    plugin.setdefault("chatIdEnv", "AGENT_BUS_TELEGRAM_CHAT_ID")
    plugin.setdefault("events", sorted(TELEGRAM_DEFAULT_EVENTS))
    plugin.setdefault("dryRun", False)
    return plugin


def public_telegram_plugin_status(config):
    plugin = telegram_plugin_config(config)
    token = telegram_bot_token(plugin)
    chat_id = telegram_chat_id(plugin)
    return {
        "enabled": plugin.get("enabled") is True,
        "configured": bool(token and chat_id),
        "dry_run": plugin.get("dryRun") is True or plugin.get("dry_run") is True,
        "events": plugin_events(plugin),
        "bot_token_env": plugin.get("botTokenEnv"),
        "chat_id_env": plugin.get("chatIdEnv"),
    }


def plugin_events(plugin):
    events = plugin.get("events")
    if not isinstance(events, list) or not events:
        return sorted(TELEGRAM_DEFAULT_EVENTS)
    return [str(item) for item in events]


def telegram_bot_token(plugin):
    env_name = str(plugin.get("botTokenEnv") or "AGENT_BUS_TELEGRAM_BOT_TOKEN")
    return str(os.environ.get(env_name) or plugin.get("botToken") or plugin.get("bot_token") or "").strip()


def telegram_chat_id(plugin):
    env_name = str(plugin.get("chatIdEnv") or "AGENT_BUS_TELEGRAM_CHAT_ID")
    return str(os.environ.get(env_name) or plugin.get("chatId") or plugin.get("chat_id") or "").strip()


def notify_plugin(config, event, payload):
    plugin = telegram_plugin_config(config)
    if plugin.get("enabled") is not True:
        return
    if event not in set(plugin_events(plugin)):
        return
    text = telegram_notification_text(event, payload)
    token = telegram_bot_token(plugin)
    chat_id = telegram_chat_id(plugin)
    dry_run = plugin.get("dryRun") is True or plugin.get("dry_run") is True
    status = "dry_run" if dry_run else ("queued" if token and chat_id else "missing_config")
    append_jsonl(config, "notifications.jsonl", {
        "at": now(),
        "plugin": "telegramBot",
        "event": event,
        "status": status,
        "message": text,
        "payload": payload,
    })
    if dry_run or not token or not chat_id:
        return
    threading.Thread(target=send_telegram_notification, args=(config, token, chat_id, text), daemon=True).start()


def telegram_notification_text(event, payload):
    if event == "central.started":
        return f"Agent Bus central started\nGateway: {payload.get('gateway')}\nRuntime: {payload.get('runtime')}"
    if event == "edge.registered":
        agents = ", ".join(payload.get("agents") or []) or "none"
        return f"Agent Bus edge registered\nNode: {payload.get('node_id')}\nAgents: {agents}"
    if event in ("run.completed", "run.failed"):
        return f"Agent Bus run {payload.get('status')}\nRun: {payload.get('run_id')}\nAgent: {payload.get('agent_id')}\nNode: {payload.get('node_id')}"
    if event == "room.completed":
        return f"Agent Bus room completed\nRoom: {payload.get('room_id')}\nTitle: {payload.get('title')}\nReports: {payload.get('reports')}"
    return f"Agent Bus event: {event}\n{json.dumps(payload, ensure_ascii=False)}"


def send_telegram_notification(config, token, chat_id, text):
    try:
        data = urlencode({
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": "true",
        }).encode("utf-8")
        req = Request(f"https://api.telegram.org/bot{token}/sendMessage", data=data, method="POST")
        req.add_header("content-type", "application/x-www-form-urlencoded")
        timeout = float(telegram_plugin_config(config).get("timeoutSeconds") or 5)
        with urlopen(req, timeout=max(1, min(timeout, 30))) as response:
            response.read()
        append_jsonl(config, "notifications.jsonl", {
            "at": now(),
            "plugin": "telegramBot",
            "event": "send.completed",
            "status": "completed",
        })
    except Exception as exc:
        append_jsonl(config, "notifications.jsonl", {
            "at": now(),
            "plugin": "telegramBot",
            "event": "send.failed",
            "status": "failed",
            "error": str(exc),
        })


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


def read_snapshots(config, folder):
    root = Path(config["dataDir"]) / folder
    if not root.exists():
        return []
    out = []
    for path in sorted(root.glob("*.json")):
        try:
            out.append(json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            continue
    return out


def trace_lookup(config, trace_id):
    trace_id = sanitize_trace_id(trace_id)
    if not trace_id:
        err = Exception("trace_id is required")
        err.status_code = 400
        raise err
    threads = [item for item in read_snapshots(config, "threads") if object_has_trace(item, trace_id)]
    rooms = [item for item in read_snapshots(config, "rooms") if object_has_trace(item, trace_id)]
    runs = [item for item in read_snapshots(config, "runs") if object_has_trace(item, trace_id)]
    events = [item for item in read_jsonl(config, "events.jsonl") if object_has_trace(item, trace_id)]
    result = {
        "trace_id": trace_id,
        "summary": {
            "threads": len(threads),
            "rooms": len(rooms),
            "runs": len(runs),
            "events": len(events),
            "agents": sorted({item.get("agent_id") for item in runs if item.get("agent_id")}),
            "nodes": sorted({item.get("node_id") for item in runs if item.get("node_id")}),
            "statuses": sorted({item.get("status") for item in runs if item.get("status")}),
        },
        "threads": sorted(threads, key=lambda item: item.get("created_at") or ""),
        "rooms": sorted(rooms, key=lambda item: item.get("created_at") or ""),
        "runs": sorted(runs, key=lambda item: item.get("created_at") or ""),
        "events": sorted(events, key=lambda item: item.get("at") or ""),
    }
    if not (threads or rooms or runs or events):
        err = Exception("trace not found")
        err.status_code = 404
        raise err
    return result


def object_has_trace(value, trace_id):
    if not isinstance(value, dict):
        return False
    if sanitize_trace_id(value.get("trace_id") or value.get("traceId")) == trace_id:
        return True
    for key in ("runs", "events", "messages", "reports", "conversation", "reminders"):
        items = value.get(key)
        if isinstance(items, list) and any(object_has_trace(item, trace_id) for item in items):
            return True
    blackboard = value.get("blackboard")
    if isinstance(blackboard, dict):
        for items in blackboard.values():
            if isinstance(items, list) and any(object_has_trace(item, trace_id) for item in items):
                return True
    return False


def read_jsonl(config, name):
    path = Path(config["dataDir"]) / name
    if not path.exists():
        return []
    out = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                continue
    return out


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
