# ADR 0010: joi harness：持久化目标地图与 tick 驱动复盘推进

- 状态：Accepted
- 日期：2026-08-06
- 关联：ADR 0002（唯一 joi 与唯一调度权威）、ADR 0005（wayfinder 编排方法论；本 ADR 推翻其「不加新存储」不做项）、ADR 0006（工作台私有实例与结果闭环，顺序不动）、ADR 0009（actor/component/tick 词汇与遍历规则）

## 背景

ADR 0005 把 wayfinder 方法论落为提示词纪律：destination-first、分层路径、fog of war、out-of-scope 全靠模型在单个 turn 的上下文里记住。这带来三个结构性缺口：

1. **goal 只有一层执行**：结果合成 input 的工具面收窄为 `turn_complete + work_read_result`，合成 turn 无法派发第二层工作——一层结果出来后，没有人负责「找下一层路径」。
2. **地图不落库**：destination、路径、决策、雾区没有持久化，跨 turn/跨重启即丢失；UI 无法展示目标推进。
3. **完成事实不回灌**：`workbenches.task_summary` 无运行时写点，goal 完成后工作台的上下文不增长。

## 决策

1. **四张轻量事实表**（migration 037，纯 CREATE TABLE）：`joi_harness_maps`（destination/status/revision/reviewed_revision 水位）、`joi_harness_paths`（每层路径，只引用 `work_id`，不重复建模执行）、`joi_harness_decisions`（Decisions-so-far，决策记一处）、`joi_harness_fog`（雾区，可晋升为 path）。map 是索引不是存储；执行事实的权威仍是 `work_items`/`dispatch_attempts`。升级 backfill 将存量 CONSUMED/canceled goal 直接落为 CLEARED 地图（反哺水位同置），历史 goal 不触发追溯复盘。
2. **推进引擎 = 遍历 + 系统输入**：`JoiHarnessComponent` 挂在 joi actor 上（10s 节流），只做有界 SQLite 读写：adopt（有 turn 无 map 的 goal 建图）、feedback（CLEARED → `task_summary` 追加，尾部 2000 字符）、trivial GC（空地图静默 CLEAR）、review（结果层走完 → 投 `joi_harness_review:goal:<g>:r<rev>` PENDING 行）。组件绝不发起 LLM 调用或直接派发——复盘决策全部由 joi 推理 turn 经单槽位串行做出，唯一调度权威不变。
3. **复盘闭环**：review input 带 `goal_input_id`、不带 `result_revision` → 走主会话、普通 CONSUME 分支，ADR 0006 结果事务顺序不动。推理面新增 5 个 goal 语境寻址的工具：`harness_name_destination / harness_chart_path / harness_record_decision / harness_note_fog / harness_refine_workbench`（均不入 COMMITTED_OUTCOME_TOOL_NAMES，簿记性质）。`turn_complete` 增加第四结局 `MAP_CLEARED`，仅允许 review turn 在 goal 语境下调用（工具 execute 内持久化 clearMap）。review turn 派发的工作经 **goal-binding 覆写**绑回原 goal（`work.plan.inputId = goalInputId`），结果集与合成闭环不断。
4. **工作台双通道反哺**：记录通道为确定性遍历写入（CLEARED ∧ 未反哺 → `task_summary` 追加「达成」行，经 `Task context:` 进入后续每个 turn）；参数通道为复盘 turn 工具 `harness_refine_workbench`（走既有 `WorkbenchManagementService.update` 的 COALESCE patch；禁 name/projectLabel；只收窄不扩宽；reason 必填；审计行 = decisions kind=WORKBENCH_REFINE）。
5. **幂等水位**：复盘投递 = 三重门槛（rs.revision 前进 ∧ 合成完成 ∧ 无活跃 work）+ 投递与抬 `reviewed_revision` 同事务 + input_id 内嵌 revision 的 INSERT OR IGNORE——每 (goal, revision) 至多一条 review；CLEARED 单跃迁 + `feedback_recorded_at` 水位使反哺恰好一次且崩溃可重试。
6. **UI**：home-feed goal 卡扩 `harness?` 有界投影（destination/topPaths/计数/雾区），不加新端点；GoalDetail 渲染路径推进区块；goal 查询排除 review 前缀防冒充。

## 后果

- 多层推进解锁：每层结果合成完成后，复盘 turn 可派发下一层（goal-binding 保证闭环），或判定 destination 达成而 MAP_CLEARED。
- 复盘占用串行槽位，但受水位节流（每层一次而非每 tick）与 LIMIT 有界扫描约束；复盘失败经 failTurn 回 PENDING 重跑同一行（AC-39 等价）。
- ADR 0005「不加新存储」不做项被显式推翻，范围限定 harness 四表；wayfinder 的 ticket/blocking/claim 图不引入。
- 诊断事件新增 `joi.harness.*`（只观测）；`JOI_REASONING_TOOL_NAMES` 24→29。
- 回滚：三阶段独立——组件摘除（037 表保留无害）/ 推理面恢复（review 退化不破裂）/ UI 删除渲染块。
