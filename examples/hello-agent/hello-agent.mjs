#!/usr/bin/env node
import fs from "node:fs";

const { message, source } = readAgentMessage();
const agentId = process.env.AGENT_ID || "hello-agent";
const runId = process.env.AGENT_RUN_ID || "local";
const bytes = Buffer.byteLength(message, "utf8");

console.log(`REPORT: ${agentId} received ${bytes} bytes for run ${runId}.`);
console.log(`BLACKBOARD: ${agentId} message_source=${source}`);
console.log(`BLACKBOARD: ${agentId} last_message_preview=${oneLine(message).slice(0, 160)}`);
console.log("DONE");

function readAgentMessage() {
  const file = process.env.AGENT_MESSAGE_FILE || "";
  if (file && fs.existsSync(file)) {
    return { message: fs.readFileSync(file, "utf8"), source: "file" };
  }
  return { message: process.env.AGENT_MESSAGE || "", source: "env" };
}

function oneLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
