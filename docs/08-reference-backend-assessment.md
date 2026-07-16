# 参考后端调研与吸收清单

## 1. 结论

`LChJo/digital-life` 的本地调研副本有明确参考价值，但不适合作为新工程底座，也不应整模块移植。

建议吸收六类经过源码与测试共同说明的运行时约束：

1. 事件先持久化，运行中插话只发轻量信号，不提前消费事件。
2. 用进程内标记、持久 Turn 心跳和 Wake 启动宽限共同判断一次 Wake 是否仍存活。
3. 事件类型采用单一注册表，严格校验，并把事件失败重试与未来闹钟分开。
4. 将 Wake、真实 Agent Turn、运行时上下文注入和跨层流程事实分开审计。
5. 对共享同一 Endpoint/凭据身份的调用实施连接级熔断，正确处理 `Retry-After`。
6. 保留可机器校验的分层边界；多 Life 进程隔离只作为后续高隔离模式。

记忆的“概念卡优先、碎片补充”和分层摘要可作为 M4 的设计参考，但原项目的固定权重、向量索引、文件布局和自动 TTL 不直接采用。

## 2. 调研边界与证据等级

### 2.1 快照

| 项目     | 值                                         |
| -------- | ------------------------------------------ |
| 本地路径 | 本地调研副本（未纳入仓库）                |
| 上游     | `git@github.com:LChJo/digital-life.git`    |
| 分支     | `main`                                     |
| 提交     | `8afe89bbfb8d5d510974d7dd53c72817c2e20052` |
| 项目版本 | `0.1.0`                                    |
| 许可证   | Apache License 2.0，Copyright 2026 zhp     |
| 调研日期 | 2026-07-15                                 |

### 2.2 证据等级

- **A级：** 当前提交中的生产源码与针对同一行为的回归测试一致。
- **B级：** 生产源码表达了清晰约束，但没有找到同等直接的测试。
- **C级：** 只出现在说明文档、注释或历史兼容层，必须重新验证。

本次是静态源码调研，没有把“仓库中存在测试”写成“测试已在当前机器运行通过”。原仓库部分说明文档存在路径漂移，因此本页优先引用当前源码和测试；后续若参考仓库提交变化，必须重新核查，不自动沿用结论。

## 3. 必须吸收的运行时约束

### 3.1 持久事件与运行中插话（P0，A级）

参考实现的核心不变量是：事件先写数据库，再进入统一的 wake-or-inject 判定。若主 Wake 正在运行，新事件只向进程内信号池发送“有新事件”通知：

- 不把同一用户消息再伪装成一条 session message。
- 不把正文重复塞进当前 Wake prompt。
- 不在当前 Agent 真正读取前把持久事件标为已消费。
- 若 Agent 在拾取信号前休眠，数据库中的事件仍由下一 Turn/Wake 读取。
- 消费状态发生竞争时，注入前再次过滤，避免重复呈现。
- 注入内容保留 source、channel、thread/context、eventId 等路由事实。

本项目应采用相同语义，但用 TypeScript、SQLite outbox 和 A2A WakeTurn 重新实现。UI 可以立即展示用户消息已持久化；“Agent 已读取”只能在该 eventId 被记录到某次 Turn 的 Injection/消费事实后展示。

指定参考：

- `domain/lifecycle/events.py`
- `tests/test_midsession_inject_regression.py`
- `tests/test_midsession_event_render.py`

### 3.2 Wake 存活判定（P0，A级）

不能用 Affair、会话或 Wake 记录的普通 `updatedAt` 推断 Agent 仍在运行，因为这些字段可能长期不更新，也可能被不相关写入刷新。

本项目的 `WakeLiveness` 按以下顺序取证：

1. 当前进程持有对应 wakeId 的运行标记，判定为活跃。
2. 持久 `wake_turns.last_activity_at` 在统一阈值内，判定为活跃。
3. Wake 刚创建、尚未产生第一个 Turn，且仍在启动宽限内，判定为活跃。
4. 其余情况才视为 stale，交给 lease 恢复流程。

cron、启动恢复、Arbiter 和诊断必须共用同一阈值配置，不能分别硬编码。参考实现默认 1800 秒；本项目应把该值当作初始候选，通过真实 A2A 首包和长任务数据校准，而不是照抄为永久常量。

指定参考：

- `domain/lifecycle/wake_liveness.py`
- `tests/test_wake_liveness.py`

### 3.3 事件注册、合并与失败退避（P0，A级）

事件类型应有单一注册表，至少声明：

- type、来源和 payload schema。
- 默认优先级、是否允许自动唤醒。
- 去抖窗口与合并策略：`latest | accumulate | count | none`。
- context policy：本类事件允许装配哪些上下文。
- 消费策略和最大重试次数。

未知事件可以持久化和展示，但在注册前不得自动唤醒。计划未来发生的事件不参与即时去抖；同一时刻多个 Life 的后台事件可以在允许范围内加小幅抖动，避免惊群。

失败恢复属于原事件队列：失败批次保持原 eventId，以 `availableAt` 延迟并累计失败次数。建议初始退避为 `2/4/8/16/32/60` 分钟，上限 60 分钟；是否采用该具体序列在 M3 压测后固定。闹钟只表达真实未来意图，不得为了重试失败事件额外创建“重试闹钟”。

指定参考：

- `domain/lifecycle/event_registry.py`
- `config/event_types.yaml`
- `domain/lifecycle/events.py`
- `tests/test_event_flow_contract.py`
- `tests/test_event_backoff_on_failure.py`

### 3.4 Wake、Turn、Injection 与 FlowEvent 审计（P0，A级/B级）

参考项目把真实模型调用与系统补充上下文分开记录，使某次调用输入可以重建，又不需要复制整段会话。这个思路适合 A2A Hub：

| 事实      | 本项目含义                                                                 |
| --------- | -------------------------------------------------------------------------- |
| Wake      | 一次事件选择、上下文组装、动作提交和休眠周期                               |
| Turn      | 一次真实 A2A 主 Agent 调用，记录 messageId/taskId/contextId、序号和终态    |
| Injection | 在某个 Turn 前追加的事件、记忆、工具/系统结果引用，不冒充用户或 Agent 消息 |
| FlowEvent | 跨 ingress/domain/orchestration/execution/feedback 的只读状态转换事实      |

FlowEvent 至少包含 runId、单调 sequence、layer、source、parent/causation/correlation id、摘要和严重度。每个已派发的外部动作必须最终关联 Observation、ToolError 或 ExecutionFailed；流程日志只引用领域对象，不替代 `LifeEvent`、`Invocation` 或 `LifeAction`。

Wake 与 Turn 的序号生成必须考虑部分审计写入：不能因某张表写失败后重新使用旧序号，把新 Turn 混进旧 Wake。日志正文继续遵守脱敏规则。

指定参考：

- `infrastructure/persistence/instance/runtime_log.py`
- `domain/flow_event_log/core/events.py`
- `domain/flow_event_log/core/event_log.py`
- `domain/flow_event_log/core/validation.py`
- `infrastructure/persistence/repositories/flow_event_log.py`

### 3.5 Agent Connection 级熔断（P0，A级）

参考项目的熔断按 API Key 身份跨实例共享；本项目不拥有远端 LLM Key，应改为按稳定的 Agent Connection 身份共享：

```text
breakerKey = hash(cardOrigin + agentConnectionId + credentialVersion)
```

- 不保存 Bearer 或其他可逆凭据作为 key。
- 同一连接被多个 Life 使用时，共享 429/503 冷却状态。
- 支持数字秒和 HTTP-date 两种 `Retry-After`。
- 建议把冷却夹在 10 秒至 1 小时，后到的短冷却不得覆盖已有长冷却。
- 到期自动关闭；用户消息和 Agent 结果事件继续持久化，只延迟新的远端 Invocation。
- 熔断、Life 自主预算、事件优先级是三件事，不能互相冒充。

指定参考：

- `infrastructure/budget/circuit_breaker.py`
- `infrastructure/budget/budget_gate.py`
- `tests/test_circuit_breaker.py`
- `tests/test_token_tracking.py`

### 3.6 分层边界与可选隔离（P0/P2，B级）

参考项目将 ingress、application、domain、infrastructure 分层规则做成机器可读配置，并通过路径分类器检查越界。新工程应建立等价的 TypeScript boundary test：

- Interface 只做协议解析、鉴权和 DTO 映射，不做领域决策。
- Application 负责编排事务，不直接实现工具或 A2A transport。
- Domain 不导入 Electron、HTTP、SQLite 或 A2A SDK。
- Infrastructure 实现端口，不反向定义 Life 规则。

参考项目的 master supervisor 为每个实例启动独立进程，带 5 秒 watchdog、崩溃窗口和优雅终止。这能隔离单实例故障，但会显著提高 Electron 打包、IPC、数据库连接和升级复杂度。MVP 保持单主进程、每 Life lease 与并发隔离；只有真实长稳测试证明单 Life 故障会污染全局时，才引入可选 worker process，并沿用 supervisor 的“期望状态对账、限次重启、超时强杀”原则。

指定参考：

- `application/architecture_layers.py`
- `application/architecture_classifier.py`
- `gateway/instance_supervisor.py`
- `infrastructure/persistence/instance/factory.py`

## 4. 有条件吸收的记忆设计（P1，B级）

### 4.1 概念卡优先

参考项目先返回实体 profile，再用少量近期碎片补充，避免把大量零散记忆直接注入模型。本项目已有 `memory_cards` 与 `memory_fragments` 设计，应明确：

- 有可靠来源支持的概念卡优先于碎片。
- 概念卡不因碎片被压缩或隐藏而消失。
- 碎片保留来源、置信度和最后使用时间。
- 召回后只更新访问元数据，不修改记忆正文。

参考实现的 `0.35 recency + 0.25 authority + 0.25 overlap + 0.15 verification` 是其文件式记忆环境下的启发式，不作为本项目固定参数。M4 应用可解释数据集校准 FTS、实体、Affair、时间、置信度和使用度权重。

### 4.2 分层摘要

segment/session/day/week 分层摘要能降低长期上下文成本，但参考实现同时包含异步线程、直接 LLM 调用、向量索引和多套 SQLite，耦合较重。本项目只吸收以下原则：

- 原始活动记录不可变，摘要是派生投影。
- 先生成确定性 digest，再异步尝试 Agent 归纳；失败仍有 fallback。
- 摘要必须保存来源范围和生成版本，允许重建。
- 先验证 FTS5 与概念卡，MVP 不引入向量数据库。
- 不照搬 7/30/90/180 天 TTL；本项目默认不静默删除生命数据。

指定参考：

- `domain/memory/memory/consciousness/entity_index.py`
- `domain/memory/memory/summaries/consolidation_runtime.py`
- `docs/operations/memory-maintenance.md`

## 5. 明确不复用

| 不复用项                           | 原因                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| Python master/worker 作为 MVP 底座 | 与 Electron/TypeScript/A2A 目标栈不同，增加 IPC 与发布复杂度 |
| 直接 LLM provider/runtime          | 本项目通过 A2A 调度，Hub 不持有远端模型执行细节              |
| Token 与 energy 固定换算           | A2A usage 不是必报字段，跨 Agent 不可比较                    |
| 飞书、微信和 Vue 员工控制台        | 不在 MVP 范围，交互模型也不同                                |
| `apps/{id}` 文件树作为事实库       | 本项目以 SQLite 聚合、版本和外键保证一致性                   |
| prompt/tool allowlist 原文         | 属于参考项目角色与渠道语义，不能成为本项目受信任指令         |
| 向量索引与自动 TTL                 | MVP 已选择 FTS5，且默认不静默删除生命数据                    |
| 旧字段兼容与多套配置回退           | 新工程应只有一个版本化 schema，避免把历史迁移债务带入        |
| 参考项目的 UI、数据库 schema       | 产品边界、部署拓扑和协议责任不同                             |

## 6. 从现有缺陷吸收的反向约束

### 6.1 闹钟投递必须原子或可重试

参考项目的 `fire_due_alarms()` 在持有 timers 写事务时通过新连接写 event；其端到端测试明确记录多闹钟可能触发 SQLite `database is locked`。当前实现还会在 `emit_event()` 失败后继续把 timer 标记为 fired。

本项目禁止这种语义。到期调度必须在同一数据库事务内完成以下状态转换，或使用唯一 outbox 保证等价结果：

```text
Alarm SCHEDULED -> event/outbox persisted -> Alarm FIRED
```

如果 event/outbox 没有持久化成功，Alarm 必须保持可重试，不能显示已触发。唯一键至少覆盖 `(lifeId, alarmId, occurrenceAt)`，重复 tick 只能得到同一个事件。

### 6.2 派生记忆清理不得复用失效连接

参考项目的 session consolidation 主流程关闭数据库连接后，仍存在把该连接传给定期清理的路径。新工程的后台投影必须由 application service 明确拥有事务/连接生命周期；生成摘要、索引、清理和任务关联分成独立可重试 job，不能共享已经结束的 Unit of Work。

### 6.3 文档链接不是运行时事实

参考仓库入口说明指向的部分架构文档在当前提交不存在，运维文档也引用了缺失的记忆设计页。新工程的文档检查必须验证相对链接；架构边界和 schema 必须有自动化测试，不能只靠说明文档维持。

指定反证：

- `domain/lifecycle/alarms.py`
- `tests/test_e2e_event_lifecycle.py`
- `domain/memory/memory/summaries/consolidation_runtime.py`
- `AGENTS.md`、`CLAUDE.md` 与 `docs/operations/memory-maintenance.md`

## 7. 实施采用顺序

| 优先级 | 采用项                             | 里程碑 | 完成证据                                             |
| ------ | ---------------------------------- | ------ | ---------------------------------------------------- |
| P0     | 运行中插话、延迟消费、统一事件注册 | M3     | 重复/丢失/崩溃恢复回归测试                           |
| P0     | Wake liveness                      | M3     | in-process、heartbeat、startup grace、stale 四类测试 |
| P0     | Wake/Turn/Injection/FlowEvent 审计 | M3     | 任一 Agent 调用输入与动作因果链可重建                |
| P0     | Connection 级 429/503 熔断         | M2     | 跨 Life 共享、Retry-After、凭据不落盘测试            |
| P0     | 架构 boundary test                 | M0     | CI 拒绝 Domain 导入 SDK/SQLite/Electron              |
| P0     | Alarm 到 Event 的原子投递          | M3/M4  | 并发 tick、锁冲突、投递失败均不丢不重                |
| P1     | 概念卡优先与分层摘要               | M4     | 有来源的召回评估、重建测试、无静默删除               |
| P2     | 每 Life worker process             | M6 后  | 先有长稳故障证据与 ADR，再实现 supervisor            |

## 8. 许可证与来源管理

当前只研究并记录设计，没有把参考仓库源码复制进新工程，因此现阶段不新增第三方代码文件。

后续若逐行复制、翻译或实质性移植 Apache 2.0 源码，必须在同一次变更中：

1. 在仓库加入 Apache 2.0 许可证副本和 `THIRD_PARTY_NOTICES.md`。
2. 标明来源仓库、原文件路径、参考提交和修改说明。
3. 保留原有版权、专利、商标和归属声明；当前快照未发现独立 `NOTICE` 文件，但升级快照时需重新检查。
4. 不使用上游项目名称暗示背书。
5. 在依赖/源码扫描中持续验证许可证文件随发行包分发。

优先策略仍是“从不变量和测试重写 TypeScript 实现”，而不是逐行翻译 Python。即使没有复制代码，本页也永久保留来源与提交，便于审计设计来源。

## 9. 对本文档包的落地

本次调研已同步形成以下约束：

- [系统架构](03-system-architecture.md)：补充运行审计、Connection 熔断、机器可校验分层和可选 worker 隔离。
- [领域模型与运行时](04-domain-and-runtime.md)：补充事件注册、运行中插话、Wake liveness、失败退避和概念卡召回。
- [安全与运维](06-security-and-operations.md)：补充 Endpoint 级 backpressure、闹钟原子投递和相关诊断。
- [路线图与验收](07-roadmap-and-acceptance.md)：补充边界测试、重复/丢失回归、熔断和审计重建门禁。

如果后续实现与本页冲突，以本项目产品边界、A2A 协议约束和新工程实测结果为先；任何偏离应通过 ADR 记录原因。
