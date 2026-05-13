#!/usr/bin/env python3
import calendar
import errno
import hashlib
import json
import mimetypes
import os
import re
import secrets
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError

try:
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
except ImportError:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from socketserver import ThreadingMixIn

    class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
        daemon_threads = True

TELEGRAM_DEFAULT_EVENTS = {
    "central.started",
    "edge.registered",
    "run.completed",
    "run.failed",
    "room.completed",
    "telegram.test",
    "telegram.command",
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
RUN_COMPLETION_LOCK = threading.RLock()


def int_env(name, default):
    try:
        return int(os.environ.get(name, str(default)))
    except (TypeError, ValueError):
        return default


NODE_STALE_SECONDS = max(1, int_env("AGENT_BUS_NODE_STALE_SECONDS", 180))
CLIENT_DISCONNECT_ERRNOS = {errno.EPIPE, errno.ECONNRESET, errno.ECONNABORTED}


def is_client_disconnect(exc):
    return isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)) or (
        isinstance(exc, OSError) and getattr(exc, "errno", None) in CLIENT_DISCONNECT_ERRNOS
    )


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
    (root / "telegram_sessions").mkdir(parents=True, exist_ok=True)


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
        if run_is_replaced(run) or run_is_late_complete_ignored(run):
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
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            if path == "/health":
                return self.json(central_health())
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
            if path in ("/status", "/v1/agent-bus/status"):
                self.require_auth(("admin",))
                return self.json(public_status(self.config))
            if path in ("/manifest", "/v1/agent-bus/manifest"):
                self.require_auth(("admin", "edge"))
                return self.json(agent_bus_manifest(self.config))
            if path in ("/plugins", "/v1/agent-bus/plugins"):
                self.require_auth(("admin",))
                return self.json(public_plugins_status(self.config))
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
                parts = path.strip("/").split("/")
                if len(parts) == 3 and parts[2] == "memory":
                    return self.json(room_memory_api(self.config, parts[1], query))
                if len(parts) == 4 and parts[2] == "memory" and parts[3] == "expand":
                    return self.json(room_memory_expand_api(self.config, parts[1], query))
                if len(parts) != 2:
                    return self.json({"error": "not_found"}, 404)
                room_id = parts[1] if len(parts) >= 2 else path.rsplit("/", 1)[-1]
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
            if is_client_disconnect(exc):
                return
            return self.json({"error": str(exc)}, getattr(exc, "status_code", 500))

    def do_POST(self):
        try:
            path = urlparse(self.path).path
            if path == "/edge/pair":
                body = self.read_json()
                return self.json(redeem_pair_code(self.config, body), redact_value=False)

            body = self.read_json()
            if path in ("/plugins/telegram/webhook", "/v1/agent-bus/plugins/telegram/webhook"):
                return self.json(telegram_webhook(self.config, body, self))
            if path in ("/pair-codes", "/v1/agent-bus/pair-codes"):
                self.require_auth(("admin",))
                return self.json(create_pair_code(self.config, body, self), 201)
            if path in ("/edge/tokens", "/v1/agent-bus/edge-tokens"):
                self.require_auth(("admin",))
                return self.json(create_manual_edge_token(self.config, body), 201, redact_value=False)
            if path in ("/edge/tokens/revoke", "/v1/agent-bus/edge-tokens/revoke"):
                self.require_auth(("admin",))
                return self.json(revoke_edge_token(self.config, body))
            if path in ("/plugins/telegram/test", "/v1/agent-bus/plugins/telegram/test"):
                self.require_auth(("admin",))
                return self.json(telegram_plugin_test(self.config, body))
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
                if len(parts) == 3 and parts[2] == "recover":
                    return self.json(recover_room(self.config, parts[1], body))
                if len(parts) == 3 and parts[2] in ("supervisor", "supervise"):
                    return self.json(supervise_room(self.config, parts[1], body))
                if len(parts) == 3 and parts[2] == "reminders":
                    return self.json(add_room_reminder(self.config, parts[1], body), 201)
            return self.json({"error": "not_found"}, 404)
        except Exception as exc:
            if is_client_disconnect(exc):
                return
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
        try:
            self.send_response(status)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            if is_client_disconnect(exc):
                return
            raise

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
        try:
            self.send_response(200)
            self.send_header("content-type", content_type + ("; charset=utf-8" if content_type.startswith("text/") else ""))
            self.send_header("cache-control", "no-store" if file_path.name == "index.html" else "public, max-age=60")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as exc:
            if is_client_disconnect(exc):
                return
            raise

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
                try:
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
                except Exception as exc:
                    if is_client_disconnect(exc):
                        return
                    raise
        except HTTPError as exc:
            payload = exc.read()
            try:
                self.send_response(exc.code)
                self.send_header("content-type", exc.headers.get("content-type", "application/json"))
                self.send_header("cache-control", "no-store")
                self.send_header("x-agent-bus-backend", backend["id"])
                self.end_headers()
                self.wfile.write(payload or json.dumps({"error": {"message": str(exc)}}).encode("utf-8"))
            except Exception as write_exc:
                if is_client_disconnect(write_exc):
                    return
                raise
        except Exception as exc:
            if is_client_disconnect(exc):
                return
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
                try:
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
                except Exception as exc:
                    if is_client_disconnect(exc):
                        return
                    raise
        except HTTPError as exc:
            payload = exc.read()
            try:
                self.send_response(exc.code)
                self.send_header("content-type", exc.headers.get("content-type", "application/json"))
                self.send_header("cache-control", "no-store")
                self.send_header("x-agent-bus-backend", backend["id"])
                self.end_headers()
                self.wfile.write(payload or json.dumps({"error": {"message": str(exc)}}).encode("utf-8"))
            except Exception as write_exc:
                if is_client_disconnect(write_exc):
                    return
                raise
        except Exception as exc:
            if is_client_disconnect(exc):
                return
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
        try:
            heartbeat_interval_ms = int(agent.get("run_heartbeat_interval_ms") or agent.get("runHeartbeatIntervalMs") or 0)
        except Exception:
            heartbeat_interval_ms = 0
        if heartbeat_interval_ms > 0:
            item["run_heartbeat_interval_ms"] = heartbeat_interval_ms
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
    item = {
        "id": agent.get("id"),
        "kind": agent.get("kind"),
        "role": agent.get("role"),
        "enabled": agent.get("enabled") is not False,
        "capabilities": agent.get("capabilities") or [],
    }
    try:
        heartbeat_interval_ms = int(agent.get("run_heartbeat_interval_ms") or 0)
    except Exception:
        heartbeat_interval_ms = 0
    if heartbeat_interval_ms > 0:
        item["run_heartbeat_interval_ms"] = heartbeat_interval_ms
    return item


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


def agent_id_conflicts(agents):
    by_id = {}
    for agent in agents or []:
        agent_id = str((agent or {}).get("id") or "").strip()
        if not agent_id:
            continue
        item = by_id.setdefault(agent_id, {"id": agent_id, "nodes": [], "count": 0})
        item["count"] += 1
        node_id = str((agent or {}).get("node_id") or "").strip()
        if node_id and node_id not in item["nodes"]:
            item["nodes"].append(node_id)
    conflicts = []
    for item in by_id.values():
        if item["count"] <= 1:
            continue
        item["nodes"] = sorted(item["nodes"])
        conflicts.append(item)
    return sorted(conflicts, key=lambda item: item["id"])


def raise_if_agent_ids_ambiguous(agent_ids, agents):
    wanted = {str(agent_id or "").strip() for agent_id in agent_ids or [] if str(agent_id or "").strip()}
    if not wanted:
        return
    conflicts = [item for item in agent_id_conflicts(agents) if item["id"] in wanted]
    if not conflicts:
        return
    parts = []
    for item in conflicts:
        locations = ", ".join(item["nodes"]) or (str(item["count"]) + " nodes")
        parts.append(f"{item['id']} on {locations}")
    details = ", ".join(parts)
    err = Exception("ambiguous registered agents: " + details + ". Rename duplicate agent ids before routing work.")
    err.status_code = 409
    raise err


def central_health():
    agents = public_agents()
    nodes = public_nodes()
    return {
        "ok": True,
        "nodes": len(nodes),
        "agents": len(agents),
        "registered_nodes": len(STATE["nodes"]),
        "registered_agents": sum(len(node.get("agents", [])) for node in STATE["nodes"].values()),
        "queued": sum(len(q) for q in STATE["queues"].values()),
    }


STATUS_ACTIVE_ROOM_STATUSES = {"active", "running", "finishing"}
STATUS_QUEUED_RUN_STALE_SECONDS = 21600
STATUS_RUN_HEARTBEAT_STALE_SECONDS = max(
    1,
    int_env(
        "AGENT_BUS_STATUS_RUN_HEARTBEAT_STALE_SECONDS",
        int_env("AGENT_BUS_RUNNING_RUN_STALE_SECONDS", 90),
    ),
)


def public_status(config):
    health = central_health()
    agents = public_agents()
    nodes = public_registered_nodes()
    conflicts = agent_id_conflicts(agents)
    rooms = status_room_details(config)
    active_rooms = [room for room in rooms if status_is_active_room(room)]
    run_summary = status_room_run_summary(active_rooms)
    recovery_hints = status_recovery_hints(run_summary["stale_queued_runs"])
    busy_agent_ids = set(run_summary["live_by_agent"].keys())
    for room in active_rooms:
        if isinstance(room.get("runs"), list):
            continue
        for agent_id in room.get("agents") or []:
            if agent_id:
                busy_agent_ids.add(agent_id)
    result = {
        "ok": bool(health.get("ok")),
        "health": health,
        "summary": {
            "nodes": health.get("nodes", 0),
            "agents": health.get("agents", 0),
            "registered_nodes": health.get("registered_nodes", health.get("nodes", 0)),
            "registered_agents": health.get("registered_agents", health.get("agents", 0)),
            "queued": health.get("queued", 0),
            "online_agents": len([agent for agent in agents if agent.get("status") == "online"]),
            "reachable_agents": len([agent for agent in agents if agent.get("ping_status") == "reachable"]),
            "busy_agents": len([agent for agent in agents if agent.get("id") in busy_agent_ids]),
            "rooms": len(rooms),
            "active_rooms": len(active_rooms),
            "active_runs": len(run_summary["live_runs"]),
            "stale_queued_runs": len(run_summary["stale_queued_runs"]),
            "duplicate_agent_ids": len(conflicts),
        },
        "nodes": [status_node_item(node) for node in nodes],
        "agents": [status_agent_item(agent, active_rooms, run_summary) for agent in agents],
        "agent_id_conflicts": conflicts,
        "rooms": [status_room_item(room) for room in rooms[:8]],
        "recovery_hints": recovery_hints,
    }
    result["warnings"] = status_warnings(result, run_summary["stale_queued_runs"], recovery_hints)
    result["readiness"] = status_readiness(result)
    result["next_actions"] = status_next_actions(result)
    return result


def status_room_details(config):
    by_id = {}
    for room in read_snapshots(config, "rooms"):
        if isinstance(room, dict) and room.get("id"):
            by_id[room["id"]] = room
    for room in STATE["rooms"].values():
        if isinstance(room, dict) and room.get("id"):
            by_id[room["id"]] = room
    return sorted(
        by_id.values(),
        key=lambda item: item.get("updated_at") or item.get("created_at") or "",
        reverse=True,
    )


def status_is_active_room(room):
    return str((room or {}).get("status") or "").lower() in STATUS_ACTIVE_ROOM_STATUSES


def status_room_run_summary(rooms):
    live_runs = []
    stale_queued_runs = []
    live_by_agent = {}
    stale_queued_by_agent = {}
    for room in rooms:
        buckets = status_run_buckets(room)
        live_runs.extend(buckets["live_runs"])
        stale_queued_runs.extend(buckets["stale_queued_runs"])
        status_add_runs_by_agent(live_by_agent, buckets["live_runs"])
        status_add_runs_by_agent(stale_queued_by_agent, buckets["stale_queued_runs"])
    status_sort_runs_by_newest(live_by_agent)
    status_sort_runs_by_newest(stale_queued_by_agent)
    return {
        "live_runs": live_runs,
        "stale_queued_runs": stale_queued_runs,
        "live_by_agent": live_by_agent,
        "stale_queued_by_agent": stale_queued_by_agent,
    }


def status_run_buckets(room):
    live_runs = []
    stale_queued_runs = []
    room_id = room.get("id") or ""
    for raw_run in room.get("runs") or []:
        if not run_is_active_for_room(raw_run):
            continue
        status = str(raw_run.get("status") or "queued").lower()
        run = {
            "id": raw_run.get("id"),
            "room_id": raw_run.get("room_id") or room_id,
            "agent_id": raw_run.get("agent_id"),
            "status": raw_run.get("status") or "queued",
            "created_at": raw_run.get("created_at"),
            "started_at": raw_run.get("started_at"),
        }
        if status_is_stale_queued_run(run):
            stale_queued_runs.append(run)
        else:
            live_runs.append(run)
    return {"live_runs": live_runs, "stale_queued_runs": stale_queued_runs}


def status_is_stale_queued_run(run):
    if str(run.get("status") or "").lower() != "queued":
        return False
    created_at = status_timestamp(run.get("created_at"))
    if created_at is None:
        return False
    return time.time() - created_at > STATUS_QUEUED_RUN_STALE_SECONDS


def status_timestamp(value):
    if not value:
        return None
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except Exception:
        pass
    try:
        return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))
    except Exception:
        return None


def status_add_runs_by_agent(by_agent, runs):
    for run in runs:
        agent_id = run.get("agent_id")
        if not agent_id:
            continue
        by_agent.setdefault(agent_id, []).append(run)


def status_sort_runs_by_newest(by_agent):
    def key(run):
        return status_timestamp(run.get("started_at") or run.get("created_at")) or 0
    for runs in by_agent.values():
        runs.sort(key=key, reverse=True)


def status_node_agent_id(agent):
    return agent if isinstance(agent, str) else (agent or {}).get("id")


def status_node_item(node):
    return {
        "id": node.get("node_id") or node.get("id") or "unknown",
        "status": node.get("status") or "unknown",
        "last_seen_at": node.get("last_seen_at"),
        "agents": [
            status_node_agent_id(agent)
            for agent in node.get("agents") or []
            if status_node_agent_id(agent)
        ],
    }


def status_agent_item(agent, active_rooms, run_summary):
    agent_id = agent.get("id")
    health = agent.get("health") if isinstance(agent.get("health"), dict) else {}
    active_runs = run_summary["live_by_agent"].get(agent_id, [])
    stale_queued_runs = run_summary["stale_queued_by_agent"].get(agent_id, [])
    active_room_ids = status_unique(
        [run.get("room_id") for run in active_runs if run.get("room_id")] +
        [
            room.get("id")
            for room in active_rooms
            if not isinstance(room.get("runs"), list) and agent_id in (room.get("agents") or [])
        ]
    )
    latest_run = active_runs[0] if active_runs else None
    return {
        "id": agent_id,
        "status": agent.get("status") or "unknown",
        "ping_status": agent.get("ping_status") or health.get("ping_status") or "unknown",
        "last_run_status": agent.get("last_run_status") or health.get("last_run_status"),
        "last_seen_at": agent.get("last_seen_at") or agent.get("node_last_seen_at"),
        "activity": status_agent_activity(active_runs, active_room_ids),
        "active_rooms": active_room_ids,
        "active_runs": active_runs,
        "stale_queued_runs": stale_queued_runs,
        "current_run": latest_run.get("id") if latest_run else None,
    }


def status_agent_activity(active_runs, active_room_ids):
    if any(str(run.get("status") or "").lower() == "running" for run in active_runs):
        return "running"
    if any(str(run.get("status") or "").lower() == "queued" for run in active_runs):
        return "queued"
    return "busy/room-active" if active_room_ids else "idle"


def status_room_item(room):
    buckets = status_run_buckets(room)
    return {
        "id": room.get("id"),
        "status": room.get("status"),
        "agents": room.get("agents") or [],
        "updated_at": room.get("updated_at"),
        "reports": room.get("report_count") if room.get("report_count") is not None else len(room.get("reports") or []),
        "messages": room.get("message_count") if room.get("message_count") is not None else len(room.get("messages") or []),
        "active_runs": [run.get("id") for run in buckets["live_runs"] if run.get("id")],
        "stale_queued_runs": [run.get("id") for run in buckets["stale_queued_runs"] if run.get("id")],
    }


def status_recovery_hints(stale_queued_runs):
    by_room = {}
    for run in stale_queued_runs:
        room_id = run.get("room_id")
        if not room_id:
            continue
        hint = by_room.setdefault(room_id, {
            "room_id": room_id,
            "stale_queued_runs": [],
            "agents": [],
            "inspect_command": f"agent-bus room inspect {room_id}",
            "pause_command": f"agent-bus room pause {room_id} --reason \"orphan queued run recovery\"",
            "recover_command": f"agent-bus room recover {room_id} --yes",
        })
        if run.get("id") and run.get("id") not in hint["stale_queued_runs"]:
            hint["stale_queued_runs"].append(run["id"])
        if run.get("agent_id") and run.get("agent_id") not in hint["agents"]:
            hint["agents"].append(run["agent_id"])
    return sorted(by_room.values(), key=lambda item: item.get("room_id") or "")


def status_warnings(result, stale_queued_runs, recovery_hints):
    warnings = []
    conflicts = result.get("agent_id_conflicts") or []
    if conflicts:
        details = "; ".join(
            f"{item.get('id')} on {', '.join(item.get('nodes') or []) or item.get('count')}"
            for item in conflicts[:5]
        )
        warnings.append(
            "Duplicate online agent ids are registered; routing to those ids is blocked until each agent id is unique. "
            + details
        )
    if stale_queued_runs:
        room_note = f" Example: {recovery_hints[0]['inspect_command']}" if recovery_hints else ""
        queue_note = "; gateway queue is empty" if int((result.get("health") or {}).get("queued") or 0) == 0 else ""
        warnings.append(
            f"Ignored {len(stale_queued_runs)} stale queued room run(s) older than {STATUS_QUEUED_RUN_STALE_SECONDS}s{queue_note}. "
            f"Inspect the old room before recovering or pausing it.{room_note}"
        )
    return warnings


def status_readiness(result):
    summary = result.get("summary") or {}
    if not (result.get("health") or {}).get("ok"):
        return {
            "level": "critical",
            "status": "central-unhealthy",
            "message": "Central health did not report ok.",
        }
    if int(summary.get("nodes") or 0) == 0 or int(summary.get("online_agents") or 0) == 0:
        return {
            "level": "setup",
            "status": "waiting-for-edge",
            "message": "Central is up, but no online edge agents are ready to receive work.",
        }
    if int(summary.get("duplicate_agent_ids") or 0) > 0:
        return {
            "level": "attention",
            "status": "duplicate-agent-ids",
            "message": "Central has duplicate online agent ids. Rename duplicates before routing work to those agents.",
        }
    if int(summary.get("stale_queued_runs") or 0) > 0:
        return {
            "level": "attention",
            "status": "stale-room-runs",
            "message": "Central is usable, but old queued room runs need operator review.",
        }
    if int(summary.get("queued") or 0) > 0 and int(summary.get("busy_agents") or 0) == 0:
        return {
            "level": "attention",
            "status": "queue-needs-agent",
            "message": "Central has queued work, but no agent is currently marked busy.",
        }
    if int(summary.get("busy_agents") or 0) > 0 or int(summary.get("active_rooms") or 0) > 0:
        return {
            "level": "active",
            "status": "working",
            "message": "Agents are connected and work is currently active.",
        }
    return {
        "level": "ready",
        "status": "ready",
        "message": "Central and edge agents are ready for work.",
    }


def status_next_actions(result):
    summary = result.get("summary") or {}
    actions = []
    if not (result.get("health") or {}).get("ok"):
        actions.append("Check the Central service logs and restart the central process.")
    if int(summary.get("registered_nodes") or 0) == 0:
        actions.append("Create the first edge join command with agent-bus setup central or the Web Console Edge Join panel.")
    if int(summary.get("nodes") or 0) == 0 and int(summary.get("registered_nodes") or 0) > 0:
        actions.append("Start or restart an edge with agent-bus connect --config edge.config.json.")
    if int(summary.get("nodes") or 0) > 0 and int(summary.get("online_agents") or 0) == 0:
        actions.append("Run agent-bus doctor --config edge.config.json on the edge host and restart its service.")
    if int(summary.get("registered_agents") or 0) > int(summary.get("agents") or 0):
        actions.append("Some registered agents are offline or stale; inspect the Nodes section before routing work to them.")
    if int(summary.get("duplicate_agent_ids") or 0) > 0:
        actions.append("Rename duplicate agent ids in edge.config.json, then restart the affected edge services.")
    if int(summary.get("queued") or 0) > 0 and int(summary.get("busy_agents") or 0) == 0:
        actions.append("Poll or restart edge services so queued runs can be claimed.")
    if result.get("recovery_hints"):
        actions.append(f"Inspect stale room work: {result['recovery_hints'][0]['inspect_command']}")
    if int(summary.get("online_agents") or 0) > 0 and int(summary.get("active_rooms") or 0) == 0 and int(summary.get("queued") or 0) == 0:
        actions.append("Try a live room with agent-bus room create --goal \"...\" --agents agent-a,agent-b.")
    return status_unique(actions)[:6]


def status_unique(values):
    out = []
    seen = set()
    for value in values:
        if value is None or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


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
            "status": "GET /v1/agent-bus/status",
            "manifest": "GET /v1/agent-bus/manifest",
            "nodes": "GET /nodes",
            "agents": "GET /agents",
            "route": "POST /route",
            "threads": "POST /threads",
            "rooms": "POST /rooms",
            "room": "GET /rooms/{room_id}",
            "room_memory": "GET /rooms/{room_id}/memory",
            "room_memory_expand": "GET /rooms/{room_id}/memory/expand?ref=messages[7]&around=1",
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
    agents = public_agents()
    conflict = next((item for item in agent_id_conflicts(agents) if item["id"] == agent_id), None)
    if conflict:
        nodes = ", ".join(conflict.get("nodes") or [])
        return openai_error("agent model id is ambiguous: agent:" + agent_id + " is registered on " + nodes, "agent_bus_agent_ambiguous", "model"), 409
    agent = next((item for item in agents if item["id"] == agent_id), None)
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
    agents = public_agents()
    conflict = next((item for item in agent_id_conflicts(agents) if item["id"] == agent_id), None)
    if conflict:
        nodes = ", ".join(conflict.get("nodes") or [])
        return openai_error("agent model id is ambiguous: agent:" + agent_id + " is registered on " + nodes, "agent_bus_agent_ambiguous", "model"), 409
    agent = next((item for item in agents if item["id"] == agent_id), None)
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
        raise_if_agent_ids_ambiguous(wanted, agents)
        return {"mode": "explicit", "reason": "Explicit agent selector was provided.", "matched": ["agents"], "agents": selected}
    if body.get("mode") != "orchestrate":
        raise_if_agent_ids_ambiguous([agent["id"] for agent in agents], agents)
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
    selected_agents = list(selected.values()) or agents
    raise_if_agent_ids_ambiguous([agent["id"] for agent in selected_agents], agents)
    return {
        "mode": "orchestrate",
        "reason": "Selected agents by message intent: " + ", ".join(matched) + ".",
        "matched": matched,
        "agents": selected_agents,
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
    board = room.get("blackboard") if isinstance(room.get("blackboard"), dict) else {}
    checklist = board.get("agent_checklist") if isinstance(board.get("agent_checklist"), dict) else {}
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
        "agent_checklist": checklist.get("summary") or {},
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
        update_room_agent_checklist(room, run)
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


def recover_room(config, room_id, body):
    room = get_room(config, room_id)
    queued_run_stale_seconds = max(1, int(body.get("queued_run_stale_seconds") or body.get("queuedRunStaleSeconds") or STATUS_QUEUED_RUN_STALE_SECONDS))
    dry_run = body_bool(body, "dry_run", "dryRun", default=True)
    confirm = body_bool(body, "confirm", "yes", default=False)
    force = body_bool(body, "force", default=False)
    reason = (body.get("reason") or "Stale/orphan room recovery.").strip() or "Stale/orphan room recovery."
    inspection = inspect_room_recovery(room, queued_run_stale_seconds)
    result = {
        "ok": True,
        "dry_run": dry_run,
        "executed": False,
        "room_id": room_id,
        "action": "pause_room_cancel_queued_runs",
        "reason": reason,
        "force": force,
        "requires_confirmation": True,
        "inspection": inspection,
    }
    if dry_run:
        return result
    if not confirm:
        err = Exception("room recover execution requires confirm=true or yes=true")
        err.status_code = 409
        raise err
    if not force and inspection.get("recommendation") != "pause_recover_orphan_queued_runs":
        err = Exception("Refusing room recover --yes because no stale queued orphan runs were found.")
        err.status_code = 409
        err.details = inspection
        raise err
    recovered = pause_room(config, room_id, {"reason": reason})
    result["dry_run"] = False
    result["executed"] = True
    result["room"] = recovered
    result["cancelled_queued_runs"] = (recovered.get("pause") or {}).get("cancelled_queued_runs") or []
    result["inspection_after"] = inspect_room_recovery(recovered, queued_run_stale_seconds)
    return result


def supervise_room(config, room_id, body):
    room = get_room(config, room_id)
    queued_run_stale_seconds = max(1, int(body.get("queued_run_stale_seconds") or body.get("queuedRunStaleSeconds") or STATUS_QUEUED_RUN_STALE_SECONDS))
    node_stale_seconds = max(1, int(body.get("node_stale_seconds") or body.get("nodeStaleSeconds") or NODE_STALE_SECONDS))
    run_heartbeat_stale_seconds = max(
        1,
        int(
            body.get("run_heartbeat_stale_seconds")
            or body.get("runHeartbeatStaleSeconds")
            or body.get("running_run_stale_seconds")
            or body.get("runningRunStaleSeconds")
            or STATUS_RUN_HEARTBEAT_STALE_SECONDS
        ),
    )
    dry_run = body_bool(body, "dry_run", "dryRun", default=True)
    confirm = body_bool(body, "confirm", "yes", default=False)
    reason = (body.get("reason") or "Conservative room supervisor recovery.").strip() or "Conservative room supervisor recovery."
    inspection = inspect_room_supervisor(
        room,
        queued_run_stale_seconds=queued_run_stale_seconds,
        node_stale_seconds=node_stale_seconds,
        run_heartbeat_stale_seconds=run_heartbeat_stale_seconds,
    )
    actions = supervisor_actions(room, inspection, queued_run_stale_seconds, node_stale_seconds, run_heartbeat_stale_seconds)
    executable_actions = [action for action in actions if action.get("executable")]
    result = {
        "ok": True,
        "dry_run": dry_run,
        "executed": False,
        "room_id": room_id,
        "action": "room_supervisor_tick",
        "mode": "conservative",
        "reason": reason,
        "requires_confirmation": True,
        "inspection": inspection,
        "plan": {
            "summary": ((inspection.get("analysis") or {}).get("summary") or "unknown"),
            "actions": actions,
            "safe_executable_actions": executable_actions,
            "will_execute_on_confirm": bool(executable_actions),
        },
    }
    if dry_run:
        return result
    if not confirm:
        err = Exception("room supervisor execution requires confirm=true or yes=true")
        err.status_code = 409
        raise err
    if not executable_actions:
        result["executed"] = False
        result["requires_operator_inspection"] = True
        result["refusal_reason"] = "Conservative supervisor has no safe executable action for this room state."
        return result
    recover_result = recover_room(config, room_id, {
        "queued_run_stale_seconds": queued_run_stale_seconds,
        "dry_run": False,
        "confirm": True,
        "yes": True,
        "force": False,
        "reason": reason,
    })
    recovered_room = recover_result.get("room") or get_room(config, room_id)
    result["executed"] = True
    result["executed_action"] = executable_actions[0]
    result["recover_result"] = recover_result
    result["room"] = recovered_room
    result["cancelled_queued_runs"] = recover_result.get("cancelled_queued_runs") or []
    result["inspection_after"] = inspect_room_supervisor(
        recovered_room,
        queued_run_stale_seconds=queued_run_stale_seconds,
        node_stale_seconds=node_stale_seconds,
        run_heartbeat_stale_seconds=run_heartbeat_stale_seconds,
    )
    return result


def inspect_room_supervisor(room, queued_run_stale_seconds=STATUS_QUEUED_RUN_STALE_SECONDS, node_stale_seconds=NODE_STALE_SECONDS, run_heartbeat_stale_seconds=STATUS_RUN_HEARTBEAT_STALE_SECONDS):
    node_by_id = {node_id: node for node_id, node in STATE["nodes"].items() if node_id}
    heartbeat_interval_by_agent = supervisor_heartbeat_interval_by_agent(node_by_id.values())
    node_lookup_available = bool(node_by_id)
    terminal_runs = []
    live_running_runs = []
    live_queued_runs = []
    stale_queued_runs = []
    stale_running_runs = []
    orphaned_running_runs = []
    other_non_terminal_runs = []
    for raw_run in room.get("runs") or []:
        record = supervisor_run_record(
            room,
            raw_run,
            node_by_id=node_by_id,
            node_lookup_available=node_lookup_available,
            node_stale_seconds=node_stale_seconds,
            heartbeat_interval_by_agent=heartbeat_interval_by_agent,
        )
        status = str(record.get("status") or "queued").lower()
        if run_is_terminal(raw_run) or run_is_replaced(raw_run) or run_is_late_complete_ignored(raw_run):
            terminal_runs.append(record)
            continue
        if status == "queued":
            if is_stale_queued_run_for_recovery(record, queued_run_stale_seconds):
                stale_queued_runs.append(record)
            else:
                live_queued_runs.append(record)
            continue
        if status == "running":
            if supervisor_run_is_orphaned(record, node_lookup_available):
                orphaned_running_runs.append(record)
            elif supervisor_run_is_stale_running(record, run_heartbeat_stale_seconds):
                stale_running_runs.append(record)
            else:
                live_running_runs.append(record)
            continue
        other_non_terminal_runs.append(record)
    summary = supervisor_room_summary(
        room,
        live_running_runs,
        live_queued_runs,
        stale_queued_runs,
        stale_running_runs,
        orphaned_running_runs,
        other_non_terminal_runs,
    )
    non_terminal_runs = (
        live_running_runs
        + live_queued_runs
        + stale_running_runs
        + orphaned_running_runs
        + other_non_terminal_runs
    )
    recommendation = supervisor_room_recommendation(
        summary,
        non_terminal_runs,
        stale_queued_runs,
        room.get("status"),
    )
    counts = {
        "total_runs": len(room.get("runs") or []),
        "non_terminal_runs": len(non_terminal_runs) + len(stale_queued_runs),
        "terminal_runs": len(terminal_runs),
        "live_running_runs": len(live_running_runs),
        "live_queued_runs": len(live_queued_runs),
        "stale_queued_runs": len(stale_queued_runs),
        "stale_running_runs": len(stale_running_runs),
        "orphaned_running_runs": len(orphaned_running_runs),
        "other_non_terminal_runs": len(other_non_terminal_runs),
    }
    thresholds = {
        "queued_run_stale_seconds": queued_run_stale_seconds,
        "node_stale_seconds": node_stale_seconds,
        "run_heartbeat_stale_seconds": run_heartbeat_stale_seconds,
    }
    return {
        "room": {
            "id": room.get("id") or "",
            "title": room.get("title") or "",
            "trace_id": room.get("trace_id") or "",
            "status": room.get("status") or "unknown",
            "updated_at": room.get("updated_at"),
            "created_at": room.get("created_at"),
            "agents": room.get("agents") or [],
        },
        "analysis": {
            "summary": summary,
            "thresholds": thresholds,
            "counts": counts,
            "node_inventory_available": node_lookup_available,
            "live_running_runs": live_running_runs,
            "live_queued_runs": live_queued_runs,
            "stale_queued_runs": stale_queued_runs,
            "stale_running_runs": stale_running_runs,
            "orphaned_running_runs": orphaned_running_runs,
            "other_non_terminal_runs": other_non_terminal_runs,
        },
        "thresholds": thresholds,
        "counts": {
            "runs": counts["total_runs"],
            "active_runs": len(non_terminal_runs),
            "stale_queued_runs": len(stale_queued_runs),
            "stale_running_runs": len(stale_running_runs),
            "orphaned_running_runs": len(orphaned_running_runs),
        },
        "active_runs": non_terminal_runs,
        "stale_queued_runs": stale_queued_runs,
        "stale_running_runs": stale_running_runs,
        "orphaned_running_runs": orphaned_running_runs,
        "recommendation": recommendation,
    }


def supervisor_actions(room, inspection, queued_run_stale_seconds, node_stale_seconds, run_heartbeat_stale_seconds):
    room_id = room.get("id") or "ROOM_ID"
    summary = ((inspection.get("analysis") or {}).get("summary") or "unknown")
    actions = []
    threshold_flag = "" if queued_run_stale_seconds == STATUS_QUEUED_RUN_STALE_SECONDS else f" --queued-run-stale-seconds {queued_run_stale_seconds}"
    node_stale_flag = "" if node_stale_seconds == NODE_STALE_SECONDS else f" --node-stale-seconds {node_stale_seconds}"
    heartbeat_flag = "" if run_heartbeat_stale_seconds == STATUS_RUN_HEARTBEAT_STALE_SECONDS else f" --run-heartbeat-stale-seconds {run_heartbeat_stale_seconds}"
    if summary == "stale_queued_recovery_candidate":
        actions.append({
            "kind": "recover_stale_queued_room",
            "level": "warn",
            "executable": True,
            "message": "Only stale queued runs remain. Confirmed supervisor execution can pause the room and cancel those queued runs.",
            "command": f"agent-bus room supervisor {room_id} --yes{threshold_flag}{node_stale_flag}{heartbeat_flag}",
            "fallback_command": f"agent-bus room recover {room_id} --yes{threshold_flag}",
        })
        return actions
    if summary in ("orphaned_running_candidate", "mixed_orphaned_running_and_stale_queued"):
        actions.append({
            "kind": "inspect_orphaned_running",
            "level": "warn",
            "executable": False,
            "message": "A running room task is attached to a stale or missing node. Inspect the edge service or agent process before pausing or replacing it.",
            "command": f"agent-bus room inspect {room_id}{node_stale_flag}{heartbeat_flag}{threshold_flag}",
        })
        return actions
    if summary in ("stale_running_candidate", "mixed_live_and_stale_running", "mixed_stale_running_and_stale_queued"):
        actions.append({
            "kind": "inspect_stale_running",
            "level": "warn",
            "executable": False,
            "message": "A running task has not reported a run heartbeat within the threshold. This supervisor tick will not replace running work automatically.",
            "command": f"agent-bus room inspect {room_id}{node_stale_flag}{heartbeat_flag}{threshold_flag}",
        })
        return actions
    if summary == "mixed_live_and_stale_queued":
        actions.append({
            "kind": "wait_for_live_work",
            "level": "info",
            "executable": False,
            "message": "Live work and stale queued history both exist. Wait for live work or inspect the room before recovering queued leftovers.",
            "command": f"agent-bus room inspect {room_id}{node_stale_flag}{heartbeat_flag}{threshold_flag}",
        })
        return actions
    if summary == "active_without_live_runs":
        actions.append({
            "kind": "operator_wake_available",
            "level": "info",
            "executable": False,
            "message": "Room is active with no live run. A manual wake is available after the operator verifies the desired next agent.",
            "command": f"agent-bus room wake {room_id} --reason \"operator recovery wake\"",
        })
        return actions
    actions.append({
        "kind": "no_action",
        "level": "info",
        "executable": False,
        "message": "No conservative supervisor action is needed for this room state.",
    })
    return actions


def supervisor_heartbeat_interval_by_agent(nodes):
    by_agent = {}
    for node in nodes:
        for agent in node.get("agents") or []:
            agent_id = str(agent.get("id") or "").strip()
            try:
                interval_ms = int(agent.get("run_heartbeat_interval_ms") or agent.get("runHeartbeatIntervalMs") or 0)
            except Exception:
                interval_ms = 0
            if agent_id and interval_ms > 0:
                by_agent[agent_id] = interval_ms
    return by_agent


def supervisor_run_record(room, run, node_by_id, node_lookup_available, node_stale_seconds, heartbeat_interval_by_agent):
    node_id = str(run.get("node_id") or "").strip()
    agent_id = str(run.get("agent_id") or "").strip()
    node = node_by_id.get(node_id)
    last_heartbeat_at = run.get("last_heartbeat_at") or run.get("started_at")
    item = {
        "id": run.get("id"),
        "room_id": run.get("room_id") or room.get("id"),
        "agent_id": agent_id,
        "node_id": node_id,
        "status": run.get("status") or "queued",
        "created_at": run.get("created_at"),
        "started_at": run.get("started_at"),
        "completed_at": run.get("completed_at"),
        "last_heartbeat_at": last_heartbeat_at,
        "run_heartbeat_interval_ms": heartbeat_interval_by_agent.get(agent_id),
        "node_status": node.get("status") if node else None,
        "node_last_seen_at": node.get("last_seen_at") if node else None,
        "node_freshness": supervisor_node_freshness(node, node_stale_seconds) if node else ("unknown" if node_lookup_available else "unchecked"),
        "age_seconds": run_age_seconds(run),
        "heartbeat_age_seconds": seconds_since_timestamp(last_heartbeat_at),
    }
    return item


def supervisor_node_freshness(node, node_stale_seconds):
    status = node.get("status") or "unknown"
    if status != "online":
        return status
    last_seen = status_timestamp(node.get("last_seen_at"))
    if last_seen is None:
        return "online/unknown"
    age_seconds = max(0, int(round(time.time() - last_seen)))
    if age_seconds > node_stale_seconds:
        return f"stale ({age_seconds}s ago)"
    return f"online/fresh ({age_seconds}s ago)"


def supervisor_run_is_orphaned(run, node_lookup_available):
    if str(run.get("status") or "").lower() != "running":
        return False
    freshness = str(run.get("node_freshness") or "")
    return freshness.startswith("stale") or (node_lookup_available and freshness == "unknown")


def supervisor_run_is_stale_running(run, run_heartbeat_stale_seconds):
    if str(run.get("status") or "").lower() != "running":
        return False
    age = run.get("heartbeat_age_seconds")
    if not isinstance(age, (int, float)):
        return False
    return age > run_heartbeat_stale_seconds


def supervisor_room_summary(room, live_running_runs, live_queued_runs, stale_queued_runs, stale_running_runs, orphaned_running_runs, other_non_terminal_runs):
    status = str(room.get("status") or "unknown").lower()
    if status == "completed":
        return "completed"
    if status == "paused":
        return "paused"
    if orphaned_running_runs:
        return "mixed_orphaned_running_and_stale_queued" if stale_queued_runs else "orphaned_running_candidate"
    if stale_running_runs:
        if stale_queued_runs and not live_running_runs and not live_queued_runs and not other_non_terminal_runs:
            return "mixed_stale_running_and_stale_queued"
        return "mixed_live_and_stale_running" if (live_running_runs or live_queued_runs or other_non_terminal_runs) else "stale_running_candidate"
    if stale_queued_runs and not live_running_runs and not live_queued_runs and not other_non_terminal_runs:
        return "stale_queued_recovery_candidate"
    if live_running_runs or live_queued_runs or other_non_terminal_runs:
        return "mixed_live_and_stale_queued" if stale_queued_runs else "live"
    if status == "active":
        return "active_without_live_runs"
    return status or "unknown"


def supervisor_room_recommendation(summary, active_runs, stale_queued_runs, room_status):
    if stale_queued_runs and not active_runs:
        return "pause_recover_orphan_queued_runs"
    if active_runs:
        return "wait_or_inspect_running_agents"
    status = str(room_status or "").lower()
    if summary == "paused" or status == "paused":
        return "room_paused"
    if summary == "completed" or status == "completed":
        return "room_completed"
    return "no_active_run_recovery_needed"


def seconds_since_timestamp(value):
    parsed = status_timestamp(value)
    if parsed is None:
        return None
    return max(0, int(round(time.time() - parsed)))


def inspect_room_recovery(room, queued_run_stale_seconds=STATUS_QUEUED_RUN_STALE_SECONDS):
    runs = room.get("runs") or []
    active_runs = []
    stale_queued_runs = []
    for run in runs:
        if not run_is_active_for_room(run):
            continue
        item = room_recovery_run_record(room, run)
        if is_stale_queued_run_for_recovery(run, queued_run_stale_seconds):
            stale_queued_runs.append(item)
        else:
            active_runs.append(item)
    if stale_queued_runs and not active_runs:
        recommendation = "pause_recover_orphan_queued_runs"
    elif active_runs:
        recommendation = "wait_or_inspect_running_agents"
    elif str(room.get("status") or "").lower() == "paused":
        recommendation = "room_paused"
    elif str(room.get("status") or "").lower() == "completed":
        recommendation = "room_completed"
    else:
        recommendation = "no_active_run_recovery_needed"
    return {
        "room": {
            "id": room.get("id") or "",
            "title": room.get("title") or "",
            "status": room.get("status") or "unknown",
            "updated_at": room.get("updated_at"),
            "agents": room.get("agents") or [],
        },
        "thresholds": {"queued_run_stale_seconds": queued_run_stale_seconds},
        "counts": {
            "runs": len(runs),
            "active_runs": len(active_runs),
            "stale_queued_runs": len(stale_queued_runs),
        },
        "active_runs": active_runs,
        "stale_queued_runs": stale_queued_runs,
        "recommendation": recommendation,
    }


def room_recovery_run_record(room, run):
    item = dict(run)
    item["room_id"] = run.get("room_id") or room.get("id")
    item["age_seconds"] = run_age_seconds(run)
    return item


def is_stale_queued_run_for_recovery(run, queued_run_stale_seconds):
    if str(run.get("status") or "queued").lower() != "queued":
        return False
    created_at = status_timestamp(run.get("created_at"))
    if created_at is None:
        return False
    return time.time() - created_at > queued_run_stale_seconds


def run_age_seconds(run):
    started = status_timestamp(run.get("started_at") or run.get("created_at"))
    if started is None:
        return None
    return max(0, int(round(time.time() - started)))


def body_bool(body, *names, default=False):
    for name in names:
        if name not in body:
            continue
        value = body.get(name)
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return value != 0
        text = str(value or "").strip().lower()
        if text in ("1", "true", "yes", "y", "on"):
            return True
        if text in ("0", "false", "no", "n", "off"):
            return False
    return default


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
    online_agents = public_agents()
    raise_if_agent_ids_ambiguous(agent_ids, online_agents)
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
        agent = next((item for item in online_agents if item["id"] == agent_id), None)
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
    checklist = compact_room_agent_checklist(board.get("agent_checklist"))
    if checklist:
        compact["agent_checklist"] = checklist
    return {key: value for key, value in compact.items() if value not in (None, "", [])}


def compact_room_agent_checklist(checklist):
    if not isinstance(checklist, dict):
        return None
    agents = {}
    for agent_id, item in (checklist.get("agents") or {}).items():
        if not isinstance(item, dict):
            continue
        agents[agent_id] = {
            key: value
            for key, value in {
                "status": item.get("status"),
                "run_id": item.get("run_id"),
                "has_report": item.get("has_report"),
                "has_done": item.get("has_done"),
                "duration_seconds": item.get("duration_seconds"),
                "error": item.get("error"),
            }.items()
            if value not in (None, "", [])
        }
    out = {
        "summary": checklist.get("summary") or {},
        "agents": agents,
    }
    return {key: value for key, value in out.items() if value not in (None, "", {}, [])}


def compact_recent_room_messages(room):
    item_limit = room_prompt_limit("AGENT_BUS_ROOM_PROMPT_MESSAGE_CHARS", 1000, 200, 8000)
    item_count = room_prompt_limit("AGENT_BUS_ROOM_PROMPT_MESSAGE_COUNT", 8, 1, 20)
    messages = room.get("messages") or []
    return [compact_room_item(item, item_limit) for item in messages[-item_count:] if isinstance(item, dict)]


ROOM_MEMORY_STOPWORDS = {
    "the", "and", "for", "with", "from", "this", "that", "have", "will", "room", "agent",
    "bus", "your", "you", "are", "was", "were", "into", "then", "than", "they", "them",
    "use", "using", "used", "latest", "message", "report", "blackboard", "continue",
}


def room_memory_enabled():
    value = os.environ.get("AGENT_BUS_ROOM_MEMORY_CACHE_ENABLED", "true").strip().lower()
    return value not in ("0", "false", "no", "off")


def room_memory_source_items(room):
    recent_count = room_prompt_limit("AGENT_BUS_ROOM_PROMPT_MESSAGE_COUNT", 8, 1, 20)
    items = []
    for index, item in enumerate((room.get("messages") or [])[:-recent_count]):
        if isinstance(item, dict):
            items.append(room_memory_source_entry(item, "messages", index))
    for index, item in enumerate(room.get("reports") or []):
        if isinstance(item, dict):
            items.append(room_memory_source_entry(item, "reports", index))
    board = room.get("blackboard") if isinstance(room.get("blackboard"), dict) else {}
    for key in ("notes", "reports"):
        for index, item in enumerate(board.get(key) or []):
            if isinstance(item, dict):
                items.append(room_memory_source_entry(item, f"blackboard.{key}", index))
    seen = set()
    out = []
    for item in items:
        content = str(item.get("content") or item.get("message") or item.get("text") or "").strip()
        if not content:
            continue
        ref = room_memory_item_ref(item)
        dedupe_key = (
            ref.get("label") or "",
            item.get("run_id") or "",
            item.get("speaker") or item.get("agent_id") or item.get("role") or "",
            content[:240],
        )
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        out.append(item)
    return out


def room_memory_source_entry(item, source, position):
    out = dict(item)
    ref = {
        "source": source,
        "position": position,
        "label": f"{source}[{position}]",
    }
    at = item.get("at") or item.get("created_at")
    if at:
        ref["at"] = at
    speaker = item.get("speaker") or item.get("agent_id") or item.get("role")
    if speaker:
        ref["speaker"] = speaker
    run_id = item.get("run_id")
    if run_id:
        ref["run_id"] = run_id
    out["_memory_ref"] = ref
    return out


def room_memory_item_ref(item):
    ref = item.get("_memory_ref") if isinstance(item.get("_memory_ref"), dict) else {}
    if ref:
        return ref
    source = item.get("source") or "unknown"
    position = item.get("position")
    label = item.get("label") or (f"{source}[{position}]" if position is not None else str(source))
    return {key: value for key, value in {
        "source": source,
        "position": position,
        "label": label,
        "at": item.get("at") or item.get("created_at"),
        "speaker": item.get("speaker") or item.get("agent_id") or item.get("role"),
        "run_id": item.get("run_id"),
    }.items() if value not in (None, "", [])}


def room_memory_source_hash(items):
    digest = hashlib.sha256()
    for item in items:
        ref = room_memory_item_ref(item)
        content = str(item.get("content") or item.get("message") or item.get("text") or "")
        digest.update(str(ref.get("label") or "").encode("utf-8"))
        digest.update(str(item.get("run_id") or "").encode("utf-8"))
        digest.update(str(item.get("speaker") or item.get("agent_id") or item.get("role") or "").encode("utf-8"))
        digest.update(content.encode("utf-8", errors="ignore"))
        digest.update(b"\0")
    return digest.hexdigest()[:24]


def room_memory_tokens(text):
    values = []
    for token in re.findall(r"[A-Za-z0-9][A-Za-z0-9_.:/#@-]{2,}|[\u4e00-\u9fff]{2,}", str(text or "").lower()):
        token = token.strip("._:/#@-")
        if len(token) < 3 or token in ROOM_MEMORY_STOPWORDS:
            continue
        values.append(token[:80])
    return values


def room_memory_entities(text):
    text = str(text or "")
    return {
        "urls": re.findall(r"https?://[^\s)>\]]+", text)[:8],
        "paths": re.findall(r"(?:[A-Za-z]:\\[^\s]+|/(?:[\w.-]+/)+[\w.-]+|[\w.-]+/[\w./-]+)", text)[:12],
        "agents": re.findall(r"@[A-Za-z0-9_.-]+", text)[:12],
        "commands": [line.strip()[:160] for line in text.splitlines() if re.match(r"^\s*(?:\$|npm|node|python3?|git|ssh|curl|systemctl|docker)\b", line.strip())][:8],
    }


def room_memory_item_score(item, content):
    score = 0
    speaker = str(item.get("speaker") or item.get("agent_id") or item.get("role") or "").lower()
    if speaker not in ("", "user", "system"):
        score += 2
    if item.get("run_id"):
        score += 1
    if re.search(r"\b(REPORT|BLACKBOARD|DONE|WAKE)\b", content, re.I):
        score += 4
    if re.search(r"https?://|/[A-Za-z0-9_.-]+|[A-Za-z]:\\|`[^`]+`", content):
        score += 2
    if re.search(r"\b(error|failed|fixed|decision|todo|next|blocked|deploy|commit|test|cache|session)\b", content, re.I):
        score += 2
    return score


def room_memory_item_title(content, limit=90):
    title = re.sub(r"\s+", " ", str(content or "")).strip()
    title = re.sub(r"^(REPORT|BLACKBOARD)\s*:\s*", "", title, flags=re.I)
    if len(title) <= limit:
        return title
    return title[:limit].rstrip() + "..."


def room_memory_unique_tokens(tokens, limit):
    seen = set()
    out = []
    for token in tokens:
        if token in seen:
            continue
        seen.add(token)
        out.append(token)
        if len(out) >= limit:
            break
    return out


def ensure_room_memory_cache(room):
    if not room_memory_enabled():
        room.pop("memory_cache", None)
        return {}
    items = room_memory_source_items(room)
    source_hash = room_memory_source_hash(items)
    existing = room.get("memory_cache") if isinstance(room.get("memory_cache"), dict) else {}
    if existing.get("source_hash") == source_hash and existing.get("version") == 2:
        return existing
    snippet_limit = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_SNIPPETS", 10, 0, 40)
    snippet_chars = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_SNIPPET_CHARS", 260, 80, 1000)
    keyword_limit = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_KEYWORDS", 32, 0, 100)
    entity_limit = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_ENTITIES", 20, 0, 80)
    index_limit = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_INDEX_ENTRIES", 16, 0, 80)
    topic_limit = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_INDEX_TOPICS", 5, 1, 12)
    token_counts = {}
    entity_sets = {"urls": [], "paths": [], "agents": [], "commands": []}
    snippets = []
    toc_entries = []
    for index, item in enumerate(items):
        content = redact(str(item.get("content") or item.get("message") or item.get("text") or "").strip())
        tokens = room_memory_tokens(content)
        for token in tokens:
            token_counts[token] = token_counts.get(token, 0) + 1
        entities = room_memory_entities(content)
        for key, values in entities.items():
            for value in values:
                if value not in entity_sets[key]:
                    entity_sets[key].append(value)
        score = room_memory_item_score(item, content)
        if score <= 0:
            continue
        ref = room_memory_item_ref(item)
        topics = room_memory_unique_tokens(tokens, topic_limit)
        toc_entries.append({
            "score": score,
            "index": index,
            "ref": ref,
            "title": room_memory_item_title(content),
            "topics": topics,
            "preview": truncate_for_room_prompt(content, min(snippet_chars, 180)),
        })
        snippets.append({
            "score": score,
            "index": index,
            "ref": ref,
            "topics": topics,
            "content": truncate_for_room_prompt(content, snippet_chars),
        })
    snippets = sorted(snippets, key=lambda item: (-item["score"], -item["index"]))[:snippet_limit]
    toc_entries = sorted(toc_entries, key=lambda item: (-item["score"], item["index"]))[:index_limit]
    keywords = [token for token, _count in sorted(token_counts.items(), key=lambda item: (-item[1], item[0]))[:keyword_limit]]
    memory = {
        "version": 2,
        "updated_at": now(),
        "source_count": len(items),
        "source_hash": source_hash,
        "keywords": keywords,
        "table_of_contents": [{key: value for key, value in item.items() if key not in ("score", "index")} for item in toc_entries],
        "snippets": [{key: value for key, value in item.items() if key not in ("score", "index")} for item in snippets],
        "entities": {key: values[:entity_limit] for key, values in entity_sets.items() if values[:entity_limit]},
    }
    memory = {key: value for key, value in memory.items() if value not in (None, "", [], {})}
    room["memory_cache"] = memory
    return memory


def room_memory_for_prompt(room, reason):
    memory = ensure_room_memory_cache(room)
    if not memory:
        return {}
    query = set(room_memory_tokens(" ".join([str(room.get("goal") or ""), str(reason or "")])))
    snippets = []
    for item in memory.get("snippets") or []:
        haystack = " ".join([
            item.get("content") or "",
            " ".join(item.get("topics") or []),
            str((item.get("ref") or {}).get("label") or ""),
        ])
        overlap = len(query.intersection(room_memory_tokens(haystack))) if query else 0
        snippets.append((overlap, item))
    snippets = [
        item for _score, item in sorted(
            snippets,
            key=lambda pair: (
                -pair[0],
                str((pair[1].get("ref") or {}).get("at") or ""),
                str((pair[1].get("ref") or {}).get("label") or ""),
            ),
        )
    ]
    snippet_limit = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_PROMPT_SNIPPETS", 6, 0, 20)
    index_limit = room_prompt_limit("AGENT_BUS_ROOM_MEMORY_PROMPT_INDEX_ENTRIES", 10, 0, 40)
    toc_entries = []
    for item in memory.get("table_of_contents") or []:
        haystack = " ".join([
            item.get("title") or "",
            item.get("preview") or "",
            " ".join(item.get("topics") or []),
            str((item.get("ref") or {}).get("label") or ""),
        ])
        overlap = len(query.intersection(room_memory_tokens(haystack))) if query else 0
        toc_entries.append((overlap, item))
    toc_entries = [item for _score, item in sorted(toc_entries, key=lambda pair: (-pair[0], str((pair[1].get("ref") or {}).get("label") or "")))]
    return {
        "source_count": memory.get("source_count", 0),
        "updated_at": memory.get("updated_at"),
        "keywords": (memory.get("keywords") or [])[:24],
        "entities": memory.get("entities") or {},
        "table_of_contents": toc_entries[:index_limit],
        "relevant_snippets": snippets[:snippet_limit],
    }


def room_memory_query_value(query, name, default=""):
    values = query.get(name) if isinstance(query, dict) else None
    if isinstance(values, list) and values:
        return str(values[0] or "").strip()
    return default


def room_memory_query_int(query, name, default, lower, upper):
    try:
        value = int(room_memory_query_value(query, name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(lower, min(value, upper))


def room_memory_api(config, room_id, query):
    room = get_room(config, room_id)
    reason = room_memory_query_value(query, "q") or room_memory_query_value(query, "query")
    memory = ensure_room_memory_cache(room)
    write_room(config, room)
    return {
        "room_id": room.get("id"),
        "version": memory.get("version") if memory else None,
        "memory": memory,
        "prompt_view": room_memory_for_prompt(room, reason),
        "expand": {
            "endpoint": f"/rooms/{room.get('id')}/memory/expand",
            "ref_param": "Use a table_of_contents ref label such as messages[7], reports[2], or blackboard.notes[1].",
            "around_param": "Optional number of neighboring source items to include.",
        },
    }


def room_memory_expand_api(config, room_id, query):
    room = get_room(config, room_id)
    ref_label = room_memory_query_value(query, "ref") or room_memory_query_value(query, "label")
    if not ref_label:
        err = Exception("ref is required")
        err.status_code = 400
        raise err
    source, position = parse_room_memory_ref(ref_label)
    items = room_memory_collection(room, source)
    if position < 0 or position >= len(items):
        err = Exception("memory ref not found")
        err.status_code = 404
        raise err
    around = room_memory_query_int(query, "around", 0, 0, 10)
    item_chars = room_memory_query_int(query, "chars", 4000, 200, 30000)
    memory = ensure_room_memory_cache(room)
    write_room(config, room)
    start = max(0, position - around)
    end = min(len(items), position + around + 1)
    expanded = []
    for index in range(start, end):
        item = items[index]
        if not isinstance(item, dict):
            continue
        entry = room_memory_source_entry(item, source, index)
        content = redact(str(entry.get("content") or entry.get("message") or entry.get("text") or "").strip())
        expanded.append({
            "ref": room_memory_item_ref(entry),
            "selected": index == position,
            "title": room_memory_item_title(content),
            "topics": room_memory_unique_tokens(room_memory_tokens(content), 8),
            "content": truncate_for_room_prompt(content, item_chars),
        })
    toc_entry = next(
        (
            item for item in memory.get("table_of_contents", [])
            if (item.get("ref") or {}).get("label") == f"{source}[{position}]"
        ),
        None,
    ) if memory else None
    return {
        "room_id": room.get("id"),
        "ref": f"{source}[{position}]",
        "around": around,
        "source_count": len(items),
        "toc_entry": toc_entry,
        "items": expanded,
    }


def parse_room_memory_ref(ref_label):
    match = re.match(r"^(messages|reports|blackboard\.(?:notes|reports))\[(\d+)\]$", str(ref_label or "").strip())
    if not match:
        err = Exception("unsupported memory ref; expected messages[n], reports[n], blackboard.notes[n], or blackboard.reports[n]")
        err.status_code = 400
        raise err
    return match.group(1), int(match.group(2))


def room_memory_collection(room, source):
    if source == "messages":
        return room.get("messages") or []
    if source == "reports":
        return room.get("reports") or []
    board = room.get("blackboard") if isinstance(room.get("blackboard"), dict) else {}
    if source == "blackboard.notes":
        return board.get("notes") or []
    if source == "blackboard.reports":
        return board.get("reports") or []
    err = Exception("unsupported memory source")
    err.status_code = 400
    raise err


def autonomous_prompt(room, agent, reason):
    autonomy = room.get("autonomy") or {}
    memory = room_memory_for_prompt(room, reason)
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
        "Local compressed room memory cache (older context, extractive):",
        json.dumps(memory, ensure_ascii=False, indent=2),
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
    update_room_agent_checklist(room, run)
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
        "updated_at": now(),
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
    if str(body.get("title") or "").strip():
        thread["title"] = str(body.get("title")).strip()
    if isinstance(body.get("telegram"), dict):
        thread["telegram"] = body["telegram"]
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
    if run_is_replaced(run) or run_is_late_complete_ignored(run):
        event["ignored"] = True
        event["ignored_reason"] = "run_replaced"
        run.setdefault("events", []).append(event)
        STATE["runs"][run["id"]] = run
        write_snapshot(config, "runs", run["id"], run)
        update_room_run(config, run)
        append_jsonl(config, "events.jsonl", {"run_id": run["id"], **event})
        return
    if event.get("type") == "run.started":
        run["status"] = "running"
        run["started_at"] = run.get("started_at") or event["at"]
        run["last_heartbeat_at"] = run.get("last_heartbeat_at") or event["at"]
    if event.get("type") in ("run.heartbeat", "run.progress") or event.get("stream") in ("stdout", "stderr"):
        run["last_heartbeat_at"] = event["at"]
    if event.get("stream") == "stdout" and event.get("text"):
        run["stdout"] = run.get("stdout", "") + event["text"]
    if event.get("stream") == "stderr" and event.get("text"):
        run["stderr"] = run.get("stderr", "") + event["text"]
    run.setdefault("events", []).append(event)
    STATE["runs"][run["id"]] = run
    write_snapshot(config, "runs", run["id"], run)
    update_thread_run(config, run)
    update_room_run(config, run)
    append_jsonl(config, "events.jsonl", {"run_id": run["id"], **event})


def requested_completion_state(run, body):
    result = body.get("result") or {}
    exit_code = result.get("exit_code")
    return {
        "status": result.get("status") or ("completed" if exit_code == 0 else "failed"),
        "exit_code": exit_code,
        "stdout": trim(redact_text(result.get("stdout", run.get("stdout", "")))),
        "stderr": trim(redact_text(result.get("stderr", run.get("stderr", "")))),
        "summary": trim(redact_text(result.get("summary", ""))),
    }


def stored_completion_state(run):
    return {
        "status": run.get("status"),
        "exit_code": run.get("exit_code"),
        "stdout": trim(redact_text(run.get("stdout", ""))),
        "stderr": trim(redact_text(run.get("stderr", ""))),
        "summary": trim(redact_text(run.get("summary", ""))),
    }


def complete_run(config, body):
    with RUN_COMPLETION_LOCK:
        run = STATE["runs"].get(body.get("run_id")) or read_snapshot(config, "runs", body.get("run_id"))
        if not run:
            err = Exception("unknown run_id")
            err.status_code = 404
            raise err
        touch_node_seen(body.get("node_id") or run.get("node_id"))
        STATE["runs"][run["id"]] = run
        if run_is_terminal(run):
            if stored_completion_state(run) == requested_completion_state(run, body):
                return run
            if run_is_replaced(run) or run_is_late_complete_ignored(run):
                return mark_run_late_complete_ignored(config, run, body)
            err = Exception("run already completed with different result")
            err.status_code = 409
            raise err
        if run_is_replaced(run) or run_is_late_complete_ignored(run):
            return mark_run_late_complete_ignored(config, run, body)
        if body.get("trace_id") and not run.get("trace_id"):
            run["trace_id"] = sanitize_trace_id(body.get("trace_id"))
        completion = requested_completion_state(run, body)
        run["status"] = completion["status"]
        run["completed_at"] = now()
        run["exit_code"] = completion["exit_code"]
        run["stdout"] = completion["stdout"]
        run["stderr"] = completion["stderr"]
        run["summary"] = completion["summary"]
        update_agent_run_health(run)
        STATE["runs"][run["id"]] = run
        write_snapshot(config, "runs", run["id"], run)
        update_thread_run(config, run)
        continue_group_thread(config, run)
        continue_room_run(config, run)
        append_jsonl(config, "runs.jsonl", run)
        if not notify_telegram_conversation_result(config, run):
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


def mark_run_late_complete_ignored(config, run, body):
    if run.get("late_complete_ignored_at"):
        return run
    ignored_at = now()
    result = body.get("result") or {}
    run["late_complete_ignored_at"] = ignored_at
    run["late_complete_ignored"] = {
        "at": ignored_at,
        "node_id": body.get("node_id") or run.get("node_id"),
        "trace_id": sanitize_trace_id(body.get("trace_id") or run.get("trace_id")),
        "status": result.get("status"),
        "exit_code": result.get("exit_code"),
        "reason": "run_replaced",
    }
    if run_is_replaced(run):
        run["status"] = "replaced"
    event = {
        "at": ignored_at,
        "type": "run.late_complete_ignored",
        "node_id": body.get("node_id") or run.get("node_id"),
        "trace_id": sanitize_trace_id(body.get("trace_id") or run.get("trace_id")),
        "ignored_reason": "run_replaced",
        "replaced_by_run_id": run.get("replaced_by_run_id") or run.get("replacement_run_id"),
    }
    run.setdefault("events", []).append(event)
    STATE["runs"][run["id"]] = run
    write_snapshot(config, "runs", run["id"], run)
    update_thread_run(config, run)
    update_room_run(config, run)
    append_jsonl(config, "events.jsonl", {"run_id": run["id"], **event})
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
    if run_is_replaced(run) or run_is_late_complete_ignored(run):
        update_room_run(config, run)
        return
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
    update_room_agent_checklist(room, run, content, actions)
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


def update_room_agent_checklist(room, run, content=None, actions=None):
    if not isinstance(room, dict) or not isinstance(run, dict):
        return None
    agent_id = run.get("agent_id")
    run_id = run.get("id")
    if not agent_id or not run_id:
        return None
    board = room.setdefault("blackboard", {})
    checklist = board.setdefault("agent_checklist", {
        "object": "agent_bus.room_agent_checklist",
        "version": 1,
        "agents": {},
        "summary": {},
    })
    checklist["object"] = "agent_bus.room_agent_checklist"
    checklist["version"] = 1
    checklist["expected_agents"] = list(room.get("agents") or [])
    checklist.setdefault("agents", {})
    if not isinstance(checklist.get("agents"), dict):
        checklist["agents"] = {}
    agent = checklist["agents"].setdefault(agent_id, {
        "agent_id": agent_id,
        "runs": {},
    })
    if not isinstance(agent, dict):
        agent = {"agent_id": agent_id, "runs": {}}
        checklist["agents"][agent_id] = agent
    if not isinstance(agent.get("runs"), dict):
        agent["runs"] = {}
    text = str(content if content is not None else (run.get("stdout") or run.get("summary") or run.get("stderr") or ""))
    counts = room_contract_directive_counts(text)
    previous = agent["runs"].get(run_id) if isinstance(agent.get("runs"), dict) else {}
    if not isinstance(previous, dict):
        previous = {}
    if actions is None:
        wake_count = int(previous.get("wake_count") or 0)
        reminder_count = int(previous.get("reminder_count") or 0)
    else:
        wake_count = sum(1 for action in actions if action == "wake")
        reminder_count = sum(1 for action in actions if action == "reminder")
    status = run_status(run) or "unknown"
    updated_at = now()
    record = {
        "run_id": run_id,
        "agent_id": agent_id,
        "node_id": run.get("node_id"),
        "status": status,
        "created_at": run.get("created_at"),
        "started_at": run.get("started_at"),
        "completed_at": run.get("completed_at"),
        "last_heartbeat_at": run.get("last_heartbeat_at"),
        "duration_seconds": room_run_duration_seconds(run),
        "has_report": counts["report"] > 0,
        "has_done": counts["done"] > 0,
        "report_count": counts["report"],
        "blackboard_count": counts["blackboard"],
        "done_count": counts["done"],
        "wake_count": wake_count,
        "reminder_count": reminder_count,
        "summary": room_run_contract_summary(run, text),
        "updated_at": updated_at,
    }
    error = room_run_contract_error(run, text)
    if error:
        record["error"] = error
    clean_record = {key: value for key, value in record.items() if value not in (None, "")}
    agent["runs"][run_id] = clean_record
    for key in (
        "run_id", "node_id", "status", "created_at", "started_at", "completed_at",
        "last_heartbeat_at", "duration_seconds", "has_report", "has_done",
        "report_count", "blackboard_count", "done_count", "wake_count",
        "reminder_count", "summary", "error",
    ):
        agent.pop(key, None)
    agent.update(clean_record)
    agent["run_count"] = len(agent.get("runs") or {})
    agent["updated_at"] = updated_at
    checklist["updated_at"] = updated_at
    checklist["summary"] = summarize_room_agent_checklist(room, checklist)
    return checklist


def room_contract_directive_counts(content):
    counts = {"report": 0, "blackboard": 0, "done": 0, "wake": 0, "agent_wake": 0}
    for raw_line in str(content or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if re.match(r"^REPORT\s*:", line, re.I):
            counts["report"] += 1
        if re.match(r"^BLACKBOARD\s*:", line, re.I):
            counts["blackboard"] += 1
        if re.match(r"^DONE\b", line, re.I):
            counts["done"] += 1
        if re.match(r"^WAKE\s+@?[A-Za-z0-9_.-]+\s+IN\s+[0-9]+", line, re.I):
            counts["wake"] += 1
        if re.match(r"^@[A-Za-z0-9_.-]+\s*:", line):
            counts["agent_wake"] += 1
    return counts


def room_run_duration_seconds(run):
    start = status_timestamp(run.get("started_at") or run.get("created_at"))
    end = status_timestamp(run.get("completed_at"))
    if start is None:
        return None
    if end is None:
        if run_is_active_for_room(run):
            return max(0, int(round(time.time() - start)))
        return None
    return max(0, int(round(end - start)))


def room_run_contract_summary(run, content):
    return trim_one_line(run.get("summary") or content or run.get("stderr") or "", 500)


def room_run_contract_error(run, content):
    status = run_status(run)
    if status not in {"failed", "error", "cancelled", "canceled", "skipped", "replaced", "superseded"}:
        return ""
    return trim_one_line(run.get("stderr") or run.get("summary") or content or f"run {status}", 500)


def trim_one_line(value, limit=240):
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "..."


def summarize_room_agent_checklist(room, checklist):
    expected = [agent_id for agent_id in (room.get("agents") or []) if agent_id]
    agents = checklist.get("agents") if isinstance(checklist.get("agents"), dict) else {}
    records = []
    for item in agents.values():
        if not isinstance(item, dict):
            continue
        runs = item.get("runs") if isinstance(item.get("runs"), dict) else {}
        records.extend(run for run in runs.values() if isinstance(run, dict))
    latest = {
        agent_id: agents.get(agent_id)
        for agent_id in expected
        if isinstance(agents.get(agent_id), dict)
    }
    terminal_agents = [
        agent_id for agent_id, item in latest.items()
        if item and is_room_checklist_terminal_status(item.get("status"))
    ]
    failed_statuses = {"failed", "error", "cancelled", "canceled", "skipped", "replaced", "superseded"}
    return {
        "expected_agents": len(expected),
        "agents_with_runs": len([agent_id for agent_id in expected if agent_id in latest]),
        "replied_agents": len(terminal_agents),
        "completed_agents": len([agent_id for agent_id, item in latest.items() if run_status(item) == "completed"]),
        "failed_agents": len([agent_id for agent_id, item in latest.items() if run_status(item) in failed_statuses]),
        "missing_agents": [agent_id for agent_id in expected if agent_id not in latest],
        "running_agents": [agent_id for agent_id, item in latest.items() if run_status(item) == "running"],
        "queued_agents": [agent_id for agent_id, item in latest.items() if run_status(item) == "queued"],
        "missing_report_agents": [agent_id for agent_id in terminal_agents if not latest[agent_id].get("has_report")],
        "missing_done_agents": [agent_id for agent_id in terminal_agents if not latest[agent_id].get("has_done")],
        "run_count": len(records),
        "completed_runs": len([item for item in records if run_status(item) == "completed"]),
        "failed_runs": len([item for item in records if run_status(item) in failed_statuses]),
        "runs_with_report": len([item for item in records if item.get("has_report")]),
        "runs_with_done": len([item for item in records if item.get("has_done")]),
    }


def is_room_checklist_terminal_status(status):
    return str(status or "").lower() in TERMINAL_RUN_STATUSES | REPLACED_RUN_STATUSES


TERMINAL_RUN_STATUSES = {"completed", "failed", "error", "cancelled", "canceled", "skipped"}
REPLACED_RUN_STATUSES = {"replaced", "superseded"}


def run_status(run):
    return str((run or {}).get("status") or "").lower()


def run_is_terminal(run):
    return run_status(run) in TERMINAL_RUN_STATUSES


def run_is_replaced(run):
    if not isinstance(run, dict):
        return False
    if run_status(run) in REPLACED_RUN_STATUSES:
        return True
    return bool(run.get("replaced_by_run_id") or run.get("replacement_run_id") or run.get("superseded_by_run_id"))


def run_is_late_complete_ignored(run):
    return bool(isinstance(run, dict) and run.get("late_complete_ignored_at"))


def run_is_active_for_room(run):
    return not run_is_terminal(run) and not run_is_replaced(run) and not run_is_late_complete_ignored(run)


def sync_room_run(room, run):
    room["runs"] = [run if item.get("id") == run.get("id") else item for item in room.get("runs", [])]


def active_room_runs(room):
    return [
        item for item in room.get("runs", [])
        if run_is_active_for_room(item)
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


def update_room_run(config, run):
    room_id = run.get("room_id")
    if not room_id:
        return
    room = STATE["rooms"].get(room_id) or read_snapshot(config, "rooms", room_id)
    if not room:
        return
    sync_room_run(room, run)
    update_room_agent_checklist(room, run)
    room["updated_at"] = now()
    STATE["rooms"][room["id"]] = room
    write_snapshot(config, "rooms", room["id"], room)


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
    control = dict(plugin.get("control") or {})
    env_control_enabled = os.environ.get("AGENT_BUS_TELEGRAM_CONTROL_ENABLED")
    if env_control_enabled:
        control["enabled"] = env_control_enabled.strip().lower() in ("1", "true", "yes", "on")
    control.setdefault("enabled", False)
    control.setdefault("secretTokenEnv", "AGENT_BUS_TELEGRAM_WEBHOOK_SECRET")
    control.setdefault("allowedChatIds", [])
    control.setdefault("allowRun", True)
    plugin["control"] = control
    return plugin


def public_telegram_plugin_status(config):
    plugin = telegram_plugin_config(config)
    token = telegram_bot_token(plugin)
    chat_id = telegram_chat_id(plugin)
    control = telegram_control_config(plugin)
    conversation = telegram_conversation_config(control)
    return {
        "enabled": plugin.get("enabled") is True,
        "configured": bool(token and chat_id),
        "dry_run": plugin.get("dryRun") is True or plugin.get("dry_run") is True,
        "events": plugin_events(plugin),
        "bot_token_env": plugin.get("botTokenEnv"),
        "chat_id_env": plugin.get("chatIdEnv"),
        "control": {
            "enabled": control.get("enabled") is True,
            "webhook": "/v1/agent-bus/plugins/telegram/webhook",
            "diagnostic_dry_run_header": True,
            "allow_run": control.get("allowRun") is not False and control.get("allow_run") is not False,
            "allowed_chat_count": len(telegram_allowed_chat_ids(plugin)),
            "secret_configured": bool(telegram_control_secret(control)),
            "secret_token_env": control.get("secretTokenEnv"),
            "conversation": {
                "enabled": conversation.get("enabled") is True or env_truthy(conversation.get("enabled")),
                "agents": telegram_conversation_agents(conversation),
                "mode": conversation.get("mode") or "orchestrate",
            },
        },
    }


def public_plugins_status(config):
    return {
        "telegramBot": public_telegram_plugin_status(config),
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


def telegram_control_config(plugin):
    return dict(plugin.get("control") or {})


def env_truthy(value):
    return str(value or "").strip().lower() in ("1", "true", "yes", "on")


def telegram_conversation_config(control):
    raw = control.get("conversation") or control.get("chat") or {}
    conversation = dict(raw) if isinstance(raw, dict) else {}
    env_enabled = os.environ.get("AGENT_BUS_TELEGRAM_CONVERSATION_ENABLED")
    if env_enabled is not None:
        conversation["enabled"] = env_truthy(env_enabled)
    env_agent = os.environ.get("AGENT_BUS_TELEGRAM_CONVERSATION_AGENT")
    if env_agent:
        conversation["agentId"] = env_agent.strip()
    env_agents = os.environ.get("AGENT_BUS_TELEGRAM_CONVERSATION_AGENTS")
    if env_agents:
        conversation["agents"] = [item.strip() for item in env_agents.split(",") if item.strip()]
    return conversation


def telegram_conversation_enabled(control):
    conversation = telegram_conversation_config(control)
    return conversation.get("enabled") is True or env_truthy(conversation.get("enabled"))


def telegram_conversation_agents(conversation):
    values = []
    for key in ("agentId", "agent_id", "defaultAgentId", "default_agent_id"):
        if conversation.get(key):
            values.append(str(conversation[key]).strip())
    raw = conversation.get("agents") or conversation.get("agentIds") or conversation.get("agent_ids") or []
    if isinstance(raw, str):
        raw = [item.strip() for item in raw.split(",")]
    for item in raw:
        text = str(item).strip()
        if text:
            values.append(text)
    out = []
    seen = set()
    for item in values:
        if item and item not in seen:
            out.append(item)
            seen.add(item)
    return out


def telegram_session_key(chat_id):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(chat_id or "").strip()) or "unknown"


def telegram_session_path(config, chat_id):
    return Path(config["dataDir"]) / "telegram_sessions" / f"{telegram_session_key(chat_id)}.json"


def read_telegram_session(config, chat_id):
    path = telegram_session_path(config, chat_id)
    if not path.exists():
        return {
            "chat_id": str(chat_id or "").strip(),
            "active_thread_id": None,
            "agents": [],
            "updated_at": None,
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    data["chat_id"] = str(chat_id or "").strip()
    data.setdefault("active_thread_id", None)
    data.setdefault("agents", [])
    data.setdefault("room_draft", None)
    return data


def write_telegram_session(config, chat_id, session):
    path = telegram_session_path(config, chat_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = dict(session or {})
    record["chat_id"] = str(chat_id or "").strip()
    record["updated_at"] = now()
    path.write_text(json.dumps(redact(record), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return record


def telegram_thread_for_chat(thread, chat_id):
    telegram = thread.get("telegram") if isinstance(thread, dict) else None
    return (
        isinstance(telegram, dict)
        and telegram.get("conversation") is True
        and str(telegram.get("chat_id") or "") == str(chat_id or "")
    )


def telegram_chat_threads(config, chat_id):
    by_id = {}
    for thread in read_snapshots(config, "threads"):
        if isinstance(thread, dict) and thread.get("id") and telegram_thread_for_chat(thread, chat_id):
            by_id[thread["id"]] = thread
    for thread in STATE["threads"].values():
        if isinstance(thread, dict) and thread.get("id") and telegram_thread_for_chat(thread, chat_id):
            by_id[thread["id"]] = thread
    return sorted(by_id.values(), key=lambda item: item.get("updated_at") or item.get("created_at") or "", reverse=True)


def telegram_active_thread(config, chat_id, session=None):
    session = session or read_telegram_session(config, chat_id)
    thread_id = session.get("active_thread_id")
    if not thread_id:
        return None
    thread = STATE["threads"].get(thread_id) or read_snapshot(config, "threads", thread_id)
    if isinstance(thread, dict) and telegram_thread_for_chat(thread, chat_id):
        return thread
    return None


def telegram_thread_title(message):
    title = " ".join(str(message or "").strip().split())
    return title[:80] or "Untitled Telegram process"


def telegram_thread_label(thread):
    if not thread:
        return "no active process"
    return str(thread.get("title") or thread.get("message") or thread.get("id") or "").strip()[:80] or thread.get("id")


def validate_agent_ids(agent_ids):
    wanted = []
    for agent_id in agent_ids or []:
        text = str(agent_id or "").strip()
        if text and text not in wanted:
            wanted.append(text)
    if not wanted:
        return []
    agents = public_agents()
    online = {agent["id"] for agent in agents}
    missing = [agent_id for agent_id in wanted if agent_id not in online]
    if missing:
        err = Exception("unknown registered agents: " + ", ".join(missing))
        err.status_code = 400
        raise err
    raise_if_agent_ids_ambiguous(wanted, agents)
    return wanted


def telegram_thread_agent_ids(thread):
    return [str(item) for item in ((thread or {}).get("selection", {}) or {}).get("agents") or [] if str(item or "").strip()]


def set_telegram_thread_agents(config, thread, agent_ids):
    values = validate_agent_ids(agent_ids)
    if not thread:
        return []
    thread.setdefault("selection", {})["agents"] = values
    thread["updated_at"] = now()
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)
    return values


def update_telegram_thread_agents(config, thread, agent_ids):
    if not thread:
        return []
    current = telegram_thread_agent_ids(thread)
    merged = []
    for item in [*current, *validate_agent_ids(agent_ids)]:
        if item not in merged:
            merged.append(item)
    return set_telegram_thread_agents(config, thread, merged)


def telegram_extract_mentions(text):
    remaining = str(text or "").strip()
    mentions = []
    while True:
        match = re.match(r"^@([A-Za-z0-9_.-]+)(?:\s+|$)", remaining)
        if not match:
            break
        mentions.append(match.group(1))
        remaining = remaining[match.end():].strip()
    return mentions, remaining


def telegram_process_prompt(thread, latest_message):
    item_limit = room_prompt_limit("AGENT_BUS_TELEGRAM_PROMPT_MESSAGE_CHARS", 1800, 200, 12000)
    item_count = room_prompt_limit("AGENT_BUS_TELEGRAM_PROMPT_MESSAGE_COUNT", 8, 1, 20)
    latest_limit = room_prompt_limit("AGENT_BUS_TELEGRAM_PROMPT_LATEST_CHARS", 4000, 500, 24000)
    max_bytes = room_prompt_limit("AGENT_BUS_TELEGRAM_PROMPT_MAX_BYTES", 20000, 4000, 120000)
    recent = []
    for item in (thread.get("conversation") or [])[-item_count:]:
        speaker = item.get("speaker") or item.get("role") or "unknown"
        content = truncate_for_room_prompt(item.get("content") or "", item_limit)
        if content:
            recent.append((speaker, content))
    latest = truncate_for_room_prompt(str(latest_message or "").strip(), latest_limit)

    def render(items, omitted):
        lines = [
            "You are continuing a Telegram Agent Bus process.",
            f"Process: {telegram_thread_label(thread)}",
            f"Thread: {thread.get('id')}",
            "Answer the latest user message directly. Keep continuity with the prior messages.",
            "Do not claim to be another agent. Your agent id will be added outside your reply.",
            "",
            "Recent process messages:",
        ]
        if omitted:
            lines.append(f"[{omitted} older process messages omitted to keep the prompt compact]")
        for speaker, content in items:
            lines.append(f"{speaker}: {content}")
        lines.extend(["", "Latest user message:", latest])
        return "\n".join(lines)

    items = list(recent)
    omitted = max(0, len((thread.get("conversation") or [])) - len(items))
    while items:
        prompt = render(items, omitted)
        if len(prompt.encode("utf-8")) <= max_bytes:
            return prompt
        items = items[1:]
        omitted += 1
    return render([], omitted)


def telegram_session_agents(config, control, session, thread=None, mentions=None):
    mentioned = validate_agent_ids(mentions or [])
    if mentioned:
        return mentioned
    session_agents = validate_agent_ids(session.get("agents") or [])
    if session_agents:
        return session_agents
    configured = validate_agent_ids(telegram_conversation_agents(telegram_conversation_config(control)))
    if configured:
        return configured
    thread_agents = validate_agent_ids(telegram_thread_agent_ids(thread))
    if thread_agents:
        return thread_agents
    return []


def telegram_control_secret(control):
    env_name = str(control.get("secretTokenEnv") or "AGENT_BUS_TELEGRAM_WEBHOOK_SECRET")
    return str(os.environ.get(env_name) or control.get("secretToken") or control.get("secret_token") or "").strip()


def telegram_allowed_chat_ids(plugin):
    control = telegram_control_config(plugin)
    values = control.get("allowedChatIds") or control.get("allowed_chat_ids") or []
    if isinstance(values, str):
        values = [item.strip() for item in values.split(",")]
    allowed = {str(item).strip() for item in values if str(item).strip()}
    default_chat = telegram_chat_id(plugin)
    if default_chat:
        allowed.add(default_chat)
    return sorted(allowed)


def telegram_chat_allowed(plugin, chat_id):
    allowed = telegram_allowed_chat_ids(plugin)
    return not allowed or str(chat_id) in set(allowed)


def telegram_plugin_dry_run(plugin):
    return plugin.get("dryRun") is True or plugin.get("dry_run") is True


def telegram_short_label(value, limit=34):
    text = " ".join(str(value or "").strip().split())
    if len(text) <= limit:
        return text
    return text[:max(1, limit - 3)].rstrip() + "..."


def telegram_callback_button(text, callback_data):
    data = str(callback_data or "").strip()
    if not data or len(data.encode("utf-8")) > 64:
        return None
    return {
        "text": telegram_short_label(text, 40),
        "callback_data": data,
    }


def telegram_button_rows(buttons, width=2):
    rows = []
    row = []
    for button in buttons:
        if not button:
            continue
        row.append(button)
        if len(row) >= width:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    return rows


def telegram_base_keyboard_rows():
    return [
        [
            telegram_callback_button("Status", "/status"),
            telegram_callback_button("Agents", "/agents"),
        ],
        [
            telegram_callback_button("New process", "/new"),
            telegram_callback_button("Resume", "/resume"),
        ],
        [
            telegram_callback_button("Rooms", "/rooms"),
        ],
    ]


def telegram_agent_keyboard_rows(config, chat_id):
    agents = sorted(public_agents(), key=lambda item: str(item.get("id") or ""))
    if not agents:
        return []
    session = read_telegram_session(config, chat_id) if chat_id else {"agents": []}
    active = telegram_active_thread(config, chat_id, session) if chat_id else None
    current = set(session.get("agents") or telegram_thread_agent_ids(active))
    buttons = []
    if current:
        buttons.append(telegram_callback_button("Auto route", "/agent clear"))
    for agent in agents[:10]:
        agent_id = str(agent.get("id") or "").strip()
        if not agent_id:
            continue
        label_prefix = "+ " if active else ""
        command = f"/agent toggle {agent_id}"
        if agent_id in current:
            label_prefix = "* "
        buttons.append(telegram_callback_button(label_prefix + agent_id, command))
    return telegram_button_rows(buttons, width=2)


def telegram_process_keyboard_rows(config, chat_id):
    if not chat_id:
        return []
    session = read_telegram_session(config, chat_id)
    active_id = session.get("active_thread_id")
    buttons = []
    for thread in telegram_chat_threads(config, chat_id)[:6]:
        thread_id = str(thread.get("id") or "")
        label = telegram_thread_label(thread)
        prefix = "* " if thread_id == active_id else ""
        buttons.append(telegram_callback_button(prefix + label, f"/resume {thread_id}"))
    return telegram_button_rows(buttons, width=1)


def telegram_room_draft(config, chat_id):
    session = read_telegram_session(config, chat_id)
    draft = session.get("room_draft")
    if not isinstance(draft, dict):
        draft = {}
    agents = []
    for item in draft.get("agents") or []:
        text = str(item or "").strip()
        if text and text not in agents:
            agents.append(text)
    try:
        max_steps = int(draft.get("max_steps") or draft.get("maxSteps") or 5)
    except (TypeError, ValueError):
        max_steps = 5
    return {
        "agents": agents,
        "max_steps": max(1, min(max_steps, 100)),
        "created_at": draft.get("created_at") or now(),
    }


def write_telegram_room_draft(config, chat_id, draft):
    session = read_telegram_session(config, chat_id)
    session["room_draft"] = draft
    write_telegram_session(config, chat_id, session)
    return draft


def clear_telegram_room_draft(config, chat_id):
    session = read_telegram_session(config, chat_id)
    session["room_draft"] = None
    write_telegram_session(config, chat_id, session)


def telegram_room_draft_active(config, chat_id):
    session = read_telegram_session(config, chat_id)
    return isinstance(session.get("room_draft"), dict)


def telegram_room_draft_keyboard_rows(config, chat_id):
    draft = telegram_room_draft(config, chat_id)
    current = set(draft.get("agents") or [])
    buttons = []
    for agent in sorted(public_agents(), key=lambda item: str(item.get("id") or ""))[:10]:
        agent_id = str(agent.get("id") or "").strip()
        if not agent_id:
            continue
        label = ("* " if agent_id in current else "+ ") + agent_id
        buttons.append(telegram_callback_button(label, f"/room agent toggle {agent_id}"))
    rows = telegram_button_rows(buttons, width=2)
    step_buttons = []
    max_steps = int(draft.get("max_steps") or 5)
    for value in (2, 5, 10, 20):
        label = f"* {value} steps" if value == max_steps else f"{value} steps"
        step_buttons.append(telegram_callback_button(label, f"/room steps {value}"))
    rows.extend(telegram_button_rows(step_buttons, width=2))
    rows.append([
        telegram_callback_button("Cancel", "/room cancel"),
        telegram_callback_button("Rooms", "/rooms"),
    ])
    return rows


def telegram_room_draft_text(draft):
    agents = ", ".join(draft.get("agents") or []) or "auto"
    return "\n".join([
        "New Agent Bus room draft",
        f"Agents: {agents}",
        f"Max steps: {draft.get('max_steps') or 5}",
        "Select agents and steps, then send the room goal or use /room start <goal>.",
    ])


def telegram_active_room_status(room):
    return str((room or {}).get("status") or "").lower() in ("active", "running", "finishing")


def telegram_room_label(room):
    if not room:
        return "unknown room"
    title = str(room.get("title") or room.get("goal") or room.get("id") or "").strip()
    status = str(room.get("status") or "unknown").strip()
    return telegram_short_label(f"{status}: {title}", 38)


def telegram_room_match(config, query):
    text = str(query or "").strip()
    if not text:
        return None
    lowered = text.lower()
    for room in list_rooms(config):
        room_id = str(room.get("id") or "")
        title = str(room.get("title") or room.get("goal") or "").lower()
        if room_id == text or room_id.endswith(text) or text in room_id or lowered in title:
            return room
    return None


def telegram_room_keyboard_rows(config):
    rows = [[telegram_callback_button("New room", "/room new")]]
    buttons = []
    for room in list_rooms(config)[:6]:
        room_id = str(room.get("id") or "")
        if room_id:
            buttons.append(telegram_callback_button(telegram_room_label(room), f"/room {room_id}"))
    rows.extend(telegram_button_rows(buttons, width=1))
    return rows


def telegram_room_action_keyboard_rows(room):
    if not room:
        return []
    room_id = str(room.get("id") or "")
    if not room_id:
        return []
    rows = [[telegram_callback_button("Rooms", "/rooms")]]
    rows.append([telegram_callback_button("New room", "/room new")])
    status = str(room.get("status") or "").lower()
    if telegram_active_room_status(room):
        rows.append([
            telegram_callback_button("Wake next", f"/room wake {room_id}"),
            telegram_callback_button("Pause", f"/room pause {room_id}"),
        ])
    elif status == "paused":
        rows.append([telegram_callback_button("Resume room", f"/room wake {room_id}")])
    return [row for row in rows if row and all(row)]


def telegram_reply_markup(config, command_result=None, chat_id=None):
    result = command_result if isinstance(command_result, dict) else {}
    rows = []
    command = str(result.get("command") or "").lower()
    if command in ("start", "help", "status", "unknown", "message"):
        rows.extend(telegram_base_keyboard_rows())
    if command in ("agents", "agent", "new"):
        rows.extend(telegram_agent_keyboard_rows(config, chat_id))
    if command == "resume":
        rows.extend(telegram_process_keyboard_rows(config, chat_id))
    if command == "rooms":
        rows.extend(telegram_room_keyboard_rows(config))
    if command == "room_draft":
        rows.extend(telegram_room_draft_keyboard_rows(config, chat_id))
    if command == "room":
        rows.extend(telegram_room_action_keyboard_rows(result.get("room")))
    rows = [row for row in rows if row]
    return {"inline_keyboard": rows} if rows else None


def answer_telegram_callback(config, plugin, callback_query_id):
    callback_query_id = str(callback_query_id or "").strip()
    if not callback_query_id:
        return None
    token = telegram_bot_token(plugin)
    dry_run = telegram_plugin_dry_run(plugin)
    status = "dry_run" if dry_run else ("queued" if token else "missing_config")
    append_jsonl(config, "notifications.jsonl", {
        "at": now(),
        "plugin": "telegramBot",
        "event": "telegram.callback_answer",
        "status": status,
        "callback_query_id": callback_query_id,
    })
    if dry_run or not token:
        return {
            "ok": bool(dry_run),
            "plugin": "telegramBot",
            "event": "telegram.callback_answer",
            "status": status,
            "configured": bool(token),
            "dry_run": bool(dry_run),
        }
    threading.Thread(target=send_telegram_callback_answer, args=(config, token, callback_query_id), daemon=True).start()
    return {
        "ok": True,
        "plugin": "telegramBot",
        "event": "telegram.callback_answer",
        "status": status,
        "configured": True,
        "dry_run": False,
    }


def notify_plugin(config, event, payload, dry_run_override=None, event_filter=True, chat_id_override=None, reply_markup=None):
    plugin = telegram_plugin_config(config)
    if plugin.get("enabled") is not True:
        return {
            "ok": False,
            "plugin": "telegramBot",
            "event": event,
            "status": "disabled",
        }
    if event_filter and event not in set(plugin_events(plugin)):
        return {
            "ok": False,
            "plugin": "telegramBot",
            "event": event,
            "status": "event_disabled",
        }
    text = telegram_notification_text(event, payload)
    token = telegram_bot_token(plugin)
    chat_id = str(chat_id_override or telegram_chat_id(plugin)).strip()
    dry_run = dry_run_override if dry_run_override is not None else telegram_plugin_dry_run(plugin)
    status = "dry_run" if dry_run else ("queued" if token and chat_id else "missing_config")
    markup = reply_markup or (payload.get("reply_markup") if isinstance(payload, dict) else None)
    record = {
        "at": now(),
        "plugin": "telegramBot",
        "event": event,
        "status": status,
        "message": text,
        "payload": payload,
    }
    if markup:
        record["reply_markup"] = markup
    append_jsonl(config, "notifications.jsonl", record)
    if dry_run or not token or not chat_id:
        return {
            "ok": bool(dry_run),
            "plugin": "telegramBot",
            "event": event,
            "status": status,
            "configured": bool(token and chat_id),
            "dry_run": bool(dry_run),
            "reply_markup": markup,
        }
    threading.Thread(target=send_telegram_notification, args=(config, token, chat_id, text, markup), daemon=True).start()
    return {
        "ok": True,
        "plugin": "telegramBot",
        "event": event,
        "status": status,
        "configured": True,
        "dry_run": False,
        "reply_markup": markup,
    }


def telegram_plugin_test(config, body):
    message = str(body.get("message") or "Agent Bus Telegram plugin test.").strip()
    dry_run = body.get("dryRun") if "dryRun" in body else body.get("dry_run")
    if dry_run is not None:
        dry_run = dry_run is True or str(dry_run).strip().lower() in ("1", "true", "yes", "on")
    result = notify_plugin(config, "telegram.test", {
        "message": message,
        "gateway": public_gateway_url(config),
    }, dry_run_override=dry_run, event_filter=False)
    return {
        "ok": result.get("ok") is True,
        "plugin": public_telegram_plugin_status(config),
        "notification": result,
    }


def telegram_webhook(config, body, handler):
    plugin = telegram_plugin_config(config)
    control = telegram_control_config(plugin)
    if plugin.get("enabled") is not True or control.get("enabled") is not True:
        err = Exception("telegram control webhook is disabled")
        err.status_code = 403
        raise err
    secret = telegram_control_secret(control)
    if secret and handler.headers.get("x-telegram-bot-api-secret-token") != secret:
        err = Exception("invalid telegram webhook secret")
        err.status_code = 403
        raise err
    message = telegram_update_message(body)
    chat_id = str(((message.get("chat") or {}).get("id")) or "").strip()
    text = str(message.get("text") or "").strip()
    if not chat_id or not text:
        err = Exception("telegram webhook requires message.chat.id and message.text")
        err.status_code = 400
        raise err
    if not telegram_chat_allowed(plugin, chat_id):
        err = Exception("telegram chat is not allowed")
        err.status_code = 403
        raise err
    dry_run_probe = str(handler.headers.get("x-agent-bus-telegram-dry-run") or "").strip().lower() in ("1", "true", "yes", "on")
    callback_answer = answer_telegram_callback(config, plugin, message.get("_callback_query_id"))
    command_result = telegram_handle_command(config, plugin, control, text, chat_id)
    reply_markup = telegram_reply_markup(config, command_result, chat_id)
    reply_result = notify_plugin(config, "telegram.command", {
        "command": command_result["command"],
        "reply": command_result["reply"],
        "chat_id": chat_id,
        "thread_id": command_result.get("thread", {}).get("id"),
    }, dry_run_override=True if dry_run_probe else None, event_filter=False, chat_id_override=chat_id, reply_markup=reply_markup)
    return {
        "ok": True,
        "diagnostic_dry_run": dry_run_probe,
        "command": command_result["command"],
        "reply": command_result["reply"],
        "reply_status": reply_result,
        "reply_markup": reply_markup,
        "callback_answer": callback_answer,
        "thread": command_result.get("thread"),
        "room": command_result.get("room"),
    }


def telegram_update_message(body):
    if isinstance(body.get("message"), dict):
        return body["message"]
    if isinstance(body.get("edited_message"), dict):
        return body["edited_message"]
    callback = body.get("callback_query")
    if isinstance(callback, dict) and isinstance(callback.get("message"), dict):
        item = dict(callback["message"])
        item["text"] = callback.get("data") or item.get("text") or ""
        item["_callback_query_id"] = callback.get("id")
        return item
    return {}


def telegram_handle_command(config, plugin, control, text, chat_id=None):
    is_command = str(text or "").lstrip().startswith("/")
    command, rest = telegram_parse_command(text)
    if is_command and command == "new":
        return telegram_new_command(config, chat_id, rest)
    if is_command and command == "resume":
        return telegram_resume_command(config, chat_id, rest)
    if is_command and command == "agent":
        return telegram_agent_command(config, chat_id, rest)
    if is_command and command == "agents":
        return {"command": command, "reply": telegram_agents_text()}
    if is_command and command == "rooms":
        return telegram_rooms_command(config, chat_id, rest)
    if is_command and command == "room":
        return telegram_room_command(config, chat_id, rest)
    if not is_command:
        if telegram_room_draft_active(config, chat_id):
            return telegram_room_start_command(config, chat_id, text)
        if telegram_conversation_enabled(control):
            return telegram_conversation_command(config, control, chat_id, text)
        return {
            "command": "message",
            "reply": telegram_help_text(prefix="Free-form chat is disabled. Use /run or enable control.conversation.enabled."),
        }
    if command in ("start", "help"):
        return {"command": command, "reply": telegram_help_text()}
    if command == "status":
        return {"command": command, "reply": telegram_status_text(config)}
    if command == "run":
        if control.get("allowRun") is False or control.get("allow_run") is False:
            return {"command": command, "reply": "Run commands are disabled for this Telegram bot."}
        return telegram_run_command(config, rest)
    return {"command": command or "unknown", "reply": telegram_help_text(prefix="Unknown command.")}


def telegram_new_command(config, chat_id, rest):
    session = read_telegram_session(config, chat_id)
    session["active_thread_id"] = None
    session["agents"] = []
    write_telegram_session(config, chat_id, session)
    if str(rest or "").strip():
        plugin = telegram_plugin_config(config)
        return telegram_conversation_command(config, telegram_control_config(plugin), chat_id, rest)
    return {
        "command": "new",
        "reply": "Started a new Agent Bus process. Tap agents to preselect one or more, or send the first message for automatic routing.",
    }


def telegram_resume_command(config, chat_id, rest):
    query = str(rest or "").strip()
    threads = telegram_chat_threads(config, chat_id)
    session = read_telegram_session(config, chat_id)
    if not query:
        if not threads:
            return {"command": "resume", "reply": "No Telegram processes found. Send a message to start one."}
        lines = ["Recent Agent Bus processes:"]
        active_id = session.get("active_thread_id")
        for thread in threads[:8]:
            marker = "*" if thread.get("id") == active_id else "-"
            lines.append(f"{marker} {thread.get('id')} - {telegram_thread_label(thread)}")
        lines.append("Use /resume <thread-id or title words> to switch.")
        return {"command": "resume", "reply": "\n".join(lines)}
    lowered = query.lower()
    match = None
    for thread in threads:
        title = telegram_thread_label(thread).lower()
        thread_id = str(thread.get("id") or "")
        if thread_id == query or thread_id.endswith(query) or query in thread_id or lowered in title:
            match = thread
            break
    if not match:
        return {"command": "resume", "reply": f"No matching Telegram process for: {query}"}
    session["active_thread_id"] = match["id"]
    session["agents"] = telegram_thread_agent_ids(match)
    write_telegram_session(config, chat_id, session)
    return {
        "command": "resume",
        "reply": f"Resumed process: {telegram_thread_label(match)}\nThread: {match['id']}\nAgents: {', '.join(session['agents']) or 'auto'}",
        "thread": {
            "id": match.get("id"),
            "trace_id": match.get("trace_id"),
            "runs": [],
            "agents": session["agents"],
        },
    }


def telegram_agent_command(config, chat_id, rest):
    session = read_telegram_session(config, chat_id)
    active = telegram_active_thread(config, chat_id, session)
    parts = str(rest or "").split()
    if not parts:
        online = [agent["id"] for agent in public_agents()]
        current = session.get("agents") or telegram_thread_agent_ids(active)
        return {
            "command": "agent",
            "reply": "Current agents: " + (", ".join(current) or "auto") + "\nOnline agents: " + (", ".join(online) or "none"),
        }
    action = parts[0].lower()
    if action in ("clear", "auto"):
        session["agents"] = []
        if active:
            set_telegram_thread_agents(config, active, [])
        write_telegram_session(config, chat_id, session)
        return {"command": "agent", "reply": "Agent selection cleared. The process will use Agent Bus routing."}
    if action in ("add", "+"):
        values = validate_agent_ids(parts[1:])
        if not values:
            return {"command": "agent", "reply": "Usage: /agent add <agent-id> [agent-id...]"}
        merged = []
        for item in [*(session.get("agents") or telegram_thread_agent_ids(active)), *values]:
            if item not in merged:
                merged.append(item)
        if active:
            merged = update_telegram_thread_agents(config, active, merged)
        session["agents"] = merged
        write_telegram_session(config, chat_id, session)
        return {"command": "agent", "reply": "Agents for this process: " + ", ".join(merged)}
    if action in ("toggle", "pick"):
        values = validate_agent_ids(parts[1:])
        if not values:
            return {"command": "agent", "reply": "Usage: /agent toggle <agent-id> [agent-id...]"}
        current = []
        for item in (session.get("agents") or telegram_thread_agent_ids(active)):
            if item not in current:
                current.append(item)
        for item in values:
            if item in current:
                current.remove(item)
            else:
                current.append(item)
        if active:
            set_telegram_thread_agents(config, active, current)
        session["agents"] = current
        write_telegram_session(config, chat_id, session)
        return {"command": "agent", "reply": "Agents for this process: " + (", ".join(current) or "auto")}
    if action in ("set", "="):
        values = validate_agent_ids(parts[1:])
    else:
        values = validate_agent_ids(parts)
    if not values:
        return {"command": "agent", "reply": "Usage: /agent <agent-id> [agent-id...]"}
    if active:
        update_telegram_thread_agents(config, active, values)
    session["agents"] = values
    write_telegram_session(config, chat_id, session)
    return {"command": "agent", "reply": "Agents for this process: " + ", ".join(values)}


def telegram_conversation_command(config, control, chat_id, text):
    mentions, message = telegram_extract_mentions(text)
    if not message:
        if mentions:
            return telegram_agent_command(config, chat_id, "add " + " ".join(mentions))
        message = str(text or "").strip()
    session = read_telegram_session(config, chat_id)
    active = telegram_active_thread(config, chat_id, session)
    conversation = telegram_conversation_config(control)
    agents = telegram_session_agents(config, control, session, active, mentions)
    mode = str(conversation.get("mode") or "orchestrate").strip() or "orchestrate"
    run_ids = []
    if active:
        if mentions:
            merged = update_telegram_thread_agents(config, active, [*telegram_thread_agent_ids(active), *mentions])
            session["agents"] = merged
            write_telegram_session(config, chat_id, session)
        selected = agents or telegram_thread_agent_ids(active)
        if not selected:
            selected = telegram_session_agents(config, control, session, active, [])
        if not selected:
            selection = select_agents(message, {"mode": mode, "agents": None})
            selected = [agent["id"] for agent in selection["agents"]]
            update_telegram_thread_agents(config, active, selected)
        selected = validate_agent_ids(selected)
        active.setdefault("conversation", []).append({
            "speaker": "user",
            "role": "user",
            "content": message,
            "at": now(),
        })
        prompt = telegram_process_prompt(active, message)
        online_by_id = {agent["id"]: agent for agent in public_agents()}
        for agent_id in selected:
            run = create_run(config, active, online_by_id[agent_id], prompt, trace_id=active.get("trace_id"))
            run_ids.append(run["id"])
        active["updated_at"] = now()
        STATE["threads"][active["id"]] = active
        write_snapshot(config, "threads", active["id"], active)
        append_jsonl(config, "threads.jsonl", active)
        return {
            "command": "chat",
            "reply": f"Thinking with {', '.join(selected) or 'Agent Bus'}...\nProcess: {telegram_thread_label(active)}\nThread: {active.get('id')}",
            "thread": {
                "id": active.get("id"),
                "trace_id": active.get("trace_id"),
                "runs": run_ids,
                "agents": selected,
            },
        }
    body = {
        "message": message,
        "title": telegram_thread_title(message),
        "mode": mode,
        "source": "telegram",
        "telegram": {
            "conversation": True,
            "chat_id": str(chat_id or "").strip(),
            "session": True,
        },
    }
    if agents:
        body["agents"] = agents
    thread = create_thread(config, body)
    thread.setdefault("conversation", []).append({
        "speaker": "user",
        "role": "user",
        "content": message,
        "at": thread.get("created_at") or now(),
    })
    thread["updated_at"] = now()
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)
    session["active_thread_id"] = thread["id"]
    session["agents"] = telegram_thread_agent_ids(thread)
    write_telegram_session(config, chat_id, session)
    run_ids = [run.get("id") for run in thread.get("runs") or [] if run.get("id")]
    selected = thread.get("selection", {}).get("agents") or agents
    return {
        "command": "chat",
        "reply": "Thinking with " + (", ".join(selected) or "Agent Bus") + f"...\nProcess: {telegram_thread_label(thread)}\nThread: {thread.get('id')}",
        "thread": {
            "id": thread.get("id"),
            "trace_id": thread.get("trace_id"),
            "runs": run_ids,
            "agents": selected,
        },
    }


def notify_telegram_conversation_result(config, run):
    thread_id = run.get("thread_id")
    if not thread_id or run.get("room_id"):
        return False
    thread = STATE["threads"].get(thread_id) or read_snapshot(config, "threads", thread_id)
    telegram = thread.get("telegram") if isinstance(thread, dict) else None
    if not isinstance(telegram, dict) or telegram.get("conversation") is not True:
        return False
    chat_id = str(telegram.get("chat_id") or "").strip()
    if not chat_id:
        return False
    record_telegram_conversation_reply(config, thread, run)
    reply = telegram_conversation_reply_text(run)
    reply_markup = telegram_reply_markup(config, {
        "command": "chat",
        "thread": {"id": thread_id},
    }, chat_id)
    notify_plugin(config, "telegram.command", {
        "command": "chat",
        "reply": reply,
        "chat_id": chat_id,
        "thread_id": thread_id,
        "run_id": run.get("id"),
    }, event_filter=False, chat_id_override=chat_id, reply_markup=reply_markup)
    return True


def record_telegram_conversation_reply(config, thread, run):
    if not isinstance(thread, dict):
        return
    content = trim(run.get("stdout") or run.get("summary") or run.get("stderr") or "")
    thread.setdefault("conversation", []).append({
        "speaker": run.get("agent_id") or "agent",
        "role": "assistant",
        "content": content,
        "run_id": run.get("id"),
        "status": run.get("status"),
        "at": run.get("completed_at") or now(),
    })
    thread["updated_at"] = now()
    STATE["threads"][thread["id"]] = thread
    write_snapshot(config, "threads", thread["id"], thread)


def telegram_conversation_reply_text(run):
    content = trim(run.get("stdout") or run.get("summary") or run.get("stderr") or "").strip()
    if not content:
        content = "(no output)"
    limit = 3800
    if len(content) > limit:
        content = content[:limit].rstrip() + f"\n...[truncated {len(content) - limit} chars]"
    prefix = f"[{run.get('agent_id') or 'agent'}]"
    if run.get("status") == "completed":
        return f"{prefix}\n{content}"
    return f"{prefix}\nAgent Bus run {run.get('status') or 'failed'}\n{content}"


def telegram_parse_command(text):
    parts = str(text or "").strip().split(None, 1)
    if not parts:
        return "", ""
    token = parts[0]
    rest = parts[1] if len(parts) > 1 else ""
    if token.startswith("/"):
        token = token[1:].split("@", 1)[0]
    return token.lower().replace("-", "_"), rest.strip()


def telegram_help_text(prefix=""):
    lines = []
    if prefix:
        lines.append(prefix)
    lines.extend([
        "Agent Bus Telegram commands:",
        "/status - gateway, edge, queue, and room summary",
        "/agents - list online agents",
        "/run <agent-id> <task> - queue a task for one agent",
        "/new - end the current Telegram process and start a new one",
        "/resume [thread-id or title] - list or resume Telegram processes",
        "/agent [add|set|clear] <agent-id> - choose agents for this process",
        "/rooms - list Agent Bus rooms",
        "/room <room-id> - inspect, wake, or pause a room",
        "/room new - draft a room, multi-select agents, and set max steps",
        "@agent-id message - add or target an agent for this message",
        "Plain text - chat with the configured Agent Bus agent when conversation mode is enabled",
    ])
    return "\n".join(lines)


def telegram_status_text(config):
    nodes = public_nodes()
    agents = public_agents()
    rooms = list_rooms(config)
    active_rooms = [room for room in rooms if str(room.get("status") or "").lower() in ("active", "running", "finishing")]
    queued = sum(len(queue) for queue in STATE["queues"].values())
    return "\n".join([
        "Agent Bus status",
        f"Nodes online: {len(nodes)}",
        f"Agents online: {len(agents)}",
        f"Queued runs: {queued}",
        f"Active rooms: {len(active_rooms)}",
        "Agents: " + (", ".join(agent.get("id") for agent in agents) or "none"),
    ])


def telegram_agents_text():
    agents = public_agents()
    if not agents:
        return "No online Agent Bus agents."
    lines = ["Online Agent Bus agents:"]
    for agent in agents:
        lines.append(f"- {agent.get('id')} ({agent.get('kind')}/{agent.get('role')}) on {agent.get('node_id')}")
    return "\n".join(lines)


def telegram_rooms_command(config, chat_id=None, rest=""):
    query = str(rest or "").strip()
    if query:
        return telegram_room_command(config, chat_id, query)
    rooms = list_rooms(config)
    if not rooms:
        return {
            "command": "rooms",
            "reply": "No Agent Bus rooms found. Use the CLI or web console to create a room.",
        }
    lines = ["Recent Agent Bus rooms:"]
    for room in rooms[:8]:
        agents = ", ".join(room.get("agents") or []) or "auto"
        steps = f"{room.get('steps', 0)}/{room.get('max_steps', 0) or 'unlimited'}"
        lines.append(f"- {room.get('id')} - {room.get('status')} - {telegram_thread_title(room.get('title') or room.get('goal'))} [{agents}, steps {steps}]")
    lines.append("Tap a room to inspect it, or use /room <room-id>.")
    return {
        "command": "rooms",
        "reply": "\n".join(lines),
    }


def telegram_room_command(config, chat_id, rest=""):
    parts = str(rest or "").strip().split()
    if not parts:
        return telegram_rooms_command(config, chat_id)
    action = parts[0].lower()
    if action == "new":
        goal = str(rest or "").strip()[len(parts[0]):].strip()
        return telegram_room_new_command(config, chat_id, goal)
    if action == "cancel":
        clear_telegram_room_draft(config, chat_id)
        return {
            "command": "rooms",
            "reply": "Cancelled the new room draft.",
        }
    if action == "agent":
        return telegram_room_agent_command(config, chat_id, parts[1:])
    if action in ("steps", "step", "max_steps", "maxsteps"):
        return telegram_room_steps_command(config, chat_id, parts[1:])
    if action == "start":
        goal = str(rest or "").strip()[len(parts[0]):].strip()
        if not goal:
            draft = write_telegram_room_draft(config, chat_id, telegram_room_draft(config, chat_id))
            return {
                "command": "room_draft",
                "reply": telegram_room_draft_text(draft),
            }
        return telegram_room_start_command(config, chat_id, goal)
    if action in ("wake", "resume", "pause"):
        query = " ".join(parts[1:]).strip()
    elif action in ("show", "open"):
        query = " ".join(parts[1:]).strip()
        action = "show"
    else:
        query = " ".join(parts).strip()
        action = "show"
    match = telegram_room_match(config, query)
    if not match:
        return {
            "command": "room",
            "reply": f"No matching Agent Bus room for: {query or rest}",
        }
    room = get_room(config, match["id"])
    if action == "pause":
        room = pause_room(config, room["id"], {"reason": "Paused from Telegram."})
        return {
            "command": "room",
            "reply": "Paused room.\n" + telegram_room_detail_text(room),
            "room": room_summary(room),
        }
    if action in ("wake", "resume"):
        if str(room.get("status") or "").lower() == "completed":
            return {
                "command": "room",
                "reply": "Room is already completed.\n" + telegram_room_detail_text(room),
                "room": room_summary(room),
            }
        if str(room.get("status") or "").lower() == "paused":
            room["status"] = "active"
            room.pop("pause", None)
            write_room(config, room)
        room = wake_room(config, room["id"], {"reason": "Woken from Telegram."})
        return {
            "command": "room",
            "reply": "Woke room.\n" + telegram_room_detail_text(room),
            "room": room_summary(room),
        }
    return {
        "command": "room",
        "reply": telegram_room_detail_text(room),
        "room": room_summary(room),
    }


def telegram_room_new_command(config, chat_id, goal=""):
    draft = telegram_room_draft(config, chat_id)
    draft.setdefault("agents", [])
    draft.setdefault("max_steps", 5)
    write_telegram_room_draft(config, chat_id, draft)
    if str(goal or "").strip():
        return telegram_room_start_command(config, chat_id, goal)
    return {
        "command": "room_draft",
        "reply": telegram_room_draft_text(draft),
    }


def telegram_room_agent_command(config, chat_id, parts):
    draft = telegram_room_draft(config, chat_id)
    args = [str(item or "").strip() for item in (parts or []) if str(item or "").strip()]
    action = args[0].lower() if args else ""
    if action in ("clear", "auto"):
        draft["agents"] = []
    elif action in ("toggle", "pick"):
        values = validate_agent_ids(args[1:])
        current = list(draft.get("agents") or [])
        for item in values:
            if item in current:
                current.remove(item)
            else:
                current.append(item)
        draft["agents"] = current
    elif action in ("add", "+"):
        current = list(draft.get("agents") or [])
        for item in validate_agent_ids(args[1:]):
            if item not in current:
                current.append(item)
        draft["agents"] = current
    else:
        draft["agents"] = validate_agent_ids(args)
    write_telegram_room_draft(config, chat_id, draft)
    return {
        "command": "room_draft",
        "reply": telegram_room_draft_text(draft),
    }


def telegram_room_steps_command(config, chat_id, parts):
    draft = telegram_room_draft(config, chat_id)
    raw = str((parts or [""])[0] if parts else "").strip()
    try:
        steps = int(raw)
    except (TypeError, ValueError):
        return {
            "command": "room_draft",
            "reply": "Usage: /room steps <1-100>\n" + telegram_room_draft_text(draft),
        }
    draft["max_steps"] = max(1, min(steps, 100))
    write_telegram_room_draft(config, chat_id, draft)
    return {
        "command": "room_draft",
        "reply": telegram_room_draft_text(draft),
    }


def telegram_room_start_command(config, chat_id, goal):
    draft = telegram_room_draft(config, chat_id)
    goal = str(goal or "").strip()
    if not goal:
        return {
            "command": "room_draft",
            "reply": telegram_room_draft_text(draft),
        }
    body = {
        "title": telegram_thread_title(goal),
        "goal": goal,
        "source": "telegram",
        "max_steps": int(draft.get("max_steps") or 5),
        "auto_rotate": True,
    }
    agents = validate_agent_ids(draft.get("agents") or [])
    if agents:
        body["agents"] = agents
        body["wakeAgents"] = [agents[0]]
    room = create_room(config, body)
    clear_telegram_room_draft(config, chat_id)
    return {
        "command": "room",
        "reply": "Created room.\n" + telegram_room_detail_text(room),
        "room": room_summary(room),
    }


def telegram_room_detail_text(room):
    summary = room_summary(room)
    agents = ", ".join(summary.get("agents") or []) or "auto"
    steps = f"{summary.get('steps', 0)}/{summary.get('max_steps', 0) or 'unlimited'}"
    lines = [
        "Agent Bus room",
        f"Room: {summary.get('id')}",
        f"Title: {summary.get('title') or 'untitled'}",
        f"Status: {summary.get('status')}",
        f"Agents: {agents}",
        f"Steps: {steps}",
        f"Messages: {summary.get('message_count', 0)}",
        f"Reports: {summary.get('report_count', 0)}",
    ]
    reports = room.get("reports") or []
    if reports:
        latest = trim(str(reports[-1].get("content") or reports[-1].get("summary") or ""))
        if latest:
            lines.extend(["Latest report:", latest[:800]])
    return "\n".join(lines)


def telegram_run_command(config, rest):
    agent_id, _, message = str(rest or "").partition(" ")
    agent_id = agent_id.strip()
    message = message.strip()
    if not agent_id or not message:
        return {"command": "run", "reply": "Usage: /run <agent-id> <task>"}
    thread = create_thread(config, {
        "message": message,
        "agents": [agent_id],
        "mode": "orchestrate",
        "source": "telegram",
    })
    run_ids = [run.get("id") for run in thread.get("runs") or [] if run.get("id")]
    return {
        "command": "run",
        "reply": f"Queued {thread.get('id')} for {agent_id}.\nRuns: {', '.join(run_ids) or 'none'}",
        "thread": {
            "id": thread.get("id"),
            "trace_id": thread.get("trace_id"),
            "runs": run_ids,
        },
    }


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
    if event == "telegram.test":
        return f"Agent Bus Telegram test\n{payload.get('message')}\nGateway: {payload.get('gateway')}"
    if event == "telegram.command":
        return str(payload.get("reply") or "Agent Bus Telegram command completed.")
    return f"Agent Bus event: {event}\n{json.dumps(payload, ensure_ascii=False)}"


def send_telegram_notification(config, token, chat_id, text, reply_markup=None):
    try:
        fields = {
            "chat_id": chat_id,
            "text": text,
            "disable_web_page_preview": "true",
        }
        if reply_markup:
            fields["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)
        data = urlencode(fields).encode("utf-8")
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


def send_telegram_callback_answer(config, token, callback_query_id):
    try:
        data = urlencode({
            "callback_query_id": callback_query_id,
            "text": "Agent Bus command received.",
            "cache_time": "1",
        }).encode("utf-8")
        req = Request(f"https://api.telegram.org/bot{token}/answerCallbackQuery", data=data, method="POST")
        req.add_header("content-type", "application/x-www-form-urlencoded")
        timeout = float(telegram_plugin_config(config).get("timeoutSeconds") or 5)
        with urlopen(req, timeout=max(1, min(timeout, 30))) as response:
            response.read()
        append_jsonl(config, "notifications.jsonl", {
            "at": now(),
            "plugin": "telegramBot",
            "event": "telegram.callback_answer.completed",
            "status": "completed",
        })
    except Exception as exc:
        append_jsonl(config, "notifications.jsonl", {
            "at": now(),
            "plugin": "telegramBot",
            "event": "telegram.callback_answer.failed",
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
