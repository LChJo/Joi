# ADR 0010: joi harness：持久化目标地图与 tick 驱动复盘推进

- 状态：Accepted
- 日期：2026-08-06

2026-09-22 更新：ADR 0020 取代下文参数通道的自主 `harness_refine_workbench` 工具入口。完成摘要反哺和地图复盘保留；人格/职责由用户编辑，运行策略改进转入独立评测、版本与回退闭环。历史 WORKBENCH_REFINE 决策继续保留。
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
7. **执行路径机械同步（2026-08-26 增补）**：harness component 在 adopt 后按稳定 workId 为 goal-bound Work 幂等建立 path，按此前 review input 数计算层级，并以 Work 权威终态关闭 path。模型不再负责为已派发 Work 重复建 path；`harness_chart_path` 保留给不绑定 Work 的显式探索路径。
8. **终态与评审投影（2026-08-26 增补）**：result outcome 是当前证据层总结，不等于 goal terminal。map ACTIVE 时 home-feed 投影 `REVIEWING`，复盘后存在活跃 Work 时投影 `EXTENDING`；只有 `MAP_CLEARED` 或后台安全收口事务重验 review turn、最新综合水位、Work-path 覆盖和无开放路径后，当前 outcome 才作为最终结果开放完成操作。2026-09-20 补充：成功结束的评审若先于 Work-path 同步，不得因没有 FAILED turn 而永远被恢复扫描遗漏。后台仅在当前综合明确为 COMPLETED、全部 Work 终态、路径齐全且关闭、无活跃评审、目标执行门禁未关闭时自动清图；写事务再次核验，重复 tick 不改写完成时间、不重跑评审或 Work。CONTINUE/BLOCKED、待回答和回答后尚未恢复执行的目标不得因此完成。
9. **结果续跑（2026-09-04 增补）**：`CONTINUE` 结果按 ADR 0017 在持久额度内自动进入下一证据层；普通 `MAP_CLEARED` 只接受 `COMPLETED` disposition，接受缺口必须走 goal/revision 绑定的用户动作。
10. **隔离后的显式恢复（2026-10-27 增补）**：无法安全重放的评审关闭执行门禁并形成版本化恢复问题；用户可在原目标重新核对或补充要求。旧无门禁与 OPEN 门禁记录在用户恢复事务中兼容，匹配恢复回合调用 `goal_resume` 后才能继续。恢复保留 Work、结果与旧回合，必要时重新综合已有证据。migration 084 只增加默认空的 `review_recovery_epoch`，由用户显式恢复事务写入，与 `reopened_at` 同步推进；旧记录保持原评审身份。恢复代次参与新评审身份，扫描、入队、重验和清图使用同一身份；同结果版本的恢复不复用旧评审，也不能重置完成事实、验收或自动续跑额度。

11. **内部复核失败（2026-10-28 增补）**：普通评审不暴露 `goal_resume`。外部动作的保守副作用标记保持独立；migration 085 的 `review_replay_safe` 仅在失败回合全部工具已结束、且只含查询、成功地图事实或可信无修改拒绝时与 FAILED 原子写入。旧回合及中断未知回合默认无证明。当前证据与门禁允许时，同一评审身份至多自动重核一次，扫描与写入都核对失败/空转次数；耗尽或不安全状态保留显式重试。双端显示复核中断和重试入口，补充为可选折叠，不能把内部恢复提示伪装成需要用户补充的具体业务问题。

12. **派发失败的恢复证明（2026-10-29 增补）**：`work_dispatch` 的 SDK `isError` 不证明未提交。应用服务在进入派发仓储提交前通知可信调用方，只有此前拒绝、且未创建用户问题的工具返回可在主机 `details` 提供 `replaySafeRejection`；模型正文不能声明该证明。提交、复用已提交计划及后置检查点异常保留副作用保护。协调器核对每次开始/结束及全部未完成调用，只在失败收尾时给出全回合无提交证明。migration 086 的可空 `failure_replay_safe` 与 FAILED 原子写入，仓储以当前回合不存在持久派发计划再验；运行中粗粒度 `side_effect_started` 高水位不回退。只有带证明的失败回合可从恢复副作用查询中排除；旧未知回合、取消、真实问题、已提交回答和活跃 Work 继续约束恢复。内部评审证明与通用无提交证明相互独立，不扩大自动重核次数，也不重放既有 Work 或 outbox。

## 后果

- 多层推进解锁：每层结果合成完成后，复盘 turn 可派发下一层（goal-binding 保证闭环），或判定 destination 达成而 MAP_CLEARED。
- 复盘占用串行槽位，但受水位节流（每层一次而非每 tick）与 LIMIT 有界扫描约束；失败由无副作用调度退避或有界评审重核接管，保留相同输入身份和稳定 outbox，不重放外部动作。
- ADR 0005「不加新存储」不做项被显式推翻，范围限定 harness 四表；wayfinder 的 ticket/blocking/claim 图不引入。
- 诊断事件新增 `joi.harness.*`（只观测）；`JOI_REASONING_TOOL_NAMES` 24→29。
- 回滚：三阶段独立——组件摘除（037 表保留无害）/ 推理面恢复（review 退化不破裂）/ UI 删除渲染块。
