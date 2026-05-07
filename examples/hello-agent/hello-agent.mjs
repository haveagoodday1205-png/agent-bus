#!/usr/bin/env node
import fs from "node:fs";

const message = readAgentMessage();
const agentId = process.env.AGENT_ID || "hello-agent";
const runId = process.env.AGENT_RUN_ID || "local";
const bytes = Buffer.byteLength(message, "utf8");

console.log(`REPORT: ${agentId} received ${bytes} bytes for run ${runId}.`);
console.log(`BLACKBOARD: hello-agent last_message_preview=${oneLine(message).slice(0, 160)}`);
console.log("DONE");

function readAgentMessage() {
  const file = process.env.AGENT_MESSAGE_FILE || "";
  if (file && fs.existsSync(file)) {
    return fs.readFileSync(file, "utf8");
  }
  return process.env.AGENT_MESSAGE || "";
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
