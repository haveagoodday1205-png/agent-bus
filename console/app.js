const state = {
  health: null,
  manifest: null,
  status: null,
  nodes: [],
  agents: [],
  models: [],
  rooms: [],
  edgeTokens: [],
  edgeJoinCommand: "",
  pairJoinCommand: "",
  pairCode: null,
  selectedAgents: new Set(),
  currentThreadId: null,
  currentThread: null,
  currentRoomId: null,
  currentRoom: null,
  currentRoomDoctor: null,
  currentTrace: null,
  composerAssist: null,
  roomPolling: null,
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
    activeRooms: "Active Rooms",
    activeRuns: "active runs",
    active: "active",
    activity: "Activity",
    apiEndpoint: "API",
    autonomousRoom: "Autonomous Room",
    autoDetect: "Auto Detect",
    broadcast: "broadcast",
    busy: "busy",
    capabilities: "Capabilities",
    permissionProfile: "Permission",
    permissionCoverage: "Permission Coverage",
    owner: "Owner",
    runtime: "Runtime",
    costClass: "Cost",
    latencyClass: "Latency",
    wakeTargets: "Wake Targets",
    cacheScope: "Cache Scope",
    cacheScopePlaceholder: "Optional stable key for agent:<id> calls",
    chatPlaceholder: "Send a message through /v1/chat/completions",
    chatCompletions: "Chat Completions",
    checking: "checking",
    clear: "Clear",
    copy: "Copy",
    copied: "copied",
    copyStatus: "Copy Status",
    events: "Events",
    exportJson: "Export JSON",
    exportSummary: "Export Reports",
    exported: "exported",
    format: "Format",
    gateway: "Gateway",
    groupChat: "group chat",
    groupNeedsAgents: "group chat needs at least two selected agents",
    createPairCode: "Create Code",
    createRoom: "Create Room",
    goal: "Goal",
    healthFailed: "health failed: {message}",
    health: "Health",
    human: "Human",
    idle: "idle",
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
    maxSteps: "Max Steps (0 = unlimited)",
    modelsCheck: "Model router",
    modelsLoaded: "loaded {count} models",
    plugins: "Plugins",
    pluginsLoaded: "loaded plugin status",
    pluginsLoadFailed: "plugins failed: {message}",
    preset: "Preset",
    telegramBot: "Telegram Bot",
    enabled: "enabled",
    disabled: "disabled",
    configured: "configured",
    dry_run: "dry-run",
    nodesLoaded: "loaded {count} nodes",
    nodesLoadFailed: "nodes failed: {message}",
    noNodes: "No registered nodes.",
    noTrace: "No trace loaded.",
    noAgents: "No registered agents.",
    noAgentChat: "No agent conversation yet.",
    noComposerMatches: "No matches",
    roomDebugDetails: "Debug Details",
    noRoom: "No room selected.",
    noThread: "No thread selected.",
    node: "Node",
    nodes: "Nodes",
    onlineAgents: "Online",
    overview: "Overview",
    offline: "offline",
    online: "online",
    orchestrate: "orchestrate",
    pairCode: "Pair Code",
    pairCodeCreated: "pair code created",
    pairCodeFailed: "pair code failed: {message}",
    pairJoinPlaceholder: "Create a pair code",
    completed: "completed",
    failed: "failed",
    finishing: "finishing",
    running: "running",
    copyJoin: "Copy Join",
    createJoin: "Create Join",
    edgeJoin: "Edge Join",
    edgeJoinCreated: "edge join command created",
    edgeJoinFailed: "edge join failed: {message}",
    edgeJoinPlaceholder: "Create a join command",
    edgeLabel: "Edge Label",
    edgeLabelPlaceholder: "office-macbook",
    edgeTokens: "Edge Tokens",
    edgeTokensLoaded: "loaded {count} edge tokens",
    edgeTokensLoadFailed: "edge tokens failed: {message}",
    edgeTokenRevoked: "edge token revoked",
    edgeTokenRevokeFailed: "edge token revoke failed: {message}",
    prompt: "Prompt",
    queued: "Queued",
    quickstart: "Quickstart",
    readiness: "Readiness",
    readiness_central_unhealthy: "Central health did not report ok.",
    readiness_queue_needs_agent: "Central has queued work, but no agent is currently marked busy.",
    readiness_ready: "Central and edge agents are ready for work.",
    readiness_stale_room_runs: "Central is usable, but old queued room runs need operator review.",
    readiness_token_needed: "Gateway is reachable, but authenticated details are hidden.",
    readiness_waiting_for_edge: "Central is up, but no online edge agents are ready to receive work.",
    readiness_working: "Agents are connected and work is currently active.",
    refresh: "Refresh",
    reload: "Reload",
    reachable: "reachable",
    recentRooms: "Recent Rooms",
    reports: "reports",
    response: "Response",
    responsesApi: "Responses",
    revoked: "revoked",
    revoke: "Revoke",
    role: "Role",
    route: "Route",
    routeFailed: "route failed: {message}",
    routeLog: "route: {reason}",
    routeSummary: "Route: {agents}",
    rooms: "Rooms",
    roomCreated: "room created: {id}",
    roomFailed: "room failed: {message}",
    roomGoalEmpty: "room goal is empty",
    roomGoalPlaceholder: "Describe the goal for the autonomous agent room",
    roomMessage: "Message",
    roomMessageEmpty: "room message is empty",
    roomMessageFailed: "room message failed: {message}",
    roomMessagePlaceholder: "Send a message into the selected room",
    roomMessageSent: "room message sent",
    roomDoctor: "Doctor",
    roomDoctorFailed: "room doctor failed: {message}",
    roomHistoryFallback: "room chat history endpoint unavailable; using room snapshot: {message}",
    roomLoadFailed: "room load failed: {message}",
    roomChat: "Room Chat",
    roomTimeline: "Room Timeline",
    pauseRoom: "Pause",
    pauseRoomFailed: "pause failed: {message}",
    paused: "paused",
    rounds: "Rounds",
    runTask: "Run Task",
    save: "Save",
    seen: "Seen",
    selectedAgents: "selected agents",
    send: "Send",
    showTrace: "Show Trace",
    stopPolling: "Stop Polling",
    status: "Status",
    statusCommand: "Status command",
    recoveryCommands: "Recovery commands",
    statusLoadFailed: "status failed: {message}",
    statusLoaded: "readiness: {status}",
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
    ttlSeconds: "TTL Seconds",
    timeoutSeconds: "Timeout (s)",
    trace: "Trace",
    traceFailed: "trace failed: {message}",
    traceId: "Trace ID",
    traceLoaded: "trace loaded: {id}",
    traceOutput: "Trace Output",
    tracePlaceholder: "Paste trace id, or open a room with trace_id",
    traces: "Traces",
    unknown: "unknown",
    unreachable: "unreachable",
    not_configured: "not configured",
    none: "none",
    waiting: "waiting..."
    ,
    nextActions: "Next Actions",
    noNextActions: "No pending next actions.",
    wake: "Wake",
    wakeAll: "all selected",
    wakeFirst: "first selected",
    wakeNext: "Wake Next",
    wakeRoomFailed: "wake failed: {message}"
  },
  zh: {
    agent: "Agent",
    agents: "智能体",
    agentsLoaded: "已加载 {count} 个智能体",
    agentsLoadFailed: "无法加载智能体：{message}",
    agentsLogFailed: "智能体加载失败：{message}",
    activeRooms: "活跃房间",
    activeRuns: "活跃运行",
    active: "活跃",
    activity: "活动",
    apiEndpoint: "接口",
    autonomousRoom: "自主房间",
    autoDetect: "自动检测",
    broadcast: "广播给全部",
    busy: "忙碌",
    capabilities: "能力",
    permissionProfile: "权限",
    permissionCoverage: "权限覆盖",
    owner: "负责人",
    runtime: "运行时",
    costClass: "成本",
    latencyClass: "延迟",
    wakeTargets: "唤醒目标",
    cacheScope: "缓存作用域",
    cacheScopePlaceholder: "agent:<id> 调用的可选稳定键",
    chatPlaceholder: "通过 /v1/chat/completions 发送消息",
    chatCompletions: "Chat Completions",
    checking: "检查中",
    clear: "清空",
    copy: "复制",
    copied: "已复制",
    copyStatus: "复制状态命令",
    events: "事件",
    exportJson: "导出 JSON",
    exportSummary: "导出报告",
    exported: "已导出",
    format: "格式",
    gateway: "网关",
    groupChat: "群聊",
    groupNeedsAgents: "群聊至少需要选择两个智能体",
    createPairCode: "生成短码",
    createRoom: "创建房间",
    goal: "目标",
    healthFailed: "健康检查失败：{message}",
    health: "健康",
    human: "人类可读",
    idle: "空闲",
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
    maxSteps: "最大步数（0 = 不限制）",
    modelsCheck: "模型路由",
    modelsLoaded: "已加载 {count} 个模型",
    plugins: "插件",
    pluginsLoaded: "已加载插件状态",
    pluginsLoadFailed: "插件加载失败：{message}",
    preset: "预设",
    telegramBot: "Telegram Bot",
    enabled: "已启用",
    disabled: "未启用",
    configured: "已配置",
    dry_run: "dry-run",
    nodesLoaded: "已加载 {count} 个节点",
    nodesLoadFailed: "节点加载失败：{message}",
    noNodes: "没有已注册的节点。",
    noTrace: "尚未加载 trace。",
    noAgents: "没有已注册的智能体。",
    noAgentChat: "还没有 agent 对话。",
    noComposerMatches: "没有匹配项",
    roomDebugDetails: "调试详情",
    noRoom: "尚未选择房间。",
    noThread: "尚未选择线程。",
    node: "节点",
    nodes: "节点",
    onlineAgents: "在线",
    overview: "概览",
    offline: "离线",
    online: "在线",
    orchestrate: "自动编排",
    pairCode: "Pair Code",
    pairCodeCreated: "Pair Code 已生成",
    pairCodeFailed: "Pair Code 生成失败：{message}",
    pairJoinPlaceholder: "生成短期接入码",
    completed: "已完成",
    failed: "失败",
    finishing: "收尾中",
    running: "运行中",
    copyJoin: "复制接入命令",
    createJoin: "生成接入",
    edgeJoin: "Edge 接入",
    edgeJoinCreated: "Edge 接入命令已生成",
    edgeJoinFailed: "Edge 接入失败：{message}",
    edgeJoinPlaceholder: "生成接入命令",
    edgeLabel: "Edge 名称",
    edgeLabelPlaceholder: "office-macbook",
    edgeTokens: "Edge Token",
    edgeTokensLoaded: "已加载 {count} 个 Edge Token",
    edgeTokensLoadFailed: "Edge Token 加载失败：{message}",
    edgeTokenRevoked: "Edge Token 已撤销",
    edgeTokenRevokeFailed: "Edge Token 撤销失败：{message}",
    prompt: "提示词",
    queued: "队列",
    quickstart: "快速状态",
    readiness: "就绪状态",
    readiness_central_unhealthy: "Central 健康检查未返回 ok。",
    readiness_queue_needs_agent: "Central 有排队任务，但当前没有智能体被标记为忙碌。",
    readiness_ready: "Central 和 Edge 智能体已准备好接收任务。",
    readiness_stale_room_runs: "Central 可用，但旧的房间排队任务需要检查。",
    readiness_token_needed: "网关可达，但认证后的详情被隐藏。",
    readiness_waiting_for_edge: "Central 已启动，但还没有在线 Edge 智能体可接收任务。",
    readiness_working: "智能体已连接，当前有任务正在运行。",
    refresh: "刷新",
    reload: "重新加载",
    reachable: "可达",
    recentRooms: "最近房间",
    reports: "报告",
    response: "响应",
    responsesApi: "Responses",
    revoked: "已撤销",
    revoke: "撤销",
    role: "角色",
    route: "路由",
    routeFailed: "路由失败：{message}",
    routeLog: "路由：{reason}",
    routeSummary: "路由到：{agents}",
    rooms: "房间",
    roomCreated: "房间已创建：{id}",
    roomFailed: "房间创建失败：{message}",
    roomGoalEmpty: "房间目标不能为空",
    roomGoalPlaceholder: "描述这个自主 agent 房间要完成的目标",
    roomMessage: "消息",
    roomMessageEmpty: "房间消息不能为空",
    roomMessageFailed: "房间消息发送失败：{message}",
    roomMessagePlaceholder: "向当前选中的房间发送消息",
    roomMessageSent: "房间消息已发送",
    roomDoctor: "诊断",
    roomDoctorFailed: "房间诊断失败：{message}",
    roomHistoryFallback: "房间聊天记录接口不可用，已使用房间快照：{message}",
    roomLoadFailed: "房间加载失败：{message}",
    roomChat: "房间群聊",
    roomTimeline: "房间时间线",
    pauseRoom: "暂停",
    pauseRoomFailed: "暂停失败：{message}",
    paused: "已暂停",
    rounds: "轮数",
    runTask: "运行任务",
    save: "保存",
    seen: "最近在线",
    selectedAgents: "选中的智能体",
    send: "发送",
    showTrace: "查看 Trace",
    stopPolling: "停止轮询",
    status: "状态",
    statusCommand: "状态命令",
    recoveryCommands: "恢复命令",
    statusLoadFailed: "状态加载失败：{message}",
    statusLoaded: "就绪状态：{status}",
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
    ttlSeconds: "有效期（秒）",
    timeoutSeconds: "超时（秒）",
    trace: "Trace",
    traceFailed: "trace 加载失败：{message}",
    traceId: "Trace ID",
    traceLoaded: "trace 已加载：{id}",
    traceOutput: "Trace 输出",
    tracePlaceholder: "粘贴 trace id，或从房间 trace_id 打开",
    traces: "Trace",
    unknown: "未知",
    unreachable: "不可达",
    not_configured: "未配置",
    none: "无",
    waiting: "等待中...",
    nextActions: "下一步",
    noNextActions: "暂无待处理动作。",
    wake: "唤醒",
    wakeAll: "全部选中",
    wakeFirst: "第一个选中",
    wakeNext: "唤醒下一个",
    wakeRoomFailed: "唤醒失败：{message}"
  }
};

const apiBase = new URL("../", window.location.href);
$("gatewayLabel").textContent = apiBase.href.replace(/\/$/, "");
$("tokenInput").value = initialConsoleToken();
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
}));
$("saveTokenButton").addEventListener("click", saveToken);
$("tokenInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") saveToken();
});
$("refreshButton").addEventListener("click", refreshAll);
$("copyStatusCommandButton").addEventListener("click", copyStatusCommand);
$("copyEdgeJoinButton").addEventListener("click", copyEdgeJoinCommand);
$("edgeJoinForm").addEventListener("submit", createEdgeJoin);
$("copyPairJoinButton").addEventListener("click", copyPairJoinCommand);
$("pairCodeForm").addEventListener("submit", createPairCode);
$("loadNodesButton").addEventListener("click", loadNodes);
$("loadAgentsButton").addEventListener("click", loadAgents);
$("loadPluginsButton").addEventListener("click", loadManifest);
$("loadRoomsButton").addEventListener("click", loadRooms);
$("roomForm").addEventListener("submit", createRoom);
$("roomDoctorButton").addEventListener("click", loadCurrentRoomDoctor);
$("roomTraceButton").addEventListener("click", openCurrentRoomTrace);
$("exportRoomButton").addEventListener("click", exportCurrentRoomSummary);
$("wakeRoomButton").addEventListener("click", wakeCurrentRoom);
$("pauseRoomButton").addEventListener("click", pauseCurrentRoom);
$("roomMessageForm").addEventListener("submit", sendRoomMessage);
$("routeButton").addEventListener("click", routeTask);
$("taskForm").addEventListener("submit", submitTask);
$("taskMode").addEventListener("change", syncTaskMode);
$("stopPollingButton").addEventListener("click", stopPolling);
$("loadModelsButton").addEventListener("click", loadModels);
$("chatForm").addEventListener("submit", sendChat);
$("clearModelOutputButton").addEventListener("click", () => { $("modelOutput").textContent = ""; });
$("traceForm").addEventListener("submit", lookupTrace);
$("traceFormat").addEventListener("change", () => {
  if (state.currentTrace) renderTrace(state.currentTrace);
});
$("exportTraceButton").addEventListener("click", exportCurrentTrace);
$("clearTraceButton").addEventListener("click", () => {
  state.currentTrace = null;
  $("traceOutput").textContent = "";
});
$("clearEventsButton").addEventListener("click", () => { $("eventLog").textContent = ""; });

initComposerAssist();
refreshAll();
syncTaskMode();
setInterval(() => {
  loadHealth();
  if (currentToken()) loadStatus({ silent: true });
}, 8000);

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.remove("active"));
  $(`${name}Panel`).classList.add("active");
}

async function refreshAll() {
  await loadHealth();
  await loadStatus({ silent: true });
  await loadManifest();
  await loadEdgeTokens();
  await loadNodes();
  await loadAgents();
  await loadRooms();
  await loadModels({ silent: true });
}

async function saveToken() {
  const token = normalizeToken($("tokenInput").value);
  $("tokenInput").value = token;
  if (!token) {
    sessionStorage.removeItem("agentBusToken");
    state.status = null;
    state.edgeTokens = [];
    state.edgeJoinCommand = "";
    state.pairJoinCommand = "";
    state.pairCode = null;
    setTokenStatus("tokenRequiredShort", "failed");
    renderEdgeJoin();
    renderPairJoin();
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
    state.health = data;
    setGatewayStatus(data.ok ? "online" : "unknown", data.ok ? "status online" : "status");
    $("nodeCount").textContent = data.nodes ?? "-";
    $("agentCount").textContent = data.agents ?? "-";
    $("queuedCount").textContent = data.queued ?? "-";
    if (!state.agents.length) $("onlineAgentCount").textContent = data.agents ?? "-";
    renderOverview();
  } catch (err) {
    state.health = null;
    setGatewayStatus("offline", "status failed");
    renderOverview();
    logEvent(t("healthFailed", { message: err.message }));
  }
}

async function loadStatus({ silent = false } = {}) {
  if (!currentToken()) {
    state.status = null;
    renderOverview();
    return;
  }
  try {
    const data = await request("v1/agent-bus/status");
    state.status = data;
    updateStatusSummaryStats(data.summary);
    renderOverview();
    if (!silent) logEvent(t("statusLoaded", { status: data.readiness?.status || "unknown" }));
  } catch (err) {
    state.status = null;
    renderOverview();
    if (!silent) logEvent(t("statusLoadFailed", { message: err.message }));
  }
}

async function loadNodes() {
  try {
    state.nodes = await request("nodes");
    renderNodes();
    updateDashboardStats();
    logEvent(t("nodesLoaded", { count: state.nodes.length }));
  } catch (err) {
    state.nodes = [];
    renderNodes();
    renderOverview();
    logEvent(t("nodesLoadFailed", { message: err.message }));
  }
}

async function loadManifest() {
  if (!currentToken()) {
    state.manifest = null;
    renderPlugins();
    renderOverview();
    return;
  }
  try {
    state.manifest = await request("v1/agent-bus/manifest");
    renderPlugins();
    renderOverview();
    logEvent(t("pluginsLoaded"));
  } catch (err) {
    state.manifest = null;
    renderPlugins();
    renderOverview();
    logEvent(t("pluginsLoadFailed", { message: err.message }));
  }
}

async function loadEdgeTokens() {
  if (!currentToken()) {
    state.edgeTokens = [];
    renderEdgeJoin();
    return;
  }
  try {
    const data = await request("v1/agent-bus/edge-tokens");
    state.edgeTokens = Array.isArray(data) ? data : data.edgeTokens || data.tokens || [];
    renderEdgeJoin();
    logEvent(t("edgeTokensLoaded", { count: state.edgeTokens.length }));
  } catch (err) {
    state.edgeTokens = [];
    renderEdgeJoin();
    logEvent(t("edgeTokensLoadFailed", { message: err.message }));
  }
}

async function loadAgents() {
  try {
    state.agents = await request("agents");
    const knownIds = new Set(state.agents.map((agent) => agent.id));
    for (const selected of [...state.selectedAgents]) {
      if (!knownIds.has(selected)) state.selectedAgents.delete(selected);
    }
    if (!state.selectedAgents.size) {
      for (const agent of state.agents) state.selectedAgents.add(agent.id);
    }
    renderAgents();
    updateDashboardStats();
    renderOverview();
    logEvent(t("agentsLoaded", { count: state.agents.length }));
  } catch (err) {
    renderAuthError(err);
    renderOverview();
  }
}

function renderPlugins() {
  const list = $("pluginsList");
  list.textContent = "";
  const telegram = state.manifest?.plugins?.telegramBot;
  if (!telegram) {
    const row = document.createElement("div");
    row.className = "check-row";
    row.innerHTML = `
      <span class="status unknown">--</span>
      <strong>${escapeHtml(t("telegramBot"))}</strong>
      <span>${escapeHtml(currentToken() ? t("unknown") : t("tokenRequiredShort"))}</span>
    `;
    list.append(row);
    return;
  }
  const detail = telegram.enabled
    ? `${telegram.configured ? t("configured") : t("not_configured")}${telegram.dry_run ? ` / ${t("dry_run")}` : ""}`
    : t("disabled");
  const row = document.createElement("div");
  row.className = "check-row";
  row.innerHTML = `
    <span class="status ${telegram.enabled ? (telegram.configured || telegram.dry_run ? "online" : "paused") : "unknown"}">${escapeHtml(telegram.enabled ? "OK" : "--")}</span>
    <strong>${escapeHtml(t("telegramBot"))}</strong>
    <span>${escapeHtml(detail)}</span>
  `;
  list.append(row);
}

function renderAgents() {
  const tbody = $("agentsTable");
  tbody.textContent = "";
  if (!state.agents.length) {
    tbody.append(rowMessage(t("noAgents")));
    return;
  }
  for (const agent of state.agents) {
    const ping = agent.ping_status || "unknown";
    const lastRun = agent.last_run_status || "";
    const activity = agentActivity(agent);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-agent="${escapeHtml(agent.id)}" ${state.selectedAgents.has(agent.id) ? "checked" : ""}></td>
      <td><div class="agent-name">${escapeHtml(agent.id)}</div><span class="status ${escapeHtml(agent.status || agent.node_status || "")}">${escapeHtml(statusText(agent.status || agent.node_status || "unknown"))}</span></td>
      <td>${escapeHtml(agent.node_id || "-")}</td>
      <td><span class="status ${escapeHtml(ping)}">${escapeHtml(statusText(ping))}</span>${lastRun ? `<div class="muted">${escapeHtml(statusText(lastRun))}</div>` : ""}</td>
      <td><span class="status ${escapeHtml(activity)}">${escapeHtml(statusText(activity))}</span></td>
      <td>${escapeHtml(agent.kind || "-")}</td>
      <td>${escapeHtml(agent.role || "-")}</td>
      <td>${permissionProfileHtml(agent)}</td>
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

function permissionProfileHtml(agent) {
  const profile = agent.permission_profile || agent.permissionProfile || "";
  const owner = agent.owner || "";
  const runtime = agent.runtime || "";
  const costClass = agent.cost_class || agent.costClass || "";
  const latencyClass = agent.latency_class || agent.latencyClass || "";
  const wakeTargets = Array.isArray(agent.allowed_wake_targets)
    ? agent.allowed_wake_targets
    : Array.isArray(agent.allowedWakeTargets)
      ? agent.allowedWakeTargets
      : [];
  const rooms = Array.isArray(agent.allowed_rooms)
    ? agent.allowed_rooms
    : Array.isArray(agent.allowedRooms)
      ? agent.allowedRooms
      : [];
  const hasWakeTargets = hasOwn(agent, "allowed_wake_targets") || hasOwn(agent, "allowedWakeTargets");
  const hasRooms = hasOwn(agent, "allowed_rooms") || hasOwn(agent, "allowedRooms");
  const lines = [
    `<span class="status ${profile ? "online" : "paused"}">${escapeHtml(profile || "unprofiled")}</span>`
  ];
  if (owner) lines.push(`<div class="muted">${escapeHtml(t("owner"))}: ${escapeHtml(owner)}</div>`);
  if (runtime) lines.push(`<div class="muted">${escapeHtml(t("runtime"))}: ${escapeHtml(runtime)}</div>`);
  if (costClass || latencyClass) {
    const parts = [];
    if (costClass) parts.push(`${t("costClass")}: ${costClass}`);
    if (latencyClass) parts.push(`${t("latencyClass")}: ${latencyClass}`);
    lines.push(`<div class="muted">${escapeHtml(parts.join(" / "))}</div>`);
  }
  if (hasWakeTargets) lines.push(`<div class="muted">${escapeHtml(t("wakeTargets"))}: ${escapeHtml(wakeTargets.length ? wakeTargets.join(", ") : t("none"))}</div>`);
  if (hasRooms) lines.push(`<div class="muted">${escapeHtml(t("rooms"))}: ${escapeHtml(rooms.length ? rooms.join(", ") : t("none"))}</div>`);
  return lines.join("");
}

function hasOwn(value, key) {
  return Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
}

function rowMessage(message, colSpan = 10) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = colSpan;
  td.className = "muted";
  td.textContent = message;
  tr.append(td);
  return tr;
}

function renderNodes() {
  const tbody = $("nodesTable");
  tbody.textContent = "";
  if (!state.nodes.length) {
    tbody.append(rowMessage(t("noNodes"), 4));
    return;
  }
  for (const node of state.nodes) {
    const id = node.id || node.node_id || "-";
    const status = node.status || node.node_status || "unknown";
    const agents = (node.agents || []).map((agent) => typeof agent === "string" ? agent : agent.id).filter(Boolean);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><div class="agent-name">${escapeHtml(id)}</div></td>
      <td><span class="status ${escapeHtml(status)}">${escapeHtml(statusText(status))}</span></td>
      <td>${agents.map((agent) => `<span class="pill">${escapeHtml(agent)}</span>`).join("") || "-"}</td>
      <td>${escapeHtml(node.last_seen_at || node.node_last_seen_at || "-")}</td>
    `;
    tbody.append(tr);
  }
}

function renderOverview() {
  renderReadinessPanel();
  const checks = quickstartChecks();
  const list = $("quickstartList");
  list.textContent = "";
  for (const item of checks) {
    const row = document.createElement("div");
    row.className = "check-row";
    row.innerHTML = `
      <span class="status ${item.ok ? "online" : item.warn ? "paused" : "unknown"}">${escapeHtml(item.ok ? "OK" : item.warn ? "WAIT" : "--")}</span>
      <strong>${escapeHtml(item.label)}</strong>
      <span>${escapeHtml(item.detail)}</span>
    `;
    list.append(row);
  }
  $("quickstartCommands").textContent = quickstartCommandText();
  renderEdgeJoin();
}

function renderReadinessPanel() {
  const panel = $("readinessPanel");
  if (!panel) return;
  const status = state.status;
  const readiness = status?.readiness || (!currentToken()
    ? { level: "limited", status: "token-needed", message: t("readiness_token_needed") }
    : null);
  if (!readiness) {
    panel.className = "readiness-panel readiness-unknown";
    panel.innerHTML = `
      <div class="readiness-header">
        <span class="status unknown">--</span>
        <div>
          <strong>${escapeHtml(t("readiness"))}</strong>
          <span>${escapeHtml(t("waiting"))}</span>
        </div>
      </div>
    `;
    return;
  }
  const summary = status?.summary || {};
  const level = String(readiness.level || "unknown").toLowerCase();
  const label = String(readiness.status || readiness.level || "unknown");
  const actions = Array.isArray(status?.next_actions) ? status.next_actions : [];
  const permission = status?.permission_observations || null;
  const permissionMetric = permission?.total_agents
    ? `<span>${escapeHtml(t("permissionCoverage"))}: ${escapeHtml(permission.with_permission_profile || 0)}/${escapeHtml(permission.total_agents || 0)}</span>`
    : "";
  panel.className = `readiness-panel readiness-${escapeClass(level)}`;
  panel.innerHTML = `
    <div class="readiness-header">
      <span class="status ${readinessStatusClass(level)}">${escapeHtml(label)}</span>
      <div>
        <strong>${escapeHtml(t("readiness"))}</strong>
        <span>${escapeHtml(readinessMessage(readiness))}</span>
      </div>
    </div>
    <div class="readiness-metrics">
      <span>${escapeHtml(t("nodes"))}: ${escapeHtml(summary.nodes ?? state.health?.nodes ?? "-")}/${escapeHtml(summary.registered_nodes ?? state.health?.registered_nodes ?? "-")}</span>
      <span>${escapeHtml(t("agents"))}: ${escapeHtml(summary.agents ?? state.health?.agents ?? "-")}/${escapeHtml(summary.registered_agents ?? state.health?.registered_agents ?? "-")}</span>
      <span>${escapeHtml(t("queued"))}: ${escapeHtml(summary.queued ?? state.health?.queued ?? "-")}</span>
      <span>${escapeHtml(t("activeRooms"))}: ${escapeHtml(summary.active_rooms ?? "-")}</span>
      ${permissionMetric}
    </div>
    <div class="readiness-actions">
      <strong>${escapeHtml(t("nextActions"))}</strong>
      ${actions.length
        ? `<ul>${actions.map(renderNextAction).join("")}</ul>`
        : `<span>${escapeHtml(t("noNextActions"))}</span>`}
    </div>
  `;
  wireReadinessActionCopy(panel);
}

function renderNextAction(action) {
  const command = nextActionCommand(action);
  if (!command) return `<li>${escapeHtml(action)}</li>`;
  return `
    <li class="next-action-item">
      <span>${escapeHtml(action)}</span>
      <code>${escapeHtml(command)}</code>
      <button type="button" class="copy-action-button" data-copy-command="${escapeHtml(command)}">${escapeHtml(t("copy"))}</button>
    </li>
  `;
}

function nextActionCommand(action) {
  const text = String(action || "").trim();
  const colonCommand = text.match(/:\s*(agent-bus\s+.+)$/);
  if (colonCommand) return trimNextActionCommand(colonCommand[1]);

  const withCommand = text.match(/\bwith\s+(agent-bus\s+.+)$/);
  if (withCommand) return trimNextActionCommand(withCommand[1]);

  const runCommand = text.match(/^Run\s+(agent-bus\s+.+?)(?:\s+on\s+the\s+edge\s+host\b|[.;]\s*$)/);
  if (runCommand) return trimNextActionCommand(runCommand[1]);

  const fullCommand = text.match(/^(agent-bus\s+.+)$/);
  return fullCommand ? trimNextActionCommand(fullCommand[1]) : "";
}

function trimNextActionCommand(command) {
  return String(command || "").trim().replace(/[.;]\s*$/, "");
}

function wireReadinessActionCopy(panel) {
  for (const button of panel.querySelectorAll("[data-copy-command]")) {
    button.addEventListener("click", () => copyTextToClipboard(button.dataset.copyCommand || "", button));
  }
}

function readinessMessage(readiness) {
  const key = `readiness_${String(readiness.status || "").replace(/-/g, "_")}`;
  if (messages[state.lang]?.[key] || messages.en[key]) return t(key);
  return readiness.message || readiness.status || readiness.level || "unknown";
}

function readinessStatusClass(level) {
  if (["ready", "active"].includes(level)) return "online";
  if (["attention", "setup", "limited"].includes(level)) return "paused";
  if (["critical"].includes(level)) return "failed";
  return "unknown";
}

function escapeClass(value) {
  return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

function quickstartChecks() {
  const token = currentToken();
  const onlineNodes = state.nodes.filter((node) => String(node.status || node.node_status || "").toLowerCase() === "online");
  const onlineAgents = state.agents.filter((agent) => String(agent.status || agent.node_status || "").toLowerCase() === "online");
  const activeRooms = state.rooms.filter((room) => ["active", "running", "finishing"].includes(String(room.status || "").toLowerCase()));
  const telegram = state.manifest?.plugins?.telegramBot;
  const permission = state.status?.permission_observations || permissionObservationsFromAgents();
  return [
    {
      label: t("gateway"),
      ok: Boolean(state.health?.ok),
      detail: state.health ? `${state.health.nodes ?? 0}/${state.health.registered_nodes ?? state.health.nodes ?? 0} ${t("nodes")}` : t("offline")
    },
    {
      label: t("token"),
      ok: Boolean(token),
      warn: !token,
      detail: token ? t("tokenSaved") : t("tokenRequiredShort")
    },
    {
      label: t("nodes"),
      ok: onlineNodes.length > 0,
      warn: state.nodes.length > 0,
      detail: `${onlineNodes.length}/${state.nodes.length || state.health?.registered_nodes || 0} ${t("online")}`
    },
    {
      label: t("agents"),
      ok: onlineAgents.length > 0,
      warn: state.agents.length > 0,
      detail: `${onlineAgents.length}/${state.agents.length || state.health?.registered_agents || 0} ${t("onlineAgents")}`
    },
    {
      label: t("rooms"),
      ok: activeRooms.length > 0 || state.rooms.length > 0,
      warn: state.rooms.length > 0,
      detail: `${activeRooms.length} ${t("activeRooms")} / ${state.rooms.length} ${t("rooms")}`
    },
    {
      label: t("modelsCheck"),
      ok: state.models.length > 0,
      warn: !state.models.length,
      detail: `${state.models.length} ${t("models")}`
    },
    {
      label: t("permissionProfile"),
      ok: Number(permission.total_agents || 0) > 0 && Number(permission.with_permission_profile || 0) === Number(permission.total_agents || 0),
      warn: Number(permission.total_agents || 0) > 0,
      detail: permissionCoverageDetail(permission)
    },
    {
      label: t("telegramBot"),
      ok: Boolean(telegram?.enabled && (telegram.configured || telegram.dry_run)),
      warn: Boolean(telegram?.enabled),
      detail: telegram ? (telegram.enabled ? `${telegram.configured ? t("configured") : t("not_configured")}${telegram.dry_run ? ` / ${t("dry_run")}` : ""}` : t("disabled")) : t("unknown")
    }
  ];
}

function permissionObservationsFromAgents() {
  const agents = state.agents || [];
  const validAgents = agents.filter((agent) => String(agent.id || "").trim());
  const profileCounts = {};
  for (const agent of validAgents) {
    const profile = String(agent.permission_profile || agent.permissionProfile || "").trim();
    if (profile) profileCounts[profile] = (profileCounts[profile] || 0) + 1;
  }
  return {
    total_agents: validAgents.length,
    with_permission_profile: validAgents.filter((agent) => agent.permission_profile || agent.permissionProfile).length,
    with_allowed_wake_targets: validAgents.filter((agent) => hasOwn(agent, "allowed_wake_targets") || hasOwn(agent, "allowedWakeTargets")).length,
    with_allowed_rooms: validAgents.filter((agent) => hasOwn(agent, "allowed_rooms") || hasOwn(agent, "allowedRooms")).length,
    with_owner: validAgents.filter((agent) => agent.owner).length,
    with_runtime: validAgents.filter((agent) => agent.runtime).length,
    with_cost_class: validAgents.filter((agent) => agent.cost_class || agent.costClass).length,
    with_latency_class: validAgents.filter((agent) => agent.latency_class || agent.latencyClass).length,
    profiles: profileCounts
  };
}

function permissionCoverageDetail(permission = {}) {
  const total = Number(permission.total_agents || 0);
  const profile = `${permission.with_permission_profile || 0}/${total} permission_profile`;
  if (!total) return profile;
  const wake = `${permission.with_allowed_wake_targets || 0}/${total} wake`;
  const rooms = `${permission.with_allowed_rooms || 0}/${total} rooms`;
  const runtime = `${permission.with_runtime || 0}/${total} runtime`;
  return `${profile} / ${wake} / ${rooms} / ${runtime}`;
}

function quickstartCommandText() {
  const gateway = apiBase.href.replace(/\/$/, "");
  const agents = [...state.selectedAgents].join(",") || "agent-id";
  const lines = [
    `${t("statusCommand")}:`,
    `agent-bus status --gateway ${gateway} --token ***`,
    "",
    "Room:",
    `agent-bus room create --gateway ${gateway} --token *** --agents ${agents} --goal "Check current Agent Bus status and report next action."`
  ];
  const recoveryCommands = recoveryCommandLines(gateway);
  if (recoveryCommands.length) {
    lines.push("", `${t("recoveryCommands")}:`, ...recoveryCommands);
  }
  if (state.currentRoom?.trace_id) {
    lines.push("", "Trace:", `agent-bus trace show ${state.currentRoom.trace_id} --gateway ${gateway} --token ***`);
  }
  return lines.join("\n");
}

function recoveryCommandLines(gateway) {
  const hints = Array.isArray(state.status?.recovery_hints) ? state.status.recovery_hints : [];
  const commands = [];
  for (const hint of hints.slice(0, 3)) {
    for (const key of ["inspect_command", "recover_command", "pause_command"]) {
      const command = hint?.[key];
      if (command) commands.push(withGatewayToken(command, gateway));
    }
  }
  return [...new Set(commands)];
}

function withGatewayToken(command, gateway) {
  const text = String(command || "").trim();
  if (!text) return "";
  const hasGateway = /(?:^|\s)--gateway(?:\s|=)/.test(text);
  const hasToken = /(?:^|\s)--token(?:\s|=)/.test(text);
  return `${text}${hasGateway ? "" : ` --gateway ${gateway}`}${hasToken ? "" : " --token ***"}`;
}

async function copyStatusCommand() {
  const command = quickstartCommandText().split("\n").find((line) => line.startsWith("agent-bus status"));
  if (!command) return;
  await copyTextToClipboard(command, $("quickstartCommands"));
}

async function copyTextToClipboard(text, fallbackElement = null) {
  const value = String(text || "");
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      fallbackElement?.focus?.();
    }
  } catch {
    fallbackElement?.focus?.();
  }
  logEvent(t("copied"));
}

async function createEdgeJoin(event) {
  event.preventDefault();
  const label = $("edgeJoinLabel").value.trim();
  try {
    const data = await request("v1/agent-bus/edge-tokens", {
      method: "POST",
      body: { label: label || "web-console" }
    });
    if (data.edgeToken) upsertEdgeToken(data.edgeToken);
    state.edgeJoinCommand = data.token ? edgeJoinCommand(data.token) : "";
    renderEdgeJoin();
    logEvent(t("edgeJoinCreated"));
  } catch (err) {
    logEvent(t("edgeJoinFailed", { message: err.message }));
  }
}

function renderEdgeJoin() {
  const command = state.edgeJoinCommand || "";
  const activeTokens = state.edgeTokens.filter((item) => String(item.status || "active").toLowerCase() === "active");
  $("edgeTokenSummary").textContent = currentToken()
    ? `${activeTokens.length}/${state.edgeTokens.length} ${t("edgeTokens")}`
    : t("tokenRequiredShort");
  $("edgeJoinCommand").textContent = command || t("edgeJoinPlaceholder");
  $("copyEdgeJoinButton").disabled = !command;
  renderEdgeTokenList();
  renderPairJoin();
}

function edgeJoinCommand(token) {
  const gateway = apiBase.href.replace(/\/$/, "");
  return `agent-bus setup edge --gateway ${gateway} --token ${token} --auto --service auto --out edge.config.json`;
}

async function copyEdgeJoinCommand() {
  if (!state.edgeJoinCommand) {
    $("edgeJoinCommand").focus();
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(state.edgeJoinCommand);
    } else {
      $("edgeJoinCommand").focus();
    }
  } catch {
    $("edgeJoinCommand").focus();
  }
  logEvent(t("copied"));
}

function upsertEdgeToken(edgeToken) {
  const id = edgeToken?.id;
  if (!id) return;
  state.edgeTokens = [edgeToken, ...state.edgeTokens.filter((item) => item.id !== id)];
}

function renderEdgeTokenList() {
  const list = $("edgeTokenList");
  list.textContent = "";
  for (const token of state.edgeTokens.slice(0, 8)) {
    const status = String(token.status || "active").toLowerCase();
    const row = document.createElement("div");
    row.className = "edge-token-row";
    row.innerHTML = `
      <div>
        <strong>${escapeHtml(token.label || token.id || "-")}</strong>
        <span class="muted">${escapeHtml(token.id || "")}</span>
      </div>
      <span class="status ${escapeHtml(status)}">${escapeHtml(statusText(status))}</span>
      <span class="muted">${escapeHtml(token.created_at || "")}</span>
      <button type="button" class="danger-button" data-edge-token-id="${escapeHtml(token.id || "")}" ${status === "revoked" ? "disabled" : ""}>${escapeHtml(t("revoke"))}</button>
    `;
    const button = row.querySelector("button");
    button.addEventListener("click", () => revokeEdgeToken(token.id));
    list.append(row);
  }
}

async function revokeEdgeToken(id) {
  if (!id) return;
  try {
    const data = await request("v1/agent-bus/edge-tokens/revoke", {
      method: "POST",
      body: { id }
    });
    if (data.edgeToken) upsertEdgeToken(data.edgeToken);
    renderEdgeJoin();
    logEvent(t("edgeTokenRevoked"));
  } catch (err) {
    logEvent(t("edgeTokenRevokeFailed", { message: err.message }));
  }
}

async function createPairCode(event) {
  event.preventDefault();
  const label = $("pairCodeLabel").value.trim();
  const preset = $("pairCodePreset").value.trim();
  const ttlSeconds = Math.max(30, Math.min(86400, Number.parseInt($("pairCodeTtl").value || "600", 10) || 600));
  $("pairCodeTtl").value = String(ttlSeconds);
  try {
    const data = await request("v1/agent-bus/pair-codes", {
      method: "POST",
      body: {
        gatewayUrl: apiBase.href.replace(/\/$/, ""),
        ttlSeconds,
        ...(label ? { label } : {}),
        ...(preset ? { agentPreset: preset } : {})
      }
    });
    state.pairCode = data;
    state.pairJoinCommand = pairJoinCommand(data);
    renderPairJoin();
    logEvent(t("pairCodeCreated"));
  } catch (err) {
    logEvent(t("pairCodeFailed", { message: err.message }));
  }
}

function renderPairJoin() {
  const command = state.pairJoinCommand || "";
  const code = state.pairCode?.code || "";
  const expires = state.pairCode?.expires_at || "";
  $("pairCodeSummary").textContent = code ? `${code} / ${expires}` : t("pairJoinPlaceholder");
  $("pairJoinCommand").textContent = command || t("pairJoinPlaceholder");
  $("copyPairJoinButton").disabled = !command;
}

function pairJoinCommand(data = {}) {
  const gateway = String(data.gatewayUrl || apiBase.href).replace(/\/$/, "");
  const code = data.code || "ABCD-2345";
  const preset = data.agentPreset ? ` --preset ${data.agentPreset}` : "";
  return `agent-bus setup edge --gateway ${gateway} --code ${code}${preset} --auto --service auto --out edge.config.json`;
}

async function copyPairJoinCommand() {
  if (!state.pairJoinCommand) {
    $("pairJoinCommand").focus();
    return;
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(state.pairJoinCommand);
    } else {
      $("pairJoinCommand").focus();
    }
  } catch {
    $("pairJoinCommand").focus();
  }
  logEvent(t("copied"));
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
  if ($("taskMode").value === "group" && state.selectedAgents.size < 2) {
    return logEvent(t("groupNeedsAgents"));
  }
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
  if (mode === "group") {
    payload.agents = [...state.selectedAgents];
    payload.rounds = Number($("groupRounds").value || 2);
  }
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

async function loadRooms() {
  try {
    const rooms = await request("rooms");
    state.rooms = [...rooms].sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
    renderRooms();
    updateDashboardStats();
    renderOverview();
    if (!state.currentRoomId && rooms[0]) {
      state.currentRoomId = state.rooms[0].id;
      await loadRoom(state.rooms[0].id);
    }
  } catch (err) {
    logEvent(t("roomLoadFailed", { message: err.message }));
    renderOverview();
  }
}

function renderRooms() {
  const list = $("roomList");
  list.textContent = "";
  $("roomListCount").textContent = String(state.rooms.length || "-");
  if (!state.rooms.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("noRoom");
    list.append(empty);
    return;
  }
  for (const room of state.rooms.slice(0, 40)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `room-list-item ${room.id === state.currentRoomId ? "active" : ""}`;
    const activeRuns = roomActiveRunCount(room);
    const preview = roomListPreview(room);
    const title = roomDisplayTitle(room);
    button.innerHTML = `
      <div class="room-list-avatar" aria-hidden="true">${escapeHtml(chatInitials(title))}</div>
      <div class="room-list-body">
        <div class="room-list-title">
          <strong>${escapeHtml(title)}</strong>
          <time>${escapeHtml(formatChatTime(room.updated_at || room.created_at || ""))}</time>
        </div>
        <div class="room-list-preview">${escapeHtml(preview)}</div>
        <div class="room-list-meta">
          <span class="status ${escapeHtml(room.status || "unknown")}">${escapeHtml(statusText(room.status || "unknown"))}</span>
          <span>${escapeHtml(roomReportCount(room))} ${escapeHtml(t("reports"))}</span>
          <span>${escapeHtml(activeRuns)} ${escapeHtml(t("activeRuns"))}</span>
        </div>
      </div>
    `;
    button.addEventListener("click", () => loadRoom(room.id));
    list.append(button);
  }
}

async function createRoom(event) {
  event.preventDefault();
  const goal = $("roomGoal").value.trim();
  if (!goal) return logEvent(t("roomGoalEmpty"));
  const agents = [...state.selectedAgents];
  try {
    const body = {
      goal,
      agents,
      maxSteps: Number($("roomMaxSteps").value || 0),
      wakeAgents: $("roomWakeMode").value === "all" ? agents : agents.slice(0, 1),
      autoRotate: false
    };
    const room = await request("rooms", { method: "POST", body });
    state.currentRoomId = room.id;
    state.rooms = [room, ...state.rooms.filter((item) => item.id !== room.id)];
    renderRooms();
    await loadRoom(room.id);
    startRoomPolling(room.id);
    logEvent(t("roomCreated", { id: room.id }));
  } catch (err) {
    logEvent(t("roomFailed", { message: err.message }));
  }
}

async function wakeCurrentRoom() {
  if (!state.currentRoomId) return;
  try {
    const room = await request(`rooms/${encodeURIComponent(state.currentRoomId)}/wake`, { method: "POST", body: {} });
    upsertRoom(room);
    renderRoom(room);
    startRoomPolling(room.id);
  } catch (err) {
    logEvent(t("wakeRoomFailed", { message: err.message }));
  }
}

async function pauseCurrentRoom() {
  if (!state.currentRoomId) return;
  try {
    const room = await request(`rooms/${encodeURIComponent(state.currentRoomId)}/pause`, {
      method: "POST",
      body: { reason: "Paused from Agent Bus Console." }
    });
    upsertRoom(room);
    renderRoom(room);
  } catch (err) {
    logEvent(t("pauseRoomFailed", { message: err.message }));
  }
}

async function sendRoomMessage(event) {
  event.preventDefault();
  if (!state.currentRoomId) return;
  const message = $("roomMessage").value.trim();
  if (!message) return logEvent(t("roomMessageEmpty"));
  const directed = roomMessagePayload(message);
  const body = { message: directed.message, speaker: "user", wake: true };
  if (directed.agents.length) {
    body.agents = directed.agents;
    body.autoRotate = false;
    body.reason = `Directed room message to ${directed.agents.join(", ")}.`;
  }
  try {
    const room = await request(`rooms/${encodeURIComponent(state.currentRoomId)}/messages`, {
      method: "POST",
      body
    });
    $("roomMessage").value = "";
    upsertRoom(room);
    await loadRoom(room.id);
    startRoomPolling(room.id);
    logEvent(t("roomMessageSent"));
  } catch (err) {
    logEvent(t("roomMessageFailed", { message: err.message }));
  }
}

function roomMessagePayload(rawMessage) {
  const targets = new Map();
  const message = String(rawMessage || "").replace(/@([A-Za-z0-9_.-]+)/g, (match, rawId) => {
    const agentId = canonicalAgentId(rawId);
    if (!agentId) return match;
    targets.set(agentId.toLowerCase(), agentId);
    return `@${agentId}`;
  });
  return { message, agents: [...targets.values()] };
}

function canonicalAgentId(value) {
  const needle = String(value || "").trim().toLowerCase();
  if (!needle) return "";
  const roomAgents = Array.isArray(state.currentRoom?.agents) ? state.currentRoom.agents : [];
  const knownAgents = [...roomAgents, ...state.agents.map((agent) => agent.id)].filter(Boolean);
  return knownAgents.find((agentId) => String(agentId).toLowerCase() === needle) || "";
}

function startRoomPolling(roomId) {
  if (state.roomPolling) clearInterval(state.roomPolling);
  state.roomPolling = setInterval(() => loadRoom(roomId), 3000);
}

async function loadRoom(roomId) {
  try {
    const room = await request(`rooms/${encodeURIComponent(roomId)}`);
    try {
      const history = await request(`rooms/${encodeURIComponent(roomId)}/chat`);
      room.chat_history = Array.isArray(history.items) ? history.items : [];
      room.chat_history_meta = {
        object: history.object || "",
        count: history.count || 0,
        total: history.total || 0
      };
    } catch (err) {
      logEvent(t("roomHistoryFallback", { message: err.message }));
    }
    renderRoom(room);
    const active = (room.runs || []).some((run) => ["queued", "running"].includes(run.status));
    if (!active && room.status !== "active" && state.roomPolling) {
      clearInterval(state.roomPolling);
      state.roomPolling = null;
    }
  } catch (err) {
    logEvent(t("roomLoadFailed", { message: err.message }));
  }
}

async function loadCurrentRoomDoctor() {
  if (!state.currentRoomId) return;
  const panel = $("roomDoctor");
  panel.className = "room-doctor-panel";
  panel.textContent = t("waiting");
  try {
    const doctor = await request(`rooms/${encodeURIComponent(state.currentRoomId)}/doctor`);
    state.currentRoomDoctor = doctor;
    renderRoomDoctor(doctor);
  } catch (err) {
    panel.className = "room-doctor-panel failed";
    panel.textContent = err.message;
    logEvent(t("roomDoctorFailed", { message: err.message }));
  }
}

function renderRoom(room) {
  state.currentRoom = room;
  state.currentRoomId = room.id;
  if (state.currentRoomDoctor?.room?.id !== room.id) {
    state.currentRoomDoctor = null;
    $("roomDoctor").textContent = "";
    $("roomDoctor").className = "room-doctor-panel";
  }
  upsertRoom(room);
  $("roomSummary").removeAttribute("data-i18n");
  $("roomSummary").innerHTML = `
    <div class="chat-room-head">
      <div class="chat-room-avatar" aria-hidden="true">${escapeHtml(chatInitials(roomDisplayTitle(room)))}</div>
      <div class="chat-room-main">
        <div class="chat-room-title">
          <h3>${escapeHtml(roomDisplayTitle(room))}</h3>
          <span class="status ${escapeHtml(room.status || "unknown")}">${escapeHtml(statusText(room.status || "unknown"))}</span>
        </div>
        <div class="chat-room-subtitle">${escapeHtml(roomAgentLine(room))}</div>
        <div class="chat-room-id">${escapeHtml(room.id)}</div>
      </div>
      <div class="chat-room-stats">
        <span>${escapeHtml(roomMessageCount(room))} ${escapeHtml(t("message"))}</span>
        <span>${escapeHtml(roomReportCount(room))} ${escapeHtml(t("reports"))}</span>
        <span>${escapeHtml(room.autonomy?.steps || 0)}/${escapeHtml(room.autonomy?.max_steps || 0)} ${escapeHtml(t("maxSteps"))}</span>
        ${room.trace_id ? `<span>${escapeHtml(t("trace"))}: ${escapeHtml(room.trace_id)}</span>` : ""}
      </div>
    </div>
  `;
  $("roomDoctorButton").disabled = !room.id;
  $("pauseRoomButton").disabled = !room.id || ["paused", "completed"].includes(room.status);
  $("wakeRoomButton").disabled = !room.id || room.status === "paused";
  $("roomTraceButton").disabled = !room.trace_id;
  $("exportRoomButton").disabled = !room.id;
  if (state.currentRoomDoctor) renderRoomDoctor(state.currentRoomDoctor);
  renderRooms();
  updateDashboardStats();
  const messageList = $("roomMessages");
  messageList.textContent = "";
  const chatItems = roomChatItems(room);
  if (!chatItems.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state room-chat-empty";
    empty.textContent = room?.id ? t("noAgentChat") : t("noRoom");
    messageList.append(empty);
  }
  for (const item of chatItems) {
    messageList.append(renderRoomChatItem(item));
  }
  requestAnimationFrame(() => {
    messageList.scrollTop = messageList.scrollHeight;
  });
  const reports = $("roomReports");
  reports.textContent = "";
  if ((room.reports || []).length) {
    const title = document.createElement("div");
    title.className = "subhead room-side-section";
    title.textContent = t("reports");
    reports.append(title);
  }
  for (const report of room.reports || []) {
    const node = document.createElement("div");
    node.className = "run-item room-side-item";
    node.innerHTML = `
      <div class="run-head">
        <strong>${escapeHtml(report.speaker || "report")}</strong>
        <span class="muted">${escapeHtml(report.at || "")}</span>
      </div>
      <pre class="output">${escapeHtml((report.content || "").trim())}</pre>
    `;
    reports.append(node);
  }
  const notes = room.blackboard?.notes || [];
  if (notes.length) {
    const title = document.createElement("div");
    title.className = "subhead room-side-section";
    title.textContent = "BLACKBOARD";
    reports.append(title);
  }
  for (const note of notes) {
    const node = document.createElement("div");
    node.className = "run-item room-side-item";
    node.innerHTML = `
      <div class="run-head">
        <strong>${escapeHtml(note.speaker || "blackboard")}</strong>
        <span class="muted">${escapeHtml(note.at || "")}</span>
      </div>
      <pre class="output">${escapeHtml((note.content || "").trim())}</pre>
    `;
    reports.append(node);
  }
  if ((room.runs || []).length) {
    const title = document.createElement("div");
    title.className = "subhead room-side-section";
    title.textContent = "RUNS";
    reports.append(title);
  }
  for (const run of room.runs || []) {
    const output = (run.stdout || run.summary || run.stderr || "").trim();
    const node = document.createElement("div");
    node.className = "run-item room-side-item";
    node.innerHTML = `
      <div class="run-head">
        <div><strong>${escapeHtml(run.agent_id || "-")}</strong> <span class="muted">${escapeHtml(run.node_id || run.id || "")}</span></div>
        <span class="status ${escapeHtml(run.status || "unknown")}">${escapeHtml(statusText(run.status || "unknown"))}</span>
      </div>
      <pre class="output">${escapeHtml(output)}</pre>
    `;
    reports.append(node);
  }
  renderOverview();
}

function roomChatItems(room = {}) {
  if (Array.isArray(room.chat_history) && room.chat_history.length) {
    return sortRoomChatItems(room.chat_history.map((item, index) => normalizeRoomChatItem({
      kind: item.source || item.kind || "message",
      speaker: item.speaker || item.role || "agent",
      role: item.role || item.label || "",
      status: item.status || "",
      at: item.at || "",
      content: roomChatDisplayContent(item, item.source || item.kind || "message"),
      runId: item.run_id || item.runId || "",
      ordinal: item.ordinal || index + 1
    })).filter(isVisibleRoomChatItem));
  }
  const items = [];
  let ordinal = 0;
  for (const message of room.messages || []) {
    const content = roomChatDisplayContent(message, "message");
    if (!content) continue;
    items.push(normalizeRoomChatItem({
      kind: "message",
      speaker: message.speaker || message.role || "agent",
      role: message.role || "",
      status: message.status || "",
      at: message.at || message.created_at || message.completed_at || "",
      content,
      runId: message.run_id || "",
      ordinal: ordinal += 1
    }));
  }
  if (items.length) {
    return sortRoomChatItems(items);
  }
  for (const report of room.reports || []) {
    const content = roomChatDisplayContent(report, "report");
    if (!content) continue;
    items.push(normalizeRoomChatItem({
      kind: "report",
      speaker: report.speaker || "report",
      role: "REPORT",
      at: report.at || report.created_at || "",
      content,
      ordinal: ordinal += 1
    }));
  }
  for (const note of room.blackboard?.notes || []) {
    const content = roomChatDisplayContent(note, "blackboard");
    if (!content) continue;
    items.push(normalizeRoomChatItem({
      kind: "blackboard",
      speaker: note.speaker || "blackboard",
      role: "BLACKBOARD",
      at: note.at || note.created_at || "",
      content,
      ordinal: ordinal += 1
    }));
  }
  return sortRoomChatItems(items);
}

function roomDisplayTitle(room = {}) {
  return String(room.title || room.goal || room.id || "Room").trim().slice(0, 96);
}

function roomAgentLine(room = {}) {
  const agents = Array.isArray(room.agents) ? room.agents : [];
  if (!agents.length) return "-";
  return agents.join(", ");
}

function roomListPreview(room = {}) {
  const chat = roomChatItems(room);
  const last = chat[chat.length - 1];
  if (last?.content) return `${last.speaker}: ${last.content}`.slice(0, 150);
  const agents = roomAgentLine(room);
  if (agents && agents !== "-") return `${t("noAgentChat")} - ${agents}`.slice(0, 150);
  return room.id ? t("noAgentChat") : "-";
}

function sortRoomChatItems(items) {
  return items
    .sort((a, b) => (a.timestamp - b.timestamp) || (a.ordinal - b.ordinal))
    .filter((item, index, sorted) => !isDuplicateChatItem(item, sorted[index - 1]));
}

function normalizeRoomChatItem(item) {
  const speaker = String(item.speaker || "agent").trim() || "agent";
  const kind = String(item.kind || "message").toLowerCase();
  return {
    ...item,
    kind,
    speaker,
    label: roomChatLabel(kind, item.role, item.status),
    content: String(item.content || "").trim(),
    timestamp: Date.parse(item.at || "") || Number.MAX_SAFE_INTEGER
  };
}

function roomItemContent(item = {}) {
  return String(item.content || item.message || item.text || item.summary || "").trim();
}

function roomChatDisplayContent(item = {}, kind = "") {
  if (["report", "blackboard"].includes(String(kind || "").toLowerCase())) return "";
  if (!isAgentChatSpeaker(item.speaker || item.role)) return "";
  const lines = roomItemContent(item)
    .split(/\r?\n/)
    .map(roomChatDialogueLine)
    .filter(Boolean);
  return trimBlankLines(lines).join("\n").trim();
}

function isVisibleRoomChatItem(item) {
  return Boolean(item?.content && isAgentChatSpeaker(item.speaker));
}

function isAgentChatSpeaker(value) {
  const speaker = String(value || "").trim().toLowerCase();
  return Boolean(speaker && !["user", "operator", "admin", "system", "tool", "blackboard", "report"].includes(speaker));
}

function isRoomChatNoiseLine(line) {
  const text = String(line || "").trim();
  if (!text) return false;
  if (/^(REPORT|BLACKBOARD|DONE|TODO|WAKE)\b\s*:?\s*/i.test(text)) return true;
  if (/^(STDOUT|STDERR|TOOL|COMMAND|EXIT CODE|RUN|TRACE|DEBUG)\b\s*:?\s*/i.test(text)) return true;
  if (/^[-=]{3,}$/.test(text)) return true;
  if (/^⚠/.test(text)) return true;
  if (/\b(compression model|compression threshold|compression can run|context is [0-9,]+ tokens|main model|auto-lowered|config\.yaml)\b/i.test(text)) return true;
  if (/^(to make this permanent|use a larger compression model|lower the compression threshold)\b/i.test(text)) return true;
  if (/^\d+\.\s+(use a larger|lower the)\b/i.test(text)) return true;
  if (/^\s*(auxiliary|compression|model|threshold)\s*:/i.test(text)) return true;
  if (/^[-*]\s*(tool|command|stderr|stdout|run)\b/i.test(text)) return true;
  if (/^\{.*"(tool_calls?|function_call|cmd|command|stderr|stdout|run_id)"/i.test(text)) return true;
  if (/^\[?(tool|command|stderr|stdout|trace|debug)\]?[\s:.-]/i.test(text)) return true;
  return false;
}

function roomChatDialogueLine(line) {
  const text = String(line || "").trimEnd();
  if (isRoomChatNoiseLine(text)) return "";
  return stripRoomProtocolTail(text).trimEnd();
}

function stripRoomProtocolTail(line) {
  return String(line || "")
    .replace(/\s+\b(?:REPORT|BLACKBOARD)\s*:[\s\S]*$/, "")
    .replace(/\s+\bWAKE\s+@?[A-Za-z0-9_.-]+(?:\s+IN\b|\s*:)[\s\S]*$/, "")
    .replace(/\s+\b(?:DONE|TODO)\b\s*:?\s*[\s\S]*$/, "");
}

function trimBlankLines(lines) {
  const result = [...lines];
  while (result.length && !result[0].trim()) result.shift();
  while (result.length && !result[result.length - 1].trim()) result.pop();
  return result;
}

function roomChatLabel(kind, role = "", status = "") {
  return ["report", "blackboard"].includes(kind) ? kind.toUpperCase() : "";
}

function isDuplicateChatItem(item, previous) {
  if (!previous) return false;
  return item.kind === previous.kind
    && item.speaker === previous.speaker
    && item.content === previous.content
    && item.at === previous.at;
}

function renderRoomChatItem(item) {
  const node = document.createElement("article");
  const isUser = ["user", "operator", "admin"].includes(String(item.speaker || "").toLowerCase());
  const kindClass = item.kind.replace(/[^a-z0-9_-]/g, "") || "message";
  node.className = `chat-message ${isUser ? "is-user" : "is-agent"} is-${kindClass}`;
  node.innerHTML = `
    <div class="chat-avatar" aria-hidden="true">${escapeHtml(chatInitials(item.speaker))}</div>
    <div class="chat-bubble">
      <div class="chat-meta">
        <strong>${escapeHtml(item.speaker)}</strong>
        ${item.label ? `<span>${escapeHtml(item.label)}</span>` : ""}
        <time>${escapeHtml(formatChatTime(item.at))}</time>
      </div>
      <div class="chat-text">${escapeHtml(item.content)}</div>
    </div>
  `;
  return node;
}

function chatInitials(value) {
  const text = String(value || "AB").trim();
  const words = text.split(/[\s._:-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0] || ""}${words[1][0] || ""}`.toUpperCase();
  return text.slice(0, 2).toUpperCase();
}

function formatChatTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function renderRoomDoctor(doctor) {
  const panel = $("roomDoctor");
  const room = doctor?.room || {};
  const counts = doctor?.counts || {};
  const contract = doctor?.contract || {};
  const actions = Array.isArray(doctor?.actions) ? doctor.actions.slice(0, 5) : [];
  const severity = String(doctor?.severity || "info").toLowerCase().replace(/[^a-z0-9_-]/g, "") || "info";
  panel.className = `room-doctor-panel ${severity}`;
  panel.innerHTML = `
    <div class="doctor-head">
      <strong>${escapeHtml(t("roomDoctor"))}</strong>
      <span class="status ${escapeHtml(severity)}">${escapeHtml(doctor?.summary || room.status || "unknown")}</span>
    </div>
    <div class="doctor-grid">
      <span>${escapeHtml(t("status"))}: ${escapeHtml(room.status || "unknown")}</span>
      <span>${escapeHtml(t("activeRuns"))}: ${escapeHtml(counts.active_runs || 0)}</span>
      <span>stale queued: ${escapeHtml(counts.stale_queued_runs || 0)}</span>
      <span>failed: ${escapeHtml(counts.failed_attempts || 0)}</span>
      <span>retryable: ${escapeHtml(counts.retryable_failed_agents || 0)}</span>
      <span>contract gaps: ${escapeHtml(counts.contract_gap_agents || 0)}</span>
    </div>
    <div class="doctor-contract">${escapeHtml(contract.complete ? "Contract complete" : `Contract gaps: ${roomContractGapText(contract)}`)}</div>
    ${actions.length ? `<div class="doctor-actions">${actions.map(renderDoctorAction).join("")}</div>` : ""}
  `;
  wireRoomDoctorCopy(panel);
}

function renderDoctorAction(action) {
  const command = String(action?.command || "").trim();
  return `
    <div class="doctor-action">
      <div><strong>${escapeHtml(action?.kind || action?.level || "action")}</strong> ${escapeHtml(action?.message || "")}</div>
      ${command ? `<code>${escapeHtml(command)}</code><button type="button" class="copy-action-button" data-copy-command="${escapeHtml(command)}">${escapeHtml(t("copy"))}</button>` : ""}
    </div>
  `;
}

function wireRoomDoctorCopy(panel) {
  for (const button of panel.querySelectorAll("[data-copy-command]")) {
    button.addEventListener("click", () => copyTextToClipboard(button.dataset.copyCommand || "", button));
  }
}

function roomContractGapText(contract) {
  const parts = [];
  if (contract?.missing_agents?.length) parts.push(`missing agents=${contract.missing_agents.join(",")}`);
  if (contract?.missing_report_agents?.length) parts.push(`missing REPORT=${contract.missing_report_agents.join(",")}`);
  if (contract?.missing_done_agents?.length) parts.push(`missing DONE=${contract.missing_done_agents.join(",")}`);
  return parts.join("; ") || "unknown";
}

async function openCurrentRoomTrace() {
  if (!state.currentRoom?.trace_id) return;
  $("traceInput").value = state.currentRoom.trace_id;
  activateTab("traces");
  await lookupTrace();
}

function exportCurrentRoomSummary() {
  if (!state.currentRoom?.id) return;
  downloadJson(`${state.currentRoom.id}-reports-summary.json`, roomExportSummary(state.currentRoom));
  logEvent(t("exported"));
}

function upsertRoom(room) {
  if (!room?.id) return;
  state.rooms = [room, ...state.rooms.filter((item) => item.id !== room.id)]
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
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
  $("threadSummary").textContent = thread.mode === "group"
    ? `${thread.id} | group | ${(thread.selection?.agents || []).join(", ")} | ${thread.conversation?.length || 0}/${(thread.group?.max_turns || 0) + 1}`
    : `${thread.id} | ${thread.mode} | ${(thread.selection?.agents || []).join(", ")}`;
  renderConversation(thread);
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

function renderConversation(thread) {
  const list = $("conversationList");
  list.textContent = "";
  if (thread.mode !== "group") return;
  for (const item of thread.conversation || []) {
    const node = document.createElement("div");
    node.className = `run-item conversation-item ${item.speaker === "user" ? "user" : ""}`;
    node.innerHTML = `
      <div class="run-head">
        <strong>${escapeHtml(item.speaker || item.role || "agent")}</strong>
        <span class="muted">${escapeHtml(item.at || "")}</span>
      </div>
      <pre class="output">${escapeHtml((item.content || "").trim())}</pre>
    `;
    list.append(node);
  }
}

async function loadModels(options = {}) {
  try {
    const data = await request("v1/models");
    state.models = data.data || [];
    renderModelOptions();
    if (!options.silent) {
      $("modelOutput").textContent = JSON.stringify(data, null, 2);
      logEvent(t("modelsLoaded", { count: data.data?.length || 0 }));
    }
    renderOverview();
  } catch (err) {
    state.models = [];
    if (!options.silent) $("modelOutput").textContent = err.message;
    renderOverview();
  }
}

function renderModelOptions() {
  const list = $("modelOptions");
  list.textContent = "";
  for (const model of state.models) {
    const id = String(model.id || "").trim();
    if (!id) continue;
    const option = document.createElement("option");
    option.value = id;
    if (model.owned_by) option.label = model.owned_by;
    list.append(option);
  }
}

async function sendChat(event) {
  event.preventDefault();
  const model = $("modelInput").value.trim() || "agent-bus-default";
  const endpoint = $("modelEndpoint").value;
  const prompt = $("chatPrompt").value.trim();
  const cacheScope = $("modelCacheScope").value.trim();
  const timeoutSeconds = Number($("modelTimeoutSeconds").value || 0);
  if (!prompt) return logEvent(t("modelPromptEmpty"));
  $("modelOutput").textContent = t("waiting");
  try {
    const path = endpoint === "responses" ? "v1/responses" : "v1/chat/completions";
    const data = await request(path, { method: "POST", body: modelRequestBody({ endpoint, model, prompt, cacheScope, timeoutSeconds }) });
    $("modelOutput").textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    $("modelOutput").textContent = err.message;
  }
}

async function lookupTrace(event) {
  if (event) event.preventDefault();
  const traceId = $("traceInput").value.trim();
  if (!traceId) {
    $("traceOutput").textContent = t("noTrace");
    return;
  }
  try {
    const data = await request(`traces/${encodeURIComponent(traceId)}`);
    state.currentTrace = data;
    renderTrace(data);
    logEvent(t("traceLoaded", { id: traceId }));
  } catch (err) {
    $("traceOutput").textContent = err.message;
    logEvent(t("traceFailed", { message: err.message }));
  }
}

function renderTrace(trace) {
  if ($("traceFormat").value === "json") {
    $("traceOutput").textContent = JSON.stringify(trace, null, 2);
    return;
  }
  const summary = trace.summary || {};
  const lines = [
    `Trace ${trace.trace_id || $("traceInput").value.trim()}`,
    `${t("rooms")}: ${summary.rooms || 0} | ${t("tasks")}: ${summary.threads || 0} | ${t("activeRuns")}: ${summary.runs || 0}`,
    `${t("agents")}: ${(summary.agents || []).join(", ") || "-"}`,
    `${t("nodes")}: ${(summary.nodes || []).join(", ") || "-"}`,
    ""
  ];
  if (trace.rooms?.length) {
    lines.push(`${t("rooms")}:`);
    for (const room of trace.rooms) {
      lines.push(`- ${room.id}: ${statusText(room.status || "unknown")} | ${(room.agents || []).join(", ") || "-"} | ${room.updated_at || "-"}`);
    }
    lines.push("");
  }
  if (trace.runs?.length) {
    lines.push("Runs:");
    for (const run of trace.runs) {
      lines.push(`- ${run.id}: ${statusText(run.status || "unknown")} | ${run.agent_id || "-"} | ${run.node_id || "-"} | ${run.room_id || run.thread_id || "-"}`);
    }
    lines.push("");
  }
  if (trace.events?.length) {
    lines.push(`${t("events")}:`);
    for (const event of trace.events.slice(-30)) {
      lines.push(`- ${event.at || ""} ${event.type || event.event || "event"} ${event.agent_id || ""} ${event.run_id || ""}`.trim());
    }
  }
  $("traceOutput").textContent = lines.join("\n");
}

function exportCurrentTrace() {
  if (!state.currentTrace) {
    $("traceOutput").textContent = t("noTrace");
    return;
  }
  downloadJson(`${state.currentTrace.trace_id || "trace"}.json`, state.currentTrace);
  logEvent(t("exported"));
}

function modelRequestBody({ endpoint, model, prompt, cacheScope, timeoutSeconds }) {
  const timeout = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? { timeout_seconds: timeoutSeconds } : {};
  if (endpoint === "responses") {
    return {
      model,
      input: prompt,
      ...(cacheScope ? { metadata: { agent_bus_cache_scope: cacheScope } } : {}),
      ...timeout
    };
  }
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    ...(cacheScope ? { prompt_cache_key: cacheScope } : {}),
    ...timeout
  };
}

function initComposerAssist() {
  const menu = document.createElement("div");
  menu.id = "composerAssist";
  menu.className = "composer-assist";
  menu.hidden = true;
  document.body.append(menu);
  state.composerAssist = {
    menu,
    target: null,
    trigger: "",
    query: "",
    start: 0,
    end: 0,
    selectedIndex: 0,
    items: []
  };
  for (const id of ["roomMessage", "roomGoal", "taskMessage", "chatPrompt"]) {
    const target = $(id);
    if (!target) continue;
    target.addEventListener("input", () => updateComposerAssist(target));
    target.addEventListener("click", () => updateComposerAssist(target));
    target.addEventListener("focus", () => updateComposerAssist(target));
    target.addEventListener("keydown", handleComposerAssistKeydown);
    target.addEventListener("blur", () => {
      setTimeout(() => {
        if (!menu.matches(":hover")) closeComposerAssist();
      }, 120);
    });
  }
  document.addEventListener("mousedown", (event) => {
    const active = state.composerAssist?.target;
    if (menu.contains(event.target) || active === event.target) return;
    closeComposerAssist();
  });
  window.addEventListener("resize", positionComposerAssist);
  document.addEventListener("scroll", positionComposerAssist, true);
}

function handleComposerAssistKeydown(event) {
  const assist = state.composerAssist;
  if (!assist || assist.target !== event.target || assist.menu.hidden) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    moveComposerAssistSelection(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    moveComposerAssistSelection(-1);
    return;
  }
  if (event.key === "Enter" || event.key === "Tab") {
    const item = assist.items[assist.selectedIndex];
    if (item && !item.disabled) {
      event.preventDefault();
      selectComposerAssistItem(assist.selectedIndex);
    }
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeComposerAssist();
  }
}

function updateComposerAssist(target) {
  const trigger = currentComposerTrigger(target);
  if (!trigger) {
    closeComposerAssist();
    return;
  }
  const items = trigger.trigger === "@"
    ? agentComposerItems(trigger.query)
    : slashComposerItems(target, trigger.query);
  const assist = state.composerAssist;
  assist.target = target;
  assist.trigger = trigger.trigger;
  assist.query = trigger.query;
  assist.start = trigger.start;
  assist.end = trigger.end;
  assist.items = items.length ? items : [emptyComposerItem()];
  assist.selectedIndex = firstEnabledComposerItemIndex(assist.items);
  renderComposerAssist();
}

function currentComposerTrigger(target) {
  const end = target.selectionStart ?? 0;
  const prefix = String(target.value || "").slice(0, end);
  const match = prefix.match(/(^|[\s([{])([@/][A-Za-z0-9_.-]*)$/);
  if (!match) return null;
  const token = match[2];
  return {
    trigger: token[0],
    query: token.slice(1).toLowerCase(),
    start: prefix.length - token.length,
    end
  };
}

function agentComposerItems(query) {
  const normalized = String(query || "").toLowerCase();
  return [...state.agents]
    .filter((agent) => {
      const haystack = [agent.id, agent.role, agent.kind, agent.node_id, ...(agent.capabilities || [])]
        .join(" ")
        .toLowerCase();
      return !normalized || haystack.includes(normalized);
    })
    .sort((a, b) => agentComposerRank(a) - agentComposerRank(b) || String(a.id || "").localeCompare(String(b.id || "")))
    .slice(0, 9)
    .map((agent) => ({
      kind: "agent",
      label: `@${agent.id}`,
      detail: [agent.role || agent.kind || t("agent"), statusText(agent.status || agent.node_status || "unknown")]
        .filter(Boolean)
        .join(" - "),
      insert: `@${agent.id} `
    }));
}

function agentComposerRank(agent) {
  const online = String(agent.status || agent.node_status || "").toLowerCase() === "online" ? 0 : 10;
  const reachable = String(agent.ping_status || "").toLowerCase() === "reachable" ? 0 : 1;
  return online + reachable;
}

function slashComposerItems(target, query) {
  const normalized = String(query || "").toLowerCase();
  return composerCommandDefinitions(target)
    .filter((item) => [item.label, item.detail, item.insert].join(" ").toLowerCase().includes(normalized))
    .slice(0, 9);
}

function composerCommandDefinitions(target) {
  const zh = state.lang === "zh";
  const id = target.id;
  if (id === "roomMessage") {
    return [
      {
        label: "/wake",
        detail: zh ? "唤醒房间里的下一个 agent" : "Wake the next room agent",
        insert: "",
        onSelect: () => wakeCurrentRoom()
      },
      {
        label: "/doctor",
        detail: zh ? "打开房间诊断" : "Open room doctor",
        insert: "",
        onSelect: () => loadCurrentRoomDoctor()
      },
      {
        label: "/trace",
        detail: zh ? "打开当前房间 trace" : "Open this room trace",
        insert: "",
        onSelect: () => openCurrentRoomTrace()
      },
      {
        label: "/export",
        detail: zh ? "导出房间摘要" : "Export room summary",
        insert: "",
        onSelect: () => exportCurrentRoomSummary()
      },
      {
        label: "/pause",
        detail: zh ? "暂停当前房间" : "Pause this room",
        insert: "",
        onSelect: () => pauseCurrentRoom()
      },
      {
        label: "/handoff",
        detail: zh ? "插入一条继续推进提示" : "Insert a continuation prompt",
        insert: zh ? "请基于当前房间上下文继续推进，只输出关键对话内容。" : "Continue from the current room context and reply with only the useful conversation."
      }
    ];
  }
  if (id === "roomGoal") {
    return [
      {
        label: "/issue",
        detail: zh ? "生成 issue -> planner -> coder -> reviewer 目标" : "Issue to planner/coder/reviewer goal",
        insert: "Turn this issue into a planner -> coder -> reviewer workflow. Planner should break down the work, coder should draft the patch, reviewer should check risk and tests, then produce a concise patch/PR draft."
      },
      {
        label: "/demo",
        detail: zh ? "生成 live demo 目标" : "Live demo goal",
        insert: "Run a concise live demo that proves the selected agents can collaborate in this room. Each agent should write one short conversational update, then summarize the result."
      },
      {
        label: "/review",
        detail: zh ? "生成项目审查目标" : "Project review goal",
        insert: "Review the current Agent Bus project state, identify the highest-impact product polish work, and return a short prioritized plan."
      },
      {
        label: "/handoff",
        detail: zh ? "生成交接阅读目标" : "Read handoff goal",
        insert: "Read docs/project-handoff.md first, summarize the current architecture and online agents, then propose the next concrete development step."
      }
    ];
  }
  if (id === "taskMessage") {
    return [
      {
        label: "/group",
        detail: zh ? "切换成群聊任务" : "Switch to group chat task",
        insert: "Discuss this as a group and produce a concise decision:",
        onSelect: () => setTaskMode("group")
      },
      {
        label: "/broadcast",
        detail: zh ? "切换成广播任务" : "Switch to broadcast task",
        insert: "Each selected agent should report its current status, blockers, and next recommended step:",
        onSelect: () => setTaskMode("broadcast")
      },
      {
        label: "/explicit",
        detail: zh ? "切换成选中 agent 任务" : "Switch to selected-agent task",
        insert: "Selected agents, handle this task and return concise results:",
        onSelect: () => setTaskMode("explicit")
      },
      {
        label: "/review",
        detail: zh ? "插入审查任务模板" : "Insert review task template",
        insert: "Review this change for bugs, regressions, missing tests, and deployment risk."
      }
    ];
  }
  if (id === "chatPrompt") {
    return [
      {
        label: "/models",
        detail: zh ? "刷新模型列表" : "Refresh model list",
        insert: "",
        onSelect: () => loadModels()
      },
      {
        label: "/summarize",
        detail: zh ? "插入总结提示" : "Insert summarization prompt",
        insert: "Summarize the important points, decisions, and next actions."
      },
      {
        label: "/compare",
        detail: zh ? "插入对比提示" : "Insert comparison prompt",
        insert: "Compare the options, call out tradeoffs, and recommend one path."
      },
      {
        label: "/agent",
        detail: zh ? "插入 agent 模型测试提示" : "Insert agent model test prompt",
        insert: "Introduce yourself as an Agent Bus agent and describe what you can help with."
      }
    ];
  }
  return [];
}

function setTaskMode(mode) {
  $("taskMode").value = mode;
  syncTaskMode();
}

function emptyComposerItem() {
  return {
    kind: "empty",
    label: t("noComposerMatches"),
    detail: "",
    disabled: true
  };
}

function firstEnabledComposerItemIndex(items) {
  const index = items.findIndex((item) => !item.disabled);
  return index === -1 ? 0 : index;
}

function moveComposerAssistSelection(direction) {
  const assist = state.composerAssist;
  if (!assist?.items?.length) return;
  let index = assist.selectedIndex;
  for (let i = 0; i < assist.items.length; i += 1) {
    index = (index + direction + assist.items.length) % assist.items.length;
    if (!assist.items[index]?.disabled) {
      assist.selectedIndex = index;
      renderComposerAssist();
      return;
    }
  }
}

function renderComposerAssist() {
  const assist = state.composerAssist;
  if (!assist?.menu || !assist.target) return;
  assist.menu.textContent = "";
  assist.items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `composer-assist-item ${index === assist.selectedIndex ? "active" : ""}`;
    button.disabled = Boolean(item.disabled);
    button.innerHTML = `
      <span class="composer-assist-label">${escapeHtml(item.label)}</span>
      ${item.detail ? `<span class="composer-assist-detail">${escapeHtml(item.detail)}</span>` : ""}
    `;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => selectComposerAssistItem(index));
    assist.menu.append(button);
  });
  assist.menu.hidden = false;
  positionComposerAssist();
}

function positionComposerAssist() {
  const assist = state.composerAssist;
  if (!assist?.menu || assist.menu.hidden || !assist.target) return;
  const rect = assist.target.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
  assist.menu.style.width = `${width}px`;
  assist.menu.style.left = `${left}px`;
  assist.menu.style.top = "0px";
  assist.menu.style.visibility = "hidden";
  const height = assist.menu.offsetHeight || 0;
  const below = rect.bottom + 6;
  const above = rect.top - height - 6;
  const top = below + height > window.innerHeight - 8 && above > 8 ? above : below;
  assist.menu.style.top = `${Math.max(8, top)}px`;
  assist.menu.style.visibility = "visible";
}

function selectComposerAssistItem(index) {
  const assist = state.composerAssist;
  const item = assist?.items?.[index];
  if (!assist?.target || !item || item.disabled) return;
  const target = assist.target;
  const before = target.value.slice(0, assist.start);
  const after = target.value.slice(assist.end);
  const insert = item.insert ?? item.label;
  target.value = `${before}${insert}${after}`;
  const caret = before.length + String(insert).length;
  target.setSelectionRange(caret, caret);
  closeComposerAssist();
  target.focus();
  target.dispatchEvent(new Event("input", { bubbles: true }));
  if (typeof item.onSelect === "function") {
    setTimeout(() => item.onSelect(), 0);
  }
}

function closeComposerAssist() {
  const assist = state.composerAssist;
  if (!assist?.menu) return;
  assist.menu.hidden = true;
  assist.target = null;
  assist.items = [];
  assist.trigger = "";
  assist.query = "";
}

async function request(path, options = {}) {
  const url = new URL(path, apiBase);
  const headers = { ...(options.headers || {}) };
  if (options.auth !== false) {
    const token = currentToken();
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

function currentToken() {
  return normalizeToken($("tokenInput").value || sessionStorage.getItem("agentBusToken") || "");
}

function initialConsoleToken() {
  const hash = String(window.location.hash || "").replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const hashToken = normalizeToken(params.get("token") || params.get("access_token") || "");
  if (hashToken) {
    sessionStorage.setItem("agentBusToken", hashToken);
    params.delete("token");
    params.delete("access_token");
    const nextHash = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}${nextHash ? `#${nextHash}` : ""}`);
    return hashToken;
  }
  return sessionStorage.getItem("agentBusToken") || "";
}

function normalizeToken(value) {
  return String(value || "").trim().replace(/^Bearer\s+/i, "").trim();
}

function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
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
  renderNodes();
  renderPlugins();
  renderOverview();
  renderEdgeJoin();
  renderRooms();
  if (state.currentRoom) renderRoom(state.currentRoom);
  if (state.currentThread) renderThread(state.currentThread);
  if (state.currentTrace) renderTrace(state.currentTrace);
}

function t(key, values = {}) {
  let message = (messages[state.lang] && messages[state.lang][key]) || messages.en[key] || key;
  for (const [name, value] of Object.entries(values)) {
    message = message.replaceAll(`{${name}}`, String(value));
  }
  return message;
}

function statusText(status) {
  const key = String(status || "unknown").replaceAll("-", "_");
  return t(key) || status;
}

function agentActivity(agent) {
  const activeRuns = agent.active_runs || [];
  if (activeRuns.length || agent.current_run) return "busy";
  const lastStatus = String(agent.last_run_status || "").toLowerCase();
  if (["queued", "running"].includes(lastStatus)) return lastStatus;
  return "idle";
}

function roomReportCount(room) {
  if (Array.isArray(room.reports)) return room.reports.length;
  if (Number.isFinite(room.report_count)) return room.report_count;
  if (Number.isFinite(room.reports)) return room.reports;
  return 0;
}

function roomMessageCount(room) {
  if (Array.isArray(room.messages)) return room.messages.length;
  if (Number.isFinite(room.message_count)) return room.message_count;
  if (Number.isFinite(room.messages)) return room.messages;
  return 0;
}

function roomActiveRunCount(room) {
  if (Array.isArray(room.active_runs)) return room.active_runs.length;
  if (!Array.isArray(room.runs)) return 0;
  return room.runs.filter((run) => ["queued", "running"].includes(String(run.status || "").toLowerCase())).length;
}

function roomExportSummary(room) {
  return {
    object: "agent_bus.room_reports_summary",
    reports_only: true,
    sharing_note: "Reports-only export omits the room goal, full messages, and run output by default. Review generated reports before sharing.",
    id: room.id,
    trace_id: room.trace_id,
    title: room.title,
    status: room.status,
    created_at: room.created_at,
    updated_at: room.updated_at,
    agents: room.agents || [],
    reports: room.reports || [],
    blackboard: {
      notes: room.blackboard?.notes || [],
      next_actions: room.blackboard?.next_actions || [],
      open_questions: room.blackboard?.open_questions || []
    },
    runs: (room.runs || []).map((run) => ({
      id: run.id,
      trace_id: run.trace_id,
      agent_id: run.agent_id,
      node_id: run.node_id,
      status: run.status,
      created_at: run.created_at,
      started_at: run.started_at,
      completed_at: run.completed_at,
      exit_code: run.exit_code
    }))
  };
}

function updateDashboardStats() {
  if (state.nodes.length) {
    const onlineNodes = state.nodes.filter((node) => String(node.status || node.node_status || "").toLowerCase() === "online").length;
    $("nodeCount").textContent = `${onlineNodes}/${state.nodes.length}`;
  }
  if (state.agents.length) {
    $("agentCount").textContent = state.agents.length;
    $("onlineAgentCount").textContent = state.agents.filter((agent) => (agent.status || agent.node_status) === "online").length;
  }
  if (state.rooms.length) {
    const activeRooms = state.rooms.filter((room) => ["active", "running", "finishing"].includes(String(room.status || "").toLowerCase())).length;
    $("activeRoomCount").textContent = activeRooms;
  } else {
    $("activeRoomCount").textContent = "-";
  }
  if (state.status?.summary) {
    updateStatusSummaryStats(state.status.summary);
  }
  renderOverview();
}

function updateStatusSummaryStats(summary = {}) {
  const nodes = summary.nodes ?? state.health?.nodes ?? "-";
  const registeredNodes = summary.registered_nodes ?? state.health?.registered_nodes;
  const agents = summary.agents ?? state.health?.agents ?? "-";
  const registeredAgents = summary.registered_agents ?? state.health?.registered_agents;
  $("nodeCount").textContent = registeredNodes == null ? nodes : `${nodes}/${registeredNodes}`;
  $("agentCount").textContent = registeredAgents == null ? agents : `${agents}/${registeredAgents}`;
  $("onlineAgentCount").textContent = summary.online_agents ?? summary.agents ?? state.health?.agents ?? "-";
  $("queuedCount").textContent = summary.queued ?? state.health?.queued ?? "-";
  $("activeRoomCount").textContent = summary.active_rooms ?? "-";
}

function syncTaskMode() {
  const mode = $("taskMode").value;
  $("roundsField").hidden = mode !== "group";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
