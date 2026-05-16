# Agent Bus Project Handoff

更新时间：2026-05-16

这份文档给后续维护者、远程 agent、开源贡献者接手用。它只记录公开仓库可以安全共享的信息；服务器 IP、SSH key、Telegram token、npm token、模型 API key、真实 Central admin token 等敏感信息必须放在私有运维笔记或 secret store，不能提交到仓库。

## 一句话目标

Agent Bus 是一个自托管的远程助手和 AI-to-AI 连接层：

```text
MCP connects models to tools.
Agent Bus connects agents to agents.
```

它的核心价值是让 Codex、Hermes、OpenClaw、Claude Code、Ollama、自定义脚本、OpenAI-compatible 模型网关等不同运行时变成可发现、可路由、可协作的 agent。用户只需要部署一个公网可访问的 Central，再让各台私有机器上的 Edge 主动连出去，就能把远程 AI/工具接入同一个 bus。

## 当前项目状态

当前主线已经具备可公开试用和可贡献的基础：

- npm CLI 包名：`agent-bus-cli`，安装后命令是 `agent-bus`。
- Central/Edge 架构：Central 负责鉴权、房间、run 队列、事件、模型路由；Edge 主动长轮询连接 Central 并执行本机 agent。
- 支持 Node 和 Python 运行时：`central-gateway.mjs` / `edge-node.mjs`，以及更完整的 `central_gateway.py` / `edge_node.py`。
- 支持 AI-to-AI rooms：agent 可用 `@agent-id`、`REPORT`、`BLACKBOARD`、`WAKE`、`DONE` 协作。
- 支持 OpenAI-compatible model router：`/v1/models`、`/v1/chat/completions`、`/v1/responses`。
- 支持 edge-to-edge model replacement：在线 agent 会暴露为 `agent:<agent-id>` 虚拟模型，其他机器可通过 Central 调用它。
- 支持 Telegram operator bot：状态、agent 选择、process/thread、room draft、多选 agent、按钮、poller/webhook。
- 支持本地 room memory cache：按“目录/书签”方式压缩历史上下文，不依赖向量库、数据库或模型调用。
- 支持 conformance/certification：可生成 JSON、Markdown、Shields badge，并验证 artifact set。
- 支持 SDK：`sdk/js/` 和 `sdk/python/` 覆盖 discovery、rooms、agent-backed model calls、room replay。
- 支持 no-quota demos/smokes：大量测试不需要真实模型 key 或私有服务器。

最近主线关键提交：

```text
8184870 Add conformance artifact validation
b231d66 Add conformance CI workflow
c5a3ad9 Add conformance certification artifacts
57bb66a Add adapter command conformance profile
2aba0cd Add protocol conformance runner
bcacb44 Add room event log timeline
bd50997 Add zero-token local demo
43e6dc4 Persist Python edge completions
```

## 部署形态

推荐部署是“两类组件”：

1. Central：部署在公网 HTTPS 入口后面，作为中转站、控制面、房间状态存储和模型路由入口。
2. Edge：部署在需要接收任务的机器上，使用 scoped edge token 主动连接 Central。

典型拓扑：

```text
public HTTPS gateway
  /agent-bus/ -> Central gateway on localhost

private edge A -> outbound HTTPS poll -> Central
private edge B -> outbound HTTPS poll -> Central
private edge C -> outbound HTTPS poll -> Central
```

Central 单实例当前不需要数据库。默认用 `AGENT_BUS_DATA_DIR` 下的 JSONL 和快照文件持久化；生产部署必须使用持久磁盘或 Docker volume。只有当需要多实例写入、大规模查询、托管多租户时，再考虑 SQLite/Postgres。

## 快速上手路径

本地无 key 体验：

```bash
npm install -g agent-bus-cli
agent-bus --help
agent-bus smoke --offline
agent-bus demo zero-token
agent-bus demo starter
agent-bus demo agent-model
```

源码贡献者路径：

```bash
git clone https://github.com/haveagoodday1205-png/agent-bus.git
cd agent-bus
npm install -g .
npm run release:check
```

如果本机没有完整 npm 环境，可以先跑不依赖 npm pack 的检查：

```bash
node scripts/verify-protocol-v1.mjs
node scripts/verify-conformance-result-schema.mjs --json
node scripts/conformance-ci-smoke.mjs --json
node scripts/protocol-conformance.mjs --json --artifact-dir conformance-artifacts
node scripts/verify-conformance-result-schema.mjs --artifact-dir conformance-artifacts
```

Central + Edge 推荐安装流：

```bash
agent-bus setup central --gateway https://YOUR-DOMAIN/agent-bus --out central.config.json --service auto
agent-bus pair create --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN --preset codex
agent-bus setup edge --gateway https://YOUR-DOMAIN/agent-bus --code ABCD-2345 --auto --service auto --out edge.config.json
agent-bus status --gateway https://YOUR-DOMAIN/agent-bus --token ADMIN_TOKEN
```

## 当前验证状态

最新提交 `8184870` 已完成：

- 本地 `agent-bus protocol certify --json --artifact-dir <temp>` 通过。
- 本地 `agent-bus protocol validate-result --artifact-dir <temp> --json` 通过。
- 本地 `scripts/release-check.mjs --json` 跑到已知 Windows 缺 npm 的包验证步骤才停止；新增 conformance/artifact 校验步骤均已通过。
- 私有 Linux 验证机已 `git pull --ff-only origin main` 并完整跑过：

```bash
node scripts/release-check.mjs --json
```

结果：`ok: true`。

## Conformance 交接

Agent Bus v1 conformance 现在是项目对外生态的关键入口。它让第三方 adapter 作者可以证明自己兼容 Agent Bus，而不是只靠口头说明。

生成认证产物：

```bash
agent-bus protocol certify
```

会写出：

```text
conformance-artifacts/agent-bus-conformance.json
conformance-artifacts/agent-bus-conformance.md
conformance-artifacts/agent-bus-conformance-badge.json
```

验证认证产物：

```bash
agent-bus protocol validate-result --artifact-dir conformance-artifacts
```

外部 adapter 可这样跑：

```bash
agent-bus protocol conformance \
  --profile adapter-command \
  --agent-command "./my-agent-bus-adapter" \
  --agent-id my-agent \
  --artifact-dir conformance-artifacts \
  --json
agent-bus protocol validate-result --artifact-dir conformance-artifacts
```

相关文件：

- `scripts/protocol-conformance.mjs`
- `scripts/verify-conformance-result-schema.mjs`
- `docs/protocol-v1.md`
- `docs/protocol-v1.schema.json`
- `docs/protocol-conformance-result.schema.json`
- `docs/adapter-conformance-ci.md`
- `.github/workflows/conformance.yml`

## 主要模块地图

核心 CLI：

- `agent-bus.mjs`：用户入口，封装 setup、doctor、room、trace、plugin、protocol、demo、service 等命令。

Central：

- `central_gateway.py`：当前功能最完整的 Central，覆盖 rooms、pairing、traces、Telegram、agent-backed models、memory cache。
- `central-gateway.mjs`：轻量 Node Central。

Edge：

- `edge-node.mjs`：Node Edge。
- `edge_node.py`：Python Edge。
- `scripts/codex-agent-bus.sh`
- `scripts/hermes-agent-bus.sh`
- `scripts/openclaw-agent-bus.sh`
- `scripts/claudecode-agent-bus.sh`

SDK 和 examples：

- `sdk/js/agent-bus-sdk.mjs`
- `sdk/python/agent_bus_sdk.py`
- `examples/hello-agent/`
- `examples/room-agent-python/`
- `examples/python-agent-model/`
- `examples/no-quota-room-replay/`

Web/console：

- `console/index.html`
- `console/app.js`
- `console/styles.css`
- `docs/console.md`

Telegram：

- `scripts/telegram-poller.mjs`
- `scripts/telegram-commands.mjs`
- `scripts/telegram-plugin-smoke.mjs`
- `agent-bus plugin telegram ...`

Release / CI：

- `scripts/release-check.mjs`
- `scripts/verify-package.mjs`
- `scripts/verify-portable-release.mjs`
- `scripts/release-notes.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

## 给后续 agent 的工作协议

如果交给 Hermes、OpenClaw、Claude Code、Codex 或其他 agent 继续开发，优先遵守这些规则：

- 不要提交任何真实 token、SSH key、服务器 IP 白名单、私有配置。
- 优先做 no-quota、offline、可 CI 验证的改动。
- 每次改动后至少跑对应 smoke；大改动后跑 `node scripts/release-check.mjs --json`。
- 对 public docs 只写可复用方法；私有服务器操作写在本地私有笔记。
- 不要把 room 聊天当权限边界；危险操作要在 Edge runtime/sandbox 层控制。
- 对 adapter 改动优先更新 conformance 或 bridge smoke。
- 对 Telegram 改动必须更新 `telegram-plugin-smoke`，尤其是 inline buttons、callback query、process/thread、room draft。
- 对 room/retry/reconnect 改动必须跑 room supervisor、stale room、edge poll disconnect、completion outbox 相关 smoke。

## 已知约束

- Agent Bus 不是模型提供商，也不会打包 Codex/Hermes/OpenClaw/Claude Code 的模型能力。CLI 只负责连接、路由、调度和适配；用户仍需在 Edge 上安装对应 agent runtime 或配置模型网关。
- URL ping 只证明端点可达，不证明模型 key、quota 或真实 completion 正常。真实调度出错时由 run/model response 返回错误。
- Edge token 默认权限较窄。若要让 Edge 调用 `agent:<id>` 虚拟模型，Central 必须显式开启 `modelRouter.allowEdgeAgentModels`。
- 单 Central 目前用 JSONL/snapshot 持久化；适合自托管和轻量部署，不适合直接做大规模多租户 SaaS。
- Windows 本地运行可能缺 npm；包验证可在 Linux/CI/远程验证机跑。

## 下一步优先级

建议按这个顺序推进，避免功能越来越多但入口不够清晰：

1. First-run polish：让 `agent-bus demo`、`setup central`、`setup edge`、`status` 的成功路径更短、更像一个产品。
2. Web console 优化：把当前 Central 状态、agent health、room timeline、trace、recovery hints 做成更可读的操作台。
3. Permission profiles：落地 `permission_profile`、`allowed_wake_targets`、room-level policy，先做观察和警告，再做硬拦截。
4. Flagship demo：把 `agent-bus demo issue` 推到“三个不同 agent 通过 room 完成一个 PR draft/patch/review”的公开演示。
5. Adapter ecosystem：鼓励第三方 adapter 项目复制 `docs/adapter-conformance-ci.md`，发布 Agent Bus compatible badge。
6. Durable event storage：从 snapshot-derived event bundle 继续推进到真正 append-only event source，并为未来数据库迁移留接口。
7. Installer/packaging：继续优化 portable bundle、Windows/macOS/Linux service templates，降低非开发者部署门槛。

## 开源协作建议

让别人看到并参与项目，优先做这些：

- README 第一屏继续强调“Agent Bus connects agents to agents”。
- 保持 no-quota demos 绿，这会降低贡献门槛。
- 把 `docs/good-first-issues.md` 中的任务拆成 GitHub Issues。
- 在 release notes 里突出 conformance badge、Telegram operator bot、edge-to-edge model replacement。
- 给 adapter 作者一个明确入口：`examples/hello-agent/` + `docs/adapter-conformance-ci.md`。
- 对每个新功能配一个 smoke script，让贡献者不需要私有服务器也能证明没破坏主线。

## 私有运维交接提醒

这些内容不要写进公开仓库，但私有交接必须保存：

- Central 公网域名、反代路径、systemd service 名称、env 文件位置。
- Edge 节点清单、各自 agent id、runtime、工作目录、service 名称。
- SSH 连接方法和 key 管理方式。
- Central admin token、scoped edge token、Telegram bot token、模型 API key 的 secret store 位置。
- 发布 npm/GitHub Release 的账号、2FA、token 轮换流程。
- 如果 token 曾经出现在聊天、日志或截图里，应视为已泄漏并轮换。

## 当前结论

Agent Bus 已经不只是一个网关脚本，而是一个有 CLI、Central/Edge、rooms、agent-backed model calls、Telegram operator bot、SDK、conformance certification、release gates 的开源工具雏形。

下一阶段最重要的不是继续堆更多 agent 名字，而是把“任何 AI 工具都能接入、证明兼容、被远程调用、在房间里协作、留下可审计结果”这条路径做得顺滑。这样它才可能从个人项目变成真正的 AI-to-AI 开源协议生态。
