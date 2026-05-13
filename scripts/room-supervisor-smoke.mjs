import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");
const procs = [];
const childLogs = new WeakMap();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-room-supervisor-"));
const HERMETIC_AGENT_BUS_ENV = [
  "AGENT_BUS_GATEWAY_URL",
  "AGENT_BUS_TOKEN",
  "AGENT_BUS_NODE_ID",
  "AGENT_BUS_ROOM_ID",
  "AGENT_BUS_CONFIG",
  "AGENT_BUS_HOST",
  "AGENT_BUS_PORT",
  "AGENT_BUS_DATA_DIR"
];

main().catch((err) => {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}).finally(async () => {
  for (const child of procs.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
    await waitForExit(child);
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function main() {
  const python = findPython();
  if (!python) throw new Error("room supervisor smoke requires Python 3.6+.");

  const port = await freePort();
  const gateway = `http://127.0.0.1:${port}`;
  const token = "sk-room-supervisor-smoke-token-000000";
  const configPath = path.join(tempDir, "central.config.json");
  const dataDir = path.join(tempDir, "data");
  const roomAgentIds = ["old-runner", "replacement-runner"];

  fs.writeFileSync(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    dataDir,
    token,
    defaults: { mode: "orchestrate", pollTimeoutMs: 500 },
    modelRouter: { enabled: false, backends: [] }
  }, null, 2)}\n`);

  step("Starting Python central");
  let central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir
  });
  await waitForJson(`${gateway}/health`, 15000, central);

  step("Registering a fake edge node");
  await registerFakeEdge(gateway, token, roomAgentIds);

  step("Verifying duplicate agent id guardrail");
  await registerDuplicateAgentEdges(gateway, token);
  const duplicateStatus = await runCliJson(["status", "--json", "--gateway", gateway, "--token", token]);
  assert(duplicateStatus.summary?.duplicate_agent_ids === 1, "CLI status did not count duplicate agent ids");
  assert(duplicateStatus.readiness?.status === "duplicate-agent-ids", "CLI status did not elevate duplicate agent ids into readiness");
  assert(duplicateStatus.agent_id_conflicts?.some((item) => item.id === "duplicate-agent" && item.nodes?.includes("duplicate-edge-a") && item.nodes?.includes("duplicate-edge-b")), "CLI status did not expose duplicate agent conflict metadata");
  const duplicateRoom = await fetch(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Duplicate agent guardrail smoke",
      goal: "Verify duplicate agent ids cannot be routed ambiguously.",
      agents: ["duplicate-agent"],
      wakeAgents: ["duplicate-agent"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const duplicateRoomText = await duplicateRoom.text();
  assert(duplicateRoom.status === 409, `duplicate agent room create returned ${duplicateRoom.status}: ${duplicateRoomText}`);

  step("Verifying supervisor resolves duplicate queued runs conservatively");
  const duplicateQueuedRoom = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Room supervisor duplicate queued smoke",
      goal: "Verify conservative supervisor cancels duplicate queued work without pausing the room.",
      agents: ["old-runner"],
      wakeAgents: ["old-runner"],
      auto_rotate: false,
      max_steps: 3
    })
  });
  await runCliJson([
    "room",
    "wake",
    duplicateQueuedRoom.id,
    "--agent",
    "old-runner",
    "--reason",
    "intentional duplicate queued run for supervisor smoke",
    "--gateway",
    gateway,
    "--token",
    token
  ]);
  const duplicateSupervisorDryRun = await runCliJson([
    "room",
    "supervisor",
    duplicateQueuedRoom.id,
    "--json",
    "--gateway",
    gateway,
    "--token",
    token
  ]);
  assert(duplicateSupervisorDryRun.dry_run === true, "duplicate supervisor did not default to dry-run");
  assert(duplicateSupervisorDryRun.plan?.safe_executable_actions?.some((action) => action.kind === "resolve_duplicate_active_runs"), "duplicate supervisor did not plan duplicate resolution");
  assert(duplicateSupervisorDryRun.inspection?.analysis?.duplicate_active_runs?.cancellable_queued_run_ids?.length === 1, "duplicate supervisor did not identify one cancellable queued duplicate");
  const duplicateSupervisorResolved = await runCliJson([
    "room",
    "supervisor",
    duplicateQueuedRoom.id,
    "--yes",
    "--json",
    "--gateway",
    gateway,
    "--token",
    token,
    "--reason",
    "confirmed duplicate queued supervisor smoke"
  ]);
  assert(duplicateSupervisorResolved.executed === true, "duplicate supervisor did not execute");
  assert(duplicateSupervisorResolved.executed_action?.kind === "resolve_duplicate_active_runs", "duplicate supervisor executed the wrong action");
  assert(duplicateSupervisorResolved.cancelled_queued_runs?.length === 1, "duplicate supervisor did not cancel one queued duplicate");
  assert(duplicateSupervisorResolved.room?.status === "active", "duplicate supervisor unexpectedly paused the room");
  assert(duplicateSupervisorResolved.room?.runs?.filter((run) => run.agent_id === "old-runner" && run.status === "queued").length === 1, "duplicate supervisor did not leave exactly one queued run");
  assert(duplicateSupervisorResolved.room?.runs?.filter((run) => run.agent_id === "old-runner" && run.status === "cancelled").length === 1, "duplicate supervisor did not mark one duplicate cancelled");
  assert(duplicateSupervisorResolved.inspection_after?.analysis?.duplicate_active_runs?.duplicate_active_agent_count === 0, "duplicate supervisor still reported duplicate active runs after execution");
  await runCliJson(["room", "pause", duplicateQueuedRoom.id, "--reason", "room supervisor duplicate queued smoke cleanup", "--gateway", gateway, "--token", token]);

  step("Creating a room and claiming the original run");
  const room = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Room supervisor PR-1 smoke",
      goal: "Verify replaced room runs cannot pollute the room when their completion arrives late.",
      agents: roomAgentIds,
      wakeAgents: ["old-runner"],
      auto_rotate: false,
      max_steps: 4
    })
  });
  const oldRunId = room.runs?.[0]?.id;
  assert(oldRunId, "room did not create the original run");
  const oldTask = await pollTask(gateway, token, oldRunId);
  await requestJson(`${gateway}/edge/events`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "room-supervisor-edge",
      run_id: oldRunId,
      trace_id: room.trace_id,
      event: { type: "run.started", agent_id: "old-runner" }
    })
  });
  assert(oldTask.task?.agent_id === "old-runner", "fake edge claimed the wrong original agent");

  step("Creating a replacement run and injecting replacement metadata");
  const wokeRoom = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}/wake`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      agents: ["replacement-runner"],
      reason: "Manual replacement for PR-1 smoke."
    })
  });
  const replacementRunId = wokeRoom.runs?.find((run) => run.id !== oldRunId)?.id;
  assert(replacementRunId, "room wake did not create a replacement run");

  await stopChild(central);
  central = null;

  patchRunSnapshot(dataDir, oldRunId, (run) => {
    run.status = "running";
    run.replaced_by_run_id = replacementRunId;
    run.replacement_reason = "room-supervisor-smoke";
  });
  patchRoomSnapshot(dataDir, room.id, oldRunId, (run) => {
    run.status = "running";
    run.replaced_by_run_id = replacementRunId;
    run.replacement_reason = "room-supervisor-smoke";
  });

  step("Restarting Python central and completing the replacement run");
  central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir
  });
  await waitForJson(`${gateway}/health`, 15000, central);
  await registerFakeEdge(gateway, token, roomAgentIds);

  const replacementTask = await pollTask(gateway, token, replacementRunId);
  assert(replacementTask.task?.agent_id === "replacement-runner", "fake edge claimed the wrong replacement agent");
  await requestJson(`${gateway}/edge/events`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "room-supervisor-edge",
      run_id: replacementRunId,
      trace_id: room.trace_id,
      event: { type: "run.started", agent_id: "replacement-runner" }
    })
  });
  await requestJson(`${gateway}/edge/events`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "room-supervisor-edge",
      run_id: replacementRunId,
      trace_id: room.trace_id,
      event: { type: "run.progress", agent_id: "replacement-runner" }
    })
  });
  const progressedRun = await requestJson(`${gateway}/runs/${encodeURIComponent(replacementRunId)}`, {
    headers: authHeaders(token)
  });
  assert(progressedRun.last_heartbeat_at, "run.progress did not update last_heartbeat_at");
  assert(progressedRun.events?.some((event) => event.type === "run.progress"), "run.progress was not stored on the run");

  const replacementCompleteBody = {
    node_id: "room-supervisor-edge",
    run_id: replacementRunId,
    trace_id: room.trace_id,
    result: {
      status: "completed",
      exit_code: 0,
      stdout: "REPORT: replacement run completed without waiting for the replaced run.\nBLACKBOARD: replaced old runs are excluded from active room runs.\nDONE\n",
      stderr: "",
      summary: "replacement completed"
    }
  };
  await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify(replacementCompleteBody)
  });
  const completedRoom = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}`, {
    headers: authHeaders(token)
  });
  assert(completedRoom.status === "completed", `room did not complete after replacement run; status=${completedRoom.status}`);
  assert(completedRoom.reports?.some((report) => /replacement run completed/.test(report.content || "")), "replacement report was not recorded");
  const completedCounts = roomCounts(completedRoom);

  step("Replaying the replacement completion and submitting the old late completion");
  await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify(replacementCompleteBody)
  });
  const afterDuplicate = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}`, {
    headers: authHeaders(token)
  });
  assertSameCounts(afterDuplicate, completedCounts, "duplicate replacement completion changed room counts");

  const lateOldRun = await requestJson(`${gateway}/edge/complete`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "room-supervisor-edge",
      run_id: oldRunId,
      trace_id: room.trace_id,
      result: {
        status: "completed",
        exit_code: 0,
        stdout: [
          "REPORT: OLD SHOULD NOT APPEAR",
          "BLACKBOARD: OLD SHOULD NOT APPEAR",
          "@replacement-runner: OLD SHOULD NOT WAKE",
          "WAKE replacement-runner IN 1s: OLD SHOULD NOT REMIND",
          "DONE",
          ""
        ].join("\n"),
        stderr: "",
        summary: "old late completion should be ignored"
      }
    })
  });
  assert(lateOldRun.status === "replaced", `late old run was not marked replaced: ${lateOldRun.status}`);
  assert(lateOldRun.late_complete_ignored_at, "late old run did not record late_complete_ignored_at");

  const afterLateOld = await requestJson(`${gateway}/rooms/${encodeURIComponent(room.id)}`, {
    headers: authHeaders(token)
  });
  assertSameCounts(afterLateOld, completedCounts, "late old completion changed room counts");
  assert(afterLateOld.status === "completed", "late old completion changed the completed room status");
  const roomText = JSON.stringify({
    messages: afterLateOld.messages || [],
    reports: afterLateOld.reports || [],
    blackboard: afterLateOld.blackboard || {},
    reminders: afterLateOld.reminders || []
  });
  assert(!roomText.includes("OLD SHOULD NOT"), "late old completion polluted room messages, reports, blackboard, or reminders");
  const oldRoomRun = afterLateOld.runs?.find((run) => run.id === oldRunId);
  assert(oldRoomRun?.replaced_by_run_id === replacementRunId, "room snapshot lost old run replacement metadata");
  assert(oldRoomRun?.late_complete_ignored_at, "room snapshot did not sync late completion ignore metadata");

  const idlePoll = await requestJson(`${gateway}/edge/poll`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ node_id: "room-supervisor-edge", timeout_ms: 1 })
  });
  assert(idlePoll.type === "idle", `late old directives unexpectedly enqueued another task: ${JSON.stringify(idlePoll)}`);

  step("Verifying server-side recover defaults to dry-run and requires confirmation");
  const staleRoom = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Room recover PR-2 smoke",
      goal: "Verify stale queued room recovery is a server-side dry-run unless explicitly confirmed.",
      agents: roomAgentIds,
      wakeAgents: ["old-runner"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const staleRunId = staleRoom.runs?.[0]?.id;
  assert(staleRunId, "stale recover room did not create a queued run");

  await stopChild(central);
  central = null;
  const oldCreatedAt = "2020-01-01T00:00:00Z";
  patchRunSnapshot(dataDir, staleRunId, (run) => {
    run.created_at = oldCreatedAt;
  });
  patchRoomSnapshot(dataDir, staleRoom.id, staleRunId, (run, patchedRoom) => {
    run.created_at = oldCreatedAt;
    patchedRoom.updated_at = oldCreatedAt;
  });

  central = start(python, [path.join(root, "central_gateway.py")], {
    AGENT_BUS_CONFIG: configPath,
    AGENT_BUS_TOKEN: token,
    AGENT_BUS_HOST: "127.0.0.1",
    AGENT_BUS_PORT: String(port),
    AGENT_BUS_DATA_DIR: dataDir
  });
  await waitForJson(`${gateway}/health`, 15000, central);
  await registerFakeEdge(gateway, token, roomAgentIds);

  const staleBefore = await requestJson(`${gateway}/rooms/${encodeURIComponent(staleRoom.id)}`, {
    headers: authHeaders(token)
  });
  const healthBeforeDryRun = await requestJson(`${gateway}/health`);
  const recoverDryRun = await runCliJson([
    "room",
    "recover",
    staleRoom.id,
    "--json",
    "--gateway",
    gateway,
    "--token",
    token,
    "--queued-run-stale-seconds",
    "1"
  ]);
  assert(recoverDryRun.dry_run === true, "CLI room recover did not default to server-side dry-run");
  assert(recoverDryRun.executed === false, "dry-run recover unexpectedly executed");
  assert(recoverDryRun.inspection?.recommendation === "pause_recover_orphan_queued_runs", "dry-run recover did not identify stale queued room recovery");
  assert(recoverDryRun.inspection?.stale_queued_runs?.some((run) => run.id === staleRunId), "dry-run recover did not report the stale queued run");
  const staleAfterDry = await requestJson(`${gateway}/rooms/${encodeURIComponent(staleRoom.id)}`, {
    headers: authHeaders(token)
  });
  const healthAfterDryRun = await requestJson(`${gateway}/health`);
  assert(staleAfterDry.status === staleBefore.status, "dry-run recover changed room status");
  assert(staleAfterDry.runs?.find((run) => run.id === staleRunId)?.status === "queued", "dry-run recover changed the queued run");
  assert(healthAfterDryRun.queued === healthBeforeDryRun.queued, "dry-run recover changed gateway queue length");

  const supervisorDryRun = await runCliJson([
    "room",
    "supervisor",
    staleRoom.id,
    "--json",
    "--gateway",
    gateway,
    "--token",
    token,
    "--queued-run-stale-seconds",
    "1"
  ]);
  assert(supervisorDryRun.dry_run === true, "CLI room supervisor did not default to server-side dry-run");
  assert(supervisorDryRun.executed === false, "dry-run supervisor unexpectedly executed");
  assert(supervisorDryRun.plan?.summary === "stale_queued_recovery_candidate", `dry-run supervisor reported unexpected summary: ${supervisorDryRun.plan?.summary}`);
  assert(supervisorDryRun.plan?.safe_executable_actions?.some((action) => action.kind === "recover_stale_queued_room"), "dry-run supervisor did not plan safe queued recovery");
  const staleAfterSupervisorDry = await requestJson(`${gateway}/rooms/${encodeURIComponent(staleRoom.id)}`, {
    headers: authHeaders(token)
  });
  const healthAfterSupervisorDry = await requestJson(`${gateway}/health`);
  assert(staleAfterSupervisorDry.status === staleBefore.status, "dry-run supervisor changed room status");
  assert(staleAfterSupervisorDry.runs?.find((run) => run.id === staleRunId)?.status === "queued", "dry-run supervisor changed the queued run");
  assert(healthAfterSupervisorDry.queued === healthBeforeDryRun.queued, "dry-run supervisor changed gateway queue length");

  const noConfirm = await fetch(`${gateway}/rooms/${encodeURIComponent(staleRoom.id)}/recover`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      dry_run: false,
      queued_run_stale_seconds: 1,
      reason: "unconfirmed smoke recover"
    })
  });
  const noConfirmText = await noConfirm.text();
  assert(noConfirm.status === 409, `unconfirmed server recover returned ${noConfirm.status}: ${noConfirmText}`);

  const supervisorNoConfirm = await fetch(`${gateway}/rooms/${encodeURIComponent(staleRoom.id)}/supervisor`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      dry_run: false,
      queued_run_stale_seconds: 1,
      reason: "unconfirmed smoke supervisor"
    })
  });
  const supervisorNoConfirmText = await supervisorNoConfirm.text();
  assert(supervisorNoConfirm.status === 409, `unconfirmed server supervisor returned ${supervisorNoConfirm.status}: ${supervisorNoConfirmText}`);

  const recoverExecuted = await runCliJson([
    "room",
    "recover",
    staleRoom.id,
    "--yes",
    "--json",
    "--gateway",
    gateway,
    "--token",
    token,
    "--queued-run-stale-seconds",
    "1",
    "--reason",
    "confirmed room-supervisor smoke recover"
  ]);
  assert(recoverExecuted.dry_run === false && recoverExecuted.executed === true, "confirmed recover did not execute");
  assert(recoverExecuted.cancelled_queued_runs?.includes(staleRunId), "confirmed recover did not cancel the stale queued run");
  const staleAfterRecover = await requestJson(`${gateway}/rooms/${encodeURIComponent(staleRoom.id)}`, {
    headers: authHeaders(token)
  });
  assert(staleAfterRecover.status === "paused", "confirmed recover did not pause the room");
  assert(staleAfterRecover.runs?.find((run) => run.id === staleRunId)?.status === "cancelled", "confirmed recover did not mark the stale queued run cancelled");
  const queueAfterRecover = await requestJson(`${gateway}/edge/poll`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ node_id: "room-supervisor-edge", timeout_ms: 1 })
  });
  assert(queueAfterRecover.type === "idle", `confirmed recover left the cancelled run queued: ${JSON.stringify(queueAfterRecover)}`);

  step("Verifying supervisor reports but does not replace orphaned running work");
  const orphanRoom = await requestJson(`${gateway}/rooms`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      title: "Room supervisor PR-3 orphaned running smoke",
      goal: "Verify conservative supervisor reports orphaned running work without replacing it.",
      agents: roomAgentIds,
      wakeAgents: ["old-runner"],
      auto_rotate: false,
      max_steps: 1
    })
  });
  const orphanRunId = orphanRoom.runs?.[0]?.id;
  assert(orphanRunId, "orphan running room did not create a queued run");
  await pollTask(gateway, token, orphanRunId);
  await requestJson(`${gateway}/edge/events`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "room-supervisor-edge",
      run_id: orphanRunId,
      trace_id: orphanRoom.trace_id,
      event: { type: "run.started", agent_id: "old-runner" }
    })
  });
  await delay(2200);
  const orphanDryRun = await runCliJson([
    "room",
    "supervisor",
    orphanRoom.id,
    "--json",
    "--gateway",
    gateway,
    "--token",
    token,
    "--node-stale-seconds",
    "1",
    "--run-heartbeat-stale-seconds",
    "86400"
  ]);
  assert(orphanDryRun.plan?.summary === "orphaned_running_candidate", `supervisor did not report orphaned running candidate: ${orphanDryRun.plan?.summary}`);
  assert(orphanDryRun.plan?.safe_executable_actions?.length === 0, "supervisor planned an executable action for orphaned running work");
  assert(orphanDryRun.inspection?.orphaned_running_runs?.some((run) => run.id === orphanRunId), "supervisor did not list the orphaned running run");

  const orphanConfirmed = await runCliJson([
    "room",
    "supervisor",
    orphanRoom.id,
    "--yes",
    "--json",
    "--gateway",
    gateway,
    "--token",
    token,
    "--node-stale-seconds",
    "1",
    "--run-heartbeat-stale-seconds",
    "86400"
  ]);
  assert(orphanConfirmed.dry_run === false, "confirmed orphan supervisor did not disable dry-run");
  assert(orphanConfirmed.executed === false, "confirmed orphan supervisor unexpectedly executed a destructive action");
  assert(orphanConfirmed.requires_operator_inspection === true, "confirmed orphan supervisor did not require operator inspection");
  const orphanAfterSupervisor = await requestJson(`${gateway}/rooms/${encodeURIComponent(orphanRoom.id)}`, {
    headers: authHeaders(token)
  });
  assert(orphanAfterSupervisor.status === "active", "supervisor changed orphaned running room status");
  assert(orphanAfterSupervisor.runs?.find((run) => run.id === orphanRunId)?.status === "running", "supervisor changed orphaned running run status");

  const result = {
    ok: true,
    quota: "no_model_calls",
    gateway_runtime: "python",
    room_id: room.id,
    old_run_id: oldRunId,
    replacement_run_id: replacementRunId,
    late_complete_ignored: true,
    duplicate_complete_idempotent: true,
    recover_room_id: staleRoom.id,
    server_recover_dry_run: true,
    server_recover_confirmed: true,
    duplicate_agent_guardrail: true,
    supervisor_duplicate_resolution: true,
    supervisor_dry_run: true,
    supervisor_orphan_no_auto_replace: true
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("room supervisor smoke ok");
    console.log(`Room: ${room.id}`);
    console.log(`Old run: ${oldRunId}`);
    console.log(`Replacement run: ${replacementRunId}`);
    console.log("Quota: no model calls");
  }

  await stopChild(central);
}

async function registerFakeEdge(gateway, token, agentIds) {
  return requestJson(`${gateway}/edge/register`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({
      node_id: "room-supervisor-edge",
      hostname: "room-supervisor-smoke",
      agents: agentIds.map((id) => ({
        id,
        kind: "smoke",
        role: "worker",
        capabilities: ["room", "supervisor", "no-quota"]
      }))
    })
  });
}

async function registerDuplicateAgentEdges(gateway, token) {
  for (const nodeId of ["duplicate-edge-a", "duplicate-edge-b"]) {
    await requestJson(`${gateway}/edge/register`, {
      method: "POST",
      headers: authJsonHeaders(token),
      body: JSON.stringify({
        node_id: nodeId,
        hostname: nodeId,
        agents: [{
          id: "duplicate-agent",
          kind: "smoke",
          role: "worker",
          capabilities: ["duplicate-guardrail", "no-quota"]
        }]
      })
    });
  }
}

async function pollTask(gateway, token, runId) {
  const polled = await requestJson(`${gateway}/edge/poll`, {
    method: "POST",
    headers: authJsonHeaders(token),
    body: JSON.stringify({ node_id: "room-supervisor-edge", timeout_ms: 10 })
  });
  assert(polled.type === "task", `edge poll did not return a task for ${runId}: ${JSON.stringify(polled)}`);
  assert(polled.task?.run_id === runId, `edge poll returned ${polled.task?.run_id || "missing"} instead of ${runId}`);
  return polled;
}

function patchRunSnapshot(dataDir, runId, patchFn) {
  const file = path.join(dataDir, "runs", `${runId}.json`);
  const run = readJsonFile(file);
  patchFn(run);
  fs.writeFileSync(file, `${JSON.stringify(run, null, 2)}\n`);
}

function patchRoomSnapshot(dataDir, roomId, runId, patchFn) {
  const file = path.join(dataDir, "rooms", `${roomId}.json`);
  const room = readJsonFile(file);
  const run = room.runs?.find((item) => item.id === runId);
  assert(run, `room snapshot missing run ${runId}`);
  patchFn(run, room);
  fs.writeFileSync(file, `${JSON.stringify(room, null, 2)}\n`);
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function start(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: smokeChildEnv(env),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = { command, args, stdout: "", stderr: "", error: "", exit: null };
  childLogs.set(child, logs);
  child.stdout.on("data", (chunk) => appendLog(logs, "stdout", chunk));
  child.stderr.on("data", (chunk) => appendLog(logs, "stderr", chunk));
  child.on("error", (err) => {
    logs.error = err.message || String(err);
  });
  child.on("exit", (code, signal) => {
    logs.exit = { code, signal };
  });
  procs.push(child);
  return child;
}

function smokeChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const name of HERMETIC_AGENT_BUS_ENV) delete env[name];
  return { ...env, ...overrides };
}

async function stopChild(child) {
  if (!child || child.killed || child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await waitForExit(child);
}

async function waitForJson(url, timeoutMs = 10000, child = null) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (child && childFailed(child)) {
      throw new Error(`Process exited before ${url} became ready.\n${formatChildDiagnostics(child)}`);
    }
    try {
      return await requestJson(url);
    } catch (err) {
      lastError = err;
      await delay(200);
    }
  }
  const diagnostics = child ? `\n${formatChildDiagnostics(child)}` : "";
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "no response"}${diagnostics}`);
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text}`);
  return text.trim() ? JSON.parse(text) : {};
}

async function runCliJson(args) {
  const result = spawnSync(process.execPath, [path.join(root, "agent-bus.mjs"), ...args], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: smokeChildEnv()
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`agent-bus ${redactDiagnostics(args.join(" "))} failed with ${result.status}: ${redactDiagnostics(result.stderr || result.stdout)}`);
  }
  return JSON.parse(result.stdout || "{}");
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

function authJsonHeaders(token) {
  return { ...authHeaders(token), "content-type": "application/json" };
}

function findPython() {
  const candidates = [
    process.env.AGENT_BUS_PYTHON,
    process.env.PYTHON,
    ...commonBundledPythonPaths(),
    process.platform === "win32" ? "python.exe" : "python3",
    "python3",
    "python"
  ].filter(Boolean);
  for (const candidate of unique(candidates)) {
    const result = spawnSync(candidate, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 6) else 1)"], {
      cwd: root,
      windowsHide: true,
      stdio: "ignore"
    });
    if (!result.error && result.status === 0) return candidate;
  }
  return "";
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
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function roomCounts(room) {
  return {
    messages: (room.messages || []).length,
    reports: (room.reports || []).length,
    notes: (room.blackboard?.notes || []).length,
    reminders: (room.reminders || []).length,
    runs: (room.runs || []).length
  };
}

function assertSameCounts(room, expected, label) {
  const actual = roomCounts(room);
  for (const key of Object.keys(expected)) {
    assert(actual[key] === expected[key], `${label}: expected ${key}=${expected[key]}, got ${actual[key]}`);
  }
}

function appendLog(logs, key, chunk) {
  const limit = 20000;
  logs[key] += chunk.toString();
  if (logs[key].length > limit) logs[key] = logs[key].slice(-limit);
}

function childFailed(child) {
  const logs = childLogs.get(child);
  return Boolean(logs?.error || child.exitCode !== null || child.signalCode);
}

function formatChildDiagnostics(child) {
  const logs = childLogs.get(child);
  if (!logs) return "child diagnostics unavailable";
  const exit = logs.exit || { code: child.exitCode, signal: child.signalCode };
  const lines = [
    `child: ${logs.command} ${logs.args.join(" ")}`,
    `exit: code=${exit.code ?? "running"} signal=${exit.signal ?? ""}`
  ];
  if (logs.error) lines.push(`spawn_error: ${logs.error}`);
  if (logs.stdout.trim()) lines.push(`stdout:\n${redactDiagnostics(logs.stdout.trim())}`);
  if (logs.stderr.trim()) lines.push(`stderr:\n${redactDiagnostics(logs.stderr.trim())}`);
  return lines.join("\n");
}

function waitForExit(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function step(message) {
  if (!jsonOut) console.log(message);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values) {
  return [...new Set(values)];
}

function redactDiagnostics(text) {
  return String(text || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "sk-[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]");
}
