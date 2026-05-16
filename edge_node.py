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
import threading
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
    config["pollRequestGraceMs"] = int(config.get("pollRequestGraceMs", 5000))
    config["requestTimeoutMs"] = int(config.get("requestTimeoutMs", 60000))
    config["idleDelayMs"] = int(config.get("idleDelayMs", 1000))
    config["defaultTimeoutMs"] = int(config.get("defaultTimeoutMs", 600000))
    config["healthProbeIntervalMs"] = int(config.get("healthProbeIntervalMs", 60000))
    config["healthProbeTimeoutMs"] = int(config.get("healthProbeTimeoutMs", 5000))
    config["runHeartbeatIntervalMs"] = int(config.get("runHeartbeatIntervalMs", 30000))
    config["completeRetryAttempts"] = int(config.get("completeRetryAttempts", 5))
    config["completeRetryBaseDelayMs"] = int(config.get("completeRetryBaseDelayMs", 2000))
    config["dataDir"] = resolve_config_path(os.environ.get("AGENT_BUS_DATA_DIR") or config.get("dataDir") or ".agent-bus", path.parent)
    config["completionOutboxDir"] = resolve_config_path(
        os.environ.get("AGENT_BUS_COMPLETION_OUTBOX_DIR") or config.get("completionOutboxDir") or str(Path(config["dataDir"]) / "edge-completions"),
        path.parent,
    )
    config.setdefault("agents", [])
    config["edgeSessionId"] = os.environ.get("AGENT_BUS_EDGE_SESSION_ID") or f"edge_session_{int(time.time() * 1000):x}_{uuid.uuid4()}"
    config["_agentHealth"] = {}
    config["_nextHealthProbeAt"] = 0
    return config


def resolve_config_path(value, base_dir):
    path = Path(str(value or "")).expanduser()
    if not path.is_absolute():
        path = Path(base_dir) / path
    return str(path)


def public_agents(config):
    heartbeat_interval_ms = int(config.get("runHeartbeatIntervalMs", 0) or 0)
    return [{
        "id": agent["id"],
        "kind": agent.get("kind", "agent"),
        "role": agent.get("role", "worker"),
        "enabled": agent.get("enabled", True) is not False,
        "adapter": agent.get("adapter", "command"),
        "capabilities": agent.get("capabilities") or [],
        **agent_observation_fields(agent),
        **({"run_heartbeat_interval_ms": heartbeat_interval_ms} if heartbeat_interval_ms > 0 else {}),
        "health": agent_health(config, agent),
    } for agent in config["agents"] if agent.get("enabled", True) is not False]


def agent_observation_fields(agent):
    out = {}
    for snake, camel in [
        ("owner", "owner"),
        ("runtime", "runtime"),
        ("permission_profile", "permissionProfile"),
        ("cost_class", "costClass"),
        ("latency_class", "latencyClass"),
    ]:
        value = optional_text(agent.get(snake) if agent.get(snake) is not None else agent.get(camel))
        if value:
            out[snake] = value
    for snake, camel in [
        ("allowed_rooms", "allowedRooms"),
        ("allowed_wake_targets", "allowedWakeTargets"),
    ]:
        if not has_observation_field(agent, snake, camel):
            continue
        out[snake] = optional_string_list(agent.get(snake) if agent.get(snake) is not None else agent.get(camel))
    return out


def has_observation_field(agent, snake, camel):
    return isinstance(agent, dict) and (snake in agent or camel in agent)


def optional_text(value):
    text = str(value or "").strip()
    return text[:160] if text else ""


def optional_string_list(value):
    if isinstance(value, list):
        raw = value
    elif isinstance(value, str):
        raw = value.split(",")
    else:
        raw = []
    out = []
    for item in raw:
        text = optional_text(item)
        if text and text not in out:
            out.append(text)
        if len(out) >= 64:
            break
    return out


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
            drain_pending_completions(config)
            refresh_agent_health(config)
            payload = post(config, "/edge/poll", {
                "node_id": config["nodeId"],
                "edge_session_id": config["edgeSessionId"],
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
        "edge_session_id": config["edgeSessionId"],
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
    stop_heartbeat = start_run_heartbeat(config, task, agent)
    try:
        result = run_agent(config, agent, task)
    except Exception as exc:
        result = {"status": "error", "exit_code": 1, "stdout": "", "stderr": repr(exc)}
    finally:
        stop_heartbeat()
    result["duration_ms"] = int((time.time() - started) * 1000)
    record_run_health(config, agent, result)
    complete(config, task, result)


def start_run_heartbeat(config, task, agent):
    interval_ms = int(config.get("runHeartbeatIntervalMs", 0) or 0)
    if interval_ms <= 0:
        return lambda: None
    stopped = threading.Event()
    interval_seconds = max(interval_ms, 1000) / 1000

    def pump():
        while not stopped.wait(interval_seconds):
            try:
                event(config, task, {"type": "run.heartbeat", "agent_id": agent["id"]})
            except Exception:
                # Heartbeats are best-effort; the terminal completion path remains authoritative.
                pass

    thread = threading.Thread(target=pump, daemon=True)
    thread.start()

    def stop():
        stopped.set()
        thread.join(timeout=1)

    return stop


def run_agent(config, agent, task):
    if agent.get("adapter") == "echo":
        stdout = f"[{agent['id']}] {task.get('message', '')}\n"
        emit_event(config, task, {"type": "run.output", "stream": "stdout", "text": stdout})
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
    wake_reason = str(task.get("wake_reason") or "")
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
        "AGENT_WAKE_REASON": wake_reason,
        "AGENT_CACHE_SCOPE": cache_scope,
        "AGENT_CACHE_KEY": cache_key,
        "AGENT_SESSION_ID": cache_key,
        "AGENT_ID": agent["id"],
        "EDGE_NODE_ID": config["nodeId"],
        "EDGE_SESSION_ID": config["edgeSessionId"],
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
            universal_newlines=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=(int(agent.get("timeoutMs", config["defaultTimeoutMs"])) / 1000))
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            stderr = (stderr or "") + f"\nTimed out after {agent.get('timeoutMs', config['defaultTimeoutMs'])}ms"
            return {"status": "failed", "exit_code": 124, "stdout": stdout or "", "stderr": stderr.strip()}
        if emit and stdout:
            emit_event(config, task, {"type": "run.output", "stream": "stdout", "text": stdout})
        if emit and stderr:
            emit_event(config, task, {"type": "run.output", "stream": "stderr", "text": stderr})
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
    return post(config, "/edge/events", {"node_id": config["nodeId"], "edge_session_id": config["edgeSessionId"], "run_id": task["run_id"], "trace_id": task.get("trace_id", ""), "event": payload})


def emit_event(config, task, payload):
    try:
        event(config, task, payload)
    except Exception as exc:
        if config.get("debugEvents"):
            print(f"edge-node: failed to emit {payload.get('type', 'event')} for run {task.get('run_id')}: {exc}", file=sys.stderr, flush=True)


def complete(config, task, result):
    body = {"node_id": config["nodeId"], "edge_session_id": config["edgeSessionId"], "run_id": task["run_id"], "trace_id": task.get("trace_id", ""), "result": result}
    pending_file, _pending_record = write_pending_completion(config, body)
    response = submit_completion_with_retry(config, body)
    delete_pending_completion(pending_file)
    return response


def submit_completion_with_retry(config, body):
    attempts = max(1, int(config.get("completeRetryAttempts", 5) or 5))
    base_delay = max(100, int(config.get("completeRetryBaseDelayMs", 2000) or 2000))
    last_exc = None
    for attempt in range(1, attempts + 1):
        try:
            return post(config, "/edge/complete", body)
        except AgentBusHttpError as exc:
            if exc.status_code < 500 and not is_registration_lost(exc):
                raise
            last_exc = exc
        except Exception as exc:
            last_exc = exc
        if attempt == attempts:
            raise last_exc
        delay = min(30.0, (base_delay / 1000) * (2 ** min(attempt - 1, 5)))
        print(f"edge-node: /edge/complete attempt {attempt} failed ({last_exc}); retrying in {delay:.1f}s", file=sys.stderr, flush=True)
        time.sleep(delay + random.random() * min(1.0, delay / 2))


def drain_pending_completions(config):
    files = list_pending_completion_files(config)
    if not files:
        return
    print(f"edge-node: replaying {len(files)} pending completion{'s' if len(files) != 1 else ''}", flush=True)
    for file_path in files:
        try:
            record = json.loads(file_path.read_text(encoding="utf-8"))
        except Exception as exc:
            move_pending_completion_to_failed(config, file_path, exc, corrupt=True)
            continue
        body = record.get("body") if isinstance(record, dict) and isinstance(record.get("body"), dict) else record
        if not isinstance(body, dict) or not body.get("run_id") or not body.get("result"):
            move_pending_completion_to_failed(config, file_path, RuntimeError("pending completion is missing run_id or result"), corrupt=True)
            continue
        try:
            touch_pending_completion(file_path, record, "")
            submit_completion_with_retry(config, body)
            delete_pending_completion(file_path)
            print(f"edge-node: replayed pending completion for run {body.get('run_id')}", flush=True)
        except AgentBusHttpError as exc:
            touch_pending_completion(file_path, record, str(exc))
            if exc.status_code not in (401, 403) and exc.status_code < 500 and not is_registration_lost(exc):
                move_pending_completion_to_failed(config, file_path, exc)
                continue
            raise
        except Exception as exc:
            touch_pending_completion(file_path, record, str(exc))
            raise


def write_pending_completion(config, body):
    outbox = completion_outbox_dir(config)
    outbox.mkdir(parents=True, exist_ok=True)
    file_path = outbox / f"{safe_file_name(body.get('run_id'))}.json"
    record = {
        "object": "agent_bus.edge_completion",
        "version": 1,
        "node_id": body.get("node_id"),
        "run_id": body.get("run_id"),
        "trace_id": body.get("trace_id") or "",
        "created_at": iso_now(),
        "attempts": 0,
        "body": body,
    }
    write_json_atomic(file_path, record)
    return file_path, record


def touch_pending_completion(file_path, record, last_error):
    next_record = dict(record) if isinstance(record, dict) else {}
    next_record["attempts"] = int(next_record.get("attempts") or 0) + 1
    next_record["last_attempt_at"] = iso_now()
    if last_error:
        next_record["last_error"] = last_error
    write_json_atomic(file_path, next_record)


def list_pending_completion_files(config):
    outbox = completion_outbox_dir(config)
    if not outbox.exists():
        return []
    return sorted(
        [item for item in outbox.iterdir() if item.is_file() and item.suffix == ".json"],
        key=lambda item: item.stat().st_mtime,
    )


def delete_pending_completion(file_path):
    try:
        path = Path(file_path)
        if path.exists():
            path.unlink()
    except Exception:
        pass


def move_pending_completion_to_failed(config, file_path, exc, corrupt=False):
    failed_dir = completion_outbox_dir(config) / "failed"
    failed_dir.mkdir(parents=True, exist_ok=True)
    target = failed_dir / f"{Path(file_path).stem}.{int(time.time() * 1000)}.json"
    try:
        record = json.loads(Path(file_path).read_text(encoding="utf-8")) if Path(file_path).exists() else {}
        if not isinstance(record, dict):
            record = {}
        record["failed_at"] = iso_now()
        record["failed_reason"] = "corrupt_pending_completion" if corrupt else "permanent_completion_error"
        record["last_error"] = str(exc)
        write_json_atomic(target, record)
        if Path(file_path).exists():
            Path(file_path).unlink()
    except Exception:
        try:
            Path(file_path).replace(target)
        except Exception:
            pass
    print(f"edge-node: moved pending completion {Path(file_path).name} to failed outbox: {exc}", file=sys.stderr, flush=True)


def completion_outbox_dir(config):
    return Path(config.get("completionOutboxDir") or (Path(config.get("dataDir") or ".agent-bus") / "edge-completions")).expanduser().resolve()


def write_json_atomic(file_path, value):
    file_path = Path(file_path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = file_path.with_name(f"{file_path.name}.{os.getpid()}.{int(time.time() * 1000)}.tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(file_path)


def safe_file_name(value):
    text = "".join(char if char.isalnum() or char in "._-" else "_" for char in str(value or "unknown"))
    return (text[:180] or "unknown")


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def post(config, pathname, body):
    data = json.dumps(body).encode("utf-8")
    req = Request(endpoint(config["gatewayUrl"], pathname), data=data, method="POST")
    req.add_header("content-type", "application/json")
    if config.get("token"):
        req.add_header("authorization", "Bearer " + config["token"])
    try:
        with urlopen(req, timeout=post_timeout_seconds(config, pathname, body)) as res:
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


def post_timeout_seconds(config, pathname, body):
    if pathname == "/edge/poll":
        timeout_ms = int(body.get("timeout_ms") or config.get("pollTimeoutMs", 25000)) + int(config.get("pollRequestGraceMs", 5000))
    else:
        timeout_ms = int(config.get("requestTimeoutMs", 60000))
    return bounded_seconds(timeout_ms, 1000, 10 * 60 * 1000, 60000)


def bounded_seconds(value_ms, minimum_ms, maximum_ms, fallback_ms):
    try:
        numeric = int(value_ms)
    except (TypeError, ValueError):
        numeric = fallback_ms
    if numeric <= 0:
        numeric = fallback_ms
    return min(max(numeric, minimum_ms), maximum_ms) / 1000


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
