#!/usr/bin/env python3
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import Request, urlopen


def main():
    args = sys.argv[1:]
    command = args[0] if args and not args[0].startswith("--") else "connect"
    config = load_config(option(args, "--config") or "edge.config.json")
    if command == "agents":
        print(json.dumps(public_agents(config), ensure_ascii=False, indent=2))
        return
    if command == "health":
        results = [run_health(config, agent) for agent in public_agents(config)]
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
    config.setdefault("agents", [])
    return config


def public_agents(config):
    return [{
        "id": agent["id"],
        "kind": agent.get("kind", "agent"),
        "role": agent.get("role", "worker"),
        "enabled": agent.get("enabled", True) is not False,
        "adapter": agent.get("adapter", "command"),
        "capabilities": agent.get("capabilities") or [],
    } for agent in config["agents"] if agent.get("enabled", True) is not False]


def connect(config, once=False):
    post(config, "/edge/register", {
        "node_id": config["nodeId"],
        "hostname": socket.gethostname(),
        "version": "0.1.0-py",
        "agents": public_agents(config),
    })
    print(f"edge-node.py {config['nodeId']} connected to {config['gatewayUrl']}", flush=True)
    while True:
        payload = post(config, "/edge/poll", {"node_id": config["nodeId"], "timeout_ms": config["pollTimeoutMs"]})
        if payload.get("type") == "task":
            handle_task(config, payload["task"])
            if once:
                return
            continue
        if once:
            return
        time.sleep(config["idleDelayMs"] / 1000)


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
    if agent.get("adapter") == "echo":
        return {"agent_id": agent["id"], "status": "completed", "exit_code": 0, "stdout": "echo adapter ok\n", "stderr": ""}
    command = next((item.get("healthCommand") for item in config["agents"] if item.get("id") == agent["id"]), None)
    if not command:
        return {"agent_id": agent["id"], "status": "unknown", "exit_code": None, "stdout": "", "stderr": "No healthCommand configured"}
    task = {"run_id": "local_" + str(uuid.uuid4()), "message": ""}
    result = run_command(config, agent, task, command, emit=False)
    return {"agent_id": agent["id"], **result}


def run_command(config, agent, task, command, emit=True):
    env = os.environ.copy()
    env.update({
        "AGENT_MESSAGE": task.get("message", ""),
        "AGENT_RUN_ID": task.get("run_id", ""),
        "AGENT_ID": agent["id"],
        "EDGE_NODE_ID": config["nodeId"],
    })
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


def event(config, task, payload):
    return post(config, "/edge/events", {"node_id": config["nodeId"], "run_id": task["run_id"], "event": payload})


def complete(config, task, result):
    return post(config, "/edge/complete", {"node_id": config["nodeId"], "run_id": task["run_id"], "result": result})


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
        raise RuntimeError(raw or f"HTTP {exc.code}") from exc


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
