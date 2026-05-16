#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);

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

  const botToken = optionValue("--bot-token") || process.env.AGENT_BUS_TELEGRAM_BOT_TOKEN || "";
  const secretToken = optionValue("--secret-token") || process.env.AGENT_BUS_TELEGRAM_WEBHOOK_SECRET || "";
  const gateway = optionValue("--gateway") || process.env.AGENT_BUS_GATEWAY_URL || "http://127.0.0.1:8788";
  const apiBaseUrl = optionValue("--api-base-url") || process.env.AGENT_BUS_TELEGRAM_API_BASE_URL || "https://api.telegram.org";
  const offsetFile = optionValue("--offset-file") || process.env.AGENT_BUS_TELEGRAM_POLLER_OFFSET_FILE || defaultOffsetFile();
  const timeoutSeconds = positiveInteger(optionValue("--poll-timeout") || process.env.AGENT_BUS_TELEGRAM_POLLER_TIMEOUT_SECONDS, 25, 50);
  const intervalMs = positiveInteger(optionValue("--interval-ms") || process.env.AGENT_BUS_TELEGRAM_POLLER_INTERVAL_MS, 250, 60000);
  const once = args.includes("--once");
  const jsonOut = args.includes("--json");
  const quiet = args.includes("--quiet") || jsonOut;

  if (!botToken) throw new Error("AGENT_BUS_TELEGRAM_BOT_TOKEN or --bot-token is required.");
  if (!secretToken) throw new Error("AGENT_BUS_TELEGRAM_WEBHOOK_SECRET or --secret-token is required.");

  fs.mkdirSync(path.dirname(offsetFile), { recursive: true });

  if (args.includes("--delete-webhook")) {
    await telegramApi(botToken, "deleteWebhook", {
      drop_pending_updates: args.includes("--drop-pending") ? "true" : "false"
    }, apiBaseUrl);
  }
  if (args.includes("--set-commands") || envTruthy(process.env.AGENT_BUS_TELEGRAM_SET_COMMANDS)) {
    await telegramApi(botToken, "setMyCommands", {
      commands: JSON.stringify(defaultBotCommands())
    }, apiBaseUrl);
  }

  let nextOffset = readOffset(offsetFile);
  let handled = 0;
  let failed = 0;

  const stop = createStopSignal();
  if (!quiet) {
    console.log(`Agent Bus Telegram poller forwarding to ${gatewayEndpoint(gateway, "/v1/agent-bus/plugins/telegram/webhook")}`);
  }

  while (!stop.requested) {
    const updates = await telegramUpdates(botToken, {
      offset: nextOffset,
      timeout: timeoutSeconds,
      limit: 50,
      allowed_updates: JSON.stringify(["message", "edited_message", "callback_query"])
    }, apiBaseUrl);

    for (const update of updates) {
      const updateId = Number(update.update_id);
      try {
        await forwardUpdate(gateway, secretToken, update);
        handled += 1;
        if (!quiet) {
          console.log(`forwarded update ${updateId}: ${updatePreview(update)}`);
        }
      } catch (err) {
        failed += 1;
        console.error(`failed update ${Number.isFinite(updateId) ? updateId : "unknown"}: ${err.message || err}`);
      } finally {
        if (Number.isFinite(updateId)) {
          nextOffset = updateId + 1;
          writeOffset(offsetFile, nextOffset);
        }
      }
    }

    if (once) break;
    if (!updates.length) await delay(intervalMs);
  }

  if (jsonOut) {
    console.log(JSON.stringify({ ok: failed === 0, handled, failed, next_offset: nextOffset, offset_file: offsetFile }, null, 2));
  }
}

function printHelp() {
  console.log(`agent-bus telegram poller

Usage:
  agent-bus plugin telegram poll --gateway http://127.0.0.1:8788 --delete-webhook [--set-commands]

Environment:
  AGENT_BUS_TELEGRAM_BOT_TOKEN       Telegram bot token.
  AGENT_BUS_TELEGRAM_WEBHOOK_SECRET  Shared secret sent to the local Central webhook.
  AGENT_BUS_GATEWAY_URL              Central gateway URL, usually http://127.0.0.1:8788 for the poller.
  AGENT_BUS_TELEGRAM_API_BASE_URL    Optional Telegram API base URL for no-network smoke tests.
  AGENT_BUS_TELEGRAM_SET_COMMANDS    Register slash-command suggestions on startup when true.
`);
}

async function telegramUpdates(botToken, params, apiBaseUrl) {
  const response = await telegramApi(botToken, "getUpdates", params, apiBaseUrl);
  return Array.isArray(response.result) ? response.result : [];
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

function updatePreview(update) {
  const text = update.message?.text || update.edited_message?.text;
  if (text) return String(text).slice(0, 80);
  const data = update.callback_query?.data;
  if (data) return `callback ${String(data).slice(0, 70)}`;
  return "non-message update";
}

function defaultBotCommands() {
  return [
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
}

async function forwardUpdate(gateway, secretToken, update) {
  const res = await fetch(gatewayEndpoint(gateway, "/v1/agent-bus/plugins/telegram/webhook"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secretToken
    },
    body: JSON.stringify(update)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `${res.status} ${res.statusText}`);
  return parseJson(text);
}

function gatewayEndpoint(gatewayUrl, pathname) {
  const url = new URL(gatewayUrl);
  const prefix = url.pathname.replace(/\/$/, "");
  url.pathname = `${prefix}${pathname}`.replace(/\/{2,}/g, "/");
  return url;
}

function defaultOffsetFile() {
  return path.join(os.homedir(), ".agent-bus", "telegram-poller.offset");
}

function readOffset(file) {
  try {
    const value = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeOffset(file, value) {
  fs.writeFileSync(file, `${value}\n`);
}

function optionValue(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function positiveInteger(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function envTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function parseJson(text) {
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStopSignal() {
  const state = { requested: false };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      state.requested = true;
    });
  }
  return state;
}
