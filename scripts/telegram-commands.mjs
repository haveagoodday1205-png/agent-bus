#!/usr/bin/env node
const args = process.argv.slice(2);

const DEFAULT_COMMANDS = [
  ["start", "Open the Agent Bus control menu"],
  ["help", "Show Telegram control commands"],
  ["status", "Show central, edge, queue, and room status"],
  ["agents", "List online agents and choose process agents"],
  ["new", "Start a new Telegram process/thread"],
  ["resume", "Resume a previous process/thread"],
  ["agent", "Set, toggle, or clear process agents"],
  ["rooms", "List Agent Bus rooms"],
  ["room", "Inspect or create rooms, set agents and steps"],
  ["goal", "Create a room from the current room draft"],
  ["run", "Queue one task for a specific agent"]
].map(([command, description]) => ({ command, description }));

main().catch((err) => {
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
});

async function main() {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const action = args[0] || "set";
  const jsonOut = args.includes("--json");
  const botToken = optionValue("--bot-token") || process.env.AGENT_BUS_TELEGRAM_BOT_TOKEN || "";
  const apiBaseUrl = optionValue("--api-base-url") || process.env.AGENT_BUS_TELEGRAM_API_BASE_URL || "https://api.telegram.org";
  if (!botToken) throw new Error("AGENT_BUS_TELEGRAM_BOT_TOKEN or --bot-token is required.");

  let result;
  if (["set", "install", "register"].includes(action)) {
    result = await setCommands(botToken, apiBaseUrl, DEFAULT_COMMANDS);
  } else if (["list", "get", "status"].includes(action)) {
    result = await telegramApi(botToken, "getMyCommands", {}, apiBaseUrl);
  } else if (["delete", "clear", "unset"].includes(action)) {
    result = await telegramApi(botToken, "deleteMyCommands", {}, apiBaseUrl);
  } else {
    throw new Error("Usage: agent-bus plugin telegram commands set|list|delete");
  }

  const output = {
    ok: result.ok !== false,
    action,
    commands: action === "set" || action === "install" || action === "register" ? DEFAULT_COMMANDS : result.result,
    telegram: result
  };
  if (jsonOut) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(`Telegram bot commands ${action} ok.`);
}

async function setCommands(botToken, apiBaseUrl, commands) {
  return telegramApi(botToken, "setMyCommands", {
    commands: JSON.stringify(commands)
  }, apiBaseUrl);
}

async function telegramApi(botToken, method, params = {}, apiBaseUrl = "https://api.telegram.org") {
  const root = String(apiBaseUrl || "https://api.telegram.org").replace(/\/+$/, "");
  const url = new URL(`${root}/bot${botToken}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  const body = parseJson(text);
  if (!res.ok || body.ok === false) {
    throw new Error(body.description || text || `${res.status} ${res.statusText}`);
  }
  return body;
}

function printHelp() {
  console.log(`agent-bus telegram commands

Usage:
  agent-bus plugin telegram commands set
  agent-bus plugin telegram commands list
  agent-bus plugin telegram commands delete

Environment:
  AGENT_BUS_TELEGRAM_BOT_TOKEN       Telegram bot token.
  AGENT_BUS_TELEGRAM_API_BASE_URL    Optional Telegram API base URL for no-network smoke tests.
`);
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function parseJson(text) {
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}
