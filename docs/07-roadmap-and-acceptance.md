# 路线图与验收

## 0. JOI-01 实施路线

JOI-01 是当前目标架构任务，按 W0-W7 串行收敛：W0 文档/ADR；W1 Pi 与 provider contract；W2 Model Source/Avatar/Partner 领域及迁移；W3 首次连接、inbox 与最小首页闭环；W4 Work DAG/并发/outbox；W5 Local Pi/A2A 搭档；W6 唯一首页与次级管理 UI；W7 兼容切换、安全与发布验证。

纵向里程碑为 M1=W0-W3、M2=W4-W5、M3=W6-W7。底层组件完成不能替代“首页输入 -> Avatar 归属 -> Pi -> 派发/结果”的可演示闭环。全部 AC 的唯一追踪矩阵位于 `docs/10-requirements-traceability.md`。

旧 M0-M7 记录保留为现有 Life/Wake 运行时的已验证基线和可复用能力，不代表 JOI-01 已完成。

2026-08-03 的信息架构增量以 AC-37/AC-40 为门禁：首页必须保持单栏可清理，具体执行只能沿“目标 Avatar 卡 → Agent 卡 → 只读展示对话”下钻；原始引擎消息和 A2A payload 不得跨越展示投影边界。

2026-08-05 的编排收敛增量以 AC-41/AC-43 为门禁：Work 必须强关联原始目标且每个 run 只有一个权威终态；执行 Agent 接收私有完整 brief，可机械验证的任务必须验收后才能完成；同一目标的全部权威结果按 revision 只综合一次，首页仅展示 joi 持久化的目标级完成结论。

## 1. 当前状态

| 阶段             | 状态   | 产物                          |
| ---------------- | ------ | ----------------------------- |
| 产品与技术文档   | 完成   | 本目录中的 README 与 10 份分册 |
| 新工程创建       | 完成   | M0 源码、测试、CI 与打包骨架已实现；macOS 实机验证保留至 M7 |
| AI Mana 配套扩展 | 未开始 | 仅有协议规格                  |
| MVP 实现         | 进行中 | M0-M6 本机实现与自动化完成；M7 Windows 构建已验证，真实互操作/macOS/长稳待完成 |

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

## 3. 实施里程碑

### M0：工程与 Harness（自动化完成）

目标：建立可重复开发、测试和打包的空工程。

交付：

- Electron + React + TypeScript + Vite 工程。
- lint、typecheck、unit、integration、renderer、e2e、production build 命令。
- 项目 Harness、模块边界、ADR、CI 和 Windows/macOS 打包骨架。
- 可机器校验的 import boundary rules；新增未分类生产目录默认失败。
- 测试数据库、临时 userData 和凭据替身，禁止测试访问真实用户数据。

门禁：空应用能启动、打包并在 Windows/macOS 打开；Domain 导入 Electron/SQLite/HTTP/A2A SDK 的反例测试会失败；所有验证命令为 0。

### M1：持久化、HTTP 与单管理员（自动化完成）

目标：建立不依赖 Agent 的 Runtime 基础。

交付：

- SQLite migration、Repository、事务、outbox、runtime lease。
- loopback + 可选 LAN 双 listener。
- 管理员口令、桌面 bootstrap、LAN session、CSRF、SSE cursor。
- Life CRUD、Agent Connection 空壳、诊断和备份 manifest。

门禁：LAN listener 失败不影响桌面；重启后 Life 与 SSE 序号保持；Token/口令不出主进程。

### M2：A2A Gateway 与 AI Mana 配套扩展（Hub 自动化完成；外部扩展与真实互操作待验收）

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

### M3：事件与唤醒内核

目标：形成最小持续生命循环。

交付：

- Life lifecycle、持久事件队列、Arbiter、Wake/WakeTurn。
- EventTypeRegistry、运行中 event signal、Wake liveness 和失败退避。
- Context assembler、Wake/Turn/Injection/FlowEvent 审计、ActionProcessor、一次 repair、意识残留。
- 用户消息、出生、恢复、表达、sleep 与紧急停止。
- 每生命单主 Wake、Hub/Endpoint 并发和 outbox dispatcher。

门禁：生命能出生、回复、休眠、自设一次性闹钟并在重启后再次醒来；运行中插话不取消当前调用、不重复渲染且不提前消费；任一 Turn 的输入引用和动作因果链可以从审计记录重建。

### M4：事务、记忆、作息与协作（Hub 自动化完成；真实跨机互操作待 M7）

目标：完成“跨天连续 + 多 Agent”的产品闭环。

交付：

- Affair、Todo、Alarm、Schedule、等待关系。
- Alarm occurrence 到 Event 的原子/幂等投递。
- 活动记录、意识残留、情景记忆、语义记忆、概念卡优先、FTS5 召回和记忆代谢。
- 主 Agent + 协作者 allowlist、异步 delegate、结果事件。
- 受预算自治、安静时段、空闲探索和每日重置。

门禁：两个协作者并行完成后主 Agent被新事件唤醒；context 过期后用有界记忆重建；等待中的 Affair 不阻塞其他事务；多个同时到期 Alarm 在锁冲突或投递失败后不丢不重。

### M5：完整 Web 体验

目标：让核心能力无需阅读协议即可使用。

交付：

- 首次设置、Agent 添加、三步生命创建。
- 全部生命、活动时间线、输入框、状态侧栏。
- 事务/待办、记忆、作息/闹钟、Agents、设置与诊断。
- input/auth、Artifact、失败重试、预算追加和紧急停止。
- 768 px LAN 浏览器和 960 px 桌面窗口响应式行为。

门禁：新用户 10 分钟内创建并启动生命；所有状态有文本反馈；键盘可完成主要路径；用户消息与协议状态不混杂。

### M6：恢复、安全与桌面生命周期

目标：从演示升级为可长期运行的本机产品。

交付：

- crash marker、启动恢复、unknown invocation 人工处理。
- 一致性备份、quarantine 恢复、migration 回滚。
- 托盘、开机启动、显式退出、强更重启语义。
- SSRF、凭据、Artifact、日志、Origin/CSRF 和会话硬化。
- 资源上限、磁盘不足、健康状态和脱敏诊断。

门禁：在各关键事务点强制杀进程后均能恢复；备份恢复不重复远端副作用；安全测试全绿。

### M7：真实环境验收与发布

目标：完成第二台机器和真实 Agents 的闭环。

交付：

- Windows、macOS 安装包与升级路径。
- 一台 Hub、至少两台/两个局域网 Agents、一台 LAN 浏览器的测试报告。
- 性能、长稳、恢复、隐私与发布检查单。

门禁：本页第 6 节的端到端场景全部通过，遗留 concerns 明确记录，不把未执行门禁标为通过。

## 4. 测试策略

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

## 5. 需求追踪

| 需求组          | 主里程碑 | 必须验收                           |
| --------------- | -------- | ---------------------------------- |
| LIFE / WEB 基础 | M1、M5   | 创建、启停、LAN 登录、状态展示     |
| AGENT           | M2       | Card/Token、readiness、漂移、停用  |
| EVENT / ACTION  | M3       | 持久事件、Wake、repair、表达与停止 |
| MEMORY / RHYTHM | M4       | 召回、代谢、闹钟、作息、预算       |
| 多 Agent 协作   | M4       | 异步 delegate、结果回流、部分失败  |
| 恢复与安全      | M2、M6   | 幂等、Task 恢复、SSRF、备份、凭据  |
| 桌面与发布      | M6、M7   | 托盘、强更、双平台包、第二机       |

## 6. 端到端验收场景

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

## 7. 发布定义

一个里程碑只有在以下证据齐全时才能标记 DONE：

- 需求与测试的追踪关系。
- 自动化命令、数量、失败数和覆盖率。
- 受影响平台的手工证据。
- 未执行项目明确标为 concern，不写成“默认通过”。
- 无高优先级数据丢失、重复副作用、凭据泄露或跨 Life 越权问题。

MVP 发布后仍明确不包含多用户、云同步、外部消息渠道、自动发现、二维码配对、自我修改代码、向量数据库和公网部署。
