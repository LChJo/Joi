# SQLite migrations

M1 起所有迁移使用单调版本号并在 Runtime 调度前执行。本目录只存生产 migration，不存真实数据库、凭据或测试 userData。

Migration 042 起，普通直接回答写入独立 `joi_turn_completions` 展示投影；Goal synthesis 继续使用带 revision 的 `joi_goal_outcomes`。

Migration 044 起，搭档提问和历史 WAITING 恢复使用 `joi_user_action_requests` 持久关联具体 Work/Run；首页不得再从 `waiting_count` 猜测“需要你”。

Migration 045 起，多个工作台可以绑定同一物理工作目录；工作台上下文仍隔离，文件执行冲突由同目录跨 workspace ref 的 READ/WRITE lease 协调。

Migration 046 起，场景预设包以 `(pack_id, role_id)` 持久绑定全局搭档；重复或部分失败安装复用稳定绑定，用户修改和停用状态不被预设静默覆盖。

Migration 047 起，搭档 revision 可在 `engine_config_json` 保存引擎专属非敏感配置；首个消费者是 Codex 的 sandbox、network、web search 与固定 never approval 权限。旧 NULL 行由 repository 按历史工具列表确定性映射。

Migration 048 修复旧开发库已占用 migration 047 但缺少 `engine_config_json` 的版本冲突；已有该列的数据库只记录修复版本，不重复执行 `ALTER TABLE`。
