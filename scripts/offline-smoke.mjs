import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const procs = [];
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-offline-smoke-"));

main().catch((err) => {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}).finally(() => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const python = findPython();
  if (!python) {
    throw new Error("agent-bus smoke --offline requires Python 3.10+ because the Python gateway currently owns room support.");
  }

  const gatewayPort = await freePort();
  const token = "sk-offline-smoke-token-000000";
  const edgeToken = "abt_edge_offline_smoke_token_000000";
  const base = `http://127.0.0.1:${gatewayPort}`;
  const centralConfig = path.join(tempDir, "central.config.json");
  const edgeConfig = path.join(tempDir, "edge.config.json");
  const agentScript = path.join(tempDir, "offline-agent.mjs");
  const failAgentScript = path.join(tempDir, "offline-fail-agent.mjs");
  const authFailAgentScript = path.join(tempDir, "offline-auth-fail-agent.mjs");
  const noReportAgentScript = path.join(tempDir, "offline-no-report-agent.mjs");

  fs.writeFileSync(centralConfig, `${JSON.stringify({
    host: "127.0.0.1",
    port: gatewayPort,
    dataDir: path.join(tempDir, "data"),
    token,
    defaults: {
      mode: "orchestrate",
      pollTimeoutMs: 1000
    },
    edgeTokens: [edgeToken],
    modelRouter: {
      enabled: true,
      agentModels: true,
      allowEdgeAgentModels: true,
      backends: []
    }
  }, null, 2)}\n`);

  fs.writeFileSync(agentScript, `const room = process.env.AGENT_ROOM_ID || "";\nconst cache = process.env.AGENT_CACHE_KEY || "";\nconst wake = process.env.AGENT_WAKE_REASON || "";\nconst edgeSession = process.env.EDGE_SESSION_ID || "";\nconsole.log("REPORT: offline smoke run completed for " + room);\nconsole.log("BLACKBOARD: cache key " + cache);\nconsole.log("BLACKBOARD: wake reason " + wake);\nconsole.log("BLACKBOARD: edge session " + edgeSession);\nconsole.log("BLACKBOARD: fake token=sk-test-secret-000000000000000000");\nconsole.log("DONE");\n`);
  fs.writeFileSync(failAgentScript, `console.error("API Error: 502 Upstream request failed in offline smoke");\nprocess.exit(1);\n`);
  fs.writeFileSync(authFailAgentScript, `console.error("API Error: 401 unauthorized API key in offline smoke");\nprocess.exit(1);\n`);
  fs.writeFileSync(noReportAgentScript, `console.log("Completed without a REPORT line so room doctor can detect contract gaps.");\nconsole.log("DONE");\n`);

  fs.writeFileSync(edgeConfig, `${JSON.stringify({
    nodeId: "offline-smoke-node",
    gatewayUrl: base,
    token: edgeToken,
    pollTimeoutMs: 1000,
    idleDelayMs: 100,
    defaultTimeoutMs: 15000,
    agents: [{
      id: "offline-agent",
      kind: "offline",
      role: "executor",
      enabled: true,
      adapter: "command",
      capabilities: ["test", "room", "offline"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(agentScript)}`
    }, {
      id: "offline-fail-agent",
      kind: "offline",
      role: "executor",
      enabled: true,
      adapter: "command",
      capabilities: ["test", "room", "offline", "failure"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(failAgentScript)}`
    }, {
      id: "offline-auth-fail-agent",
      kind: "offline",
      role: "executor",
      enabled: true,
      adapter: "command",
      capabilities: ["test", "room", "offline", "auth-failure"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(authFailAgentScript)}`
    }, {
      id: "offline-no-report-agent",
      kind: "offline",
      role: "executor",
      enabled: true,
      adapter: "command",
      capabilities: ["test", "room", "offline", "contract-gap"],
      runCommand: `${quoteCommandArg(process.execPath)} ${quoteCommandArg(noReportAgentScript)}`
    }]
  }, null, 2)}\n`);

  const central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: centralConfig,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(gatewayPort),
    AGENT_BUS_DATA_DIR: path.join(tempDir, "data")
  });
  await waitForJson(`${base}/health`);

  const edge = start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  const agent = await waitForAgent(base, token, "offline-agent");
  await waitForAgent(base, token, "offline-fail-agent");
  await waitForAgent(base, token, "offline-auth-fail-agent");
  await waitForAgent(base, token, "offline-no-report-agent");
  assert(agent.status === "online", "agent discovery did not expose online status");
  assert(agent.node_status === "online", "agent discovery did not expose online node status");
  assert(Boolean(agent.last_seen_at), "agent discovery did not expose last_seen_at");
  assert(agent.ping_status === "not_configured", "offline agent should report ping_status=not_configured");
  const models = await requestJson(`${base}/v1/models`, { headers: authHeaders(token) });
  assert(models.data?.some((item) => item.id === "agent:offline-agent"), "admin model list did not include the offline agent model");
  const edgeModels = await requestJson(`${base}/v1/models`, { headers: authHeaders(edgeToken) });
  assert(edgeModels.data?.some((item) => item.id === "agent:offline-agent"), "edge model list did not include the offline agent model");
  const agentChat = await requestJson(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent:offline-agent",
      messages: [{ role: "user", content: "agent model replacement smoke" }],
      timeout_seconds: 10
    })
  });
  assert(agentChat.model === "agent:offline-agent", "agent-backed chat completion returned the wrong model");
  assert(agentChat.agent_bus?.agent_id === "offline-agent", "agent-backed chat completion did not include Agent Bus run metadata");
  assert(/offline smoke run completed/.test(agentChat.choices?.[0]?.message?.content || ""), "agent-backed chat completion did not return agent stdout");
  const agentResponse = await requestJson(`${base}/v1/responses`, {
    method: "POST",
    headers: authJsonHeaders(edgeToken),
    body: JSON.stringify({
      model: "agent:offline-agent",
      input: "agent responses replacement smoke",
      timeout_seconds: 10
    })
  });
  assert(agentResponse.model === "agent:offline-agent", "agent-backed response returned the wrong model");
  assert(agentResponse.agent_bus?.agent_id === "offline-agent", "agent-backed response did not include Agent Bus run metadata");
  assert(/offline smoke run completed/.test(agentResponse.output_text || ""), "agent-backed response did not return agent output_text");
  assert(agentResponse.output?.[0]?.content?.[0]?.type === "output_text", "agent-backed response did not return Responses-style output content");

  const room = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline smoke room",
      goal: "Verify Agent Bus room dispatch, command adapter env, directive parsing, blackboard persistence, and completion without model quota.",
      agents: ["offline-agent"],
      wakeAgents: ["offline-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });

  const finalRoom = await waitForRoomComplete(base, token, room.id);
  const run = finalRoom.runs?.find((item) => item.agent_id === "offline-agent");
  assert(run?.status === "completed", "offline room run did not complete");
  assert(run?.wake_reason === "Initial room wake.", "offline room run did not persist the wake reason");
  assert(/^edge_session_/.test(run?.edge_session_id || ""), "offline room run did not persist edge_session_id");
  assert(run?.lease?.state === "released", "offline room run did not release its run lease");
  assert(run?.lease?.edge_session_id === run?.edge_session_id, "offline room lease did not track the edge session");
  await requestJson(`${base}/edge/events`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "offline-smoke-node",
      run_id: run.id,
      trace_id: run.trace_id,
      edge_session_id: run.edge_session_id,
      event: { type: "run.heartbeat" }
    })
  });
  const runAfterLateHeartbeat = await requestJson(`${base}/runs/${encodeURIComponent(run.id)}`, { headers: authHeaders(token) });
  assert(runAfterLateHeartbeat.status === "completed", "late heartbeat changed completed run status");
  assert(runAfterLateHeartbeat.lease?.state === "released", "late heartbeat moved a released lease back to heartbeat");
  assert(runAfterLateHeartbeat.attempt?.status === "completed", "late heartbeat changed completed attempt status");
  assert(runAfterLateHeartbeat.events?.some((event) => event.type === "run.heartbeat" && event.ignored === true && event.ignored_reason === "run_terminal"), "late heartbeat was not recorded as an ignored terminal event");
  assert(finalRoom.status === "completed", "offline room did not complete after DONE");
  assert(finalRoom.reports?.some((item) => /offline smoke run completed/.test(item.content || "")), "REPORT directive was not captured");
  assert(finalRoom.blackboard?.notes?.some((item) => /cache key agent-bus-offline-agent/.test(item.content || "")), "BLACKBOARD directive was not captured");
  assert(finalRoom.blackboard?.notes?.some((item) => /wake reason Initial room wake\./.test(item.content || "")), "AGENT_WAKE_REASON was not exposed to the command adapter");
  assert(finalRoom.blackboard?.notes?.some((item) => /edge session edge_session_/.test(item.content || "")), "EDGE_SESSION_ID was not exposed to the command adapter");
  assert((run.stdout || "").includes("DONE"), "agent stdout did not include DONE");
  const checklist = finalRoom.blackboard?.agent_checklist;
  const checklistAgent = checklist?.agents?.["offline-agent"];
  assert(checklist?.summary?.expected_agents === 1, "room checklist did not count expected agents");
  assert(checklist?.summary?.replied_agents === 1, "room checklist did not count replied agents");
  assert(checklist?.summary?.completed_agents === 1, "room checklist did not count completed agents");
  assert(checklist?.summary?.missing_report_agents?.length === 0, "room checklist incorrectly marked REPORT missing");
  assert(checklist?.summary?.missing_done_agents?.length === 0, "room checklist incorrectly marked DONE missing");
  assert(checklistAgent?.status === "completed", "room checklist did not record agent completion");
  assert(checklistAgent?.has_report === true, "room checklist did not record REPORT compliance");
  assert(checklistAgent?.has_done === true, "room checklist did not record DONE compliance");
  assert(Number.isFinite(checklistAgent?.duration_seconds), "room checklist did not record run duration");

  const cliRoom = await runCliJson(["room", "show", finalRoom.id, "--gateway", base, "--token", token]);
  assert(cliRoom.id === finalRoom.id, "CLI room show did not return the expected room");
  const cliRoomHealth = await runCliJson(["room", "health", finalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(cliRoomHealth.object === "agent_bus.room_health", "CLI room health did not return a room health object");
  assert(cliRoomHealth.room?.id === finalRoom.id, "CLI room health returned the wrong room");
  assert(cliRoomHealth.summary?.completed_agents === 1, "CLI room health did not include completed agent count");
  assert(cliRoomHealth.summary?.last_wake_reason === "Initial room wake.", "CLI room health did not expose the last wake reason");
  assert(cliRoomHealth.agents?.some((item) => item.agent_id === "offline-agent" && item.has_report === true && item.has_done === true && item.wake_reason === "Initial room wake." && /^edge_session_/.test(item.edge_session_id || "") && item.lease_state === "released"), "CLI room health did not expose agent contract and lease status");
  assert(cliRoomHealth.recovery_actions?.some((item) => item.kind === "archive_completed_room"), "CLI room health did not suggest archiving a completed room");
  const cliRoomHealthText = await runCliText(["room", "health", finalRoom.id, "--gateway", base, "--token", token]);
  assert(cliRoomHealthText.includes("Agent Bus room health:"), "CLI room health text did not render a title");
  assert(cliRoomHealthText.includes("Missing REPORT: -"), "CLI room health text did not render missing REPORT status");
  assert(cliRoomHealthText.includes("Last wake: Initial room wake."), "CLI room health text did not render the last wake reason");
  assert(cliRoomHealthText.includes("Recovery actions:"), "CLI room health text did not render recovery actions");
  const cliRooms = await runCliJson(["room", "list", "--gateway", base, "--token", token]);
  assert(Array.isArray(cliRooms) && cliRooms.some((item) => item.id === finalRoom.id), "CLI room list did not include the smoke room");
  const cliNodes = await runCliJson(["nodes", "--gateway", base, "--token", token]);
  assert(Array.isArray(cliNodes) && cliNodes.some((item) => item.node_id === "offline-smoke-node"), "CLI nodes did not include the smoke node");
  assert(cliNodes.some((item) => item.node_id === "offline-smoke-node" && /^edge_session_/.test(item.edge_session_id || "")), "CLI nodes did not expose edge_session_id");
  const cliStatus = await runCliJson(["status", "--json", "--gateway", base, "--token", token]);
  assert(cliStatus.ok === true, "CLI status did not report ok=true");
  assert(cliStatus.summary?.online_agents === 4, "CLI status did not count all online smoke agents");
  assert(cliStatus.nodes?.some((item) => item.id === "offline-smoke-node" && item.freshness?.startsWith("online/fresh")), "CLI status did not include node freshness");
  assert(cliStatus.rooms?.some((item) => item.id === finalRoom.id), "CLI status did not include the smoke room");
  const statusAgent = cliStatus.agents?.find((item) => item.id === "offline-agent");
  assert(statusAgent?.freshness?.startsWith("online/fresh"), "CLI status JSON did not include derived freshness label");
  assert(statusAgent?.activity === "idle", "CLI status JSON did not include derived idle activity label");
  assert(Array.isArray(statusAgent?.active_runs) && statusAgent.active_runs.length === 0, "CLI status JSON should expose no active runs after completion");
  assert(statusAgent?.current_run === null, "CLI status JSON should expose current_run=null after completion");
  assert(statusAgent?.ping_label === "not configured", "CLI status JSON did not include derived ping label");
  assert(statusAgent?.last_run_health === "ok", "CLI status JSON did not include derived last-run health");
  const cliStatusText = await runCliText(["status", "--gateway", base, "--token", token]);
  assert(cliStatusText.includes("node=online/fresh"), "CLI status human output did not include node freshness");
  assert(cliStatusText.includes("activity=idle"), "CLI status human output did not include activity label");
  assert(cliStatusText.includes("ping=not configured"), "CLI status human output did not include ping label");
  assert(cliStatusText.includes("last_run=ok"), "CLI status human output did not include last-run health");
  const cliExport = await runCliText(["room", "export", finalRoom.id, "--gateway", base, "--token", token]);
  assert(cliExport.includes(`# Agent Bus Room: ${finalRoom.title}`), "CLI room export did not render markdown title");
  assert(cliExport.includes("offline smoke run completed"), "CLI room export did not include report content");
  assert(cliExport.includes("## Agent Checklist"), "CLI room export did not include agent checklist");
  assert(!cliExport.includes("sk-test-secret-000000000000000000"), "CLI room export did not redact token-like content");
  assert(cliExport.includes("token=[REDACTED]"), "CLI room export did not include a redaction marker");
  const summaryExport = await runCliText(["room", "export", finalRoom.id, "--reports-only", "--gateway", base, "--token", token]);
  assert(summaryExport.includes("## Reports"), "CLI room export --reports-only did not include reports");
  assert(summaryExport.includes("## Agent Checklist"), "CLI room export --reports-only did not include agent checklist");
  assert(summaryExport.includes("reports-only:"), "CLI room export --reports-only did not mark the sharing boundary");
  assert(!summaryExport.includes("## Goal"), "CLI room export --reports-only included the room goal");
  assert(!summaryExport.includes("## Messages"), "CLI room export --reports-only included full messages");
  const exportJson = path.join(tempDir, "room-export.json");
  await runCliText(["room", "export", finalRoom.id, "--format", "json", "--out", exportJson, "--gateway", base, "--token", token]);
  const exportJsonText = fs.readFileSync(exportJson, "utf8");
  assert(!exportJsonText.includes("sk-test-secret-000000000000000000"), "CLI room export --format json did not redact token-like content");
  const exportedRoom = JSON.parse(exportJsonText);
  assert(exportedRoom.id === finalRoom.id, "CLI room export --format json wrote the wrong room");
  const summaryJson = await runCliJson(["room", "export", finalRoom.id, "--format", "json", "--reports-only", "--gateway", base, "--token", token]);
  assert(summaryJson.id === finalRoom.id, "CLI room export --reports-only json wrote the wrong room");
  assert(summaryJson.object === "agent_bus.room_reports_summary", "CLI room export --reports-only json omitted the summary object type");
  assert(summaryJson.blackboard?.agent_checklist?.summary?.completed_agents === 1, "CLI room export --reports-only json omitted checklist summary");
  assert(!Object.hasOwn(summaryJson, "goal"), "CLI room export --reports-only json included the room goal");
  assert(!Object.hasOwn(summaryJson, "messages"), "CLI room export --reports-only json included full messages");
  const eventBundle = await runCliJson(["room", "export", finalRoom.id, "--format", "events", "--gateway", base, "--token", token]);
  assert(eventBundle.object === "agent_bus.room_event_bundle", "CLI room export --format events did not return an event bundle");
  assert(eventBundle.room?.id === finalRoom.id, "event bundle has the wrong room id");
  assert(eventBundle.export_metadata?.format === "events", "event bundle did not include export metadata");
  assert(eventBundle.export_metadata?.event_count === eventBundle.events?.length, "event bundle export metadata has the wrong event count");
  assert(eventBundle.events?.every((event, index) => event.sequence === index + 1), "event bundle events did not include contiguous sequence numbers");
  assert(eventBundle.events?.some((event) => event.type === "room.created"), "event bundle did not include room.created");
  assert(eventBundle.events?.some((event) => event.type === "run.completed"), "event bundle did not include run.completed");
  assert(eventBundle.events?.some((event) => event.type === "room.report.added"), "event bundle did not include room.report.added");
  assert(!JSON.stringify(eventBundle).includes("sk-test-secret-000000000000000000"), "event bundle did not redact token-like content");
  const reportsOnlyBundle = await runCliJson(["room", "export", finalRoom.id, "--format", "events", "--reports-only", "--gateway", base, "--token", token]);
  assert(reportsOnlyBundle.reports_only === true, "reports-only event bundle did not mark reports_only=true");
  assert(reportsOnlyBundle.events?.some((event) => event.type === "room.created" && event.payload?.goal_omitted === true), "reports-only event bundle did not omit the room goal");
  assert(!JSON.stringify(reportsOnlyBundle).includes("Verify Agent Bus room dispatch"), "reports-only event bundle leaked the room goal text");
  const eventBundlePath = path.join(tempDir, "room-events.json");
  await runCliText(["room", "export", finalRoom.id, "--format", "events", "--out", eventBundlePath, "--gateway", base, "--token", token]);
  const replayJson = await runCliJson(["room", "replay", "--in", eventBundlePath]);
  assert(replayJson.object === "agent_bus.room_replay", "CLI room replay did not return a replay summary");
  assert(replayJson.room?.id === finalRoom.id, "CLI room replay returned the wrong room id");
  assert(replayJson.export_metadata?.format === "events", "CLI room replay did not preserve export metadata");
  assert(replayJson.counts?.completed_runs >= 1, "CLI room replay did not count completed runs");
  assert(replayJson.counts?.reports >= 1, "CLI room replay did not count reports");
  const replayMarkdown = await runCliText(["room", "replay", "--in", eventBundlePath, "--format", "markdown"]);
  assert(replayMarkdown.includes("# Agent Bus Room Replay:"), "CLI room replay --format markdown did not render a title");
  assert(replayMarkdown.includes("offline smoke run completed"), "CLI room replay markdown did not include report content");
  const completedDoctor = await runCliJson(["room", "doctor", finalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(completedDoctor.object === "agent_bus.room_doctor", "CLI room doctor did not return a doctor object");
  assert(completedDoctor.summary === "completed", `completed room doctor returned ${completedDoctor.summary}`);
  assert(completedDoctor.actions?.some((item) => item.kind === "archive_or_export_completed_room"), "completed room doctor did not suggest archive/export");

  const contractGapRoom = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline contract gap room",
      goal: "Verify room doctor catches a completed room where an agent emitted DONE without REPORT.",
      agents: ["offline-no-report-agent"],
      wakeAgents: ["offline-no-report-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const contractGapFinalRoom = await waitForRoomComplete(base, token, contractGapRoom.id);
  assert(contractGapFinalRoom.status === "completed", "contract gap room did not complete");
  assert(contractGapFinalRoom.blackboard?.agent_checklist?.summary?.missing_report_agents?.includes("offline-no-report-agent"), "contract gap room checklist did not mark missing REPORT");
  const contractGapDoctor = await runCliJson(["room", "doctor", contractGapFinalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(contractGapDoctor.summary === "completed_with_contract_gaps", `contract gap doctor returned ${contractGapDoctor.summary}`);
  assert(contractGapDoctor.contract?.missing_report_agents?.includes("offline-no-report-agent"), "contract gap doctor did not expose missing REPORT agent");
  assert(contractGapDoctor.counts?.contract_gap_agents === 1, "contract gap doctor did not count contract gap agent");
  assert(contractGapDoctor.actions?.some((item) => item.kind === "create_contract_followup_room" && /room create/.test(item.command || "")), "contract gap doctor did not suggest a follow-up room");
  const contractGapDoctorText = await runCliText(["room", "doctor", contractGapFinalRoom.id, "--gateway", base, "--token", token]);
  assert(contractGapDoctorText.includes("completed_with_contract_gaps"), "contract gap doctor human output did not expose contract gap summary");
  assert(contractGapDoctorText.includes("Missing REPORT: offline-no-report-agent"), "contract gap doctor human output did not list missing REPORT agent");
  const contractGapHealth = await runCliJson(["room", "health", contractGapFinalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(contractGapHealth.recovery_actions?.some((item) => item.kind === "request_report" && /room create/.test(item.command || "")), "contract gap health did not suggest a follow-up room instead of waking a completed room");

  const failedRoom = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline failed room",
      goal: "Verify failed room runs are visible in the agent checklist without requiring model quota.",
      agents: ["offline-fail-agent"],
      wakeAgents: ["offline-fail-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const failedFinalRoom = await waitForRoomRunTerminal(base, token, failedRoom.id, "offline-fail-agent");
  const failedRun = failedFinalRoom.runs?.find((item) => item.agent_id === "offline-fail-agent");
  const failedChecklist = failedFinalRoom.blackboard?.agent_checklist;
  const failedChecklistAgent = failedChecklist?.agents?.["offline-fail-agent"];
  assert(failedRun?.status === "failed", "offline failed room run did not fail");
  assert(failedRun?.attempt?.attempt_no === 1, "failed room run did not record attempt_no=1");
  assert(failedRun?.attempt?.failure_class === "upstream_transient", `failed room run classified as ${failedRun?.attempt?.failure_class || "missing"} instead of upstream_transient`);
  assert(failedRun?.attempt?.failure_category === "model_gateway", `failed room run category was ${failedRun?.attempt?.failure_category || "missing"} instead of model_gateway`);
  assert(failedRun?.attempt?.recommended_action === "retry_failed_agents", "failed room run did not record retry_failed_agents recommended action");
  assert(failedRun?.attempt?.retryable === true, "failed room upstream transient attempt was not marked retryable");
  assert(failedChecklist?.summary?.failed_agents === 1, "room checklist did not count failed agents");
  assert(failedChecklist?.summary?.missing_report_agents?.includes("offline-fail-agent"), "room checklist did not mark missing REPORT on failed agent");
  assert(failedChecklist?.summary?.missing_done_agents?.includes("offline-fail-agent"), "room checklist did not mark missing DONE on failed agent");
  assert(failedChecklistAgent?.status === "failed", "room checklist did not record failed agent status");
  assert(failedChecklistAgent?.has_report === false, "room checklist incorrectly marked failed agent as having REPORT");
  assert(failedChecklistAgent?.has_done === false, "room checklist incorrectly marked failed agent as having DONE");
  assert(failedChecklistAgent?.failure_category === "model_gateway", "room checklist did not record failed agent category");
  assert(failedChecklistAgent?.recommended_action === "retry_failed_agents", "room checklist did not record failed agent recommended action");
  assert(/502 Upstream/.test(failedChecklistAgent?.error || ""), "room checklist did not capture failed agent error text");
  const failedHealth = await runCliJson(["room", "health", failedFinalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(failedHealth.summary?.failed_agents === 1, "CLI room health did not count failed agents");
  assert(failedHealth.summary?.missing_report_agents?.includes("offline-fail-agent"), "CLI room health did not expose missing REPORT agents");
  assert(failedHealth.agents?.some((item) => item.agent_id === "offline-fail-agent" && item.status === "failed" && /502 Upstream/.test(item.last_error || "")), "CLI room health did not expose failed agent error");
  assert(failedHealth.agents?.some((item) => item.agent_id === "offline-fail-agent" && item.attempt_no === 1 && item.failure_class === "upstream_transient" && item.failure_category === "model_gateway" && item.recommended_action === "retry_failed_agents" && item.retryable === true), "CLI room health did not expose attempt failure taxonomy and recommended action");
  assert(failedHealth.recovery_actions?.some((item) => item.kind === "request_report" && item.agents?.includes("offline-fail-agent")), "CLI room health did not suggest requesting REPORT from a failed agent");
  assert(failedHealth.recovery_actions?.some((item) => item.kind === "recover_failed_agents" && item.agents?.includes("offline-fail-agent")), "CLI room health did not suggest failed-agent recovery");
  assert(failedHealth.recovery_actions?.some((item) => item.kind === "recover_failed_agents" && /retry-failed/.test(item.command || "")), "CLI room health did not suggest the guarded failed-agent retry command");
  const failedRetryDryRun = await runCliJson(["room", "retry-failed", failedFinalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(failedRetryDryRun.dry_run === true, "CLI room retry-failed did not default to dry-run");
  assert(failedRetryDryRun.inspection?.retryable_agents?.includes("offline-fail-agent"), "CLI room retry-failed did not identify the failed agent as retryable");
  assert(failedRetryDryRun.inspection?.safe_retryable_agents?.includes("offline-fail-agent"), "CLI room retry-failed did not expose taxonomy-safe retryable agents");
  assert(failedRetryDryRun.inspection?.groups?.some((item) => item.agent_id === "offline-fail-agent" && item.taxonomy_retryable === true && item.failure_category === "model_gateway" && item.recommended_action === "retry_failed_agents"), "CLI room retry-failed did not expose enriched taxonomy for upstream transient failure");
  const failedDoctor = await runCliJson(["room", "doctor", failedFinalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(failedDoctor.summary === "failed_agents_retryable", `failed room doctor returned ${failedDoctor.summary}`);
  assert(failedDoctor.retryable_failed_agents?.includes("offline-fail-agent"), "failed room doctor did not expose retryable failed agent");
  assert(failedDoctor.failed_attempts?.some((item) => item.agent_id === "offline-fail-agent" && item.failure_category === "model_gateway" && item.recommended_action === "retry_failed_agents"), "failed room doctor did not expose failed attempt category/action");
  assert(failedDoctor.actions?.some((item) => item.kind === "retry_failed_agents" && /retry-failed/.test(item.command || "")), "failed room doctor did not suggest failed-agent retry");
  const failedDoctorText = await runCliText(["room", "doctor", failedFinalRoom.id, "--gateway", base, "--token", token]);
  assert(failedDoctorText.includes("Agent Bus room doctor:"), "CLI room doctor did not render human output");
  assert(failedDoctorText.includes("offline-fail-agent"), "CLI room doctor human output did not include failed agent");
  const failedRetry = await runCliJson(["room", "retry-failed", failedFinalRoom.id, "--yes", "--json", "--reason", "offline smoke retry failed agent", "--gateway", base, "--token", token]);
  assert(failedRetry.executed === true, "CLI room retry-failed --yes did not execute");
  assert(failedRetry.created_run_ids?.length === 1, "CLI room retry-failed --yes did not create one retry run");
  const failedRetryRun = await waitForRunTerminal(base, token, failedRetry.created_run_ids[0]);
  assert(failedRetryRun.status === "failed", "retry failed-agent run did not reach failed terminal status");
  assert(failedRetryRun.attempt?.attempt_no === 2, "retry failed-agent run did not record attempt_no=2");
  assert(failedRetryRun.attempt?.retry_of_run_id === failedRun.id, "retry failed-agent run did not record retry_of_run_id");
  assert(failedRetryRun.attempt?.source_failure_category === "model_gateway", "retry failed-agent run did not record source failure category");
  assert(failedRetryRun.attempt?.source_recommended_action === "retry_failed_agents", "retry failed-agent run did not record source recommended action");
  assert(failedRetryRun.attempt?.failure_class === "upstream_transient", "retry failed-agent run did not preserve upstream transient classification");
  const failedAfterRetry = await requestJson(`${base}/rooms/${failedFinalRoom.id}`, { headers: authHeaders(token) });
  assert(failedAfterRetry.runs?.filter((item) => item.agent_id === "offline-fail-agent" && item.status === "failed").length === 2, "failed-agent retry did not preserve both failed attempts");
  assert(failedAfterRetry.blackboard?.agent_checklist?.agents?.["offline-fail-agent"]?.run_count === 2, "failed-agent retry did not update checklist run count");
  await runCliJson(["room", "pause", failedAfterRetry.id, "--reason", "offline smoke failed room checked", "--gateway", base, "--token", token]);

  const authFailedRoom = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline auth failed room",
      goal: "Verify non-transient failures are blocked from automatic failed-agent retry.",
      agents: ["offline-auth-fail-agent"],
      wakeAgents: ["offline-auth-fail-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const authFailedFinalRoom = await waitForRoomRunTerminal(base, token, authFailedRoom.id, "offline-auth-fail-agent");
  const authFailedRun = authFailedFinalRoom.runs?.find((item) => item.agent_id === "offline-auth-fail-agent");
  assert(authFailedRun?.status === "failed", "offline auth failure room run did not fail");
  assert(authFailedRun?.attempt?.failure_class === "auth_config", `auth failure classified as ${authFailedRun?.attempt?.failure_class || "missing"} instead of auth_config`);
  assert(authFailedRun?.attempt?.failure_category === "auth_config", "auth failure did not record auth_config category");
  assert(authFailedRun?.attempt?.recommended_action === "fix_auth_or_model_config", "auth failure did not record fix_auth_or_model_config recommended action");
  assert(authFailedRun?.attempt?.retryable === false, "auth failure was incorrectly marked retryable");
  const authRetryDryRun = await runCliJson(["room", "retry-failed", authFailedFinalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(authRetryDryRun.inspection?.retryable_agents?.length === 0, "auth failure was incorrectly retryable without --force");
  assert(authRetryDryRun.inspection?.blocked_failure_class_agents?.includes("offline-auth-fail-agent"), "auth failure was not blocked by failure class");
  assert(authRetryDryRun.inspection?.groups?.some((item) => item.agent_id === "offline-auth-fail-agent" && item.taxonomy_retryable === false && item.failure_category === "auth_config" && item.recommended_action === "fix_auth_or_model_config" && item.blocked_reason === "failure_class_not_retryable"), "auth failure retry inspection did not expose taxonomy block reason and recommended action");
  const authForceDryRun = await runCliJson(["room", "retry-failed", authFailedFinalRoom.id, "--force", "--json", "--gateway", base, "--token", token]);
  assert(authForceDryRun.inspection?.retryable_agents?.includes("offline-auth-fail-agent"), "auth failure was not force-retryable in dry-run");
  assert(authForceDryRun.inspection?.groups?.some((item) => item.agent_id === "offline-auth-fail-agent" && item.forced_retry === true), "force retry dry-run did not mark forced_retry=true");
  const authDoctor = await runCliJson(["room", "doctor", authFailedFinalRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(authDoctor.summary === "failed_agents_blocked", `auth failed room doctor returned ${authDoctor.summary}`);
  assert(authDoctor.blocked_failed_agents?.includes("offline-auth-fail-agent"), "auth failed room doctor did not expose blocked failed agent");
  assert(authDoctor.failed_attempts?.some((item) => item.agent_id === "offline-auth-fail-agent" && item.failure_category === "auth_config" && item.recommended_action === "fix_auth_or_model_config"), "auth failed room doctor did not expose blocked failed category/action");
  assert(authDoctor.actions?.some((item) => item.kind === "inspect_or_force_failed_agents" && /--force/.test(item.command || "")), "auth failed room doctor did not suggest explicit force retry path");
  await runCliJson(["room", "pause", authFailedFinalRoom.id, "--reason", "offline smoke auth failed room checked", "--gateway", base, "--token", token]);

  if (!edge.killed) edge.kill("SIGTERM");
  await waitForExit(edge);
  await delay(1200);
  const duplicateActiveRoom = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline duplicate active room",
      goal: "Verify room health detects duplicate active runs for the same agent.",
      agents: ["offline-agent"],
      wakeAgents: ["offline-agent"],
      auto_rotate: false,
      max_steps: 3
    })
  });
  const duplicateWokenRoom = await runCliJson(["room", "wake", duplicateActiveRoom.id, "--agent", "offline-agent", "--reason", "intentional duplicate active run smoke", "--gateway", base, "--token", token]);
  assert((duplicateWokenRoom.runs || []).filter((item) => item.agent_id === "offline-agent" && item.status === "queued").length === 2, "duplicate active room did not create two queued runs for the same agent");
  const duplicateHealth = await runCliJson(["room", "health", duplicateActiveRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(duplicateHealth.summary?.duplicate_active_agent_count === 1, "CLI room health did not count duplicate active agents");
  assert(duplicateHealth.summary?.duplicate_active_agents?.includes("offline-agent"), "CLI room health did not expose duplicate active agent ids");
  assert(duplicateHealth.agents?.some((item) => item.agent_id === "offline-agent" && item.active_run_count === 2 && item.active_run_ids?.length === 2), "CLI room health did not expose duplicate active run ids");
  assert(duplicateHealth.recovery_actions?.some((item) => item.kind === "resolve_duplicate_active_runs" && item.agents?.includes("offline-agent")), "CLI room health did not suggest resolving duplicate active runs");
  const duplicateHealthText = await runCliText(["room", "health", duplicateActiveRoom.id, "--gateway", base, "--token", token]);
  assert(duplicateHealthText.includes("Duplicate active agents: `offline-agent`"), "CLI room health text did not render duplicate active agents");
  const duplicateDryRun = await runCliJson(["room", "resolve-duplicates", duplicateActiveRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(duplicateDryRun.dry_run === true, "CLI room resolve-duplicates did not default to dry run");
  assert(duplicateDryRun.inspection?.cancellable_queued_run_ids?.length === 1, "CLI room resolve-duplicates did not identify one queued duplicate");
  const duplicateResolved = await runCliJson(["room", "resolve-duplicates", duplicateActiveRoom.id, "--yes", "--json", "--gateway", base, "--token", token]);
  assert(duplicateResolved.executed === true, "CLI room resolve-duplicates --yes did not execute");
  assert(duplicateResolved.cancelled_queued_runs?.length === 1, "CLI room resolve-duplicates --yes did not cancel one queued duplicate");
  assert(duplicateResolved.room?.runs?.filter((item) => item.agent_id === "offline-agent" && item.status === "queued").length === 1, "CLI room resolve-duplicates --yes did not leave exactly one queued run");
  assert(duplicateResolved.room?.runs?.filter((item) => item.agent_id === "offline-agent" && item.status === "cancelled").length === 1, "CLI room resolve-duplicates --yes did not mark one duplicate run cancelled");
  const duplicateAfterHealth = await runCliJson(["room", "health", duplicateActiveRoom.id, "--json", "--gateway", base, "--token", token]);
  assert(duplicateAfterHealth.summary?.duplicate_active_agent_count === 0, "CLI room health still reported duplicate active agents after resolve-duplicates");
  await runCliJson(["room", "pause", duplicateActiveRoom.id, "--reason", "offline smoke duplicate active checked", "--gateway", base, "--token", token]);

  const pauseRoom = await requestJson(`${base}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Offline pause recovery room",
      goal: "Verify room pause cancels queued work without deleting history.",
      agents: ["offline-agent"],
      wakeAgents: ["offline-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const queuedBeforePause = await requestJson(`${base}/health`);
  assert(queuedBeforePause.queued >= 1, "pause recovery room did not leave queued work in the gateway");
  assert(pauseRoom.status === "active", "pause recovery room was not active before pause");
  assert(pauseRoom.runs?.length === 1 && pauseRoom.runs[0].status === "queued", "pause recovery room did not have one queued run before pause");
  const pausedRoom = await runCliJson(["room", "pause", pauseRoom.id, "--reason", "offline smoke recovery", "--gateway", base, "--token", token]);
  assert(pausedRoom.status === "paused", "CLI room pause did not return a paused room");
  assert(pausedRoom.runs?.length === 1 && pausedRoom.runs[0].status === "cancelled", "CLI room pause did not cancel the queued room run");
  const queuedAfterPause = await requestJson(`${base}/health`);
  assert(queuedAfterPause.queued <= queuedBeforePause.queued - 1, "CLI room pause did not remove the queued room task");
  assert(pausedRoom.reports?.some((item) => /Paused by operator: offline smoke recovery/.test(item.content || "")), "CLI room pause did not add an operator report");
  const pausedStatus = await runCliJson(["status", "--json", "--gateway", base, "--token", token]);
  assert(!pausedStatus.rooms?.some((item) => item.id === pauseRoom.id && ["active", "running", "finishing"].includes(item.status)), "CLI status should not report the paused room as active");
  assert(pausedStatus.summary?.active_rooms === 0, "CLI status should not count the paused room as active");
  const pausedAfterWake = await runCliJson(["room", "wake", pauseRoom.id, "--agent", "offline-agent", "--gateway", base, "--token", token]);
  assert(pausedAfterWake.status === "paused", "CLI room wake should leave a paused room paused");
  assert((pausedAfterWake.runs || []).length === 1, "CLI room wake should not create a new run for a paused room");

  const restartedEdge = start(process.execPath, [path.join(root, "edge-node.mjs"), "connect", "--config", edgeConfig], {
    AGENT_BUS_CONFIG: edgeConfig
  });
  const reconnectedNode = await waitForNodeReconnect(base, token, "offline-smoke-node");
  assert((reconnectedNode?.restart_count || 0) >= 1, "edge reconnect did not increment restart_count");
  assert(/^edge_session_/.test(reconnectedNode?.previous_edge_session_id || ""), "edge reconnect did not preserve previous_edge_session_id");
  assert(/^edge_session_/.test(reconnectedNode?.edge_session_id || ""), "edge reconnect did not expose the current edge_session_id");
  if (!restartedEdge.killed) restartedEdge.kill("SIGTERM");

  const result = {
    ok: true,
    mode: "offline",
    quota: "no_model_calls",
    gateway: base,
    agent_status: agent.status,
    ping_status: agent.ping_status,
    room_id: finalRoom.id,
    room_status: finalRoom.status,
    failed_room_id: failedFinalRoom.id,
    failed_room_status: failedFinalRoom.status,
    paused_room_id: pausedRoom.id,
    paused_cancelled_runs: pausedRoom.pause?.cancelled_queued_runs?.length || 0,
    run_id: run.id,
    failed_run_id: failedRun.id,
    reports: finalRoom.reports?.length || 0,
    blackboard_notes: finalRoom.blackboard?.notes?.length || 0,
    checklist_completed_agents: checklist?.summary?.completed_agents || 0,
    checklist_failed_agents: failedChecklist?.summary?.failed_agents || 0,
    event_count: eventBundle.events?.length || 0,
    export_bytes: Buffer.byteLength(cliExport)
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("Agent Bus offline smoke passed");
    console.log(`Room: ${result.room_id}`);
    console.log(`Run: ${result.run_id}`);
    console.log("Quota: no model calls");
  }

  if (!edge.killed) edge.kill("SIGTERM");
  if (!central.killed) central.kill("SIGTERM");
}

function start(command, commandArgs, env = {}) {
  const child = spawn(command, commandArgs, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (!jsonOut) {
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  }
  child.on("exit", (code, signal) => {
    if (code && !child.killed && !jsonOut) {
      console.error(`${path.basename(command)} exited with ${code || signal}`);
    }
  });
  procs.push(child);
  return child;
}


function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) {
    delete env[name];
  }
  return { ...env, ...overrides };
}

function runCliJson(commandArgs, timeoutMs = 10000) {
  return runCliText(commandArgs, timeoutMs).then((stdout) => {
    try {
      return JSON.parse(stdout);
    } catch (err) {
      throw new Error(`CLI did not return JSON: ${stdout || err.message}`);
    }
  });
}

function runCliText(commandArgs, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "agent-bus.mjs"), ...commandArgs], {
      cwd: root,
      env: smokeChildEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI timed out: agent-bus ${commandArgs.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`CLI exited with ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];

function findPython() {
  const candidates = [...new Set([
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean))];
  for (const candidate of candidates) {
    const version = pythonVersion(candidate);
    if (version && (version.major > 3 || (version.major === 3 && version.minor >= 10))) return candidate;
  }
  return "";
}

function pythonVersion(candidate) {
  const result = spawnSync(candidate, ["-c", "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')"], {
    encoding: "utf8",
    windowsHide: true
  });
  if (result.error || result.status !== 0) return null;
  const match = String(result.stdout || "").trim().match(/^(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10)
  };
}

function commonBundledPythonPaths() {
  const home = os.homedir();
  const roots = [
    path.join(home, ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "python"),
    path.join(home, ".codex", "runtimes", "codex-primary-runtime", "dependencies", "python")
  ];
  const names = process.platform === "win32"
    ? ["python.exe"]
    : ["bin/python3", "bin/python", "python3", "python"];
  return roots.flatMap((rootDir) => names.map((name) => path.join(rootDir, name)));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForAgent(base, token, agentId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const agents = await requestJson(`${base}/agents`, { headers: authHeaders(token) });
    const agent = agents.find((item) => item.id === agentId);
    if (agent) return agent;
    await delay(250);
  }
  throw new Error(`Timed out waiting for agent ${agentId}`);
}

async function waitForNodeReconnect(base, token, nodeId, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const nodes = await requestJson(`${base}/nodes`, { headers: authHeaders(token) });
    const node = nodes.find((item) => item.node_id === nodeId);
    if ((node?.restart_count || 0) >= 1 && node?.previous_edge_session_id && node?.edge_session_id) return node;
    await delay(250);
  }
  throw new Error(`Timed out waiting for node reconnect ${nodeId}`);
}

async function waitForRoomComplete(base, token, roomId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${base}/rooms/${roomId}`, { headers: authHeaders(token) });
    const terminalRuns = (room.runs || []).filter((run) => ["completed", "failed", "error"].includes(run.status));
    if (room.status === "completed" && terminalRuns.length) return room;
    await delay(250);
  }
  throw new Error(`Timed out waiting for room ${roomId}`);
}

async function waitForRoomRunTerminal(base, token, roomId, agentId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const room = await requestJson(`${base}/rooms/${roomId}`, { headers: authHeaders(token) });
    const run = (room.runs || []).find((item) => item.agent_id === agentId && ["completed", "failed", "error"].includes(item.status));
    if (run) return room;
    await delay(250);
  }
  throw new Error(`Timed out waiting for terminal run from ${agentId} in room ${roomId}`);
}

async function waitForRunTerminal(base, token, runId, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await requestJson(`${base}/runs/${runId}`, { headers: authHeaders(token) });
    if (["completed", "failed", "error", "cancelled", "canceled"].includes(run.status)) return run;
    await delay(250);
  }
  throw new Error(`Timed out waiting for terminal run ${runId}`);
}

async function waitForJson(url, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await requestJson(url);
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function quoteCommandArg(value) {
  const text = String(value || "");
  if (process.platform === "win32") return `"${text.replace(/"/g, '""')}"`;
  return `"${text.replace(/(["\\$`])/g, "\\$1")}"`;
}
