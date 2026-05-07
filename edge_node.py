#!/usr/bin/env python3
import json
import hashlib
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse, urlunparse
from urllib.request import Request, urlopen


def main():
    args = sys.argv[1:]
    command = args[0] if args and not args[0].startswith("--") else "connect"
    config = load_config(option(args, "--config") or "edge.config.json")
    if command == "agents":
        print(json.dumps(public_agents(config), ensure_ascii=False, indent=2))
        return
    if command == "health":
        results = [run_health(config, agent) for agent in config["agents"] if agent.get("enabled", True) is not False]
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return
    if command == "connect":
        connect(config, once="--once" in args)
        return
    raise SystemExit(f"Unknown command: {command}")


def load_config(config_path):
    path = Path(config_path)
    if not path.exists():
        raise SystemExit(f"Missing config: {path}")
    config = json.loads(path.read_text(encoding="utf-8"))
    config["nodeId"] = os.environ.get("AGENT_BUS_NODE_ID", config.get("nodeId") or socket.gethostname())
    config["gatewayUrl"] = os.environ.get("AGENT_BUS_GATEWAY_URL", config.get("gatewayUrl", "http://127.0.0.1:8788"))
    config["token"] = os.environ.get("AGENT_BUS_TOKEN", config.get("token", ""))
    config["pollTimeoutMs"] = int(config.get("pollTimeoutMs", 25000))
    config["idleDelayMs"] = int(config.get("idleDelayMs", 1000))
    config["defaultTimeoutMs"] = int(config.get("defaultTimeoutMs", 600000))
    config["healthProbeIntervalMs"] = int(config.get("healthProbeIntervalMs", 60000))
    config["healthProbeTimeoutMs"] = int(config.get("healthProbeTimeoutMs", 5000))
    config.setdefault("agents", [])
    config["_agentHealth"] = {}
    config["_nextHealthProbeAt"] = 0
    return config


def public_agents(config):
    return [{
        "id": agent["id"],
        "kind": agent.get("kind", "agent"),
        "role": agent.get("role", "worker"),
        "enabled": agent.get("enabled", True) is not False,
        "adapter": agent.get("adapter", "command"),
        "capabilities": agent.get("capabilities") or [],
        "health": agent_health(config, agent),
    } for agent in config["agents"] if agent.get("enabled", True) is not False]


def agent_health(config, agent):
    cached = config.get("_agentHealth", {}).get(agent["id"])
    if cached:
        return cached
    ping_url = agent_ping_url(agent)
    health = {
        "kind": "url" if ping_url else "none",
        "ping_status": "unknown" if ping_url else "not_configured",
        "checked_at": None,
    }
    if ping_url:
        health["ping_target"] = safe_url_for_status(ping_url)
    return health


def connect(config, once=False):
    registered = False
    failures = 0
    while True:
        try:
            if not registered:
                register(config)
                registered = True
                failures = 0
                print(f"edge-node.py {config['nodeId']} connected to {config['gatewayUrl']}", flush=True)
            refresh_agent_health(config)
            payload = post(config, "/edge/poll", {
                "node_id": config["nodeId"],
                "timeout_ms": config["pollTimeoutMs"],
                "agents": public_agents(config),
            })
            failures = 0
            if payload.get("type") == "task":
                handle_task(config, payload["task"])
                if once:
                    return
                continue
            if once:
                return
            time.sleep(config["idleDelayMs"] / 1000)
        except AgentBusHttpError as exc:
            if exc.status_code in (401, 403) or (400 <= exc.status_code < 500 and not is_registration_lost(exc)):
                raise
            if is_registration_lost(exc):
                registered = False
            failures += 1
            wait = reconnect_delay(config, failures)
            print(f"edge-node.py {config['nodeId']} transient error: {exc}; retrying in {wait:.1f}s", file=sys.stderr, flush=True)
            if once:
                raise
            time.sleep(wait)
        except (URLError, TimeoutError, OSError) as exc:
            failures += 1
            wait = reconnect_delay(config, failures)
            print(f"edge-node.py {config['nodeId']} transient error: {exc}; retrying in {wait:.1f}s", file=sys.stderr, flush=True)
            if once:
                raise
            time.sleep(wait)


def register(config):
    refresh_agent_health(config, force=True)
    return post(config, "/edge/register", {
        "node_id": config["nodeId"],
        "hostname": socket.gethostname(),
        "version": "0.1.0-py",
        "agents": public_agents(config),
    })


def handle_task(config, task):
    agent = next((item for item in config["agents"] if item.get("id") == task.get("agent_id") and item.get("enabled", True) is not False), None)
    if not agent:
        complete(config, task, {"status": "failed", "exit_code": 127, "stdout": "", "stderr": f"Agent not found: {task.get('agent_id')}"})
        return
    event(config, task, {"type": "run.started", "agent_id": agent["id"]})
    started = time.time()
    try:
        result = run_agent(config, agent, task)
    except Exception as exc:
        result = {"status": "error", "exit_code": 1, "stdout": "", "stderr": repr(exc)}
    result["duration_ms"] = int((time.time() - started) * 1000)
    record_run_health(config, agent, result)
    complete(config, task, result)


def run_agent(config, agent, task):
    if agent.get("adapter") == "echo":
        stdout = f"[{agent['id']}] {task.get('message', '')}\n"
        event(config, task, {"type": "run.output", "stream": "stdout", "text": stdout})
        return {"status": "completed", "exit_code": 0, "stdout": stdout, "stderr": "", "summary": stdout.strip()}
    command = agent.get("runCommand")
    if not command:
        return {"status": "failed", "exit_code": 126, "stdout": "", "stderr": f"Missing runCommand for {agent['id']}"}
    return run_command(config, agent, task, command, emit=True)


def run_health(config, agent):
    ping_url = agent_ping_url(agent)
    if ping_url:
        return {"agent_id": agent["id"], **probe_ping_url(config, agent, ping_url)}
    if agent.get("adapter") == "echo":
        return {"agent_id": agent["id"], "status": "completed", "exit_code": 0, "stdout": "echo adapter ok\n", "stderr": ""}
    command = next((item.get("healthCommand") for item in config["agents"] if item.get("id") == agent["id"]), None)
    if not command:
        return {"agent_id": agent["id"], "status": "unknown", "exit_code": None, "stdout": "", "stderr": "No healthCommand configured"}
    task = {"run_id": "local_" + str(uuid.uuid4()), "message": ""}
    result = run_command(config, agent, task, command, emit=False)
    return {"agent_id": agent["id"], **result}


def refresh_agent_health(config, force=False):
    current = time.time() * 1000
    if not force and current < float(config.get("_nextHealthProbeAt", 0)):
        return
    config["_nextHealthProbeAt"] = current + int(config.get("healthProbeIntervalMs", 60000))
    for agent in config["agents"]:
        if agent.get("enabled", True) is False:
            continue
        health = probe_agent(config, agent)
        config["_agentHealth"][agent["id"]] = {**config["_agentHealth"].get(agent["id"], {}), **health}


def probe_agent(config, agent):
    ping_url = agent_ping_url(agent)
    if not ping_url:
        return agent_health(config, agent)
    return probe_ping_url(config, agent, ping_url)


def probe_ping_url(config, agent, ping_url):
    started = time.time()
    timeout = (int(agent.get("healthProbeTimeoutMs", config.get("healthProbeTimeoutMs", 5000))) / 1000)
    try:
        status_code = request_status(ping_url, "HEAD", timeout)
        return ping_health("HEAD", status_code, started, ping_url)
    except HTTPError as exc:
        if exc.code == 405:
            try:
                status_code = request_status(ping_url, "GET", timeout)
                return ping_health("GET", status_code, started, ping_url)
            except HTTPError as get_exc:
                return ping_health("GET", get_exc.code, started, ping_url)
            except Exception as get_exc:
                return ping_failure(get_exc, started, ping_url)
        return ping_health("HEAD", exc.code, started, ping_url)
    except Exception as exc:
        return ping_failure(exc, started, ping_url)


def request_status(url, method, timeout):
    req = Request(url, method=method)
    with urlopen(req, timeout=timeout) as res:
        return res.status


def ping_health(method, status_code, started, ping_url):
    return {
        "kind": "url",
        "ping_status": "unhealthy" if status_code >= 500 else "reachable",
        "http_status": status_code,
        "method": method,
        "latency_ms": int((time.time() - started) * 1000),
        "checked_at": now_iso(),
        "ping_target": safe_url_for_status(ping_url),
    }


def ping_failure(exc, started, ping_url):
    return {
        "kind": "url",
        "ping_status": "unreachable",
        "latency_ms": int((time.time() - started) * 1000),
        "checked_at": now_iso(),
        "ping_target": safe_url_for_status(ping_url),
        "error": str(exc)[:500],
    }


def agent_ping_url(agent):
    return agent.get("pingUrl") or agent.get("healthUrl") or agent.get("modelUrl") or ""


def safe_url_for_status(raw_url):
    try:
        parsed = urlparse(raw_url)
        host = parsed.hostname or ""
        if parsed.port:
            host = f"{host}:{parsed.port}"
        return urlunparse((parsed.scheme, host, parsed.path or "/", "", "", ""))
    except Exception:
        return ""


def record_run_health(config, agent, result):
    now_text = now_iso()
    health = {
        "last_run_status": result.get("status"),
        "last_run_at": now_text,
    }
    if result.get("status") == "completed":
        health["last_success_at"] = now_text
    else:
        health["last_error_at"] = now_text
        health["last_error"] = str(result.get("stderr") or result.get("summary") or "run failed")[:2000]
    config["_agentHealth"][agent["id"]] = {**config["_agentHealth"].get(agent["id"], {}), **health}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


MAX_ENV_MESSAGE_BYTES = 24 * 1024


def agent_runtime_env(config, agent, task, message_file=""):
    thread_id = str(task.get("thread_id") or "")
    room_id = str(task.get("room_id") or "")
    trace_id = str(task.get("trace_id") or "")
    cache_scope = str(task.get("cache_scope") or "")
    message = str(task.get("message", ""))
    cache_key = agent_cache_key(agent, task, cache_scope or room_id or thread_id or task.get("run_id") or "")
    return {
        "AGENT_MESSAGE": env_safe_message(message),
        "AGENT_MESSAGE_FILE": message_file,
        "AGENT_MESSAGE_BYTES": str(len(message.encode("utf-8"))),
        "AGENT_RUN_ID": task.get("run_id", ""),
        "AGENT_THREAD_ID": thread_id,
        "AGENT_ROOM_ID": room_id,
        "AGENT_TRACE_ID": trace_id,
        "AGENT_CACHE_SCOPE": cache_scope,
        "AGENT_CACHE_KEY": cache_key,
        "AGENT_SESSION_ID": cache_key,
        "AGENT_ID": agent["id"],
        "EDGE_NODE_ID": config["nodeId"],
    }


def env_safe_message(message):
    return message if len(message.encode("utf-8")) <= MAX_ENV_MESSAGE_BYTES else ""


def write_task_message_file(message):
    temp_dir = tempfile.mkdtemp(prefix="agent-bus-msg-")
    file_path = os.path.join(temp_dir, "message.txt")
    with open(file_path, "w", encoding="utf-8") as handle:
        handle.write(message)
    return temp_dir, file_path


def agent_cache_key(agent, task, scope_id):
    agent_part = sanitize_cache_key_part(agent.get("id") or task.get("agent_id") or "agent")
    scope_part = compact_cache_scope(scope_id or task.get("run_id") or "local")
    return bounded_cache_key(f"agent-bus-{agent_part}-{scope_part}")


def compact_cache_scope(value):
    raw = str(value or "")
    cleaned = sanitize_cache_key_part(raw)
    lowered = cleaned.lower()
    if len(cleaned) <= 32 and not lowered.startswith(("room_", "room-", "room.", "thread_", "thread-", "thread.", "run_", "run-", "run.")):
        return cleaned
    if lowered.startswith(("room_", "room-", "room.")):
        prefix = "room"
    elif lowered.startswith(("thread_", "thread-", "thread.")):
        prefix = "thread"
    elif lowered.startswith(("run_", "run-", "run.")):
        prefix = "run"
    else:
        prefix = "scope"
    digest = hashlib.sha256((raw or cleaned).encode("utf-8")).hexdigest()[:16]
    return f"{prefix}-{digest}"


def sanitize_cache_key_part(value):
    cleaned = "".join(char if char.isalnum() or char in "._-" else "-" for char in str(value or "").strip())
    while "--" in cleaned:
        cleaned = cleaned.replace("--", "-")
    cleaned = cleaned.strip("-")
    return cleaned or "unknown"


def bounded_cache_key(value):
    text = str(value or "agent-bus-unknown")
    if len(text) <= 180:
        return text
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    return f"{text[:167]}-{digest}"


def run_command(config, agent, task, command, emit=True):
    message_dir, message_file = write_task_message_file(str(task.get("message", "")))
    env = os.environ.copy()
    try:
        env.update(agent_runtime_env(config, agent, task, message_file))
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=agent.get("cwd") or config.get("cwd") or os.getcwd(),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=(int(agent.get("timeoutMs", config["defaultTimeoutMs"])) / 1000))
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            stderr = (stderr or "") + f"\nTimed out after {agent.get('timeoutMs', config['defaultTimeoutMs'])}ms"
            return {"status": "failed", "exit_code": 124, "stdout": stdout or "", "stderr": stderr.strip()}
        if emit and stdout:
            event(config, task, {"type": "run.output", "stream": "stdout", "text": stdout})
        if emit and stderr:
            event(config, task, {"type": "run.output", "stream": "stderr", "text": stderr})
        return {
            "status": "completed" if proc.returncode == 0 else "failed",
            "exit_code": proc.returncode,
            "stdout": stdout or "",
            "stderr": stderr or "",
            "summary": (stdout or "").strip()[:2000],
        }
    finally:
        shutil.rmtree(message_dir, ignore_errors=True)


def event(config, task, payload):
    return post(config, "/edge/events", {"node_id": config["nodeId"], "run_id": task["run_id"], "trace_id": task.get("trace_id", ""), "event": payload})


def complete(config, task, result):
    return post(config, "/edge/complete", {"node_id": config["nodeId"], "run_id": task["run_id"], "trace_id": task.get("trace_id", ""), "result": result})


def post(config, pathname, body):
    data = json.dumps(body).encode("utf-8")
    req = Request(endpoint(config["gatewayUrl"], pathname), data=data, method="POST")
    req.add_header("content-type", "application/json")
    if config.get("token"):
        req.add_header("authorization", "Bearer " + config["token"])
    try:
        with urlopen(req, timeout=max(10, (config.get("pollTimeoutMs", 25000) / 1000) + 10)) as res:
            raw = res.read().decode("utf-8")
            return json.loads(raw) if raw.strip() else {}
    except HTTPError as exc:
        raw = exc.read().decode("utf-8")
        message = raw or f"HTTP {exc.code}"
        try:
            parsed = json.loads(raw)
            message = parsed.get("error") or parsed.get("message") or message
        except Exception:
            pass
        raise AgentBusHttpError(exc.code, message) from exc


class AgentBusHttpError(RuntimeError):
    def __init__(self, status_code, message):
        super().__init__(message)
        self.status_code = status_code


def is_registration_lost(exc):
    return exc.status_code == 404 and "unknown node_id" in str(exc).lower()


def reconnect_delay(config, failures):
    base = float(config.get("reconnectBaseDelayMs", 1000)) / 1000
    max_delay = float(config.get("reconnectMaxDelayMs", 30000)) / 1000
    delay = min(max_delay, base * (2 ** min(max(failures - 1, 0), 5)))
    return delay + random.random() * min(1.0, delay / 2)


def endpoint(gateway_url, pathname):
    parsed = urlparse(gateway_url)
    prefix = parsed.path.rstrip("/")
    return urlunparse(parsed._replace(path=(prefix + pathname).replace("//", "/")))


def option(args, name):
    if name not in args:
        return None
    index = args.index(name)
    return args[index + 1] if index + 1 < len(args) else None


if __name__ == "__main__":
    main()
