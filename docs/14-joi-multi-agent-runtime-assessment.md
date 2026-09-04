# joi 驱动/状态链路与多 Agent 编排评估

> 评估日期：2026-09-04 · 评估对象：`master` 分支工作树（**含未提交的 goal-continuation 进行中改动**）

---

## 0. 评估方法与置信度说明

本评估由多 agent 并行测绘 + 对抗验证 + 人工复核三段组成，**结论的证据强度不均匀，本节明确划分，请勿把推断当事实读**。

**方法**

1. 7 个 agent 并行测绘子系统（actor 驱动、wake/rhythm 调度、状态机与持久化、多 agent 引擎、编排与结论生产、容错与 A2A、测试覆盖），各自独立读代码产出驱动链/状态链结构化结果。
2. 对每个子系统派风险评估 agent，共提出 **32 条**风险，每条要求给出 `file:line` 与可复现失败场景。
3. 对抗验证阶段：每条风险派 3 个视角（代码核实 / 可达性 / 影响度）的反驳 agent，默认立场「这不是真问题」。

**实际完成度（必须如实说明）**

编排任务因并发过高被中止，对抗验证阶段**只完成了 4 个判决**。为补齐，我人工顺序复核了全部 7 条 P0 风险。因此本文风险的证据等级分三档，表格中逐条标注：

| 等级 | 含义 | 数量 |
|---|---|---|
| **已确证** | 经对抗验证判决或人工逐行复核，代码证据充分 | 6 条 |
| **已驳回** | 复核后发现风险描述不成立 | 1 条 |
| **未复核** | agent 提出且给了 `file:line`，但未经独立验证，**可能有误** | 25 条 |

**有运行时证据的部分**（我实际执行，非静态推断）：测试套件 3 次全量运行 + 1 次隔离对比、`typecheck`、`lint`、`check:boundaries`、覆盖率数据。见 §6.1。

**纯静态推断的部分**：所有并发时序、崩溃恢复行为、长时运行 agent 的租约失效——**均未通过实际运行复现**。§9 给出对应的验证动作清单。

**测绘盲区**：actor 树子系统的独立测绘未返回（7 个中缺 1），其驱动机制由 wake/rhythm 测绘的前 3 步 + 我人工阅读 `src/main/index.ts` 与 `actor-tree.ts` 补齐；组件级细节的覆盖密度低于其他 6 个子系统。

---

## 1. 摘要

joi 的运行时是一个**单时钟、单根、串行 tick 的 actor 树**，全部跨组件协调都通过 SQLite 事实表完成，进程内不传消息。这个设计选择极大压缩了竞态面——大量本该出现的并发 bug 在架构层就不存在。持久化侧尤其扎实：状态枚举有 DB CHECK 兜底、关键幂等键有 UNIQUE/部分唯一索引、计划提交是单事务、outbox 保证至少一次投递。

但**编排层的确定性远低于持久化层**，且有一整块子系统已经死掉。最关键的 5 条结论：

1. **声明的 Work 依赖 DAG 完全没有被执行侧强制**。`buildWorkExecutionWaves` 算出的执行波次只写进计划快照和诊断字段，从不用于门控派发——所有 Work 在同一事务里一次性进 outbox 且 `availableAt = createdAt`。依赖后继与前置**并行执行**。（已确证，3 份独立判决）

2. **整条旧 Wake 子系统是死代码**。`WakeCoordinator` / `WakeRunner` / `WakeArbiter` / `WakeRepairService` / `WakeAuditService` / `WakeRecoveryService` / `ActionProcessor` 在 `src/` 生产装配中**零引用**，`src/main/composition/` 完全不提 wake。它们仍被测试覆盖，因此贡献了测试数与覆盖率，却不保护任何在跑的代码。

3. **native agent（claude-code / codex）的正式运行没有死线，也没有可达的取消**。`AbortController` 建了、传进 SDK 了，但全文件唯一的 `controller.abort()` 在 45s 探针路径里；正式 run 无人 abort。agent 挂死即永久占死该 `(workbench, partner)` 槽位。（已确证）

4. **工作区租约 10 分钟固定 TTL 且无续租机制**，而任何一次 `acquire()` 都会先清扫过期租约。超过 10 分钟的 agent 运行会被静默剥夺工作区独占权，随后第二个 agent 可以拿到同一工作区的 WRITE 租约。agent 运行超 10 分钟是常态，不是边缘情况。（已确证）

5. **验证环节可被绕过，且验证结果在下游无人消费**。验收检查为空即返回 `NOT_REQUIRED`，而验收项由模型自愿在 `work_dispatch` 时声明；`work_result_verifications` 是只写表。「看起来完成但结论错」的主要入口在此。（未复核，但三条独立风险相互印证）

当前工作树的质量门禁是红的（`typecheck` 5 错、`lint` 3 错、9 个测试稳定失败），但这些**全部源于一批未提交的进行中改动**，不是已发布代码的缺陷。详见 §6.1。

---

## 2. 驱动链路全景

### 2.1 唯一时钟

整个运行时只有一个定时器。`src/main/index.ts:306`：

```
setInterval(2000) ── rootTickInFlight 守卫（非空直接 return，不排队）
  ├─ await actorTree.tick(clock.now())
  └─ await outboxDispatcher.dispatchOnce()
```

`outboxTimer.unref()`（`index.ts:319`）使其不阻止事件循环退出。启动时另有一次同步 tick（`index.ts:196` 附近）。

**这条链的错误处理是个观测缺口**：`index.ts:314` 的 `.catch(() => process.stderr.write("Runtime background dispatch cycle failed.\n"))` **丢弃了 error 对象**，只写一行常量文本，且不发诊断事件。整条 tick 链上任何未被内层捕获的失败，对外只表现为这一行无信息量的文字。

### 2.2 端到端串联

```
[2s 定时器]  src/main/index.ts:306
     │
     ▼
[ActorTree 单根遍历]  actor-tree.ts:20-40
     │   #inFlight 非空时复用同一 Promise，绝不并发第二轮
     │   roots 顺序 await updateActorSafely；actor 不持定时器、不互发消息
     │   唯一协调介质 = SQLite 事实表
     ▼
[JoiActor 组件固定顺序]  wire-runtime.ts:143-171
     │   JoiAutomationComponent → JoiTaskComponent → JoiHarnessComponent → JoiRhythmComponent
     │
     ├─ JoiAutomationComponent ── automation-store.claimDue（单事务认领到期 Routine）
     ├─ JoiTaskComponent ─────── 唯一模型执行槽位（详见下）
     ├─ JoiHarnessComponent ──── 10s 节流，目标地图收敛；从不调 LLM、从不派发
     └─ JoiRhythmComponent ───── 6 个调度器串行折叠：
     │                            alarm → schedule → todo → expression → budgets → idle
     │                            每个异常被 try/catch 吞掉，只发 joi.rhythm.tick_failed
     ▼
[WorkbenchActor（每工作台）]
     │
     ├─ WorkbenchAgentComponent ── 扫 listUnsynthesizedResults → 汇入目标合成
     └─ AgentDispatchComponent ─── 每 (workbench, partner) 一个实例
     │     #inFlight 单槽 → 同一对同时只允许一个运行
     │     claim（30s 租约）→ prepare → ack outbox → 异步 fire run → 后续 tick 收敛
     ▼
[OutboxDispatcher]  outbox-dispatcher.ts
       claimOutbox(claimUntil=+30s, limit=20, excludeKinds=['partner.dispatch'])
       失败 releaseOutbox(availableAt = now + min(60, 2**attempt) 分钟)
```

### 2.3 输入 → 结论的完整链路

| # | 环节 | 位置 |
|---|---|---|
| 1 | 输入落库 PENDING（`idempotency_key` UNIQUE 去重；正文 1–32000 字符、附件 ≤8） | `joi-inbox-service.ts` |
| 2 | 单串行槽取最早一条 PENDING（需 `gate.hasReadySource()`；15 分钟不 settle 则 abort 但仍占槽） | `joi-task-component.ts:47-138` |
| 3 | Workbench 路由（`router.decide` 最多两次，第二次 `repair=true`） | `joi-coordinator.ts:145-305` |
| 3b | **确定性动作恢复**：`resolvedAction` 存在时只 createTurn + work.resume，不调模型 | `joi-coordinator.ts:222-270` |
| 4 | 附件装配（图片单 ≤4MB/总 ≤8MB；文本单 ≤48000/总 ≤96000 字符，超限截断并给 cursor）+ 模型源钉住 | `joi-attachment-context.ts` |
| 5 | 推理 Turn（每轮重建工具闭包，绝不复用上轮；工具名白名单双重校验） | `pi-reasoning-runtime.ts` |
| 5b | **工具面按输入类型收窄**：合成类输入只保留 10 个 SYNTHESIS 工具 | `joi-reasoning-tools.ts` |
| 6 | `work_dispatch` → `plan()`：去重、拒绝 `workspaceRef`、验收项禁绝对路径/盘符/`..` | `work-orchestration-service.ts` |
| 6b | 派发策略门（应用层裁决，基础设施只收集事实） | `dispatch-policy.ts` |
| 6c | **单事务**提交 work_items + policies + dependencies + dispatch_plans + outbox，并复验 turn↔goal 绑定 | `sqlite-work-plan-repository.ts` |
| 7 | 派发执行状态机（prepare 抛错则 `2**attempt` 分钟退避，上限 60） | `agent-dispatch-component.ts` |
| 8 | **验收校验实际执行**：BODY_PRESENT / ARTIFACT_PRESENT / FILE_EXISTS / FILE_CONTAINS_EXACT（后两者先 realpath 工作区根再 resolve） | `workspace-work-verifier.ts` |
| 8b | 结果落库（attempt 已终态直接返回 `isAuthoritative=false` 防重复） | `partner-dispatch-delivery-adapter.ts:506-627` |
| 8c | run 级去重（同 run 已有权威终态则本次非权威；否则旧行全部降权） | `sqlite-work-result-repository.ts` |
| 9 | 结果汇入目标结果集，`revision++`，生成 `joi_result_input:goal:*` 合成输入 | `sqlite-joi-inbox-repository.ts:457-526` |
| 10 | **合成持久化门禁**：revision 不匹配或 outcome 不合法 → 输入退回 PENDING 重跑；合成期间目标被恢复重新激活 → 只置 CONSUMED，不发布过期结论、不抬水位 | `sqlite-joi-inbox-repository.ts:616-707` |
| 11 | 目标地图推进下一层（每步独立 try/catch） | `joi-harness-component.ts` |
| 11b | 复盘投递三重门槛：map=ACTIVE 且 `revision > reviewed_revision` 且 `synthesized_revision == revision` | `sqlite-joi-harness-repository.ts:192-216,511-551` |
| 12 | 结论对外：脱敏（掩密、绝对路径→占位）+ 按行边界截 4096 字符 + 自动补未闭合代码栅栏 | `joi-coordinator.ts:494-549` |

### 2.4 已死的驱动链（重要）

旧 Wake 内核（`wakes` / `wake_turns` / `life_events` / `runtime_leases` 表 + 7 个 application 服务）设计完整——4 回合上限、30 分钟租约、`maxEvents 50` / `maxBytes 64KiB` 上限、协议失败一次 repair 后 `failWakeProtocol`、事件 DEAD_LETTER 归档。

**但它在生产中一行都不跑。** 核实方式：

```
new WakeCoordinator( / new WakeRunner( / new WakeArbiter(
new WakeRepairService( / new WakeAuditService( / new ActionProcessor(
  → src/ 中生产装配命中数：全部为 0
grep -rn "wake\|Wake" src/main/composition/*.ts → 无输出
WakeRecoveryService → src/ 内零引用，仅 tests/integration/wake-audit-repair.test.ts 引用
```

活着的等价物是 §2.2 的 actor 树 + `joi_inbox_messages`。**这块死代码的真实代价不是运行时故障，而是认知与实证污染**：它贡献测试数与覆盖率，读代码的人（和 agent）会把它当作现行机制来推理——本次评估中就有 2 条 P0 风险因此误判了影响面（见 §8 R3/R4）。

---

## 3. 状态链路全景

### 3.1 核心实体状态机

| 实体 | 状态 | 约束与幂等 |
|---|---|---|
| `joi_inbox_messages` | PENDING → ROUTED → CONSUMED / CLARIFICATION_REQUIRED | `017:203` CHECK；`idempotency_key` UNIQUE；`canceled_at`(028) / `dismissed_at`(032) / `failed_at` 为旁路标记列 |
| `joi_turns` | RUNNING → COMPLETED / FAILED（PENDING/WAITING/ABORTED **枚举存在但从不写入**） | `017:218` CHECK；`formal_output_started` / `side_effect_started` 为 0/1 |
| `work_items` | PLANNED → READY → WAITING → COMPLETED / FAILED / CANCELED（RUNNING **枚举存在但从不写入**） | `017:244` CHECK；`034` 加 BEFORE INSERT/UPDATE 触发器强制 goal 绑定 |
| `dispatch_attempts` | PENDING → COMPLETED / FAILED / WAITING_INPUT / WAITING_AUTH / UNKNOWN（DISPATCHED/ACCEPTED/RUNNING **未使用**） | `017:273` CHECK；`action_id` UNIQUE 作幂等键 |
| `work_results` | COMPLETED / FAILED / WAITING_* / UNKNOWN + `is_authoritative` + `is_late` | `027:93` CHECK；`UNIQUE(run_id, status)`；`034` 加 `idx_work_results_one_authoritative_per_run` 部分唯一索引 |
| `partner_runs` | RUNNING → COMPLETED / FAILED / WAITING_INPUT / WAITING_AUTH / UNKNOWN | `018:18` CHECK；`dispatch_attempt_id` 与 `action_id` 均 UNIQUE |
| `partner_instances` | IDLE → BUSY → DISPOSED | `024:6` CHECK |
| `joi_goal_result_sets` | `revision`（已收权威结果层数）/ `synthesized_revision`（已消费水位） | 水位单调，合成时校验 revision 一致性 |
| `joi_goal_outcomes` | COMPLETED / CONTINUE / BLOCKED / ACCEPTED_WITH_GAPS | `043` 引入两值，`051` 重建表扩为四值 |
| `joi_harness_maps` | ACTIVE → CLEARED | `037:10` CHECK；`revision >= reviewed_revision` |
| `joi_user_action_requests` | OPEN → RESOLVED → APPLIED / CANCELED | `044` 建表，`051` 重建加条件 CHECK；`idx_joi_user_action_one_open_per_input` 部分唯一索引保证每输入至多一个 OPEN |
| `outbox` | PENDING → CLAIMED → DONE | `001:54` CHECK + `idx_outbox_claim(status, available_at, claim_until)` |
| `workspace_leases` | 存在 / 过期被清扫 | **无状态列、无续租、10 分钟固定 TTL** |
| `work_recovery_attempts` | PLANNED → COMPLETED / FAILED | `050`：`attempt_no CHECK BETWEEN 1 AND 2`（有界自愈上限 2 轮） |
| `connection_breakers` | 闭合 / `open_until > now` | 行永不清理（导致 `openBreakers` 指标恒偏高） |
| `InvocationCapacityGate` | 进入 / FIFO 排队 / 释放 | **纯进程内 Map，无持久化，重启归零** |

### 3.2 持久化边界与恢复行为

**扎实的部分**：

- 计划提交是单事务（work_items + policies + dependencies + dispatch_plans + outbox 一起落或一起不落），不存在「Work 建了但 outbox 没建」。
- 结果权威性由 DB 层保证：`UNIQUE(run_id, status)` + 部分唯一索引 `idx_work_results_one_authoritative_per_run`，重复上报无法产生两条权威结果。
- 幂等键落在 DB 而非内存：`action_id`、`idempotency_key`、`dedupe_key` 都有 UNIQUE 或部分唯一索引。
- 迁移执行器支持表重建：首行 `-- joi:migration foreign-keys-off` 会关外键、提交前跑 `PRAGMA foreign_key_check` 校验、finally 恢复（`runtime-database.ts:2920-2935`）。`030`/`038`/`051` 用它扩展过 CHECK 枚举。
- 迁移失败降级为只读恢复模式而非崩溃（`runtime-database.ts:2949-2956`：`readOnly` + `query_only`），并在 `inspect()` 暴露 `migrationFailure`。

**边界与风险**：

- `InvocationCapacityGate` 的许可与排队队列**只在内存**。进程重启后并发上限归零重算，重启瞬间可能突发超过设计并发。
- `AgentDispatchComponent` 的 `#inFlight` 单槽也是内存态。崩溃重启后靠 `#scanOrphans`（30s）+ outbox claim 租约过期来收敛，而非靠持久化的「我正在跑」标记。
- 迁移 `041` 给 `workbench_workspace_roots.root_path` 建唯一索引，`045` 又改回普通索引（允许多工作台共享根路径）。这个反复说明工作区共享语义在演进中，跨工作台的工作区隔离假设需要重新确认。

---

## 4. 多 Agent 调用与管理方案评估

### 4.1 方案骨架

**引擎多元化**（ADR 0004 / 0014）。`PartnerEngineRuntime` 端口下挂三类实现：

| 引擎 | 实现 | 会话恢复机制 |
|---|---|---|
| `PI_CORE` | `pi-partner-engine-runtime.ts`（`@earendil-works/pi-agent-core`） | 进程内 Agent + 会话快照 |
| `claude-code` | `claude-agent-sdk-partner-engine-runtime.ts` | 官方 `resume` 恢复 SDK session |
| `codex` | `codex-agent-sdk-partner-engine-runtime.ts` | 同上 |
| A2A 远端 | `partner-dispatch-delivery-adapter.ts` + `a2a-gateway-service.ts` | `task_id` / `context_id` |

`partner_revisions` 是**不可变追加**的模板表，派发时 `pinForDispatch` 钉住 `partnerRevisionId`——运行中改配置不影响在跑的 run。这是个好设计。

**实例生命周期**。`partner-instance-manager.ts` 的 `dispatch()`：先 `engine.preflight`（无副作用选模型源）→ 有 `instanceId` 则校验工作台/partner/IDLE → 无则 RESIDENT 走 `ensure()`（查上限）否则新建 EPHEMERAL → `linkDispatch` 把实例写回 `dispatch_attempts`。

**并发模型**（这是理解全局的关键）：

```
串行 tick（无 actor 并发）
  └─ 真实并行度 = 不同 (workbenchId, partnerId) 对的数量
       每对一个 AgentDispatchComponent，#inFlight 单槽
  ├─ RESIDENT 实例全局上限 12
  ├─ workspace 租约互斥（WRITE 独占，跨 workspace_ref 按 root_path 判冲突）
  └─ A2A 侧额外有 ConnectionBreaker + InvocationCapacityGate（按 origin 分 lane）
```

**信息流隔离**（ADR 0006 / 0008）。工作台私有实例 + 结果只回传有界摘要：`WorkbenchAgentComponent` 每 tick 扫 `listUnsynthesizedResults` → `enqueuePartnerResult` 只带 `resultId` / `status` / 有界 summary，不回灌完整产出。joi 主推理**只有建议权**——它通过 `work_dispatch` / `work_supplement` / `work_reassign` / `work_resume` / `work_cancel` 工具提议，实际派发由确定性的 `plan()` + 策略门决定。

### 4.2 优点

1. **建议权与执行权分离**。模型不能直接派发 agent，只能提议；`work-orchestration-service.plan()` 与 `dispatch-policy.ts` 是确定性代码。模型幻觉不能直接变成副作用。
2. **模板不可变 + 派发钉版本**。消除了「运行中配置漂移」这一类竞态。
3. **信息流按需收窄**。合成类输入只暴露 10 个工具；结果只回传有界摘要而非全文。上下文膨胀在架构层被限制。
4. **策略裁决在应用层，基础设施只收集事实**（`dispatch-policy.ts` 注释明确这一点）。跨引擎能力差异没有渗进决策逻辑。
5. **失败分类结构化**。`PartnerRunFailure` 把失败投影成 `phase` × `sideEffectState` × `retryable` 三维，且不落原始文本（只进诊断与安全字段）。`sideEffectState=OBSERVED` 在 bash/edit/write 工具触发时置位——这让「是否可安全重试」有了实际依据而非猜测。
6. **有界自愈**。`work_recovery_attempts.attempt_no CHECK BETWEEN 1 AND 2` 用 DB 约束硬性封顶恢复轮数，不可能无限自愈。

### 4.3 代价与缺陷

1. **无死线**（已确证，P0）。native 引擎正式 run 没有 timeout；`AbortController` 建了但唯一的 `abort()` 调用在探针路径。`agent-dispatch-component.ts:72` 层也没有看门狗。挂死 = 永久占死槽位，用户无感知。
2. **租约期限与 agent 实际运行时长不匹配**（已确证，P0）。10 分钟固定 TTL、无续租、任何 `acquire()` 都清扫过期租约。agent 跑 10 分钟以上是常态。
3. **依赖 DAG 不被强制**（已确证，P0）。见 §5.1。
4. **EPHEMERAL 实例占用 RESIDENT 额度**（未复核，P2）。若成立，临时运行会顶满全局 12 额度使 `ensure()` 全局失败。
5. **并发闸门半持久**。DB 侧有租约与 outbox claim，内存侧有 `#inFlight` 与 `InvocationCapacityGate`。重启后内存侧归零，收敛靠孤儿扫描而非持久标记。

---

## 5. 结论生产效果评估

把「分解 → 派发 → 收集 → 裁决 → 验证」逐环节看把关强度：

| 环节 | 把关强度 | 依据 |
|---|---|---|
| 分解 | **中** | 拓扑排序与冲突分波算得出来（`buildWorkExecutionWaves`），但**算完不用** |
| 派发 | **强** | 确定性 `plan()` + 策略门 + 单事务提交 + 目标绑定复验 |
| 收集 | **强** | run 级去重 + DB 部分唯一索引保证单一权威结果 |
| 裁决 | **强** | 合成门禁校验 revision 一致性；恢复期间不发布过期结论 |
| 验证 | **弱** | 见下 |

### 5.1 分解环节：算出来的波次没人用（已确证 P0）

`work-orchestration-service.ts:131` 算出 `waves`，但只有三个消费者：写进 `dispatch_plans.candidate_json`、诊断字段 `waveCount`、`plan()` 返回值。`:134-161` 的循环对每个通过策略的 item **无条件**建 attempt 且 `outbox.availableAt = createdAt`（`:148`），无分批、无早返回。

全仓 `work_dependencies` 只有三处命中：`017:250` 建表、`sqlite-work-plan-repository.ts:125` 唯一 INSERT、测试。**没有任何读取方**。

`domain/work/work.ts:34-42` 的 `createWorkItem` 恒写 `status = PLANNED`，不存在「依赖未满足 = WAITING」的初始态。

→ 声明 `B depends on A` 后，A 和 B 同时进 outbox、同时被派发。若 B 的正确性依赖 A 的产物，B 会在产物不存在的前提下产出结论，而这个结论**会被正常收集、裁决并发布**。这是「看起来完成但结论错」最直接的路径。

3 份独立对抗判决全部未能反驳，置信度 high。

### 5.2 验证环节：三个叠加的弱点（未复核，相互印证）

1. `partner-dispatch-delivery-adapter.ts:524` — 验收检查为空即返回 `NOT_REQUIRED`，`intent_json` 解析失败也静默降级为「无需验证」。
2. 同上 — **验收项由模型在 `work_dispatch` 时自愿声明**。模型不写验收项 = 不做验证。
3. `sqlite-work-result-repository.ts:55` — `work_result_verifications` 是只写表，`PASSED` 与 `NOT_REQUIRED` 在下游无区分消费者。

需要说明的是，验证器本身**是真实执行的**（`workspace-work-verifier.ts`：`FILE_EXISTS` / `FILE_CONTAINS_EXACT` 会先 realpath 工作区根再 resolve，防路径逃逸），DB 层也有「`RESULT_SYNTHESIZED` 必须有 COMPLETED Work」的约束。问题不在验证器实现，而在**验证是否被触发由模型决定**，且结果无人读。

### 5.3 结论质量的正面防护（应计入评估）

- 合成门禁（`sqlite-joi-inbox-repository.ts:616-707`）：revision 不匹配或 outcome 非法 → 退回 PENDING 重跑，而不是发布可疑结论。
- 恢复期间目标被重新激活 → 只置 CONSUMED，**不发布过期结论、不抬水位**。
- 复盘投递三重门槛（`synthesized_revision == revision` 等）确保复盘看到的是完整的一层结果。
- `joi-harness-review-body.ts` 写死 close-first 规则：最新完成已满足目标且无可走路径就立即 `MAP_CLEARED`，复盘不得用 `DIRECT_ANSWER`，每次复盘最多解决一个 decision。这是防「无限复盘打转」的硬约束。
- 结论对外前脱敏 + 按行边界截断 + 自动补未闭合代码栅栏。

---

## 6. 稳定性评估

### 6.1 运行时实测证据（本次实际执行）

| 门禁 | 结果 | 归因 |
|---|---|---|
| `check:boundaries` | ✅ 通过 | 生产代码导入边界干净 |
| `typecheck` | ❌ 5 错 | 全部在未提交改动内 |
| `lint` | ❌ 3 错 | `sqlite-joi-harness-repository.test.ts:375,387,388` 非空断言 |
| `test` | ❌ 9 稳定失败 + 2 个 flake | 见下 |
| 覆盖率（上次记录，非本次） | statements 94.82% / **branches 90.07%** / functions 94.07% / lines 97.19% | 阈值均为 90%，branches 仅高出 **0.07pp** |

**类型断层的确切位置**：`ports/runtime-diagnostics.ts:241` 与 `:249` 声明 `disposition: "BLOCKED" | "COMPLETED"`，而 `joi-coordinator.ts:518` 已开始发 `"CONTINUE"`；迁移 `051` 的 CHECK 也已含 `CONTINUE` / `ACCEPTED_WITH_GAPS`。即：goal-continuation 特性在 **DB 与协调器落地了，在诊断端口停住了**——跨层推进不齐。

**9 个稳定失败全部同因**：迁移 `051`（未纳入 git）把 schema 推到 51，而 4 个测试文件硬编码 50。分布：`sqlite-runtime.test.ts:17`、`sqlite-partner-registry.test.ts:102`、`joi-orchestration-migration.test.ts`（4 例）、`backup-restore.test.ts`、`diagnostics-backup.test.ts`、`remote-joi-app.test.tsx`。这是已知的维护耦合——每加一个迁移都要手改多处测试。

**2 个 flake 是实测区分出来的**（3 次全量 + 1 次隔离对比）：

| 测试 | 全量运行 | 隔离运行 | 判断 |
|---|---|---|---|
| `pi-coding-tool-factory.test.ts` | 失败 @ 5014ms | ✅ 通过 | 5000ms 阈值附近，负载敏感 |
| `sqlite-joi-inbox-clarify.test.ts` | 失败（`joi_clarification_invalid`） | ✅ 通过 | 顺序/负载依赖 |

两次全量运行收集到的用例总数还不同（1081 vs 1082），说明有条件生成的用例。

### 6.2 分档结论

**已验证稳固**

- 单根串行 tick 的重入防护：`rootTickInFlight` + `ActorTree.#inFlight` 双层，且有 `tests/integration/joi-actor-tick.test.ts` 用真 ActorTree + 注入时钟覆盖。
- 崩溃恢复重放：`tests/integration/agent-dispatch-crash.test.ts` 用真迁移建库、手写 INSERT 造出崩溃瞬间现场（CLAIMED 等中间态）再重放。这是**真实证据**而非桩。
- 架构边界：`scripts/architecture-boundaries.mjs` 被 `tests/architecture/import-boundaries.test.ts` 直接 import 执行，本次实跑通过。
- 持久化幂等与权威性：DB 层 UNIQUE / 部分唯一索引 / CHECK / 触发器多重兜底，覆盖率高。
- 迁移失败降级只读而非崩溃。

**有防护但未验证**（代码里有机制，无运行时证据）

- outbox 指数退避（`min(60, 2**attempt)` 分钟）与 30s claim 租约的实际收敛行为。
- `ConnectionBreaker` 到期自动闭合、`InvocationCapacityGate` FIFO 排队在真实限流下的表现。
- `#scanOrphans`（30s）在真实崩溃后回收 `#inFlight` 槽位的时序。
- A2A 传输层超时层级（`sendStream` 5 分钟 / `getTask` 30s / 单请求兜底 30s）是否一致自洽。
- SSRF 与 DNS rebinding 门（`outbound-network-policy.ts` 用 `lookup(all:true)` 校验全部地址）——机制看起来完备，未做渗透验证。

**有确证缺陷**

- native agent run 无死线（§4.3.1）。
- 工作区租约 10 分钟无续租（§4.3.2）。
- 依赖 DAG 不被强制（§5.1）。
- 计划期租约冲突被静默吞掉：`work-orchestration-service.ts:140` `if (!result.allowed) continue;`，只有 `workbench_workspace_not_ready` 会抛 `DomainError`；`workspace_lease_conflict` 与 `a2a_workspace_access_*` 走静默 continue。Work 落库但永不派发，joi 收不到任何信号。（1 份对抗判决确认）
- 根 tick 错误处理丢弃 error 对象（`index.ts:314`）。

### 6.3 测试实证强度的结构性问题

覆盖率数字（94.8% / 90.07%）**高估了实际保护强度**，三个原因：

1. **死代码计入覆盖**。旧 Wake 子系统 7 个服务被测试覆盖但不在生产运行，贡献覆盖率却不保护任何在跑的代码。
2. **组合层用文本断言代替行为验证**。`tests/contract/actor-runtime-authority.test.ts` 的做法是 `readFile('src/main/index.ts')` 然后 `toContain('new ActorTree(')` / `toContain('actorTree.tick(')`。这只能防止有人删掉那行字，不能验证装配正确——**而本次评估发现的「整条 Wake 链未装配」正是这类断言无法捕获的问题**。
3. **E2E 只有 1 个用例**。`tests/e2e/electron-smoke.spec.ts`（workers 1, fullyParallel false, timeout 30s）是唯一的 Playwright 用例。
4. **branches 覆盖率仅高出阈值 0.07pp**，任何新增未覆盖分支都会让门禁失败——这是脆弱点，不是安全边际。

---

## 7. 鲁棒性评估（五类扰动）

| 扰动 | 判断 | 依据与缺口 |
|---|---|---|
| **进程崩溃 / 重启** | **较好，但收敛靠扫描** | DB 侧状态与幂等键完整，有真实崩溃重放测试。缺口：`#inFlight`、`InvocationCapacityGate` 是内存态，重启归零；收敛依赖 `#scanOrphans`(30s) 与 claim 租约过期而非持久「正在跑」标记；重启瞬间可能突发超设计并发 |
| **断网 / 远端不可达** | **中** | 有熔断（按 origin+connectionId+credentialVersion）、容量门、传输层多级超时、outbox 指数退避。缺口（未复核）：`recover()` 的 `taskId` 分支据称绕过熔断与容量门，持续限流的远端可能永不熔断 |
| **模型 4xx/5xx 报错** | **中偏弱** | 有 `PartnerRunFailure` 结构化分类 + `sideEffectState` 判定可重试性；模型源健康态 READY→DEGRADED→NEEDS_AUTH→DISABLED 有落库。缺口（未复核）：一次 429/503 就把协作者 Work 打成不可自动重放的终态 UNKNOWN（`agent-dispatch-component.ts:31`） |
| **Agent 卡死** | **弱（确证）** | native run 无死线、`abort()` 不可达、上层无看门狗。挂死永久占死 `(workbench, partner)` 槽位。10 分钟后租约还会被清扫，使第二个 agent 可能进入同一工作区。**这是五类扰动中最薄弱的一环** |
| **资源耗尽** | **中偏弱** | 有 RESIDENT 上限 12、附件字节上限、`maxEvents/maxBytes`、有界自愈上限 2 轮。缺口（未复核）：协作者与恢复路径产物不受 500 MiB 配额约束（`a2a-gateway-service.ts:253`），磁盘可无界增长；`connection_breakers` 行永不清理；每流式 token 触发一次「全量删除+重插」会话快照写入，主进程同步 SQLite 上 O(N²) 放大（`partner-dispatch-delivery-adapter.ts:314`） |

**可观测性横切缺口**（影响全部五类的定位能力）：

- 根 tick 失败只写一行常量文本，丢弃 error（`index.ts:314`）。
- 错误码归一化把大量 `new Error` 压成 `"Error"`（`ports/runtime-diagnostics.ts:436`，未复核）。
- A2A 通道据称零诊断埋点，`openBreakers` 指标因行永不清理而恒偏高（未复核）。
- `JoiRhythmComponent` 6 个调度器的异常全被 try/catch 吞掉，只发一个 `joi.rhythm.tick_failed`，无法区分是哪个调度器失败。

诊断本身的设计是好的：`emitRuntimeDiagnostic` 全包 try/catch（诊断永不改控制流），写盘前 `safeDiagnosticValue` 递归过滤 `body/content/cookie/path/persona/prompt/text/token` 等键并替换绝对路径。问题是**埋点密度不足**，而非诊断机制不安全。

---

## 8. 风险清单

严重度：P0=critical / P1=high / P2=medium。**证据列是本表最重要的一列**——「未复核」条目可能有误。

### 已确证

| # | 级别 | 子系统 | 问题 | 位置 | 失败场景 | 证据 |
|---|---|---|---|---|---|---|
| R1 | **P0** | 编排 | 声明的 Work 依赖 DAG 完全不门控派发；`waves` 只进快照与诊断，`work_dependencies` 无任何读取方 | `work-orchestration-service.ts:148` | 声明 B 依赖 A 后两者同时进 outbox 并行执行；B 在 A 产物不存在时产出结论，且该结论被正常发布 | 3 份对抗判决，high |
| R2 | **P0** | 编排 | 计划期 `workspace_lease_conflict` 被静默 `continue` 吞掉，Work 落库但永不派发 | `work-orchestration-service.ts:140` | 两个 Work 争同一工作区，落败者永久卡在 PLANNED，joi 收不到信号，目标永久停滞 | 1 份对抗判决，high |
| R3 | **P0→P2** | Wake | `WakeRecoveryService` 生产零引用 | `wake-recovery-service.ts` | **原判「卡死 Wake 永久锁死 Life」不成立**——整条 Wake 链均未装配，无活 Wake 可卡。真实代价为死代码 + 覆盖率幻觉 | 人工核实（`new` 命中数 0） |
| R4 | **P0→P2** | Wake | envelope 解析在 executor 内部完成，绕过 `WakeRunner` 的 repair/failWake | `wake-runner.ts:103` | 同 R3，降级为死代码内缺陷 | 人工核实（同上） |
| R5 | **P0** | 多 Agent | 工作区租约 10 分钟固定 TTL、**无续租方法**，且任何 `acquire()` 先执行 `DELETE ... WHERE expires_at <= ?` 清扫 | `sqlite-workspace-lease-manager.ts:32,35` | agent 运行超 10 分钟（常态）→ 租约被他人 acquire 顺手删除 → 第二个 agent 取得同一工作区 WRITE 租约 → 两 agent 并发写同一工作区 | 人工通读全文件（仅 `acquire`/`release`，无 renew） |
| R6 | **P0** | 多 Agent | native 引擎正式 run 无死线；`AbortController` 建了传了但全文件唯一 `abort()` 在 45s 探针路径 | `claude-agent-sdk-partner-engine-runtime.ts:106` vs `:59` | agent 挂死 → 无 timeout、无可达取消、上层无看门狗 → 永久占死 `(workbench, partner)` 槽位，用户无感知 | 人工核实 `controller.abort()` 全部调用点 |
| R7 | P2 | 驱动 | 根 tick 的 `.catch` 丢弃 error 对象，只写常量文本，不发诊断 | `index.ts:314` | 整条 tick 链任何未捕获失败对外只有一行无信息量文字 | 人工阅读 |

### 已驳回

| # | 原判 | 位置 | 驳回理由 |
|---|---|---|---|
| D1 | ~~目标结果合成的 revision 校验是自指的，会发布陈旧结论并吞掉新证据~~ | `sqlite-joi-inbox-repository.ts:642` | **不成立**。`:643-652` 比较的是「合成输入捕获的 `result_revision`」与「结果集当前 `revision`」，这是正当的乐观并发校验。不一致时退回 PENDING 重跑；且紧随其后还有 activeWork 守卫（恢复期间只置 CONSUMED、不发布、不抬水位）。此处防护实际是**健全的** |

### 未复核（agent 提出，可能有误）

按主题归并，共 25 条。**引用前请先自行核实**。

| 主题 | 条目 | 位置 |
|---|---|---|
| 验证可绕过 | 验收为空即 `NOT_REQUIRED` / `intent_json` 解析失败静默降级 / 验收项由模型自愿声明 / `work_result_verifications` 只写无消费 | `partner-dispatch-delivery-adapter.ts:524`、`sqlite-work-result-repository.ts:55` |
| 无死线（上层） | 搭档运行无超时无看门狗，挂死堵死槽位与整个目标 | `agent-dispatch-component.ts:72` |
| 重复派发 / 幂等 | 同一 invocation 被 OutboxDispatcher 与 agent actor 双驱动 / `failTurn` 无视 `side_effect_started` 就回置 PENDING / Turn 崩溃后无「活跃 Work」守卫回 PENDING 而 `plan()` 不幂等 | `wire-runtime.ts:203`、`sqlite-joi-inbox-repository.ts:735,738` |
| 恢复路径绕闸门 | `finalizeOrphan` 绕过 prepare 全部闸门（不查取消、不过策略、不申租约）/ `recover()` 不返回远端输出却写终态 / `recover()` 的 taskId 分支绕过熔断与容量门 | `partner-dispatch-delivery-adapter.ts:399,351`、`a2a-gateway-service.ts:130` |
| 失败即终态 | 一次 429/503 就把协作者 Work 打成不可自动重放的 UNKNOWN | `agent-dispatch-component.ts:31` |
| 资源无界 | 协作者与恢复路径产物不受 500 MiB 配额约束 / 每 token 一次全量删除+重插的 O(N²) 快照写入 / EPHEMERAL 占用 RESIDENT 全局 12 额度 | `a2a-gateway-service.ts:253`、`partner-dispatch-delivery-adapter.ts:314`、`partner-instance-manager.ts:61` |
| 租约泄漏 | `prepare()` 取得租约之后的抛错路径不释放租约，且失败重试无终态出口 | `partner-dispatch-delivery-adapter.ts:271` |
| 时序阈值不一致 | 孤儿 Turn 扫描阈值 10 分钟 < 同组件卡死中止阈值 15 分钟，会把仍在运行的 Turn 判死 | `joi-task-component.ts:130` |
| 状态位不清除 | `dispatchFailureReason` 一旦置位不清除，会把已成功派发的 Turn 整体打成失败并重跑 / `delivery.complete` 抛错不清 `#inFlight`，槽位死锁且每 tick 无退避重试 | `joi-coordinator.ts:410`、`agent-dispatch-component.ts:86` |
| 吞错 | `startTurn` 的 `finally` 里 `await` 会话保存，保存失败吞掉真实错误并把「已产生副作用的成功」报成失败 | `pi-reasoning-runtime.ts:213` |
| 可观测性 | 错误码归一化把大量 `new Error` 压成 `"Error"` / A2A 通道零诊断埋点且 `openBreakers` 恒偏高 | `ports/runtime-diagnostics.ts:436`、`runtime-database.ts:2643` |

---

## 9. 盲区与后续验证动作

### 9.1 本次评估的盲区

1. **actor 树子系统未独立测绘**（7 个中缺 1）。组件级细节（每个 component 的短路条件、tick 内预算、背压位置）覆盖密度低于其他子系统。
2. **25 条风险未经独立验证**。原计划每条 3 视角对抗验证，实际只完成 4 份判决。
3. **零并发/时序类运行时验证**。所有竞态、租约失效、崩溃收敛的判断都是静态推断。项目本身也缺少假时钟竞态注入类测试。
4. **renderer 与 relay 侧未纳入状态链评估**。`src/renderer`、`src/relay`、`native/joi-remote`、`apps/joi_mobile` 是否参与状态迁移未核实。
5. **覆盖率数据非本次生成**（`coverage/` 时间戳早于本次改动），只能当参考。

### 9.2 建议的验证动作（按性价比排序）

| # | 动作 | 目的 | 成本 |
|---|---|---|---|
| 1 | 写一个集成测试：声明 `B depends on A` 后断言 A 终态前 B 不得进 outbox | 把 R1 从「已确证的缺陷」变成「有回归防护的缺陷」 | 低 |
| 2 | 用注入时钟把工作区租约 TTL 设为 100ms，跑两个并发 Work 争同一 workspace，断言不出现两个 WRITE 租约 | 复现 R5 | 低 |
| 3 | `grep` 出所有生产零引用的 application 服务，决定删除或标注 `@deprecated` | 消除 R3/R4 类认知污染，并让覆盖率反映真实保护 | 低 |
| 4 | 把 `actor-runtime-authority.test.ts` 的文本断言换成行为断言（真实装配后断言 actor 类型与组件顺序） | 让「整条链未装配」这类问题能被测试捕获 | 中 |
| 5 | 给 native 引擎正式 run 加死线 + 让上层看门狗可 abort | 修 R6，五类扰动中最弱的一环 | 中 |
| 6 | 把 `work-orchestration-service.ts:140` 的静默 continue 改为落一条可观测事实（诊断 + joi 可见信号） | 修 R2 | 低 |
| 7 | 消除测试对 schema 版本的硬编码（改为读 `migrations` 目录最大编号） | 去掉「每加迁移必手改多处测试」的耦合，也顺带消掉 9 个当前失败 | 低 |
| 8 | 隔离复跑 2 个 flake 并定位（`pi-coding-tool-factory` 疑似 5000ms 阈值，`sqlite-joi-inbox-clarify` 疑似顺序依赖） | 恢复测试信号可信度 | 低 |
| 9 | 对 25 条未复核风险逐条对抗验证（可复用本次 workflow，**降低并发额度**） | 补齐证据 | 中高 |
| 10 | 给 A2A 通道补诊断埋点，并清理 `connection_breakers` 过期行 | 让限流/熔断故障可定位 | 中 |

---

## 10. 总体判断

**架构选择是清醒的，持久化层是扎实的，编排层的确定性没跟上，可观测性是最大的系统性短板。**

「单时钟 + 单根串行 tick + SQLite 作唯一协调介质」这个决定，用吞吐换掉了绝大部分并发正确性问题——在个人计算机上跑持久化数字生命，这个取舍是对的。「模型只有建议权、执行权在确定性代码」同样是对的，它把幻觉挡在副作用之外。DB 层的 UNIQUE / 部分唯一索引 / CHECK / 触发器多重兜底，配合真实迁移 + 真实 SQLite 的集成测试，构成了本项目最可信的部分。

问题集中在两处。一是**算出来的约束没有被执行**：依赖 DAG 算好了不用、验收项声明了不强制、验证结果写了不读。这类缺陷比单纯的 bug 更危险，因为它们让系统**看起来**有把关。二是**没有死线文化**：agent run 无 timeout、租约不续期、卡死无看门狗——而 agent 编排恰恰是最需要死线的场景。

至于「多 agent 框架的结论生产效果」：收集与裁决环节可信（去重、权威性、revision 门禁、恢复期不发布过期结论都做对了），分解与验证环节不可信（R1 + §5.2）。也就是说，**joi 能可靠地把 agent 产出汇总成一个结论，但不能可靠地保证那个结论所依赖的前置工作真的按序完成过、真的通过了验收**。

最后需要重申：本文 25 条风险未经独立验证，且全部并发与恢复类判断没有运行时证据。§9.2 的第 1、2、9 项是把这份评估从「静态推断」推进到「实证」的关键。

---

## 11. 修复状态（2026-09-04，分支 `joi/runtime-hardening`）

本节记录针对本评估的修复落地情况。除注明外，均通过 `typecheck` / `lint` / `test`（1098 用例）/ `check:boundaries` 门禁。

### 11.1 已确证风险（§8）

| 风险 | 处置 | 落地阶段 |
|---|---|---|
| R1 依赖 DAG 不门控派发 | **已修复**：认领门控（`listClaimable` 增加「前置全部 COMPLETED」NOT EXISTS）+ 失败级联（递归 CTE 把下游 Work 级联 CANCELED，覆盖权威结果置 FAILED、work_cancel、input 取消、commit 时前置已终态四个触发点）；新增迁移 052（依赖反查索引 + `work_items.cancel_reason`）与 `joi.work.dependency_cascade` 诊断。 | P4 |
| R2 策略拒绝静默吞掉 | **已修复**：被拒 Work 也创建 attempt+outbox，交交付侧复检——`workspace_lease_conflict` 经 outbox 指数退避重试、`a2a_workspace_access_forbidden` 落终态 FAILED；重试 6 次后 `abandon` 落可见终态；`joi.work.plan_policy_denied` 诊断、`work_dispatch` 返回 `denied`。 | P3 |
| R3/R4 旧 Wake 子系统死代码 | **已删除**：移除 `application/wakes/`、`domain/wakes/`、`a2a-wake-agent-executor.ts` 及其测试；`wakes` 等表因被 `memory_revisions`/`delegations` 外键引用而保留。 | P1 |
| R5 工作区租约无续租 | **已修复**：`SqliteWorkspaceLeaseManager.renew()`；`AgentDispatchComponent` 每 tick 心跳续租（剩余 <60s 时续回 5 分钟），租约丢失则中止 run 并落非重放 UNKNOWN；`prepare` 取租约后的抛错路径补释放；TTL 10→5 分钟。 | P2-A |
| R6 native run 无死线 | **已修复**：`RunDeadlineGuard`（总死线 30 分钟 + 空闲死线 20 分钟，逐事件刷新）接入 claude-code/codex 引擎；组件看门狗 32 分钟兜底并可经 AbortSignal 真杀；`partner_run_timed_out`/`partner_run_idle_timed_out` 首次落地；孤儿判死阈值 10→20 分钟，消除与 15 分钟卡死中止的倒挂。 | P2-B |
| R7 根 tick 丢弃 error | **已修复**：根定时器 catch 保留错误对象，发 `joi.runtime.tick_failed`（稳定码）并仍写 stderr。 | P6 |

### 11.2 验证环节弱点（§5.2）

**已修复**（P5）：`work_dispatch` schema 与 `plan()` 权威双层强制每个 Work 至少一个验收项（`work_acceptance_checks_required`）；`intent_json` 损坏不再静默降级为「无验收」，改为收敛终态 `work_brief_invalid`；合成输入 join `work_result_verifications` 并按 `verification=PASSED/FAILED/NOT_REQUIRED` 区分已验证证据与未验证自述，`work_read_result` 首块返回验收结论。

### 11.3 可观测性缺口（§7）

**已修复**（P6）：错误码归一化优先携带 partner-run reasonCode（仍不引入 message 文本）；`connection_breakers` 过期行惰性清理、`openBreakers` 只计未过期行；A2A 通道埋点（`invocation_started/settled`、`breaker_opened`、`recover_failed`、`recover_not_ready`）且 `recover()` 不再穿透断路器冷却窗口；`JoiRhythmComponent` 记录逐调度器连续失败计数；RESIDENT 实例上限只计 RESIDENT 行。

### 11.4 其余未复核风险（§8 未复核簇）对抗验证

对 11 个剩余风险簇各派 1 个对抗验证 agent（默认立场「不是真问题」，从代码核实/可达性/影响度三角度核查），结果：**7 条确证、3 条驳回、1 条存疑**（P7 修复确证项）。

| 风险 | 判定 | 处置 |
|---|---|---|
| failTurn 无视 `side_effect_started` 回置 PENDING | 确证 | **已修复**：有副作用或存活 Work 时不回 PENDING，改置 CONSUMED 经存活 Work/结果合成收敛，杜绝中途失败/崩溃恢复后的重复派发。 |
| Turn 崩溃后无「活跃 Work」守卫、`plan()` 不幂等 | 确证 | **已修复**：同上（共用 `failTurn` 守卫）。 |
| `finalizeOrphan` 绕过闸门 | 确证 | **已修复**：对已取消 Work 不恢复、不写结果，直接收敛终态。 |
| `recover()` 丢弃远端输出 | 确证 | **已修复**：`recover()` 返回 `{invocation, output}`，适配器消费，已完成远端工作不再塌成空结果。 |
| 协作者/恢复路径产物绕过配额 | 确证 | **已修复（部分）**：A2A 派发与交互应答两处调用点补 `artifactScope` 纳入配额；重启后经 `recover()` 的产物作用域持久化仍为遗留项。 |
| 每流式块 O(N²) 全量重写会话快照 | 确证 | **已修复**：实时快照节流（≤1/500ms，展示性数据；权威会话由完成时一次性重写）。 |
| `startTurn` finally 保存失败吞掉真实错误 | 确证 | **已修复**：保存失败降级为非致命，原始 prompt 错误始终原样重抛。 |
| 同一 invocation 被双驱动 | **驳回** | outbox 按 kind 分区（`excludeKinds:["partner.dispatch"]`），两消费者互斥。 |
| 一次 429/503 落不可重放 UNKNOWN | **驳回** | 无副作用时落可重试 FAILED；有副作用不自动重放是设计契约；有断路器/恢复链兜底。 |
| `delivery.complete` 抛错卡死槽位 | **驳回** | P2-B 已有有界重试 + 强制清槽 + 孤儿回收兜底。 |
| `dispatchFailureReason` 置位不清除 | 存疑 | **已加固**：成功的 `work_dispatch` 清除早前失败原因；主要触发路径本已有守卫。 |

### 11.5 测试卫生（§6.3 / §9.2）

**已修复**（P0）：`-- joi:migration foreign-keys-off` 标记、schema 版本改用 `latestMigrationVersion()`（消除逐迁移改测试）、两处 flake（子进程超时、`SqliteJoiInboxRepository` 注入时钟）、契约测试补行为断言。
