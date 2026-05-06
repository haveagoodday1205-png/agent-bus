const state = {
  agents: [],
  selectedAgents: new Set(),
  currentThreadId: null,
  currentThread: null,
  polling: null,
  lang: localStorage.getItem("agentBusLanguage") || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en"),
  tokenStatusKey: null,
  tokenStatusClass: ""
};

const $ = (id) => document.getElementById(id);
const messages = {
  en: {
    agent: "Agent",
    agents: "Agents",
    agentsLoaded: "loaded {count} agents",
    agentsLoadFailed: "Could not load agents: {message}",
    agentsLogFailed: "agents failed: {message}",
    broadcast: "broadcast",
    capabilities: "Capabilities",
    chatPlaceholder: "Send a message through /v1/chat/completions",
    checking: "checking",
    clear: "Clear",
    events: "Events",
    gateway: "Gateway",
    healthFailed: "health failed: {message}",
    kind: "Kind",
    language: "Language",
    message: "Message",
    missingToken: "missing token",
    mode: "Mode",
    model: "Model",
    modelOutputEmpty: "",
    modelPromptEmpty: "model prompt is empty",
    modelRouter: "Model Router",
    models: "Models",
    modelsLoaded: "loaded {count} models",
    noAgents: "No registered agents.",
    noThread: "No thread selected.",
    node: "Node",
    nodes: "Nodes",
    offline: "offline",
    online: "online",
    orchestrate: "orchestrate",
    completed: "completed",
    failed: "failed",
    running: "running",
    prompt: "Prompt",
    queued: "Queued",
    refresh: "Refresh",
    reload: "Reload",
    response: "Response",
    role: "Role",
    route: "Route",
    routeFailed: "route failed: {message}",
    routeLog: "route: {reason}",
    routeSummary: "Route: {agents}",
    runTask: "Run Task",
    save: "Save",
    seen: "Seen",
    selectedAgents: "selected agents",
    send: "Send",
    stopPolling: "Stop Polling",
    task: "Task",
    taskFailed: "task failed: {message}",
    taskMessageEmpty: "task message is empty",
    taskPlaceholder: "Ask connected agents to do something",
    tasks: "Tasks",
    thread: "Thread",
    threadCreated: "thread created: {id}",
    threadLoadFailed: "thread load failed: {message}",
    token: "Token",
    tokenPlaceholder: "Paste token or Bearer token",
    tokenRejected: "Token rejected or missing",
    tokenRequired: "Required for control actions",
    tokenRequiredShort: "Token required",
    tokenSaved: "Saved for this browser tab",
    tokenSavedLog: "token saved; refreshing authorized data",
    tokenSaving: "Saved. Loading agents...",
    unknown: "unknown",
    waiting: "waiting..."
  },
  zh: {
    agent: "Agent",
    agents: "智能体",
    agentsLoaded: "已加载 {count} 个智能体",
    agentsLoadFailed: "无法加载智能体：{message}",
    agentsLogFailed: "智能体加载失败：{message}",
    broadcast: "广播给全部",
    capabilities: "能力",
    chatPlaceholder: "通过 /v1/chat/completions 发送消息",
    checking: "检查中",
    clear: "清空",
    events: "事件",
    gateway: "网关",
    healthFailed: "健康检查失败：{message}",
    kind: "类型",
    language: "语言",
    message: "消息",
    missingToken: "缺少 token",
    mode: "模式",
    model: "模型",
    modelOutputEmpty: "",
    modelPromptEmpty: "模型提示词不能为空",
    modelRouter: "模型路由",
    models: "模型",
    modelsLoaded: "已加载 {count} 个模型",
    noAgents: "没有已注册的智能体。",
    noThread: "尚未选择线程。",
    node: "节点",
    nodes: "节点",
    offline: "离线",
    online: "在线",
    orchestrate: "自动编排",
    completed: "已完成",
    failed: "失败",
    running: "运行中",
    prompt: "提示词",
    queued: "队列",
    refresh: "刷新",
    reload: "重新加载",
    response: "响应",
    role: "角色",
    route: "路由",
    routeFailed: "路由失败：{message}",
    routeLog: "路由：{reason}",
    routeSummary: "路由到：{agents}",
    runTask: "运行任务",
    save: "保存",
    seen: "最近在线",
    selectedAgents: "选中的智能体",
    send: "发送",
    stopPolling: "停止轮询",
    task: "任务",
    taskFailed: "任务失败：{message}",
    taskMessageEmpty: "任务消息不能为空",
    taskPlaceholder: "让已连接的智能体执行任务",
    tasks: "任务",
    thread: "线程",
    threadCreated: "线程已创建：{id}",
    threadLoadFailed: "线程加载失败：{message}",
    token: "Token",
    tokenPlaceholder: "粘贴 token 或 Bearer token",
    tokenRejected: "Token 错误或缺失",
    tokenRequired: "控制操作需要 token",
    tokenRequiredShort: "需要 token",
    tokenSaved: "已保存到当前浏览器标签页",
    tokenSavedLog: "token 已保存，正在刷新授权数据",
    tokenSaving: "已保存，正在加载智能体...",
    unknown: "未知",
    waiting: "等待中..."
  }
};

const apiBase = new URL("../", window.location.href);
$("gatewayLabel").textContent = apiBase.href.replace(/\/$/, "");
$("tokenInput").value = sessionStorage.getItem("agentBusToken") || "";
$("languageSelect").value = state.lang;
applyLanguage();
setTokenStatus($("tokenInput").value ? "tokenSaved" : "tokenRequired", $("tokenInput").value ? "" : "");

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

["change", "input"].forEach((eventName) => $("languageSelect").addEventListener(eventName, () => {
  state.lang = $("languageSelect").value;
  localStorage.setItem("agentBusLanguage", state.lang);
  applyLanguage();
  renderAgents();
  if (state.currentThread) renderThread(state.currentThread);
}));
$("saveTokenButton").addEventListener("click", saveToken);
$("tokenInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveToken();
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

async function saveToken() {
  const token = normalizeToken($("tokenInput").value);
  $("tokenInput").value = token;
  if (!token) {
    sessionStorage.removeItem("agentBusToken");
    setTokenStatus("tokenRequiredShort", "failed");
    renderAuthError(new Error(t("missingToken")));
    return;
  }

  sessionStorage.setItem("agentBusToken", token);
  setTokenStatus("tokenSaving", "running");
  logEvent(t("tokenSavedLog"));
  await refreshAll();
  setTokenStatus("tokenSaved", "online");
}

async function loadHealth() {
  try {
    const data = await request("health", { auth: false });
    setGatewayStatus(data.ok ? "online" : "unknown", data.ok ? "status online" : "status");
    $("nodeCount").textContent = data.nodes ?? "-";
    $("agentCount").textContent = data.agents ?? "-";
    $("queuedCount").textContent = data.queued ?? "-";
  } catch (err) {
    setGatewayStatus("offline", "status failed");
    logEvent(t("healthFailed", { message: err.message }));
  }
}

async function loadAgents() {
  try {
    state.agents = await request("agents");
    for (const agent of state.agents) state.selectedAgents.add(agent.id);
    renderAgents();
    logEvent(t("agentsLoaded", { count: state.agents.length }));
  } catch (err) {
    renderAuthError(err);
  }
}

function renderAgents() {
  const tbody = $("agentsTable");
  tbody.textContent = "";
  if (!state.agents.length) {
    tbody.append(rowMessage(t("noAgents")));
    return;
  }
  for (const agent of state.agents) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-agent="${escapeHtml(agent.id)}" ${state.selectedAgents.has(agent.id) ? "checked" : ""}></td>
      <td><div class="agent-name">${escapeHtml(agent.id)}</div><span class="status ${escapeHtml(agent.node_status || "")}">${escapeHtml(statusText(agent.node_status || "unknown"))}</span></td>
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
  if (!message) return logEvent(t("taskMessageEmpty"));
  try {
    const body = taskPayload(message);
    const data = await request("route", { method: "POST", body });
    logEvent(t("routeLog", { reason: data.reason }));
    $("threadSummary").removeAttribute("data-i18n");
    $("threadSummary").textContent = t("routeSummary", { agents: data.agents.map((agent) => agent.id).join(", ") });
    activateTab("tasks");
  } catch (err) {
    logEvent(t("routeFailed", { message: err.message }));
  }
}

async function submitTask(event) {
  event.preventDefault();
  const message = $("taskMessage").value.trim();
  if (!message) return logEvent(t("taskMessageEmpty"));
  try {
    const data = await request("threads", { method: "POST", body: taskPayload(message) });
    state.currentThreadId = data.id;
    renderThread(data);
    startPolling(data.id);
    logEvent(t("threadCreated", { id: data.id }));
  } catch (err) {
    logEvent(t("taskFailed", { message: err.message }));
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
    logEvent(t("threadLoadFailed", { message: err.message }));
  }
}

function renderThread(thread) {
  state.currentThread = thread;
  $("threadSummary").removeAttribute("data-i18n");
  $("threadSummary").textContent = `${thread.id} | ${thread.mode} | ${(thread.selection?.agents || []).join(", ")}`;
  const list = $("runsList");
  list.textContent = "";
  for (const run of thread.runs || []) {
    const item = document.createElement("div");
    item.className = "run-item";
    item.innerHTML = `
      <div class="run-head">
        <div><strong>${escapeHtml(run.agent_id)}</strong> <span class="muted">${escapeHtml(run.node_id || "")}</span></div>
        <span class="status ${escapeHtml(run.status || "")}">${escapeHtml(statusText(run.status || "unknown"))}</span>
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
    logEvent(t("modelsLoaded", { count: data.data?.length || 0 }));
  } catch (err) {
    $("modelOutput").textContent = err.message;
  }
}

async function sendChat(event) {
  event.preventDefault();
  const model = $("modelInput").value.trim() || "agent-bus-default";
  const prompt = $("chatPrompt").value.trim();
  if (!prompt) return logEvent(t("modelPromptEmpty"));
  $("modelOutput").textContent = t("waiting");
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
    const token = normalizeToken($("tokenInput").value || sessionStorage.getItem("agentBusToken") || "");
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
  tbody.append(rowMessage(t("agentsLoadFailed", { message: err.message })));
  logEvent(t("agentsLogFailed", { message: err.message }));
  if (/unauthorized|missing token|缺少 token/i.test(err.message)) setTokenStatus("tokenRejected", "failed");
}

function logEvent(message) {
  const line = `[${new Date().toLocaleTimeString()}] ${message}`;
  $("eventLog").textContent = `${line}\n${$("eventLog").textContent}`.slice(0, 20000);
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function setTokenStatus(key, className = "") {
  state.tokenStatusKey = key;
  state.tokenStatusClass = className;
  $("tokenStatus").textContent = t(key);
  $("tokenStatus").className = `token-status ${className}`.trim();
}

function setGatewayStatus(key, className = "") {
  $("gatewayStatus").dataset.statusKey = key;
  $("gatewayStatus").textContent = t(key);
  $("gatewayStatus").className = className;
}

function applyLanguage() {
  document.documentElement.lang = state.lang === "zh" ? "zh-CN" : "en";
  $("languageSelect").value = state.lang;
  document.querySelectorAll("[data-i18n]").forEach((item) => {
    item.textContent = t(item.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((item) => {
    item.placeholder = t(item.dataset.i18nPlaceholder);
  });
  if (state.tokenStatusKey) setTokenStatus(state.tokenStatusKey, state.tokenStatusClass);
  const gatewayKey = $("gatewayStatus").dataset.statusKey;
  if (gatewayKey) $("gatewayStatus").textContent = t(gatewayKey);
}

function t(key, values = {}) {
  let message = (messages[state.lang] && messages[state.lang][key]) || messages.en[key] || key;
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

function statusText(status) {
  return t(status) || status;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
