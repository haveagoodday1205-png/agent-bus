# Governance

Agent Bus uses lightweight maintainer-led governance while the project is still early. The goal is to keep the bus small, auditable, and easy to run while making it simple for outside contributors to help.

## Maintainer Responsibilities

Maintainers are responsible for:

- Reviewing issues and pull requests.
- Keeping the no-dependency gateway and edge paths working.
- Protecting the security boundary around tokens, pair codes, edge adapters, and model-router access.
- Publishing releases, changelog entries, npm packages, and portable bundles.
- Curating labels such as `good first issue`, `help wanted`, `needs-triage`, `security`, `adapter`, `protocol`, `docs`, and `packaging`.

## Decision Rules

Small fixes can be merged after one maintainer review when checks pass.

Protocol, security, packaging, or gateway behavior changes should include a short rationale, a smoke test or documented manual check, and enough migration notes for existing users.

Large product changes should start as an issue or draft PR. The preferred shape is:

1. Problem and affected users.
2. Smallest useful version.
3. Security and trust-boundary impact.
4. Offline test plan.
5. Follow-up work that can wait.

## Contribution Priority

The project currently prioritizes:

- Five-minute onboarding from npm or a portable bundle.
- Outbound-only remote assistant nodes.
- AI-to-AI rooms with readable reports, blackboard state, and replayable events.
- OpenAI-compatible `agent:<id>` model replacement across edges.
- SDKs, examples, and adapter presets that do not require private infrastructure.
- Web console debugging for operators.

Database-backed multi-instance central deployments, hosted multi-tenant controls, and strict RBAC are important, but they should not make the local/offline path harder to understand.

## Release Policy

Releases should pass `npm run release:check` before tagging. Release notes should describe user-visible changes, compatibility notes, and any security-relevant operator action.

Portable bundle and npm package contents should stay aligned with `docs/release.md`, `CHANGELOG.md`, and the smoke matrix in `CONTRIBUTING.md`.

