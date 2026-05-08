"""Small standard-library Python client for Agent Bus."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any


class AgentBusError(Exception):
    def __init__(self, message: str, *, status: int = 0, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


ROOM_EVENT_TYPES = {
    "room.created",
    "room.message.added",
    "room.blackboard.updated",
    "room.report.added",
    "room.status.changed",
    "run.queued",
    "run.started",
    "run.output",
    "run.completed",
    "run.failed",
    "agent.registered",
    "agent.health.updated",
    "wake.requested",
    "wake.dispatched",
    "wake.cancelled",
    "policy.denied",
}


@dataclass
class AgentBusClient:
    gateway_url: str | None = None
    token: str | None = None
    timeout: float = 30.0

    def __post_init__(self) -> None:
        self.gateway_url = _normalize_gateway_url(
            self.gateway_url or os.environ.get("AGENT_BUS_GATEWAY_URL") or "http://127.0.0.1:8788"
        )
        self.token = self.token if self.token is not None else os.environ.get("AGENT_BUS_TOKEN", "")

    def health(self) -> Any:
        return self.request("/health", auth=False)

    def well_known(self) -> Any:
        return self.request("/.well-known/agent-bus.json", auth=False)

    def manifest(self) -> Any:
        return self.request("/v1/agent-bus/manifest")

    def agents(self) -> Any:
        return self.request("/agents")

    def nodes(self) -> Any:
        return self.request("/nodes")

    def rooms(self) -> Any:
        return self.request("/rooms")

    def room(self, room_id: str) -> Any:
        return self.request(f"/rooms/{_path_part(room_id)}")

    def create_room(self, body: dict[str, Any]) -> Any:
        return self.request("/rooms", method="POST", body=body)

    def wake_room(self, room_id: str, body: dict[str, Any] | None = None) -> Any:
        return self.request(f"/rooms/{_path_part(room_id)}/wake", method="POST", body=body or {})

    def message_room(self, room_id: str, body: dict[str, Any] | None = None) -> Any:
        return self.request(f"/rooms/{_path_part(room_id)}/messages", method="POST", body=body or {})

    def models(self) -> Any:
        return self.request("/v1/models")

    def chat_completion(self, body: dict[str, Any]) -> Any:
        return self.request("/v1/chat/completions", method="POST", body=body)

    def response(self, body: dict[str, Any]) -> Any:
        return self.request("/v1/responses", method="POST", body=body)

    def agent_chat(self, agent_id: str, messages: list[Any], **options: Any) -> Any:
        return self.chat_completion({"model": agent_model(agent_id), "messages": messages, **options})

    def agent_response(self, agent_id: str, input_value: Any, **options: Any) -> Any:
        return self.response({"model": agent_model(agent_id), "input": input_value, **options})

    def export_room_events(self, room_id: str, *, reports_only: bool = False) -> dict[str, Any]:
        return room_event_bundle(self.room(room_id), reports_only=reports_only)

    def request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any = None,
        auth: bool = True,
        headers: dict[str, str] | None = None,
    ) -> Any:
        request_headers = {"accept": "application/json", **(headers or {})}
        if auth:
            if not self.token:
                raise AgentBusError("Agent Bus token is required for this request.")
            request_headers["authorization"] = f"Bearer {self.token}"
        data = None
        if body is not None:
            request_headers.setdefault("content-type", "application/json")
            data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            _join_url(self.gateway_url or "", path),
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return _parse_body(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode("utf-8", errors="replace")
            parsed = _parse_body(payload)
            message = parsed.get("error", parsed) if isinstance(parsed, dict) else payload
            raise AgentBusError(f"Agent Bus request failed: {exc.code} {exc.reason}: {message}", status=exc.code, body=parsed) from exc


def agent_model(agent_id: str) -> str:
    text = str(agent_id or "").strip()
    if not text:
        raise AgentBusError("agent_model requires an agent id.")
    return text if text.startswith("agent:") else f"agent:{text}"


def room_event_bundle(room: dict[str, Any], *, reports_only: bool = False) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    room_id = room.get("id", "")

    def add(event_type: str, at: str | None, actor: str, payload: dict[str, Any] | None = None, **extra: Any) -> None:
        events.append({
            "type": event_type,
            "at": at or room.get("updated_at") or room.get("created_at") or "1970-01-01T00:00:00.000Z",
            "actor": actor or "system",
            "room_id": room_id,
            **extra,
            "payload": payload or {},
        })

    add("room.created", room.get("created_at"), "system", {
        "title": room.get("title", ""),
        "goal": room.get("goal", ""),
        "status": room.get("status", "unknown"),
        "agents": room.get("agents") or [],
    })
    if not reports_only:
        for index, message in enumerate(room.get("messages") or []):
            add("room.message.added", message.get("at"), message.get("speaker") or message.get("role") or "unknown", {
                "index": index,
                "role": message.get("role", ""),
                "speaker": message.get("speaker", ""),
                "content": message.get("content", ""),
            })
    for run in room.get("runs") or []:
        add("run.queued", run.get("created_at"), run.get("agent_id") or "system", {
            "agent_id": run.get("agent_id", ""),
            "node_id": run.get("node_id", ""),
            "kind": run.get("kind", ""),
            "role": run.get("role", ""),
        }, run_id=run.get("id", ""))
        if run.get("started_at"):
            add("run.started", run.get("started_at"), run.get("agent_id") or "system", {
                "agent_id": run.get("agent_id", ""),
                "node_id": run.get("node_id", ""),
            }, run_id=run.get("id", ""))
        if not reports_only:
            for index, event in enumerate(run.get("events") or []):
                if not event.get("text") and not event.get("stream"):
                    continue
                add("run.output", event.get("at") or run.get("started_at") or run.get("created_at"), run.get("agent_id") or "system", {
                    "index": index,
                    "stream": event.get("stream", ""),
                    "text": event.get("text", ""),
                }, run_id=run.get("id", ""))
        if _terminal_run(run.get("status")):
            add("run.completed" if run.get("status") == "completed" else "run.failed", run.get("completed_at") or room.get("updated_at"), run.get("agent_id") or "system", {
                "agent_id": run.get("agent_id", ""),
                "status": run.get("status", "unknown"),
                "exit_code": run.get("exit_code"),
                "stdout_bytes": len(str(run.get("stdout", "")).encode("utf-8")),
                "stderr_bytes": len(str(run.get("stderr", "")).encode("utf-8")),
            }, run_id=run.get("id", ""))
    for index, report in enumerate(room.get("reports") or room.get("blackboard", {}).get("reports") or []):
        add("room.report.added", report.get("at"), report.get("speaker") or report.get("agent_id") or "unknown", {
            "index": index,
            "content": report.get("content", ""),
        })
    for index, note in enumerate(room.get("blackboard", {}).get("notes") or []):
        add("room.blackboard.updated", note.get("at"), note.get("speaker") or note.get("agent_id") or "unknown", {
            "index": index,
            "content": note.get("content", ""),
        })
    if room.get("status"):
        add("room.status.changed", room.get("updated_at") or room.get("completed_at"), "system", {"status": room.get("status")})

    sorted_events = []
    for index, event in enumerate(sorted(enumerate(events), key=lambda item: (str(item[1].get("at", "")), item[0])), start=1):
        clean = dict(event[1])
        clean["id"] = f"{room_id or 'room'}:event:{index:04d}"
        clean["sequence"] = index
        sorted_events.append(clean)
    generated_at = _iso_now()
    export_metadata = {
        "format": "events",
        "source": "room.snapshot",
        "generated_at": generated_at,
        "reports_only": reports_only,
        "event_count": len(sorted_events),
        "sequence_start": 1 if sorted_events else 0,
        "sequence_end": len(sorted_events),
    }
    return {
        "object": "agent_bus.room_event_bundle",
        "protocol": "agent-bus.v1",
        "generated_at": generated_at,
        "source": "room.snapshot",
        "reports_only": reports_only,
        "export_metadata": export_metadata,
        "room": {
            "id": room_id,
            "title": room.get("title", ""),
            "status": room.get("status", "unknown"),
            "agents": room.get("agents") or [],
            "created_at": room.get("created_at", ""),
            "updated_at": room.get("updated_at", ""),
        },
        "counts": _count_events(sorted_events),
        "events": sorted_events,
    }


def validate_room_event_bundle(
    bundle: dict[str, Any],
    *,
    strict_types: bool = False,
    known_types: set[str] | list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    if not isinstance(bundle, dict) or not isinstance(bundle.get("events"), list):
        raise AgentBusError("validate_room_event_bundle requires an event bundle with an events array.")
    if bundle.get("object") and bundle.get("object") != "agent_bus.room_event_bundle":
        raise AgentBusError(f"Expected agent_bus.room_event_bundle, got {bundle.get('object')}.")
    metadata = bundle.get("export_metadata") or {}
    events = bundle["events"]
    if metadata.get("event_count") is not None and metadata.get("event_count") != len(events):
        raise AgentBusError(f"Event bundle metadata count {metadata.get('event_count')} does not match {len(events)} events.")
    if events:
        if metadata.get("sequence_start") is not None and metadata.get("sequence_start") != 1:
            raise AgentBusError(f"Event bundle sequence_start must be 1, got {metadata.get('sequence_start')}.")
        if metadata.get("sequence_end") is not None and metadata.get("sequence_end") != len(events):
            raise AgentBusError(f"Event bundle sequence_end must match event count, got {metadata.get('sequence_end')}.")

    allowed_types = set(known_types or ROOM_EVENT_TYPES)
    room_id = (bundle.get("room") or {}).get("id", "")
    ids: set[str] = set()
    counts: dict[str, int] = {"events": len(events)}
    for index, event in enumerate(events):
        if not isinstance(event, dict):
            raise AgentBusError(f"Event {index + 1} must be an object.")
        event_id = event.get("id")
        if not event_id:
            raise AgentBusError(f"Event {index + 1} is missing id.")
        if event_id in ids:
            raise AgentBusError(f"Duplicate event id: {event_id}.")
        ids.add(event_id)
        if event.get("sequence") is not None and event.get("sequence") != index + 1:
            raise AgentBusError(f"Event {event_id} has non-contiguous sequence {event.get('sequence')}; expected {index + 1}.")
        event_type = event.get("type")
        if not event_type:
            raise AgentBusError(f"Event {event_id} is missing type.")
        if strict_types and event_type not in allowed_types:
            raise AgentBusError(f"Event {event_id} uses unknown type: {event_type}.")
        if not event.get("at"):
            raise AgentBusError(f"Event {event_id} is missing at timestamp.")
        if not event.get("actor"):
            raise AgentBusError(f"Event {event_id} is missing actor.")
        if not isinstance(event.get("payload"), dict):
            raise AgentBusError(f"Event {event_id} payload must be an object.")
        if room_id and event.get("room_id") and event.get("room_id") != room_id:
            raise AgentBusError(f"Event {event_id} room_id {event.get('room_id')} does not match bundle room id {room_id}.")
        counts[event_type] = counts.get(event_type, 0) + 1

    return {
        "ok": True,
        "room_id": room_id,
        "event_count": len(events),
        "sequence_start": 1 if events else 0,
        "sequence_end": len(events),
        "counts": counts,
    }


def replay_room_events(bundle: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(bundle, dict) or not isinstance(bundle.get("events"), list):
        raise AgentBusError("replay_room_events requires an event bundle with an events array.")
    runs: dict[str, dict[str, Any]] = {}
    summary = {
        "object": "agent_bus.room_replay",
        "protocol": bundle.get("protocol", "agent-bus.v1"),
        "source": bundle.get("object", "unknown"),
        "export_metadata": bundle.get("export_metadata"),
        "room": {
            "id": bundle.get("room", {}).get("id", ""),
            "title": bundle.get("room", {}).get("title", ""),
            "status": bundle.get("room", {}).get("status", "unknown"),
            "agents": bundle.get("room", {}).get("agents", []),
        },
        "counts": {"events": 0, "messages": 0, "reports": 0, "blackboard_updates": 0, "runs": 0, "completed_runs": 0, "failed_runs": 0, "output_events": 0, "output_bytes": 0},
        "reports": [],
        "blackboard": [],
        "runs": [],
    }
    for event in bundle["events"]:
        summary["counts"]["events"] += 1
        event_type = event.get("type")
        payload = event.get("payload") or {}
        if event_type == "room.created":
            summary["room"]["id"] = summary["room"]["id"] or event.get("room_id", "")
            summary["room"]["title"] = summary["room"]["title"] or payload.get("title", "")
            summary["room"]["status"] = payload.get("status") or summary["room"]["status"]
            summary["room"]["agents"] = payload.get("agents") or summary["room"]["agents"]
        elif event_type == "room.status.changed":
            summary["room"]["status"] = payload.get("status") or summary["room"]["status"]
        elif event_type == "room.message.added":
            summary["counts"]["messages"] += 1
        elif event_type == "room.report.added":
            summary["counts"]["reports"] += 1
            summary["reports"].append({"at": event.get("at"), "speaker": event.get("actor"), "content": payload.get("content", "")})
        elif event_type == "room.blackboard.updated":
            summary["counts"]["blackboard_updates"] += 1
            summary["blackboard"].append({"at": event.get("at"), "speaker": event.get("actor"), "content": payload.get("content", "")})
        elif event_type == "run.queued":
            run = _ensure_run(runs, event)
            run["status"] = "queued"
            run["created_at"] = event.get("at", "")
            run["agent_id"] = payload.get("agent_id") or event.get("actor") or run["agent_id"]
        elif event_type == "run.started":
            run = _ensure_run(runs, event)
            run["status"] = "running"
            run["started_at"] = event.get("at", "")
        elif event_type == "run.output":
            run = _ensure_run(runs, event)
            byte_count = len(str(payload.get("text", "")).encode("utf-8"))
            run["output_events"] += 1
            run["output_bytes"] += byte_count
            summary["counts"]["output_events"] += 1
            summary["counts"]["output_bytes"] += byte_count
        elif event_type in ("run.completed", "run.failed"):
            run = _ensure_run(runs, event)
            run["status"] = payload.get("status") or ("completed" if event_type == "run.completed" else "failed")
            run["completed_at"] = event.get("at", "")
            run["exit_code"] = payload.get("exit_code")
            if event_type == "run.completed":
                summary["counts"]["completed_runs"] += 1
            else:
                summary["counts"]["failed_runs"] += 1
    summary["runs"] = sorted(runs.values(), key=lambda run: str(run.get("created_at", "")))
    summary["counts"]["runs"] = len(summary["runs"])
    return summary


def _ensure_run(runs: dict[str, dict[str, Any]], event: dict[str, Any]) -> dict[str, Any]:
    run_id = event.get("run_id") or "run_unknown"
    if run_id not in runs:
        runs[run_id] = {
            "id": run_id,
            "agent_id": (event.get("payload") or {}).get("agent_id") or event.get("actor") or "",
            "status": "unknown",
            "created_at": "",
            "started_at": "",
            "completed_at": "",
            "exit_code": None,
            "output_events": 0,
            "output_bytes": 0,
        }
    return runs[run_id]


def _normalize_gateway_url(value: str) -> str:
    return str(value or "").rstrip("/")


def _join_url(base: str, path: str) -> str:
    return f"{_normalize_gateway_url(base)}{'' if str(path).startswith('/') else '/'}{path}"


def _path_part(value: str) -> str:
    return urllib.parse.quote(str(value or ""), safe="")


def _parse_body(text: str) -> Any:
    try:
        return json.loads(text) if text.strip() else {}
    except json.JSONDecodeError:
        return text


def _count_events(events: list[dict[str, Any]]) -> dict[str, int]:
    counts = {"events": len(events)}
    for event in events:
        event_type = event.get("type", "unknown")
        counts[event_type] = counts.get(event_type, 0) + 1
    return counts


def _terminal_run(status: Any) -> bool:
    return str(status or "").lower() in {"completed", "failed", "error", "cancelled", "canceled", "skipped"}


def _iso_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
