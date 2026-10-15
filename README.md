# joi · 唯一入口的个人智能编排中枢

> 唯一全局 joi 通过 Pi 思考，在彼此隔离的工作台上下文中理解输入、安排工作，并把执行派给本机 Pi 或局域网 A2A 搭档。

## JOI-01 目标形态

- 用户只面对唯一全局 joi 和首页输入框；不需要先创建工程、管线、工作台或任务。
- 工作台（代码名 `Workbench`）只保存人格、工程引用、记忆命名空间和任务上下文，不是 Agent、运行时或第二个调度器。
- 每个工作台的 workspace binding 是其工作目录权威：ACTIVE 工作台自动拥有受管或绑定工作区；多个工作台可按需绑定同一物理目录，绝对路径只保存在主进程基础设施私表中。
- joi 仅在目标项目与主要工作明确匹配时自动复用工作台；弱相关、歧义或需要新建时，由桌面或 Android 弹出选择框，可编辑建议后创建并继续。首页手动选台仅对本次发送生效；每项工作只能属于一个工作台，跨工作台必须由用户明确提出。
- joi 使用 Pi 作为唯一主推理基座，自身只有规划、查询和派发工具，不获得任意 shell、文件读写或编辑能力。
- 原 Life 主 Agent 降级为对应工作台的首选搭档；本机 Pi 与远端 A2A 搭档统一进入版本化搭档目录。
- Partner 只是全局能力模板，不保存 cwd；每个运行实例和工作记忆都绑定一个工作台，禁止跨工作台复用。
- 搭档输出先原子归档为工作台范围内 WorkResult 并更新工作/任务投影，再以有界摘要通知 joi；正文只能由当前工作台通过分页工具读取。
- 所有输入先持久化，所有外部副作用先进入 outbox，并使用稳定幂等标识；连续输入的合并、等待或并发由 joi 在安全 Turn 边界决定。
- 首次无可用模型源时，首页先完成大模型网络连接；提供六家官方厂商和一个通用平台，厂商内区分普通 API 与官方 Coding/Token Plan，并在厂商支持时继续选择 OpenAI-compatible 或 Anthropic-compatible 协议。
- “定时任务”是唯一全局 Joi scheduler 的管理入口：Routine 可创建新目标，也可在指定首页任务卡收官后按固定指令继续同一目标；到点仍由现有 Joi 单槽位执行，诊断、导出和紧急停止收纳在“设置 → 诊断”。

目标架构决策见 [ADR 0002](docs/adr/0002-unique-joi-pi-workbench-orchestration.md)，旧 Life 数据兼容策略见 [ADR 0003](docs/adr/0003-workbench-legacy-life-migration.md)，工作台私有实例、工作区和结果闭环见 [ADR 0006](docs/adr/0006-workbench-private-partner-instances-and-results.md)。下文中 Life/Wake/主 Agent 描述的是现有兼容运行时，实施 JOI-01 时逐步收敛为只读兼容层，不再代表新的调度权威。

## 项目状态

“统计”页展示本机已观测的 Token 用量、日历/时段热力图、模型用量排名、工作台与高消耗目标，并区分编排、搭档、进化、摘要和模型测试。只读取执行时已返回的用量，不额外调用模型；历史数据不补算，未返回的用量明确标为未知。统计不改变自主进化预算。详见 [ADR 0021](docs/adr/0021-token-statistics.md)。

“设置 → 自主进化”提供上下文整理与完成检查策略改进。每日模型调用额度提供关/低/中/高四档预设，默认关闭，必须由用户明确启用。共享且可归因于策略的生产证据先驱动全局基线；只有单个工作台自己的可归因证据达到门槛时才生成工作台覆盖层。候选通过独立合成评测后只进入稳定分流的生产灰度，至少收集五个候选与五个对照目标并确认不退化后才正式生效。已有目标固定策略版本，模型固定版本变化会显式进入重新验证而不是静默沿用；人格、职责、权限和代码不由进化机制修改。页面展示全部工作台的评测进度、批次历史、调用与 Token 成本。详细边界见 [ADR 0020](docs/adr/0020-bounded-strategy-evolution.md)。

主 joi 支持在“设置 → 技能”中勾选本机 Skill，扫描 `~/.agents/skills`、`~/.claude/skills` 和 `~/.codex/skills`。默认不加载，保存后下一轮思考生效；目录变化后可刷新并移除失效选择。主 joi 按需读取所选说明，CLI、文件和外部服务操作仍由搭档执行，搭档的技能需要单独配置。技能被识别不代表所需工具、依赖和登录状态都已就绪。

当前里程碑使用 JOI-01 的 M1–M3：M1（W0–W3）与 M2（W4–W5）已有仓库内自动化证据；M3 已完成 W6 的界面收敛，正在推进 W7 的兼容切换、安全和发布验收。旧 M0–M7 只描述 Life/Wake 兼容运行时的历史建设顺序，其“本机自动化完成”不能再作为 JOI-01 或 MVP 完成结论。

Electron actor 根循环、HTTP 轮询控制面、outbox、工作台/Partner/Work、旧 Life 只读兼容、恢复与打包链已有自动化覆盖。当前仍不是“完整 MVP”：真实 AI Mana、第二台 LAN 设备、macOS 打包/签名/公证、Windows 签名、24 小时长稳和人工键盘/对比度视觉验收未在当前环境执行，不会标为通过。证据与 concerns 见[发布验收报告](docs/09-release-validation-report.md)，完整标准见[路线图与验收](docs/07-roadmap-and-acceptance.md)。AI Mana 配套扩展属于独立仓库。

## 界面语言

桌面、局域网网页、远程网页和 Android 内置简体中文与英文，可即时切换，各端独立保存偏好。默认跟随系统，中文系统使用简体中文，其余使用英文。切换保留草稿、连接和运行中的任务，不翻译用户内容、模型回复或已有名称。

翻译统一维护于 `resources/locales/`，使用 `npm run i18n -- stats` 查看覆盖率，`npm run i18n -- help` 查看语言和文案维护命令。架构、维护步骤及验收见[国际化说明](docs/20-internationalization.md)。

## 本地开发

环境要求：Node.js `>=22.19`、npm `>=11`。

```text
npm ci
npm run dev
npm run app:run
```

`npm run dev` 启动开发态；`npm run app:run` 构建并运行本地生产形态。Agent 使用的完整命令索引见 [`.agent/commands/`](.agent/commands/README.md)，旧 [`.agent/commands.md`](.agent/commands.md) 保留为兼容摘要。

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
- 创建、暂停、恢复、立即执行和删除 Routine；可从首页任意未移除任务卡创建“定时继续”，列表只显示安全运行事实，提示词必须显式 reveal。
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

多用户与团队权限、云同步、飞书/微信、Agent 自动发现/配对、通用公网管理面、自我修改代码、技能市场、向量数据库和完整项目/KPI 系统不属于第一版。唯一例外是 ADR 0013 定义的 Android 原生远程入口：用户主动启用后，可通过二维码绑定多台受限、端到端加密的手机，查看 joi 首页任务卡、提交文字并处理首页已有的受限动作；工作台归属澄清可选择建议方案新增工作台并继续原输入，但不开放通用工作台管理、目录、文件或设置权限。同网优先直连，公网自动回退 iroh 中继。

## 事实基线

文档基于 2026-07-15 的以下事实源整理：

- joi 原始理念文档：`README (1).md`
- AI Mana Front A2A 实现：分支 `featur/agents_a2a`，提交 `b93e2330`
- 独立参考后端 `LChJo/digital-life`：提交 `8afe89bb`；仅用于运行时架构与可靠性调研
- A2A Protocol：`0.3`
- JavaScript SDK：`@a2a-js/sdk@0.3.14`

文档中的“应当”和“将”描述验收标准；实现状态以[需求追踪矩阵](docs/10-requirements-traceability.md)和[发布验收报告](docs/09-release-validation-report.md)中的当前证据为准。
本地工作台任务始终在实际目录中运行：未绑定目录时，在用户主目录的 `joi/runs/日期时间_UUID/` 下为每个新任务创建独立目录，恢复和重试复用该任务目录；绑定已有目录时固定使用指定目录。派发按搭档已配置的工具计算最低 READ/WRITE 访问等级，避免 NONE 导致技能读取和命令工具被关闭。
在同一工作台重新提交提示词会启动独立目标：Joi 对话和搭档任务证据按本次目标隔离。原任务的补充回答、恢复操作继续原目标；工作台和搭档的长期配置仍可复用。
