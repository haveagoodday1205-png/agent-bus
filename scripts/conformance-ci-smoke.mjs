import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");

const requiredArtifacts = [
  "agent-bus-conformance.json",
  "agent-bus-conformance.md",
  "agent-bus-conformance-badge.json"
];

const checks = [];

try {
  const conformanceWorkflow = read(".github/workflows/conformance.yml");
  const releaseWorkflow = read(".github/workflows/release.yml");
  const adapterDoc = read("docs/adapter-conformance-ci.md");
  const protocolDoc = read("docs/protocol-v1.md");
  const pkg = JSON.parse(read("package.json"));

  check("protocol:certify script", /protocol-conformance\.mjs --artifact-dir conformance-artifacts/.test(pkg.scripts?.["protocol:certify"] || ""), "package.json exposes artifact-producing certification");
  check("conformance workflow command", conformanceWorkflow.includes("node scripts/protocol-conformance.mjs --json --artifact-dir conformance-artifacts"), "workflow runs certification");
  check("conformance workflow artifact upload", conformanceWorkflow.includes("actions/upload-artifact@v4") && conformanceWorkflow.includes("conformance-artifacts/"), "workflow uploads artifacts");
  check("release workflow builds artifacts", releaseWorkflow.includes("node scripts/protocol-conformance.mjs --json --artifact-dir dist/conformance"), "release workflow builds conformance artifacts");
  for (const artifact of requiredArtifacts) {
    check(`release asset ${artifact}`, releaseWorkflow.includes(`dist/conformance/${artifact}`), `release uploads ${artifact}`);
    check(`adapter doc ${artifact}`, adapterDoc.includes(artifact), `adapter doc names ${artifact}`);
  }
  check("adapter workflow template", adapterDoc.includes("--profile adapter-command") && adapterDoc.includes("AGENT_BUS_ADAPTER_COMMAND"), "adapter doc includes external command workflow");
  check("protocol doc links adapter CI", protocolDoc.includes("docs/adapter-conformance-ci.md"), "protocol docs link adapter CI");

  const result = { ok: checks.every((item) => item.ok), quota: "no_model_calls", checks };
  print(result);
  if (!result.ok) process.exitCode = 1;
} catch (err) {
  print({ ok: false, error: err.message || String(err), checks });
  process.exitCode = 1;
}

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

function print(result) {
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (result.ok) {
    console.log(`conformance CI smoke ok (${checks.length} checks)`);
  } else {
    console.error("conformance CI smoke failed");
    for (const item of checks.filter((check) => !check.ok)) {
      console.error(`- ${item.name}: ${item.detail}`);
    }
  }
}
