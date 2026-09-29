# SQLite migrations

Migration 060 增加本地 Token 数值账本：调用身份、各模型累计快照、采集起点与持久缺失提示。按调用内稳定标识替换快照，不扫描历史私有会话，不触发模型请求。

M1 起所有迁移使用单调版本号并在 Runtime 调度前执行。本目录只存生产 migration，不存真实数据库、凭据或测试 userData。

Migration 042 起，普通直接回答写入独立 `joi_turn_completions` 展示投影；Goal synthesis 继续使用带 revision 的 `joi_goal_outcomes`。

Migration 044 起，搭档提问和历史 WAITING 恢复使用 `joi_user_action_requests` 持久关联具体 Work/Run；首页不得再从 `waiting_count` 猜测“需要你”。

Migration 045 起，多个工作台可以绑定同一物理工作目录；工作台上下文仍隔离，文件执行冲突由同目录跨 workspace ref 的 READ/WRITE lease 协调。

Migration 046 起，场景预设包以 `(pack_id, role_id)` 持久绑定全局搭档；重复或部分失败安装复用稳定绑定，用户修改和停用状态不被预设静默覆盖。

Migration 047 起，搭档 revision 可在 `engine_config_json` 保存引擎专属非敏感配置；首个消费者是 Codex 的 sandbox、network、web search 与固定 never approval 权限。旧 NULL 行由 repository 按历史工具列表确定性映射。

Migration 048 修复旧开发库已占用 migration 047 但缺少 `engine_config_json` 的版本冲突；已有该列的数据库只记录修复版本，不重复执行 `ALTER TABLE`。

Migration 049 建立全局 Routine 配置与紧凑运行事实，并为普通 Joi inbox 增加可空 `automation_routine_id`；调度 claim、运行记录和 inbox 输入在同一事务中提交，提示词正文不进入投影。

Migration 050 持久化每个失败 Work 最多两轮的恢复尝试及其权威结果证据引用；补充 Work、dispatch outbox、恢复身份和证据引用在同一事务中提交。

Migration 051 区分可自动补证的 `CONTINUE` 与硬阻断，并为每个目标地图持久化默认两轮续跑额度；额度耗尽后以目标级用户动作提供“继续补齐/接受现状”，接受时保留 `ACCEPTED_WITH_GAPS` 终态。

Migration 052 让声明的 Work 依赖在派发时真正生效：依赖反查索引支撑认领门控（前置未全部完成不可认领），`work_items.cancel_reason` 记录依赖失败/取消触发的确定性级联取消原因。
Migration 054 持久记录每个 Work 的执行目录及准备状态；默认目录使用日期时间与 UUID，绑定目录记录实际目标，恢复、重试和产物解析复用同一记录。绝对路径仅限基础设施内部使用。

Migration 055 为目标保存可空 last_opened_at，仅用户的显式动作（继续/重试、补充回复与回答、续跑决策）更新；首页排序回退 created_at，不再随进度和结果更新时间跳动。

Migration 059 增加 evolution_states、evolution_goal_pins、evolution_evidence。存量已绑定工作台的原始目标固定基线且不采样；新目标保留策略与模型源版本。后台调用使用既有 outbox 的 evolution.model 类型，只含稳定标识，不保存模型正文，且不进入通用出站调度器。预算默认低档预设（每日 50 次调用），迁移不触发历史任务重放。

Migration 063 让上下文窗口、最大输出与压缩触发阈值成为按 model revision 可配置的三个可空列；NULL 即未配置，存量行自动退回厂商 preset 与 provider 实测值，无需回填。表仍是 append-only：一个值要在编辑后活下来，唯一的原因是服务层把它带进了新 revision，仓储从不做 UPDATE 合并。三列的上界刻意排除"压缩阈值 = 100"，那等价于撞满整窗才压缩，而那一刻 provider 已经把 `max_tokens` 夹向 1。

Migration 064 为 partner_runs 增加可空 heartbeat_at：updated_at 的语义是"状态变更时刻"（已被工作台 agent 流当作"最后活动"展示），一个执行一小时却不发生状态迁移的 run 在那里看着像早已停摆，正是活着的搭档与死掉的搭档无法区分的由来。派发 actor 在 run 在途时每 tick 续写这一列，心跳过期即意味着持有该 run 的进程已经不在，这是运行期唯一能把"还在干活"和"已经死了"分开的证据。存量行为 NULL，且 NULL 必须保持旧语义——读取方对 NULL 回退旧规则而非视为过期，否则升级后第一次启动会把所有历史 run 一次性判死。

Migration 065 为目标输入增加可空 reopened_at，仅显式重试已消费目标时更新。它是旧综合结果是否属于当前执行轮次的水位；last_opened_at 仍只负责首页排序，回答澄清或授权续跑不能让有效旧结果失效。存量 NULL 保持原有结果有效。

Migration 066 为 10 秒 harness/evolution 安全扫描补齐按目标、Work、Turn 和权威结果读取的窄索引。它不改变恢复与回滚节拍；代价是相关状态写入增加有限索引维护和数据库体积，换取历史数据增长后不再反复全表扫描。

Migration 062 增加 `workbench_agent_tool_traces`（工具轨迹私密正文）与 `workbench_agent_conversation_entries.tool_call_id`。主时间线只保留一行 ≤200 字符的脱敏调用摘要；完整命令与输出按 `(run_id, tool_call_id)` 每条追加一次，凭据写入前脱敏、绝对路径保留（本机调试必需）、单条 ≤8 KB 超出截断并标记，只经桌面写权限路由按需读取，不进首页、诊断、SSE 或远端。只登记迁移后的新 run，不回填历史：存量 TOOL_CALL 行既无 `tool_call_id` 也无正文来源。

Migration 061 修复进化证据无法收敛的三处遗留状态，不新增表。为 evolution_evidence 增加 classified_at 承载幂等判定，使证据分类可随目标收敛单调升级，而 observed_at 仍是裁决窗口时间戳、只在真正升级时前移；关闭已撤销（取消 / 忽略）目标上永久停留在 ACTIVE 的清图，撤销时刻取自目标行本身，迁移不依赖时钟；按 059 的实际落库时间精确放行当时仍在途、结局发生在迁移之后的目标，已终结的历史目标继续遵循 059 的"固定基线且不采样"。触发口径改为跨工作台共享证据池见 ADR 0020 的 2026-09-24 修订。
