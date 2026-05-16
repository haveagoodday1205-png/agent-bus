import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const schemaPath = path.join(root, "docs", "protocol-conformance-result.schema.json");
const artifactDir = valueAfter("--artifact-dir") || valueAfter("--artifacts") || "";
const checkArtifacts = Boolean(artifactDir || args.includes("--check-artifacts"));
const resultPath = valueAfter("--result") || valueAfter("--in") || (artifactDir ? path.join(artifactDir, "agent-bus-conformance.json") : "");
const checks = [];

try {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  verifySchema(schema);
  verifyFixture("passing result fixture", passingFixture());
  verifyFixture("failing result fixture", failingFixture());

  if (resultPath) {
    const resolved = path.resolve(process.cwd(), resultPath);
    const result = JSON.parse(fs.readFileSync(resolved, "utf8"));
    verifyFixture(`result artifact ${resolved}`, result);
    if (checkArtifacts) verifyArtifactSet(resolved, result);
  }

  print({ ok: true, quota: "no_model_calls", checks });
} catch (err) {
  print({ ok: false, error: err.message || String(err), checks });
  process.exitCode = 1;
}

function verifySchema(schema) {
  assert(schema.$schema?.includes("2020-12"), "schema should declare JSON Schema 2020-12");
  assert(schema.$defs?.check, "schema missing check definition");
  assert(schema.$defs?.summary, "schema missing summary definition");
  assert(schema.$defs?.artifacts, "schema missing artifacts definition");
  assert(schema.properties?.mode?.const === "protocol_conformance", "schema should lock mode to protocol_conformance");
  assert(schema.properties?.profile?.enum?.includes("local-reference-agent"), "schema profile enum missing local-reference-agent");
  assert(schema.properties?.profile?.enum?.includes("adapter-command"), "schema profile enum missing adapter-command");
  assert(schema.properties?.quota?.enum?.includes("no_model_calls"), "schema quota enum missing no_model_calls");
  assert(schema.properties?.quota?.enum?.includes("depends_on_agent_command"), "schema quota enum missing depends_on_agent_command");
  assert(schema.properties?.quota?.enum?.includes("unknown"), "schema quota enum missing unknown");
  assert(schema.allOf?.length >= 2, "schema should define success and failure conditional requirements");
  pass("schema.structure", "conformance result schema exposes required protocol result fields");
}

function verifyFixture(name, result) {
  validateConformanceResult(result);
  pass(`artifact.${safeCheckId(name)}`, "conformance result artifact shape is valid");
}

function validateConformanceResult(result) {
  assertObject(result, "result");
  assert(typeof result.ok === "boolean", "result.ok must be boolean");
  assert(result.mode === "protocol_conformance", "result.mode must be protocol_conformance");
  assert(/^agent-bus\.v[0-9]+$/.test(result.protocol || ""), "result.protocol must look like agent-bus.vN");
  assert(["local-reference-agent", "adapter-command"].includes(result.profile), "result.profile must be a known conformance profile");
  assert(["no_model_calls", "depends_on_agent_command", "unknown"].includes(result.quota), "result.quota must be a known quota label");
  assertValidTimestamp(result.generated_at, "result.generated_at");
  assert(Array.isArray(result.checks), "result.checks must be an array");

  for (const [index, check] of result.checks.entries()) {
    assertObject(check, `result.checks[${index}]`);
    assertIdentifier(check.id, `result.checks[${index}].id`);
    assert(typeof check.ok === "boolean", `result.checks[${index}].ok must be boolean`);
    assert(typeof check.detail === "string", `result.checks[${index}].detail must be string`);
    if (check.data !== undefined) assertObject(check.data, `result.checks[${index}].data`);
  }

  if (result.ok) {
    assert(/^https?:\/\//.test(result.gateway || ""), "successful result.gateway must be an HTTP(S) URL");
    assertIdentifier(result.node_id, "successful result.node_id");
    assertIdentifier(result.agent_id, "successful result.agent_id");
    assertIdentifier(result.room_id, "successful result.room_id");
    assert(["active", "running", "finishing", "completed", "paused"].includes(result.room_status), "successful result.room_status must be a known room status");
    assertObject(result.summary, "successful result.summary");
    assert(Number.isInteger(result.summary.checks) && result.summary.checks >= 0, "successful result.summary.checks must be a non-negative integer");
    assert(result.summary.checks === result.checks.length, "successful result.summary.checks must match checks.length");
  } else {
    assert(typeof result.error === "string" && result.error.trim(), "failing result.error must be a non-empty string");
  }

  if (result.artifacts !== undefined) {
    assertObject(result.artifacts, "result.artifacts");
    for (const key of Object.keys(result.artifacts)) {
      assert(["result", "report", "badge"].includes(key), `result.artifacts.${key} is not a known artifact name`);
      assert(typeof result.artifacts[key] === "string" && result.artifacts[key].trim(), `result.artifacts.${key} must be a non-empty path`);
    }
  }
}

function verifyArtifactSet(resolvedResultPath, result) {
  const dir = artifactDir ? path.resolve(process.cwd(), artifactDir) : path.dirname(resolvedResultPath);
  const reportPath = path.join(dir, "agent-bus-conformance.md");
  const badgePath = path.join(dir, "agent-bus-conformance-badge.json");
  assert(fs.existsSync(reportPath), `missing Markdown report: ${reportPath}`);
  assert(fs.existsSync(badgePath), `missing Shields badge JSON: ${badgePath}`);

  const report = fs.readFileSync(reportPath, "utf8");
  assert(report.includes("# Agent Bus Conformance Report"), "Markdown report missing title");
  assert(report.includes(`- Status: ${result.ok ? "PASS" : "FAIL"}`), "Markdown report status does not match result.ok");
  assert(report.includes(`- Protocol: ${result.protocol}`), "Markdown report protocol does not match result.protocol");
  assert(report.includes(`- Profile: ${result.profile}`), "Markdown report profile does not match result.profile");

  const badge = JSON.parse(fs.readFileSync(badgePath, "utf8"));
  assert(badge.schemaVersion === 1, "badge schemaVersion must be 1");
  assert(badge.label === "agent bus", "badge label must be agent bus");
  assert(typeof badge.message === "string" && badge.message.trim(), "badge message must be non-empty");
  assert(badge.color === (result.ok ? "brightgreen" : "red"), "badge color does not match result.ok");
  pass("artifact_set.files", "conformance JSON, Markdown report, and Shields badge agree");
}

function passingFixture() {
  return {
    ok: true,
    mode: "protocol_conformance",
    protocol: "agent-bus.v1",
    profile: "local-reference-agent",
    quota: "no_model_calls",
    generated_at: "2026-05-16T00:00:00.000Z",
    gateway: "http://127.0.0.1:8788",
    node_id: "conformance-node",
    agent_id: "conformance-agent",
    agent_command_provided: false,
    room_id: "room_conformance",
    room_status: "completed",
    checks: [
      {
        id: "gateway.health",
        ok: true,
        detail: "GET /health is reachable"
      }
    ],
    summary: {
      checks: 1,
      reports: 1,
      blackboard_notes: 1,
      event_log_entries: 8,
      event_bundle_events: 8,
      replay_completed_runs: 1
    },
    artifacts: {
      result: "conformance-artifacts/agent-bus-conformance.json",
      report: "conformance-artifacts/agent-bus-conformance.md",
      badge: "conformance-artifacts/agent-bus-conformance-badge.json"
    }
  };
}

function failingFixture() {
  return {
    ok: false,
    mode: "protocol_conformance",
    protocol: "agent-bus.v1",
    profile: "adapter-command",
    quota: "unknown",
    generated_at: "2026-05-16T00:00:00.000Z",
    error: "adapter command failed before registration",
    checks: []
  };
}

function pass(name, detail) {
  checks.push({ name, ok: true, detail });
}

function assertObject(value, label) {
  assert(Boolean(value) && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
}

function assertIdentifier(value, label) {
  assert(typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value), `${label} must be a valid Agent Bus identifier`);
}

function assertValidTimestamp(value, label) {
  assert(typeof value === "string" && !Number.isNaN(Date.parse(value)), `${label} must be an ISO timestamp`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeCheckId(value) {
  return String(value || "fixture").toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_").replace(/^_+|_+$/g, "") || "fixture";
}

function valueAfter(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

function print(result) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.ok) {
    console.log(`conformance result schema ok (${checks.length} checks)`);
    return;
  }
  console.error(`conformance result schema failed: ${result.error}`);
}
