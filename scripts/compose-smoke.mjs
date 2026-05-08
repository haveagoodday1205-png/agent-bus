import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const jsonOut = process.argv.includes("--json");

try {
  const result = main();
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("compose smoke ok");
    console.log(`Checked: ${result.files_checked.join(", ")}`);
  }
} catch (err) {
  if (jsonOut) {
    console.log(JSON.stringify({ ok: false, error: err.message || String(err) }, null, 2));
  } else {
    console.error(err.stack || err.message || String(err));
  }
  process.exitCode = 1;
}

function main() {
  const compose = read("compose.yaml");
  const envExample = read(".env.example");
  const dockerfile = read("Dockerfile");
  const readme = read("README.md");
  const cliDoc = read("docs/cli.md");
  const deploymentDoc = read("docs/deployment.md");
  const releaseDoc = read("docs/release.md");

  assert(/services:\s*\n\s+agent-bus-central:/m.test(compose), "compose.yaml is missing the agent-bus-central service");
  assert(/AGENT_BUS_CENTRAL_RUNTIME:\s*python/.test(compose), "compose.yaml no longer pins the Python central runtime");
  assert(/AGENT_BUS_DATA_DIR:\s*\/data\/central/.test(compose), "compose.yaml no longer pins /data/central");
  assert(/AGENT_BUS_TOKEN:\s*"\$\{AGENT_BUS_TOKEN:\?[^"]+\}"/.test(compose), "compose.yaml should fail fast when AGENT_BUS_TOKEN is unset");
  assert(/\.\/central\.config\.json:\/config\/central\.config\.json:ro/.test(compose), "compose.yaml no longer mounts central.config.json read-only");
  assert(/agent-bus-data:\/data/.test(compose), "compose.yaml no longer mounts the persistent agent-bus-data volume");
  assert(/command:\s*\["serve",\s*"--runtime",\s*"python",\s*"--config",\s*"\/config\/central\.config\.json"\]/.test(compose), "compose.yaml no longer starts the Python gateway through the CLI");
  assert(/fetch\('http:\/\/127\.0\.0\.1:'\+port\+'\/health'\)/.test(compose), "compose.yaml healthcheck no longer probes /health");

  assert(/Replace AGENT_BUS_TOKEN before `docker compose up`\./.test(envExample), ".env.example should warn about replacing the placeholder token");
  assert(/does not require a database container on day one/i.test(envExample), ".env.example should mention the no-database-first Compose path");
  assert(/AGENT_BUS_TOKEN=replace-with-a-long-random-token/.test(envExample), ".env.example lost the token placeholder");
  assert(/AGENT_BUS_CENTRAL_RUNTIME=python/.test(envExample), ".env.example lost the Python runtime default");
  assert(/AGENT_BUS_DATA_DIR=\.\/data\/central/.test(envExample), ".env.example lost the central data-dir default");

  assert(/RUN apk add --no-cache python3/.test(dockerfile), "Dockerfile no longer installs Python");
  assert(/ENV AGENT_BUS_CENTRAL_RUNTIME=python/.test(dockerfile), "Dockerfile no longer defaults to the Python central runtime");
  assert(/CMD \["serve", "--runtime", "python", "--config", "\/config\/central\.config\.json"\]/.test(dockerfile), "Dockerfile no longer boots the Python gateway by default");

  assert(/docker compose config/.test(readme), "README.md should include docker compose config as a preflight step");
  assert(/does not need a database to start/i.test(readme), "README.md should state that the first central deployment does not need a database");
  assert(/agent-bus-data/.test(readme), "README.md should mention the persistent volume");

  assert(/docker compose config/.test(cliDoc), "docs/cli.md should include docker compose config");
  assert(/docker compose run --rm --no-deps agent-bus-central --help/.test(cliDoc), "docs/cli.md should include the no-deps container smoke");
  assert(/does not include a database container/i.test(cliDoc), "docs/cli.md should describe the no-database Compose contract");

  assert(/docker compose config/.test(deploymentDoc), "docs/deployment.md should include docker compose config");
  assert(/docker compose run --rm --no-deps agent-bus-central --help/.test(deploymentDoc), "docs/deployment.md should include the container preflight smoke");
  assert(/default Compose stack intentionally has no database service/i.test(deploymentDoc), "docs/deployment.md should describe the no-database Compose contract");

  assert(/Docker Compose preflight smoke/i.test(releaseDoc), "docs/release.md should mention the compose smoke inside release:check");
  assert(/`compose:smoke` is the Docker\/docs gate\./.test(releaseDoc), "docs/release.md should describe compose:smoke");

  return {
    ok: true,
    quota: "no_model_calls",
    files_checked: [
      "compose.yaml",
      ".env.example",
      "Dockerfile",
      "README.md",
      "docs/cli.md",
      "docs/deployment.md",
      "docs/release.md"
    ],
    compose_contract: {
      service: "agent-bus-central",
      runtime: "python",
      data_dir: "/data/central",
      volume: "agent-bus-data",
      token_env: "required"
    }
  };
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
