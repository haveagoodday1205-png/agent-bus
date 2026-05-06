const state = {
  agents: [],
  selectedAgents: new Set(),
  currentThreadId: null,
  polling: null
};

const $ = (id) => document.getElementById(id);

const apiBase = new URL("../", window.location.href);
$("gatewayLabel").textContent = apiBase.href.replace(/\/$/, "");
$("tokenInput").value = sessionStorage.getItem("agentBusToken") || "";

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

$("saveTokenButton").addEventListener("click", () => {
  sessionStorage.setItem("agentBusToken", $("tokenInput").value.trim());
  logEvent("token saved in session storage");
});
$("refreshButton").addEventListener("click", refreshAll);
$("loadAgentsButton").addEventListener("click", loadAgents);
$("routeButton").addEventListener("click", routeTask);
$("taskForm").addEventListener("submit", submitTask);
$("stopPollingButton").addEventListener("click", stopPolling);
$("loadModelsButton").addEventListener("click", loadModels);
$("chatForm").addEventListener("submit", sendChat);
$("clearModelOutputButton").addEventListener("click", () => { $("modelOutput").textContent = ""; });
$("clearEventsButton").addEventListener("click", () => { $("eventLog").textContent = ""; });

refreshAll();
setInterval(loadHealth, 8000);

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
  $(`${name}Panel`).classList.add("active");
}

async function refreshAll() {
  await loadHealth();
  await loadAgents();
}

async function loadHealth() {
  try {
    const data = await request("health", { auth: false });
    $("gatewayStatus").textContent = data.ok ? "online" : "unknown";
    $("gatewayStatus").className = data.ok ? "status online" : "status";
    $("nodeCount").textContent = data.nodes ?? "-";
    $("agentCount").textContent = data.agents ?? "-";
    $("queuedCount").textContent = data.queued ?? "-";
  } catch (err) {
    $("gatewayStatus").textContent = "offline";
    $("gatewayStatus").className = "status failed";
    logEvent(`health failed: ${err.message}`);
  }
}

async function loadAgents() {
  try {
    state.agents = await request("agents");
    for (const agent of state.agents) state.selectedAgents.add(agent.id);
    renderAgents();
    logEvent(`loaded ${state.agents.length} agents`);
  } catch (err) {
    renderAuthError(err);
  }
}

function renderAgents() {
  const tbody = $("agentsTable");
  tbody.textContent = "";
  if (!state.agents.length) {
    tbody.append(rowMessage("No registered agents."));
    return;
  }
  for (const agent of state.agents) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-agent="${escapeHtml(agent.id)}" ${state.selectedAgents.has(agent.id) ? "checked" : ""}></td>
      <td><div class="agent-name">${escapeHtml(agent.id)}</div><span class="status ${escapeHtml(agent.node_status || "")}">${escapeHtml(agent.node_status || "unknown")}</span></td>
      <td>${escapeHtml(agent.node_id || "-")}</td>
      <td>${escapeHtml(agent.kind || "-")}</td>
      <td>${escapeHtml(agent.role || "-")}</td>
      <td>${(agent.capabilities || []).map((cap) => `<span class="pill">${escapeHtml(cap)}</span>`).join("")}</td>
      <td>${escapeHtml(agent.node_last_seen_at || "-")}</td>
    `;
    tr.querySelector("input").addEventListener("change", (event) => {
      if (event.target.checked) state.selectedAgents.add(agent.id);
      else state.selectedAgents.delete(agent.id);
    });
    tbody.append(tr);
  }
}

function rowMessage(message) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 7;
  td.className = "muted";
  td.textContent = message;
  tr.append(td);
  return tr;
}

async function routeTask() {
  const message = $("taskMessage").value.trim();
  if (!message) return logEvent("task message is empty");
  try {
    const body = taskPayload(message);
    const data = await request("route", { method: "POST", body });
    logEvent(`route: ${data.reason}`);
    $("threadSummary").textContent = `Route: ${data.agents.map((agent) => agent.id).join(", ")}`;
    activateTab("tasks");
  } catch (err) {
    logEvent(`route failed: ${err.message}`);
  }
}

async function submitTask(event) {
  event.preventDefault();
  const message = $("taskMessage").value.trim();
  if (!message) return logEvent("task message is empty");
  try {
    const data = await request("threads", { method: "POST", body: taskPayload(message) });
    state.currentThreadId = data.id;
    renderThread(data);
    startPolling(data.id);
    logEvent(`thread created: ${data.id}`);
  } catch (err) {
    logEvent(`task failed: ${err.message}`);
  }
}

function taskPayload(message) {
  const mode = $("taskMode").value;
  const payload = { message, mode: mode === "explicit" ? "orchestrate" : mode };
  if (mode === "explicit") payload.agents = [...state.selectedAgents];
  return payload;
}

function startPolling(threadId) {
  stopPolling();
  state.polling = setInterval(() => loadThread(threadId), 2500);
}

function stopPolling() {
  if (state.polling) clearInterval(state.polling);
  state.polling = null;
}

async function loadThread(threadId) {
  try {
    const data = await request(`threads/${encodeURIComponent(threadId)}`);
    renderThread(data);
    const active = (data.runs || []).some((run) => ["queued", "running"].includes(run.status));
    if (!active) stopPolling();
  } catch (err) {
    logEvent(`thread load failed: ${err.message}`);
  }
}

function renderThread(thread) {
  $("threadSummary").textContent = `${thread.id} | ${thread.mode} | ${(thread.selection?.agents || []).join(", ")}`;
  const list = $("runsList");
  list.textContent = "";
  for (const run of thread.runs || []) {
    const item = document.createElement("div");
    item.className = "run-item";
    item.innerHTML = `
      <div class="run-head">
        <div><strong>${escapeHtml(run.agent_id)}</strong> <span class="muted">${escapeHtml(run.node_id || "")}</span></div>
        <span class="status ${escapeHtml(run.status || "")}">${escapeHtml(run.status || "unknown")}</span>
      </div>
      <pre class="output">${escapeHtml((run.stdout || run.summary || run.stderr || "").trim())}</pre>
    `;
    list.append(item);
  }
}

async function loadModels() {
  try {
    const data = await request("v1/models");
    $("modelOutput").textContent = JSON.stringify(data, null, 2);
    logEvent(`loaded ${data.data?.length || 0} models`);
  } catch (err) {
    $("modelOutput").textContent = err.message;
  }
}

async function sendChat(event) {
  event.preventDefault();
  const model = $("modelInput").value.trim() || "agent-bus-default";
  const prompt = $("chatPrompt").value.trim();
  if (!prompt) return logEvent("model prompt is empty");
  $("modelOutput").textContent = "waiting...";
  try {
    const data = await request("v1/chat/completions", {
      method: "POST",
      body: {
        model,
        messages: [{ role: "user", content: prompt }]
      }
    });
    $("modelOutput").textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $("modelOutput").textContent = err.message;
  }
}

async function request(path, options = {}) {
  const url = new URL(path, apiBase);
  const headers = { ...(options.headers || {}) };
  if (options.auth !== false) {
    const token = $("tokenInput").value.trim() || sessionStorage.getItem("agentBusToken") || "";
    if (token) headers.authorization = `Bearer ${token}`;
  }
  let body;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const res = await fetch(url, {
    method: options.method || "GET",
    headers,
    body
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error?.message || data.error || `${res.status} ${res.statusText}`);
  return data;
}

function renderAuthError(err) {
  const tbody = $("agentsTable");
  tbody.textContent = "";
  tbody.append(rowMessage(`Could not load agents: ${err.message}`));
  logEvent(`agents failed: ${err.message}`);
}

function logEvent(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  $("eventLog").textContent = `${line}\n${$("eventLog").textContent}`.slice(0, 20000);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
