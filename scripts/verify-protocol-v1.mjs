import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const schemaPath = path.join(root, "docs", "protocol-v1.schema.json");
const helloAgentPath = path.join(root, "examples", "hello-agent", "hello-agent.mjs");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bus-protocol-v1-"));

try {
  verifySchema();
  verifyHelloAgent();
  console.log("protocol v1 verification passed");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

function verifySchema() {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  assert(schema.$schema?.includes("2020-12"), "schema should declare JSON Schema 2020-12");
  assert(schema.$defs?.agent, "schema missing agent definition");
  assert(schema.$defs?.room, "schema missing room definition");
  assert(schema.$defs?.run, "schema missing run definition");
  assert(schema.$defs?.event, "schema missing event definition");
  assert(schema.$defs?.manifest, "schema missing manifest definition");
  assert(schema.$defs.event.properties.type.enum.includes("run.completed"), "event enum missing run.completed");
  assert(schema.$defs.event.properties.type.enum.includes("policy.denied"), "event enum missing policy.denied");
  assert(schema.$defs.runStatus.enum.includes("queued"), "run status enum missing queued");
  assert(schema.$defs.terminalRunStatus.enum.includes("completed"), "terminal run status enum missing completed");
}

function verifyHelloAgent() {
  const messageFile = path.join(tempDir, "message.txt");
  fs.writeFileSync(messageFile, "Hello from protocol verification\nsecond line\n", "utf8");
  const result = spawnSync(process.execPath, [helloAgentPath], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      AGENT_ID: "hello-agent",
      AGENT_RUN_ID: "run_protocol_verify",
      AGENT_MESSAGE: "",
      AGENT_MESSAGE_FILE: messageFile
    }
  });
  if (result.error) throw result.error;
  assert(result.status === 0, `hello-agent exited with ${result.status}: ${result.stderr || result.stdout}`);
  assert(result.stdout.includes("REPORT: hello-agent received"), "hello-agent did not emit REPORT");
  assert(result.stdout.includes("BLACKBOARD: hello-agent message_source=file"), "hello-agent did not read AGENT_MESSAGE_FILE");
  assert(result.stdout.includes("BLACKBOARD: hello-agent last_message_preview=Hello from protocol verification second line"), "hello-agent did not emit expected BLACKBOARD");
  assert(result.stdout.includes("DONE"), "hello-agent did not emit DONE");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
