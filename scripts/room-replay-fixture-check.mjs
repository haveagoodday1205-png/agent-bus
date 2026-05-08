#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replayRoomEvents, validateRoomEventBundle } from "../sdk/js/agent-bus-sdk.mjs";

const root = path.resolve(import.meta.dirname, "..");
const bundlePath = path.join(root, "docs", "fixtures", "no-quota-room-events.v1.json");
const replayPath = path.join(root, "docs", "fixtures", "no-quota-room-replay.v1.json");
const schemaPath = path.join(root, "docs", "protocol-v1.schema.json");
const jsonOut = process.argv.includes("--json");

Promise.resolve().then(main).catch((err) => {
  const result = { ok: false, error: err.message || String(err) };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
});

function main() {
  const bundle = readJson(bundlePath);
  const expected = readJson(replayPath);
  const knownTypes = validateBundle(bundle);
  const jsValidation = validateRoomEventBundle(bundle, { strictTypes: true, knownTypes });
  assert(jsValidation.event_count === bundle.events.length, "JS SDK validation returned the wrong event count");

  const jsReplay = replayRoomEvents(bundle);
  assertDeepEqual(jsReplay, expected, "JS SDK replay summary changed");

  const pythonReplay = pythonReplayFixture(knownTypes);
  assertDeepEqual(pythonReplay, expected, "Python SDK replay summary changed");

  const cliReplay = cliReplayFixture();
  delete cliReplay.replayed_at;
  assertDeepEqual(cliReplay, expected, "CLI replay summary changed");

  const markdown = run(process.execPath, [
    path.join(root, "agent-bus.mjs"),
    "room",
    "replay",
    "--in",
    bundlePath,
    "--format",
    "markdown"
  ]).stdout;
  assert(markdown.includes("# Agent Bus Room Replay: No-quota replay fixture"), "CLI Markdown replay missing title");
  assert(markdown.includes("fixture-worker"), "CLI Markdown replay missing worker agent");
  assert(markdown.includes("output_events=1"), "CLI Markdown replay missing output accounting");

  const result = {
    ok: true,
    fixture: path.relative(root, bundlePath).replace(/\\/g, "/"),
    expected: path.relative(root, replayPath).replace(/\\/g, "/"),
    event_count: bundle.events.length,
    output_events: expected.counts.output_events,
    output_bytes: expected.counts.output_bytes,
    checks: ["metadata", "schema_event_types", "js_sdk_validate", "js_sdk_replay", "python_sdk_validate", "python_sdk_replay", "cli_strict_replay", "cli_markdown"]
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`room replay fixture check ok (${result.event_count} events, ${result.output_bytes} output bytes)`);
  }
}

function validateBundle(bundle) {
  assert(bundle.object === "agent_bus.room_event_bundle", "fixture object must be agent_bus.room_event_bundle");
  assert(bundle.protocol === "agent-bus.v1", "fixture protocol must be agent-bus.v1");
  assert(bundle.export_metadata?.format === "events", "fixture export metadata format must be events");
  assert(Array.isArray(bundle.events), "fixture must include an events array");
  assert(bundle.export_metadata.event_count === bundle.events.length, "fixture event_count must match events.length");
  assert(bundle.export_metadata.sequence_start === 1, "fixture sequence_start must be 1");
  assert(bundle.export_metadata.sequence_end === bundle.events.length, "fixture sequence_end must match events.length");
  assert(bundle.counts?.events === bundle.events.length, "fixture counts.events must match events.length");

  const schema = readJson(schemaPath);
  const knownTypes = new Set(schema.$defs?.event?.properties?.type?.enum || []);
  assert(knownTypes.size > 0, "protocol schema event enum is empty");

  const ids = new Set();
  const actualCounts = { events: bundle.events.length };
  for (const [index, event] of bundle.events.entries()) {
    assert(event.id, `event ${index + 1} is missing id`);
    assert(!ids.has(event.id), `duplicate event id: ${event.id}`);
    ids.add(event.id);
    assert(event.sequence === index + 1, `event ${event.id} has non-contiguous sequence`);
    assert(event.room_id === bundle.room.id, `event ${event.id} room_id does not match bundle room id`);
    assert(typeof event.at === "string" && event.at, `event ${event.id} missing at timestamp`);
    assert(typeof event.actor === "string" && event.actor, `event ${event.id} missing actor`);
    assert(event.payload && typeof event.payload === "object" && !Array.isArray(event.payload), `event ${event.id} payload must be an object`);
    assert(knownTypes.has(event.type), `event ${event.id} uses type not listed in protocol schema: ${event.type}`);
    actualCounts[event.type] = (actualCounts[event.type] || 0) + 1;
  }

  assert(bundle.events.some((event) => event.type === "run.output"), "fixture should include run.output events");
  assert(bundle.events.some((event) => event.type === "room.status.changed"), "fixture should include room.status.changed");
  assertDeepEqual(actualCounts, bundle.counts, "fixture counts do not match event types");
  return [...knownTypes];
}

function pythonReplayFixture(knownTypes) {
  const python = findPython();
  assert(python, "Python 3.10+ is required for the replay fixture check");
  const code = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(root)})`,
    "from sdk.python.agent_bus_sdk import replay_room_events, validate_room_event_bundle",
    `bundle_path = ${JSON.stringify(bundlePath)}`,
    `known_types = set(${JSON.stringify(knownTypes)})`,
    "with open(bundle_path, encoding='utf-8') as handle:",
    "    bundle = json.load(handle)",
    "validation = validate_room_event_bundle(bundle, strict_types=True, known_types=known_types)",
    "assert validation['event_count'] == len(bundle['events'])",
    "print(json.dumps(replay_room_events(bundle), sort_keys=True))"
  ].join("\n");
  return JSON.parse(run(python, ["-c", code]).stdout);
}

function cliReplayFixture() {
  return JSON.parse(run(process.execPath, [
    path.join(root, "agent-bus.mjs"),
    "room",
    "replay",
    "--in",
    bundlePath,
    "--strict"
  ]).stdout);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, npm_config_loglevel: "error" }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
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
  for (const command of [...new Set(candidates)]) {
    try {
      const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
        cwd: root,
        windowsHide: true,
        stdio: "ignore"
      });
      if (result.status === 0) return command;
    } catch {
      // Try the next candidate.
    }
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

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertDeepEqual(actual, expected, message) {
  const actualText = JSON.stringify(canonicalize(actual), null, 2);
  const expectedText = JSON.stringify(canonicalize(expected), null, 2);
  if (actualText !== expectedText) {
    throw new Error(`${message}\nExpected:\n${expectedText}\nActual:\n${actualText}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
