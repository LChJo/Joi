# SQLite migrations

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

Migration 055 为目标保存可空 last_opened_at，仅用户继续/重试更新；首页排序回退 created_at，不再随进度和结果更新时间跳动。
