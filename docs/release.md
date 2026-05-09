# Release Checklist

Agent Bus ships in two user-facing forms:

1. npm package: fastest for Node.js users (`npm install -g agent-bus-cli`).
2. Portable bundle: GitHub Release archives for Linux, macOS, Ubuntu, and Windows users who want a self-contained Agent Bus directory without relying on npm global state.

Both forms require Node.js 20+. Python 3.10+ is only required for the Python gateway/edge implementation and for offline room smoke tests while room support lives there.

## Before Tagging

Cut releases only from a clean `main` branch whose `package.json` version matches the tag.

```bash
git checkout main
git pull --ff-only
git status --short
node -p 'require("./package.json").version'
npm run release:preflight -- --network
```

Run the preflight summary and only offline/model-free checks before tagging:

```bash
npm run release:preflight
npm run release:check
```

`release:preflight` checks the package version, changelog section, release-note rendering, git branch, clean working tree, and local tag state, then prints the exact publication steps. It is offline by default; pass `-- --network` when you also want to check the remote tag and npm publish state.

`release:check` runs syntax checks, Python compile checks, diagnostics redaction smoke, Docker Compose preflight smoke, offline room smoke, central restart smoke, Python-edge heartbeat smoke, stale-room autonomy smoke, npm package verification, portable bundle verification, and release-note generation without calling paid model providers.

`compat:check` starts a temporary gateway and `examples/hello-agent` edge, then verifies registration, scoped edge discovery, `agent:<id>` Chat Completions, `agent:<id>` Responses, and room directive parsing without calling paid model providers. The CI workflow runs this smoke on Ubuntu, Windows, and macOS so adapter regressions are caught before release.

`pack:check` is the npm artifact gate. It runs `npm pack`, validates required runtime/docs files, rejects private or build paths, checks the CLI entrypoint, extracts the package, and runs `agent-bus --help` from the packed artifact.

`portable:check` is the GitHub Release bundle gate. It builds a temporary portable archive, validates the bundle manifest, SHA-256 values, launcher executable bit, forbidden paths, release manifest, `SHA256SUMS`, archive extraction, and bundled `agent-bus --help`.

`compose:smoke` is the Docker/docs gate. It checks `compose.yaml`, `Dockerfile`, `.env.example`, and the public docs for the single-service Python central deployment contract so the no-database-first path stays aligned without requiring Docker or model calls.

`portable:check:zip` also builds and extracts the `.zip` artifact. It is required in the GitHub release workflow and useful locally when `zip`/`unzip` or PowerShell is available.

Do not tag if either gate reports forbidden paths such as `.git`, `.github`, `data`, `dist`, `.env`, real `central.config.json`, real `edge.config.json`, or `node_modules`.

## Install Matrix for Release Notes

Use this matrix in GitHub Release notes so users know which artifact to choose.

| User path | Command or artifact | Verify | Smoke |
| --- | --- | --- | --- |
| npm on Linux/macOS/Ubuntu/Windows | `npm install -g agent-bus-cli` | `agent-bus --help` | `agent-bus smoke --offline` |
| Portable Linux/macOS/Ubuntu | `agent-bus-v<version>-portable.tar.gz` | `sha256sum -c SHA256SUMS` then `./agent-bus --help` | `./agent-bus smoke --offline` |
| Portable Windows | `agent-bus-v<version>-portable.zip` | compare with `SHA256SUMS`, then `.\agent-bus.cmd --help` | `.\agent-bus.cmd smoke --offline` |
| Contributor checkout | `npm install -g .` | `agent-bus --help` | `agent-bus smoke --offline` |

## GitHub Release

The `release` workflow runs on `v*` tags. It performs syntax checks, package verification, portable verification, smoke testing, builds the portable archives, and uploads the archives, release manifest, and `SHA256SUMS` to the GitHub Release.

Tag from the same commit you intend to publish to npm:

```bash
git tag v<version>
git push origin v<version>
```

Generate the draft release notes from `CHANGELOG.md` before or after tagging:

```bash
npm run release:notes -- --out dist/release-notes.md
```

After the workflow finishes, verify the public release page includes:

- `agent-bus-v<version>-portable.tar.gz`.
- `agent-bus-v<version>-portable.zip`.
- `agent-bus-v<version>-portable.manifest.json`.
- `SHA256SUMS`.
- generated release notes from `npm run release:notes`, with `CHANGELOG.md` used as the human-edited summary source and the first-run room demo called out explicitly.
- this install matrix, or a link back to this checklist.

## npm Publish

Publish from the same commit as the GitHub tag. Keep the package contents predictable by running the package gate first:

```bash
npm run pack:check
npm publish --access public
npm view agent-bus-cli version
```

After publishing, test an isolated global install instead of relying on a checkout-linked binary:

```bash
npm run smoke:npm-install
```

The smoke script installs `agent-bus-cli@package.json version` from the registry into a temporary npm prefix, runs `agent-bus --help`, then runs `agent-bus smoke --offline --json`. Use `npm run smoke:npm-install -- --package agent-bus-cli@latest` to test a different registry dist-tag or version. The script automatically uses the generated `agent-bus.cmd` launcher on Windows.

## Trust and Safety Notes for Release Notes

Include a short boundary reminder in release notes when behavior changes touch routing, tokens, pairing, rooms, or adapters:

- Edge nodes connect outward; they should not require inbound public ports.
- Pairing codes and scoped edge tokens are preferred over sharing the admin token.
- Health and ping status are shallow reachability signals, not proof that a real model call succeeded.
- Room participants can read room state and should avoid posting secrets, private logs, private prompts, or real config files.
- Offline smoke, the local room demo, and packaging checks must not call paid model providers.

## Rollback

If a release artifact is wrong:

1. Delete or mark the GitHub Release as broken.
2. Remove the bad tag only if no downstream process depends on it.
3. For npm, use `npm deprecate agent-bus-cli@<version> "reason"`; avoid unpublish unless the package policy window and risk justify it.
4. Cut a patch version from a clean commit and rerun both `pack:check` and `portable:check` before publishing again.
