# 路线图与验收

## 0. JOI-01 实施路线

JOI-01 是当前目标架构任务，按 W0-W7 串行收敛：W0 文档/ADR；W1 Pi 与 provider contract；W2 Model Source/工作台/Partner 领域及迁移；W3 首次连接、inbox 与最小首页闭环；W4 Work DAG/并发/outbox；W5 Local Pi/A2A 搭档；W6 唯一首页与次级管理 UI；W7 兼容切换、安全与发布验证。

纵向里程碑为 M1=W0-W3、M2=W4-W5、M3=W6-W7。底层组件完成不能替代“首页输入 -> 工作台归属 -> Pi -> 派发/结果”的可演示闭环。全部 AC 的唯一追踪矩阵位于 `docs/10-requirements-traceability.md`。

旧 M0-M7 记录保留为现有 Life/Wake 运行时的已验证基线和可复用能力，不代表 JOI-01 已完成。

2026-08-03 的信息架构增量以 AC-37/AC-40 为门禁：首页必须保持单栏可清理，具体执行只能沿“目标工作台卡 → Agent 卡 → 只读展示对话”下钻；原始引擎消息和 A2A payload 不得跨越展示投影边界。

2026-08-05 的编排收敛增量以 AC-41/AC-43 为门禁：Work 必须强关联原始目标且每个 run 只有一个权威终态；执行 Agent 接收私有完整 brief，可机械验证的任务必须验收后才能完成；同一目标的全部权威结果按 revision 只综合一次，首页仅展示 joi 持久化的目标级完成结论。

2026-08-06 的 harness 增量以 AC-44 为门禁：每个 (goal, revision) 至多一条复盘输入（水位与幂等键双保险，重启回放不重投）；CLEARED 地图的完成反哺恰好一次；`MAP_CLEARED` 只清 ACTIVE 地图且仅复盘 turn 可提交；复盘派发的工作绑回原 goal，结果闭环不断；复盘 turn 可代表 goal 提交 work（goal-binding 校验接受 goal 派生输入），无关 turn 冒充仍被拒。

2026-08-26 的 Wayfinder 状态链修复继续以 AC-44/AC-48 为门禁：当前层 outcome 在 map ACTIVE 时只能投影为 `REVIEWING`，复盘新增 Work 后为 `EXTENDING`，不得短暂标记最终完成；每个 goal-bound Work 由 harness component 以稳定 workId 幂等建立 path，并由 Work 终态闭路；`MAP_CLEARED` 在存储事务内重验复盘 turn、最新综合水位、无活跃/未建图 Work 和无 OPEN path。只有 map CLEARED 后首页才显示最终结果并开放继续/删除。

2026-08-26 的目标 Agent 终态投影以 AC-40/AC-53 为门禁：工作台全局 Agent 页继续用 `IDLE/BUSY` 表示 resident instance availability；从目标详情携带 `goalId` 查询时，卡片必须显示该 session 在该 goal 中的活跃或最新 partner run 状态。已完成 run 必须保持 `COMPLETED`，不能因实例已回到可复用 IDLE 而伪装成尚无执行结果。

2026-08-06 的可靠性修复：失败 turn 收尾必须中止其推理会话（残留流状态不得毒化后续 turn）；同一输入连续即时失败超过上限即停摆，禁止 failTurn→重投 的无限崩溃环；`joi-task-component.test.ts` 锁定停摆上限，`sqlite-work-plan-outbox.test.ts` 锁定 goal-binding 双向语义。2026-08-20 起 migration 040 将该停摆持久化为独立失败事实，不再伪造成用户取消；首页显示安全原因码、自动尝试次数、是否已启动执行和固定处理建议。

2026-08-06 的术语迁移以 AC-45 为门禁：产品文案统一为“工作台”，代码契约统一为 `Workbench/workbenchId/workbench.*`，HTTP 统一为 `/api/v1/workbenches`；migration 038 无损升级 037 的表、列、外键、枚举和待处理 outbox。旧 migration 001–037 只作为升级事实保留旧物理名，不再定义当前产品术语。

2026-08-07 的 UNKNOWN 收敛修复以 AC-41/AC-43 为门禁：只有 `WAITING_INPUT`/`WAITING_AUTH` 可保持 Work `WAITING` 并显示需要用户；不可恢复的 `UNKNOWN` 必须终结为 `FAILED`，继续 result-set 综合且不得制造无操作入口的“需要你”。migration 039 修复 schema 038 的存量错误状态、活跃任务投影与尚未综合的 UNKNOWN result member。

2026-08-19 的搭档失败恢复增量以 AC-35/AC-41/AC-43 为门禁：失败结果只公开 `phase/reasonCode/retryable/sideEffectState`；仅 timeout/connect/429/5xx 且未观察到工具或文件副作用时，Joi 可把 READY model source 固定到新的 immutable Partner revision，并以同一 Work、全新 action/dispatch attempt 重派。鉴权、余额、配置、Skill、安全拒绝及副作用 `OBSERVED/UNKNOWN` 禁止盲目重放；恢复后旧 result revision 不得提前写入目标完成 outcome。

2026-08-20 的 Pi Skill 派发修复以 AC-14/AC-33 为门禁：Skill catalog、frontmatter、递归发现和 prompt catalog 必须复用锁定版本的 Pi SDK；只向 Pi 暴露被选中 Skill 的 `name/description/location`，正文由 Agent 通过 `read` 按需加载。显式 Skill 路径加载必须关闭默认 package/project discovery；`read` 只能访问工作台与被选中 Skill 根目录。旧引用、同名碰撞、加载失败或收窄工具列表遗漏 `read` 必须在模型/工具启动前收敛为 `CONFIGURATION/NONE`，并向用户说明可安全修正后重试。搭档保存和搭档设置列表同时复用 exact Skill validator；历史脏 revision 以脱敏 `ACTION_REQUIRED` 配置状态展示，编辑器在移除失效引用或启用 `read` 前禁止提交，避免用户到派发时才发现。bash 只继承精确非敏感运行基线；脚本型 Skill 的其他环境变量保持默认拒绝，必须由当前精确选中的 Skill 通过 `metadata.joi_required_env` 声明、由 `JOI_PARTNER_ENV_PASSTHROUGH` 按变量名授权且已被 Joi 进程继承，三项同时满足才可注入，不能泄露给其他 bash Partner。非法声明必须在启动前失败；命中缺失凭据错误必须收敛为 `WAITING_INPUT`，显示变量名、授权与完整重启动作，不得交由模型以 `BLOCKED` 文本伪装成完成。
2026-08-21 的 Pi core 网页研究增量以 AC-49 为门禁：默认工具目录直接提供受控 `web_search`、`fetch_content`、`get_search_content`，无需切换 engine；适配器仅访问公开 HTTP(S)，在 DNS/重定向阶段拒绝 loopback/私网/链路本地和凭据 URL，并限制超时、响应大小、搜索结果和 runtime 内存缓存。HTML 先做可读性抽取，GitHub 仓库根 URL 优先读取公开 README，不执行 clone、cookie 注入或外部文件写入；第三方 Pi package 不被动态加载。

2026-08-18 的命名与环境收敛以 AC-46 为门禁：工作台命名聚焦长期工作聚类和运行环境，Agent 命名聚焦可复用能力聚类；前端调试/分析工作创建的受管目录固定为 `aimanadebug`，角色型 `资深程序员搭档` 归类为 `编码工坊`，创建与重建必须使用同一规则。

2026-08-18 的首页首问投影收敛以 AC-47 为门禁：输入持久化为 `PENDING` 后，在 Workbench 尚未绑定前也必须以 `ARRANGING`/“等待归属”目标卡进入 home-feed；绑定后沿同一 `inputId` 升级，未归属 `CLARIFICATION_REQUIRED` 只进入“需要你”列表，不能重复显示。

2026-08-18 的首页进度可见性收敛以 AC-48 为门禁：`progressing` 必须同时显示由持久化事实推导的阶段、Agent 数、Work 完成/失败/总数和已用时间；只展示安全枚举和计数，不展示 ETA、原始执行消息、模型标识、路径或错误正文；继续使用 HTTP home-feed 轮询与本地操作后的即时刷新，不新增 SSE/WebSocket。终态目标提交“继续”后必须先即时显示 `正在提交继续请求`，服务端确认后再进入 `queued`/`正在安排`；接口失败时撤销提交态并保留可重试错误，提交往返本身不得形成静默 gap。

2026-08-24 的直接回答结果收敛以 AC-50 为门禁：`DIRECT_ANSWER`、`TEAM_READY` 与无工具普通回答必须把非空最终 Markdown 有界脱敏后写入独立 Turn completion；写入与 Turn/Inbox 完成同事务且校验 input/turn 归属。首页仅在输入已消费且没有 result-set 时投影该 completion；当前 revision 的 Goal outcome 始终优先，重试期间不得展示旧回答，诊断不得记录回答正文。

2026-08-24 的搭档选择交互收敛以 AC-51 为门禁：`instanceId/sessionPolicy` 冲突可无副作用机械修正时必须先自动修正；一次纠正后仍需用户决定搭档时持久化 `partner_selection_required`，首页只列出 ACTIVE 且配置有效的搭档卡。点击以稳定 `partnerId` 原子匹配当前澄清并继续原输入，该卡不得显示自由输入框，具体安全 prompt 不得再被通用派发文案覆盖。

2026-08-24 的搭档长任务超时收敛以 AC-52 为门禁：本机 Pi 搭档不设置整次 Work/run 总时限；消息或工具事件持续产生时可一直运行，连续 20 分钟无任何进度才 abort 并返回 `partner_run_idle_timed_out`。每个工具调用独立限制为 15 分钟且不能被工具参数放宽，超时形成 `partner_tool_timed_out`；所有 timer、订阅与 AbortSignal 在终态后释放，既有副作用重放禁令保持不变。

2026-08-25 的等待动作与 Actor 状态收敛以 AC-53 为门禁：搭档进入 `WAITING_INPUT` 时必须同时持久化绑定精确 input/Work/run 的用户动作；问题回答或恢复决策原子解析为 `RESOLVED`，无需模型源即可用同一稳定 action id 恢复原 Work，崩溃重试不得生成第二次派发。无动作的孤立 WAITING 由工作台 actor 修复为一键“继续原工作”卡，在修复窗口内不得谎报“需要你”；Agent 展示状态同时读取权威 run，不能被 resident instance 的 IDLE 覆盖。所有远端重试和孤儿收尾跨 tick 收敛，根 tick 不等待长 I/O。

2026-08-25 的共享工作目录收敛以 AC-54 为门禁：工作台 workspace binding 仍是各自 cwd 权威，但不得对物理 root 建立跨工作台排他所有权；多个工作台绑定同一目录必须成功，绝对路径仍不得进入 DTO/诊断。不同 workspace ref 指向同一 root 时，READ/WRITE lease 必须落入同一冲突域，保持多读并发、写与其他活动访问互斥。

2026-08-25 的搭档模型配置与连通性收敛以 AC-55 为门禁：本机 Pi 搭档切换模型源时必须同步显示该来源的 active model，更新接口以显式 `null` 清除旧 pin，保存成功后读取最新 immutable revision；应用层在追加 revision 前拒绝非 READY 来源或来源/模型不匹配。搭档卡可发起固定极小、无工具、无 Work/run、无工作区副作用的模型验证，并仅展示持久化的安全状态、来源/模型、时间和稳定原因码；A2A 与本地 CLI 不提供伪连通测试。

2026-08-24 的部分失败目标综合收敛继续以 AC-43 为门禁：综合 Turn 必须显式提交 `RESULT_SYNTHESIZED` 或 `RESULT_BLOCKED`；成功至少基于一个已验收完成 Work，并由 Joi 语义判断现有证据足以回答原目标。当前 COMPLETED outcome 的权威性高于失败 Work 计数，首页仍标记完成并把异常降级为可点击搭档入口；关键证据缺失才写 BLOCKED，存量 outcome 无损回填为 COMPLETED。

2026-08-26 的 AI Berkshire 大型场景预设包以 AC-56 为门禁：内置快照必须可脱离来源 checkout 运行，二十个 canonical workflow 与写作 overlay 收敛为六个子团队、十五位共享搭档；安装以 pack/role 稳定绑定并可从部分失败继续，重复安装不得覆盖用户 revision、启用停用搭档或产生重复角色。搭档页提供子团队和完整套件的一键安装；财务计算与研究审计只通过固定、有界、不可执行任意代码的工具完成。

2026-08-27 的 Android 原生远程入口以 AC-57 为门禁：桌面与 Android 使用独立实现的 iroh transport，同网优先点对点直连、失败后自动走 `cudex.joilab.top` 中继；`joi://pair` 票据十分钟且一次有效。应用层继续使用 HMAC/HKDF/AES-GCM、严格递增序号和 `feed.get/message.send` allowlist；每台 App 有独立设备密钥，可同时连接并逐台撤销。App 只提供竖屏首页任务卡与文字提交，不依赖浏览器、Cloudflare、DCDN 或额外 WebSocket 网关。详见 ADR 0013。

## 1. 当前状态

| 阶段             | 状态   | 产物                          |
| ---------------- | ------ | ----------------------------- |
| JOI-01 M1（W0–W3） | 完成（自动化） | 文档/ADR、模型源、工作台/Partner、inbox 与最小首页闭环 |
| JOI-01 M2（W4–W5） | 完成（自动化） | Work DAG/outbox、本机 Pi 与 A2A adapter；真实互操作仍属 W7 |
| JOI-01 M3（W6–W7） | 进行中 | W6 界面收敛已有自动化证据；W7 真实环境与发布门禁未闭合 |
| AI Mana 配套扩展 | 外部未完成 | 当前仓库只有协议与 Hub adapter 证据 |

开发已经在本仓库中开始。当前证据与未执行 concerns 见[发布验收报告](09-release-validation-report.md)；不得把未执行的真实环境门禁当作 MVP 完成。

## 2. 推荐工程结构

创建工程时采用单仓库、单 package 管理：

```text
joi/
├── docs/
├── src/
│   ├── main/
│   │   ├── domain/
│   │   ├── application/
│   │   ├── infrastructure/
│   │   │   ├── a2a/
│   │   │   ├── persistence/
│   │   │   ├── scheduler/
│   │   │   └── security/
│   │   └── interfaces/http/
│   ├── preload/
│   ├── renderer/
│   └── shared/
├── tests/
│   ├── domain/
│   ├── integration/
│   ├── contract/
│   ├── renderer/
│   └── e2e/
└── resources/migrations/
```

领域层不得依赖 Electron、SQLite、HTTP 或 A2A SDK。公共 DTO 和 schema 放在 `src/shared`，但数据库记录与远端 SDK 类型不能直接跨到 renderer。

## 3. 历史兼容基线：旧 M0–M7

本节保留原 Life/Wake 运行时的建设与验收记录，供兼容层和可靠性能力追溯。这里的“完成”只表示当时范围内的仓库证据，不是上文 JOI-01 M1–M3 的状态，也不能推出当前 MVP 已发布。

### 旧 M0：工程与 Harness（自动化完成）

目标：建立可重复开发、测试和打包的空工程。

交付：

- Electron + React + TypeScript + Vite 工程。
- lint、typecheck、unit、integration、renderer、e2e、production build 命令。
- 项目 Harness、模块边界、ADR、CI 和 Windows/macOS 打包骨架。
- 可机器校验的 import boundary rules；新增未分类生产目录默认失败。
- 测试数据库、临时 userData 和凭据替身，禁止测试访问真实用户数据。

门禁：空应用能启动、打包并在 Windows/macOS 打开；Domain 导入 Electron/SQLite/HTTP/A2A SDK 的反例测试会失败；所有验证命令为 0。

### 旧 M1：持久化、HTTP 与单管理员（自动化完成）

目标：建立不依赖 Agent 的 Runtime 基础。

交付：

- SQLite migration、Repository、事务、outbox、runtime lease。
- loopback + 可选 LAN 双 listener。
- 管理员口令、桌面 bootstrap、LAN session、CSRF、SSE cursor。
- Life CRUD、Agent Connection 空壳、诊断和备份 manifest。

门禁：LAN listener 失败不影响桌面；重启后 Life 与 SSE 序号保持；Token/口令不出主进程。

### 旧 M2：A2A Gateway 与 AI Mana 配套扩展（Hub 自动化完成；外部扩展与真实互操作待验收）

目标：建立真实局域网 Agent 调用和可信主 Agent协议。

joi 仓库交付：

- Card/Token onboarding、network policy、Card 漂移。
- stream/get/cancel/resubscribe、幂等 messageId、input/auth、Artifact。
- 按 Agent Connection/credentialVersion 共享的 429/503 breaker 与 `Retry-After`。
- `WakeEnvelope`、`LifeActionEnvelope` schema、readiness 与 fenced fallback。

AI Mana Front 独立交付：

- 识别 `urn:aimana:digital-life-runtime:v1`。
- 无副作用 readiness。
- 受信任运行时指令和结构化 DataPart 输出。
- 保持普通 A2A/Workspace/Space 客户端兼容。

门禁：真实 AI Mana Agent readiness、流式动作、重启恢复、Token 轮换和 Card 漂移全通过；两个 Life 共用连接时只打开一个脱敏 breaker，冷却期间事件不丢失。

### 旧 M3：事件与唤醒内核

目标：形成最小持续生命循环。

交付：

- Life lifecycle、持久事件队列、Arbiter、Wake/WakeTurn。
- EventTypeRegistry、运行中 event signal、Wake liveness 和失败退避。
- Context assembler、Wake/Turn/Injection/FlowEvent 审计、ActionProcessor、一次 repair、意识残留。
- 用户消息、出生、恢复、表达、sleep 与紧急停止。
- 每生命单主 Wake、Hub/Endpoint 并发和 outbox dispatcher。

门禁：生命能出生、回复、休眠、自设一次性闹钟并在重启后再次醒来；运行中插话不取消当前调用、不重复渲染且不提前消费；任一 Turn 的输入引用和动作因果链可以从审计记录重建。

### 旧 M4：事务、记忆、作息与协作（Hub 自动化完成；真实跨机互操作待旧 M7）

目标：完成“跨天连续 + 多 Agent”的产品闭环。

交付：

- Affair、Todo、Alarm、Schedule、等待关系。
- Alarm occurrence 到 Event 的原子/幂等投递。
- 活动记录、意识残留、情景记忆、语义记忆、概念卡优先、FTS5 召回和记忆代谢。
- 主 Agent + 协作者 allowlist、异步 delegate、结果事件。
- 受预算自治、安静时段、空闲探索和每日重置。

门禁：两个协作者并行完成后主 Agent被新事件唤醒；context 过期后用有界记忆重建；等待中的 Affair 不阻塞其他事务；多个同时到期 Alarm 在锁冲突或投递失败后不丢不重。

### 旧 M5：完整 Web 体验

目标：让核心能力无需阅读协议即可使用。

交付：

- 首次设置、Agent 添加、三步生命创建。
- 全部生命、活动时间线、输入框、状态侧栏。
- 事务/待办、记忆、作息/闹钟、Agents、设置与诊断。
- input/auth、Artifact、失败重试、预算追加和紧急停止。
- 768 px LAN 浏览器和 960 px 桌面窗口响应式行为。

门禁：新用户 10 分钟内创建并启动生命；所有状态有文本反馈；键盘可完成主要路径；用户消息与协议状态不混杂。

### 旧 M6：恢复、安全与桌面生命周期

目标：从演示升级为可长期运行的本机产品。

交付：

- crash marker、启动恢复、unknown invocation 人工处理。
- 一致性备份、quarantine 恢复、migration 回滚。
- 托盘、开机启动、显式退出、强更重启语义。
- SSRF、凭据、Artifact、日志、Origin/CSRF 和会话硬化。
- 资源上限、磁盘不足、健康状态和脱敏诊断。

门禁：在各关键事务点强制杀进程后均能恢复；备份恢复不重复远端副作用；安全测试全绿。

### 旧 M7：真实环境验收与发布

目标：完成第二台机器和真实 Agents 的闭环。

交付：

- Windows、macOS 安装包与升级路径。
- 一台 Hub、至少两台/两个局域网 Agents、一台 LAN 浏览器的测试报告。
- 性能、长稳、恢复、隐私与发布检查单。

门禁：本页第 6 节的端到端场景全部通过，遗留 concerns 明确记录，不把未执行门禁标为通过。

## 4. 历史基线测试策略

### 4.1 测试层次

| 层                      | 覆盖内容                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Domain unit             | 状态机、EventTypeRegistry、Wake liveness、退避、预算、动作校验、记忆评分、时间规则 |
| Persistence integration | migration、事务、外键、幂等、outbox、lease、崩溃点                                 |
| A2A contract            | Card、stream/get/cancel/resubscribe、readiness、Envelope、interaction、Artifact    |
| HTTP contract           | auth、CSRF、DTO、错误码、游标、SSE 重连                                            |
| Renderer                | 创建向导、时间线、状态、input/auth、设置、响应式                                   |
| Electron e2e            | 首次设置、托盘、窗口关闭、LAN listener、更新重启、备份恢复                         |
| Interop manual          | 真实 AI Mana、第二机器、网络中断、Token/Card 变化                                  |

关键回归测试必须单独命名并长期保留：

- 同一运行中消息只进入持久事件和轻量信号，不重复成为 session/user message。
- Agent 未读取、Wake 休眠或 Hub 崩溃前，事件不得提前 CONSUMED。
- in-process marker、Turn heartbeat、startup grace 与 stale 四条 Wake liveness 路径。
- ActionDispatched 必须有 Observation、ToolError 或 ExecutionFailed 结局。
- 429/503 breaker 跨 Life 共享、正确解析两种 Retry-After 且不保存明文凭据。
- Alarm 投递 event/outbox 失败后仍可重试；并发 tick 只产生一个 occurrence event。

### 4.2 质量门禁

- TypeScript strict，不允许新增未解释的 `any`。
- lint 与格式检查零错误。
- Domain、application 和新生产模块 statements/branches 均至少 90%。
- 所有 migration 必须有空库、上一个发布版本和失败回滚测试。
- 所有外部副作用路径必须有“提交前崩溃、发送后无响应、收到终态前崩溃”测试。
- 文档相对链接、EventTypeRegistry schema 和分层依赖矩阵必须进入 CI。
- 包内容检查不得包含测试 Token、真实 userData、开发 `.env` 或源码绝对路径。

建议固定命令：

```text
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:e2e
npm run build:prod
npm run package:verify
```

## 5. 历史基线需求追踪

| 需求组          | 主里程碑 | 必须验收                           |
| --------------- | -------- | ---------------------------------- |
| LIFE / WEB 基础 | M1、M5   | 创建、启停、LAN 登录、状态展示     |
| AGENT           | M2       | Card/Token、readiness、漂移、停用  |
| EVENT / ACTION  | M3       | 持久事件、Wake、repair、表达与停止 |
| MEMORY / RHYTHM | M4       | 召回、代谢、闹钟、作息、预算       |
| 多 Agent 协作   | M4       | 异步 delegate、结果回流、部分失败  |
| 恢复与安全      | M2、M6   | 幂等、Task 恢复、SSRF、备份、凭据  |
| 桌面与发布      | M6、M7   | 托盘、强更、双平台包、第二机       |

## 6. 历史基线端到端验收场景

### E2E-01：出生与首次休眠

连接支持扩展的主 Agent，创建生命并出生。生命处理 `system.birth`、表达第一条消息、写意识残留、设置闹钟并进入 SLEEPING。

### E2E-02：运行中插话

主 Agent执行长任务时用户发送两条消息。当前 Invocation 不被取消；消息立即显示为已持久化事件，只通过轻量 eventId 信号通知运行循环，并在下一 Turn/Wake 按原顺序各读取一次。Agent 真正读取前事件不标记 CONSUMED；在信号发送后强制终止 Hub，重启后消息仍可被读取且不重复渲染。

### E2E-03：跨天自我唤醒

主 Agent设置未来闹钟。关闭窗口、保持托盘运行，到点自动唤醒；随后重启应用，生命仍能从残留和记忆继续。

### E2E-04：多 Agent 协作

主 Agent同时委派两个协作者。一个成功、一个失败；成功结果与失败分别形成事件，主 Agent选择降级方案并向用户表达，不丢失主 Affair。

### E2E-05：input/auth

协作者先请求普通 input，再请求 auth。主 Agent可处理普通问题；auth 只能由用户处理。回答/授权均绑定原 interaction，重启后仍可恢复。

### E2E-06：远端与 Hub 崩溃

在发送前、接受后、stream 中和动作提交后四个点分别终止 Hub。恢复后通过 outbox/messageId/taskId 得到唯一结果，不产生重复副作用。

### E2E-07：context 过期

远端清理主 Agent context。下一次调用识别 task/context not found，创建新 context，注入有界 persona/Affair/残留/记忆并继续。

### E2E-08：预算与安静时段

耗尽自主唤醒额度后生命进入 BUDGET_PAUSED；用户消息仍被接受但若无调用额度则明确等待。安静时段内部记忆整理可运行，普通表达延迟发送，空闲探索不运行。

### E2E-09：LAN 控制面

第二台局域网设备用管理员口令登录，接收 SSE、发送消息、回答 interaction、暂停生命。浏览器开发工具、网络响应和存储中均不存在 A2A Token。

### E2E-10：备份恢复

创建包含生命、记忆、事务和 Artifact 的备份，恢复到干净数据目录。数据与 hash 正确，Web 会话被撤销，Agent 要求重新输入 Token，旧远端未知 Task 不自动重发。

### E2E-11：Endpoint 退避与审计

两个 Life 共用同一 Agent Connection。远端依次返回带数字秒和 HTTP-date 的 429/503；Hub 只打开一个共享 breaker，较短冷却不覆盖较长冷却，期间消息仍进入事件队列。冷却后调用恢复，并可从 Wake、Turn、Injection 和 FlowEvent 重建从消息到正式动作的因果链，日志中不存在 Bearer、正文或完整 Origin。

### E2E-12：Android 原生远程扫码、切路与撤销

桌面启用原生远程并生成二维码；两台 Android App 依次绑定后可同时看到与本机首页一致的任务卡并提交文字，重启后使用系统安全存储中的独立凭据恢复。同一 Wi-Fi 显示直连，关闭 Wi-Fi 后可经 iroh 中继恢复。第二次使用原二维码失败；桌面撤销其中一台后，该连接关闭且不能恢复，另一台不受影响。桌面状态 API、诊断和 sidecar/中继输出均不存在节点私钥、设备密钥、票据或正文。

## 7. 发布门禁（继续适用）

一个里程碑只有在以下证据齐全时才能标记 DONE：

- 需求与测试的追踪关系。
- 自动化命令、数量、失败数和覆盖率。
- 受影响平台的手工证据。
- 未执行项目明确标为 concern，不写成“默认通过”。
- 无高优先级数据丢失、重复副作用、凭据泄露或跨 Life 越权问题。

MVP 发布后仍明确不包含多用户、云同步、外部消息渠道、Agent 自动发现/配对、自我修改代码、向量数据库和通用公网管理面。ADR 0013 的受限 Android 原生远程入口是唯一公网传输例外。
