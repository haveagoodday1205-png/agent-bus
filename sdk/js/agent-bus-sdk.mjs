export class AgentBusError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AgentBusError";
    this.status = details.status || 0;
    this.statusText = details.statusText || "";
    this.body = details.body;
  }
}

export class AgentBusClient {
  constructor(options = {}) {
    this.gatewayUrl = normalizeGatewayUrl(options.gatewayUrl || env("AGENT_BUS_GATEWAY_URL") || "http://127.0.0.1:8788");
    this.token = options.token || env("AGENT_BUS_TOKEN") || "";
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.timeoutMs = Number(options.timeoutMs || 30000);
    if (typeof this.fetchImpl !== "function") {
      throw new AgentBusError("AgentBusClient requires fetch. Use Node.js 20+ or pass { fetch }.");
    }
  }

  health() {
    return this.request("/health", { auth: false });
  }

  wellKnown() {
    return this.request("/.well-known/agent-bus.json", { auth: false });
  }

  manifest() {
    return this.request("/v1/agent-bus/manifest");
  }

  agents() {
    return this.request("/agents");
  }

  nodes() {
    return this.request("/nodes");
  }

  rooms() {
    return this.request("/rooms");
  }

  room(roomId) {
    return this.request(`/rooms/${pathPart(roomId)}`);
  }

  createRoom(body) {
    return this.request("/rooms", { method: "POST", body });
  }

  wakeRoom(roomId, body = {}) {
    return this.request(`/rooms/${pathPart(roomId)}/wake`, { method: "POST", body });
  }

  messageRoom(roomId, body = {}) {
    return this.request(`/rooms/${pathPart(roomId)}/messages`, { method: "POST", body });
  }

  models() {
    return this.request("/v1/models");
  }

  chatCompletion(body) {
    return this.request("/v1/chat/completions", { method: "POST", body });
  }

  response(body) {
    return this.request("/v1/responses", { method: "POST", body });
  }

  agentChat(agentId, messages, options = {}) {
    return this.chatCompletion({
      ...options,
      model: agentModel(agentId),
      messages
    });
  }

  agentResponse(agentId, input, options = {}) {
    return this.response({
      ...options,
      model: agentModel(agentId),
      input
    });
  }

  async exportRoomEvents(roomId, options = {}) {
    const room = await this.room(roomId);
    return roomEventBundle(room, options);
  }

  async request(pathname, options = {}) {
    const headers = {
      accept: "application/json",
      ...(options.headers || {})
    };
    if (options.auth !== false) {
      if (!this.token) throw new AgentBusError("Agent Bus token is required for this request.");
      headers.authorization = `Bearer ${this.token}`;
    }
    const init = {
      method: options.method || "GET",
      headers
    };
    if (options.body !== undefined) {
      headers["content-type"] = headers["content-type"] || "application/json";
      init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || this.timeoutMs));
    try {
      const res = await this.fetchImpl(joinUrl(this.gatewayUrl, pathname), { ...init, signal: controller.signal });
      const text = await res.text();
      const body = parseResponseBody(text);
      if (!res.ok) {
        throw new AgentBusError(`Agent Bus request failed: ${res.status} ${res.statusText}`, {
          status: res.status,
          statusText: res.statusText,
          body
        });
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function agentModel(agentId) {
  const text = String(agentId || "").trim();
  if (!text) throw new AgentBusError("agentModel requires an agent id.");
  return text.startsWith("agent:") ? text : `agent:${text}`;
}

export const ROOM_EVENT_TYPES = [
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
  "policy.denied"
];

export function roomEventBundle(room, options = {}) {
  const events = [];
  const roomId = room?.id || "";
  const reportsOnly = options.reportsOnly === true;
  const add = (type, at, actor, payload = {}, extra = {}) => {
    events.push({
      type,
      at: at || room?.updated_at || room?.created_at || new Date(0).toISOString(),
      actor: actor || "system",
      room_id: roomId,
      ...extra,
      payload
    });
  };
  add("room.created", room?.created_at, "system", {
    title: room?.title || "",
    goal: room?.goal || "",
    status: room?.status || "unknown",
    agents: room?.agents || []
  });
  if (!reportsOnly) {
    for (const [index, message] of (room?.messages || []).entries()) {
      add("room.message.added", message.at, message.speaker || message.role || "unknown", {
        index,
        role: message.role || "",
        speaker: message.speaker || "",
        content: message.content || ""
      });
    }
  }
  for (const run of room?.runs || []) {
    add("run.queued", run.created_at, run.agent_id || "system", {
      agent_id: run.agent_id || "",
      node_id: run.node_id || "",
      kind: run.kind || "",
      role: run.role || ""
    }, { run_id: run.id || "" });
    if (run.started_at) {
      add("run.started", run.started_at, run.agent_id || "system", {
        agent_id: run.agent_id || "",
        node_id: run.node_id || ""
      }, { run_id: run.id || "" });
    }
    if (!reportsOnly) {
      for (const [index, event] of (run.events || []).entries()) {
        if (!event?.text && !event?.stream) continue;
        add("run.output", event.at || run.started_at || run.created_at, run.agent_id || "system", {
          index,
          stream: event.stream || "",
          text: event.text || ""
        }, { run_id: run.id || "" });
      }
    }
    if (isTerminalRunStatus(run.status)) {
      add(run.status === "completed" ? "run.completed" : "run.failed", run.completed_at || room?.updated_at, run.agent_id || "system", {
        agent_id: run.agent_id || "",
        status: run.status || "unknown",
        exit_code: run.exit_code ?? null,
        stdout_bytes: byteLength(run.stdout || ""),
        stderr_bytes: byteLength(run.stderr || "")
      }, { run_id: run.id || "" });
    }
  }
  for (const [index, report] of (room?.reports || room?.blackboard?.reports || []).entries()) {
    add("room.report.added", report.at, report.speaker || report.agent_id || "unknown", {
      index,
      content: report.content || ""
    });
  }
  for (const [index, note] of (room?.blackboard?.notes || []).entries()) {
    add("room.blackboard.updated", note.at, note.speaker || note.agent_id || "unknown", {
      index,
      content: note.content || ""
    });
  }
  if (room?.status) {
    add("room.status.changed", room.updated_at || room.completed_at, "system", { status: room.status });
  }
  const sorted = events
    .map((event, index) => ({ ...event, _index: index }))
    .sort((left, right) => String(left.at).localeCompare(String(right.at)) || left._index - right._index)
    .map((event, index) => {
      const { _index, ...clean } = event;
      const sequence = index + 1;
      return { ...clean, id: `${roomId || "room"}:event:${String(sequence).padStart(4, "0")}`, sequence };
    });
  const generatedAt = new Date().toISOString();
  const exportMetadata = {
    format: "events",
    source: "room.snapshot",
    generated_at: generatedAt,
    reports_only: reportsOnly,
    event_count: sorted.length,
    sequence_start: sorted.length ? 1 : 0,
    sequence_end: sorted.length
  };
  return {
    object: "agent_bus.room_event_bundle",
    protocol: "agent-bus.v1",
    generated_at: generatedAt,
    source: "room.snapshot",
    reports_only: reportsOnly,
    export_metadata: exportMetadata,
    room: {
      id: roomId,
      title: room?.title || "",
      status: room?.status || "unknown",
      agents: room?.agents || [],
      created_at: room?.created_at || "",
      updated_at: room?.updated_at || ""
    },
    counts: countEvents(sorted),
    events: sorted
  };
}

export function validateRoomEventBundle(bundle, options = {}) {
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.events)) {
    throw new AgentBusError("validateRoomEventBundle requires an event bundle with an events array.");
  }
  if (bundle.object && bundle.object !== "agent_bus.room_event_bundle") {
    throw new AgentBusError(`Expected agent_bus.room_event_bundle, got ${bundle.object}.`);
  }
  const metadata = bundle.export_metadata || {};
  const events = bundle.events;
  if (metadata.event_count !== undefined && metadata.event_count !== events.length) {
    throw new AgentBusError(`Event bundle metadata count ${metadata.event_count} does not match ${events.length} events.`);
  }
  if (events.length) {
    if (metadata.sequence_start !== undefined && metadata.sequence_start !== 1) {
      throw new AgentBusError(`Event bundle sequence_start must be 1, got ${metadata.sequence_start}.`);
    }
    if (metadata.sequence_end !== undefined && metadata.sequence_end !== events.length) {
      throw new AgentBusError(`Event bundle sequence_end must match event count, got ${metadata.sequence_end}.`);
    }
  }

  const knownTypes = new Set(options.knownTypes || ROOM_EVENT_TYPES);
  const strictTypes = options.strictTypes === true;
  const ids = new Set();
  const counts = { events: events.length };
  const roomId = bundle.room?.id || "";
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== "object") throw new AgentBusError(`Event ${index + 1} must be an object.`);
    if (!event.id) throw new AgentBusError(`Event ${index + 1} is missing id.`);
    if (ids.has(event.id)) throw new AgentBusError(`Duplicate event id: ${event.id}.`);
    ids.add(event.id);
    if (event.sequence !== undefined && event.sequence !== index + 1) {
      throw new AgentBusError(`Event ${event.id} has non-contiguous sequence ${event.sequence}; expected ${index + 1}.`);
    }
    if (!event.type) throw new AgentBusError(`Event ${event.id} is missing type.`);
    if (strictTypes && !knownTypes.has(event.type)) {
      throw new AgentBusError(`Event ${event.id} uses unknown type: ${event.type}.`);
    }
    if (!event.at) throw new AgentBusError(`Event ${event.id} is missing at timestamp.`);
    if (!event.actor) throw new AgentBusError(`Event ${event.id} is missing actor.`);
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      throw new AgentBusError(`Event ${event.id} payload must be an object.`);
    }
    if (roomId && event.room_id && event.room_id !== roomId) {
      throw new AgentBusError(`Event ${event.id} room_id ${event.room_id} does not match bundle room id ${roomId}.`);
    }
    counts[event.type] = (counts[event.type] || 0) + 1;
  }

  return {
    ok: true,
    room_id: roomId,
    event_count: events.length,
    sequence_start: events.length ? 1 : 0,
    sequence_end: events.length,
    counts
  };
}

export function replayRoomEvents(bundle) {
  if (!bundle || typeof bundle !== "object" || !Array.isArray(bundle.events)) {
    throw new AgentBusError("replayRoomEvents requires an event bundle with an events array.");
  }
  const runs = new Map();
  const summary = {
    object: "agent_bus.room_replay",
    protocol: bundle.protocol || "agent-bus.v1",
    source: bundle.object || "unknown",
    export_metadata: bundle.export_metadata || null,
    room: {
      id: bundle.room?.id || "",
      title: bundle.room?.title || "",
      status: bundle.room?.status || "unknown",
      agents: bundle.room?.agents || []
    },
    counts: {
      events: 0,
      messages: 0,
      reports: 0,
      blackboard_updates: 0,
      runs: 0,
      completed_runs: 0,
      failed_runs: 0,
      output_events: 0,
      output_bytes: 0
    },
    reports: [],
    blackboard: [],
    runs: []
  };
  for (const event of bundle.events) {
    summary.counts.events += 1;
    if (event.type === "room.created") {
      summary.room.id ||= event.room_id || "";
      summary.room.title ||= event.payload?.title || "";
      summary.room.status = event.payload?.status || summary.room.status;
      summary.room.agents = event.payload?.agents || summary.room.agents;
    } else if (event.type === "room.status.changed") {
      summary.room.status = event.payload?.status || summary.room.status;
    } else if (event.type === "room.message.added") {
      summary.counts.messages += 1;
    } else if (event.type === "room.report.added") {
      summary.counts.reports += 1;
      summary.reports.push({ at: event.at, speaker: event.actor, content: event.payload?.content || "" });
    } else if (event.type === "room.blackboard.updated") {
      summary.counts.blackboard_updates += 1;
      summary.blackboard.push({ at: event.at, speaker: event.actor, content: event.payload?.content || "" });
    } else if (event.type === "run.queued") {
      const run = ensureRun(runs, event);
      run.status = "queued";
      run.created_at = event.at;
      run.agent_id = event.payload?.agent_id || event.actor || run.agent_id;
    } else if (event.type === "run.started") {
      const run = ensureRun(runs, event);
      run.status = "running";
      run.started_at = event.at;
    } else if (event.type === "run.output") {
      const run = ensureRun(runs, event);
      const bytes = byteLength(event.payload?.text || "");
      run.output_events += 1;
      run.output_bytes += bytes;
      summary.counts.output_events += 1;
      summary.counts.output_bytes += bytes;
    } else if (event.type === "run.completed" || event.type === "run.failed") {
      const run = ensureRun(runs, event);
      run.status = event.payload?.status || (event.type === "run.completed" ? "completed" : "failed");
      run.completed_at = event.at;
      run.exit_code = event.payload?.exit_code ?? null;
      if (event.type === "run.completed") summary.counts.completed_runs += 1;
      if (event.type === "run.failed") summary.counts.failed_runs += 1;
    }
  }
  summary.runs = [...runs.values()].sort((left, right) => String(left.created_at || "").localeCompare(String(right.created_at || "")));
  summary.counts.runs = summary.runs.length;
  return summary;
}

function ensureRun(runs, event) {
  const runId = event.run_id || "run_unknown";
  if (!runs.has(runId)) {
    runs.set(runId, {
      id: runId,
      agent_id: event.payload?.agent_id || event.actor || "",
      status: "unknown",
      created_at: "",
      started_at: "",
      completed_at: "",
      exit_code: null,
      output_events: 0,
      output_bytes: 0
    });
  }
  return runs.get(runId);
}

function normalizeGatewayUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function joinUrl(base, pathname) {
  return `${normalizeGatewayUrl(base)}${String(pathname || "").startsWith("/") ? "" : "/"}${pathname}`;
}

function pathPart(value) {
  return encodeURIComponent(String(value || ""));
}

function parseResponseBody(text) {
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

function countEvents(events) {
  const counts = { events: events.length };
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  return counts;
}

function isTerminalRunStatus(status) {
  return ["completed", "failed", "error", "cancelled", "canceled", "skipped"].includes(String(status || "").toLowerCase());
}

function byteLength(value) {
  if (typeof Buffer !== "undefined") return Buffer.byteLength(String(value || ""), "utf8");
  return new TextEncoder().encode(String(value || "")).length;
}

function env(name) {
  return globalThis.process?.env?.[name] || "";
}
