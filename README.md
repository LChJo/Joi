# joi · 唯一入口的个人智能编排中枢

> 唯一全局 joi 通过 Pi 思考，在彼此隔离的 Avatar 上下文中理解输入、安排工作，并把执行派给本机 Pi 或局域网 A2A 搭档。

## JOI-01 目标形态

- 用户只面对唯一全局 joi 和首页输入框；不需要先创建工程、管线、Avatar 或任务。
- `Avatar` 只保存人格、工程引用、记忆命名空间和任务上下文，不是 Agent、运行时或第二个调度器。
- joi 自动选择或创建 Avatar，歧义时先澄清；每项工作只能属于一个 Avatar，跨 Avatar 必须由用户明确提出。
- joi 使用 Pi 作为唯一主推理基座，自身只有规划、查询和派发工具，不获得任意 shell、文件读写或编辑能力。
- 原 Life 主 Agent 降级为对应 Avatar 的首选搭档；本机 Pi 与远端 A2A 搭档统一进入版本化搭档目录。
- 所有输入先持久化，所有外部副作用先进入 outbox，并使用稳定幂等标识；连续输入的合并、等待或并发由 joi 在安全 Turn 边界决定。
- 首次无可用模型源时，首页先完成大模型网络连接；提供六家官方厂商和一个通用平台，厂商内区分普通 API 与官方 Coding/Token Plan，并在厂商支持时继续选择 OpenAI-compatible 或 Anthropic-compatible 协议。

目标架构决策见 [ADR 0002](docs/adr/0002-unique-joi-pi-avatar-orchestration.md)，旧 Life 数据兼容策略见 [ADR 0003](docs/adr/0003-avatar-legacy-life-migration.md)。下文中 Life/Wake/主 Agent 描述的是现有兼容运行时，实施 JOI-01 时逐步收敛为只读兼容层，不再代表新的调度权威。

## 项目状态

M0–M6 的可在本机实现部分已经落地：Electron 主进程先处理 crash marker、待恢复备份与 SQLite migration，再启动 HTTP/SSE、outbox/Task/Wake 恢复和节奏调度；桌面与 LAN 共用完整 React 控制台，并具备管理员会话、加密 Agent onboarding、A2A 0.3、长期连续性、托盘生命周期、同源静态托管、在线备份和 quarantine 恢复。

自动化门禁、覆盖 960/768 px 的 Electron E2E、生产构建、包内容审计和带品牌图标的 Windows NSIS 产物已通过。当前仍不是“完整 MVP”：真实 AI Mana、第二台 LAN 设备、macOS 打包/签名/公证、Windows 签名、24 小时长稳和人工键盘/对比度视觉验收未在当前环境执行，不会标为通过。证据与 concerns 见[发布验收报告](docs/09-release-validation-report.md)，完整标准见[路线图与验收](docs/07-roadmap-and-acceptance.md)。AI Mana 配套扩展属于独立仓库。

## 本地开发

环境要求：Node.js `>=22.19`、npm `>=11`。

```text
npm ci
npm run dev
npm run app:run
```

`npm run dev` 启动开发态；`npm run app:run` 构建并运行本地生产形态。Agent 使用的完整命令索引见 [`.agent/commands.md`](.agent/commands.md)。

固定质量命令：

```text
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:e2e
npm run build:prod
npm run package:verify
npm run package:win
# 仅在 macOS 构建机执行
npm run package:mac
```

`npm run package:dir` 会在当前平台生成 unpacked 应用；`npm run clean` 只清理可重建产物。统一打包脚本会重新生成图标、构建、审计包内容，再调用 Electron Builder。正式安装包必须在目标平台完成签名与验收；测试使用操作系统临时目录，不读取真实 Electron `userData` 或真实凭据。

## 我们要构建什么

joi 不是一个新的聊天页，也不是把多个 Agent 排成固定流水线。它是运行在个人电脑上的常驻 Runtime Hub：

- Hub 保存数字生命的身份、人格、事件、记忆、作息、事务和预算。
- 主 Agent 是数字生命的主要推理器官，负责理解事件、形成决策和提出动作。
- 协作 Agents 是可调度的专业能力，结果会重新变成事件回到主 Agent。
- 人类消息、闹钟、作息、待办、Agent 结果和系统恢复都先进入同一个事件系统。
- 数字生命可以在没有新消息时被自己的闹钟、计划或空闲探索再次唤醒。

产品面向个人单用户。桌面应用在本机常驻，内嵌 Web UI，同时可以把同一控制台开放给可信局域网中的浏览器。

## 核心原则

1. **生命主体属于 Runtime，而不是某个模型会话。** A2A context 可以过期或重建，身份与记忆不能随之丢失。
2. **所有刺激都是事件。** 用户消息没有绕过事件系统直接驱动模型的特权。
3. **先持久化，再行动。** 事件、动作和调用状态必须能够在崩溃后恢复。
4. **一个主 Agent，多名协作者。** 主 Agent 维持连续视角，协作者按能力异步承接具体工作。
5. **自治必须有节奏。** 自主唤醒、空闲探索和调用量受预算、安静时段和紧急停止控制。
6. **A2A 是执行协议，不是生命数据库。** Hub 通过标准 A2A 调用 Agents，但不把长期状态寄托在远端任务历史里。

## MVP 能力

- 创建多个彼此隔离的数字生命，配置人格、原则、作息、预算和主 Agent。
- 通过 Agent Card URL 与 Bearer Token 连接局域网 A2A v0.3 Agents。
- 将消息、闹钟、作息、待办、恢复和 Agent 结果统一转成持久事件。
- 运行 `SLEEPING → QUEUED → RUNNING → SLEEPING` 的可恢复唤醒循环。
- 保存活动时间线、意识残留、情景记忆、语义记忆、事务、待办和闹钟。
- 由主 Agent 设置闹钟、写记忆、更新事务、向人表达和委派协作者。
- 展示流式状态、正式回复、input/auth 请求、Artifact 与失败恢复过程。
- 在应用重启后恢复事件队列，并对已被远端接受的 A2A Task 执行查询或续订。

## 系统概览

```mermaid
flowchart LR
  Human[人类 / 局域网浏览器] --> Web[React Web UI]
  Web --> Hub[Electron Runtime Hub]
  Clock[作息 / 闹钟 / 待办] --> Events[持久事件队列]
  Hub --> Events
  Events --> RAS[唤醒仲裁器]
  RAS --> Cortex[主 Agent]
  Cortex --> Actions[结构化生命动作]
  Actions --> Memory[记忆 / 事务 / 闹钟]
  Actions --> Workers[协作 Agents]
  Workers --> Events
  Actions --> Web
  Hub <--> Store[(SQLite + FTS5)]
  Cortex -. A2A v0.3 .-> LAN[局域网 AI Mana Agents]
  Workers -. A2A v0.3 .-> LAN
```

技术方向固定为 Electron + React + TypeScript。Electron 主进程承载常驻 Runtime、SQLite、局域网 HTTP/SSE 服务、A2A Client 和凭据加密；浏览器不直接持有 Agent Token。

## 默认运行策略

| 项目              |        默认值 |
| ----------------- | ------------: |
| 局域网 Web 端口   |       `43130` |
| 单生命主唤醒并发  |           `1` |
| 协作者并发        |           `4` |
| 单 Endpoint 并发  |           `2` |
| 每日自主唤醒额度  |          `24` |
| 每日 A2A 调用额度 |         `100` |
| 空闲探索门槛      |    `120` 分钟 |
| 每日空闲探索上限  |           `3` |
| 默认安静时段      | `23:00–07:00` |

用户消息、用户授权和系统恢复不消耗“自主唤醒”额度，但仍受并发和总调用额度约束。所有默认值可按数字生命单独修改。

## 文档导航

- [来源与术语](docs/00-sources-and-glossary.md)
- [产品需求](docs/01-product-requirements.md)
- [交互与页面规格](docs/02-ux-specification.md)
- [系统架构](docs/03-system-architecture.md)
- [领域模型与运行时](docs/04-domain-and-runtime.md)
- [A2A 集成协议](docs/05-a2a-integration.md)
- [安全与运维](docs/06-security-and-operations.md)
- [路线图与验收](docs/07-roadmap-and-acceptance.md)
- [参考后端调研与吸收清单](docs/08-reference-backend-assessment.md)
- [发布验收报告](docs/09-release-validation-report.md)
- [README / PRD 实现追踪矩阵](docs/10-requirements-traceability.md)

## 明确不在 MVP 中

多用户与团队权限、云同步、飞书/微信、局域网自动发现、二维码配对、公共互联网部署、自我修改代码、技能市场、向量数据库和完整项目/KPI 系统不属于第一版。

## 事实基线

文档基于 2026-07-15 的以下事实源整理：

- joi 原始理念文档：`README (1).md`
- AI Mana Front A2A 实现：分支 `featur/agents_a2a`，提交 `b93e2330`
- 独立参考后端 `LChJo/digital-life`：提交 `8afe89bb`；仅用于运行时架构与可靠性调研
- A2A Protocol：`0.3`
- JavaScript SDK：`@a2a-js/sdk@0.3.14`

文档中的“应当”和“将”描述验收标准；实现状态以[需求追踪矩阵](docs/10-requirements-traceability.md)和[发布验收报告](docs/09-release-validation-report.md)中的当前证据为准。
