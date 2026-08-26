# SQLite migrations

M1 起所有迁移使用单调版本号并在 Runtime 调度前执行。本目录只存生产 migration，不存真实数据库、凭据或测试 userData。

Migration 042 起，普通直接回答写入独立 `joi_turn_completions` 展示投影；Goal synthesis 继续使用带 revision 的 `joi_goal_outcomes`。

Migration 044 起，搭档提问和历史 WAITING 恢复使用 `joi_user_action_requests` 持久关联具体 Work/Run；首页不得再从 `waiting_count` 猜测“需要你”。

Migration 045 起，多个工作台可以绑定同一物理工作目录；工作台上下文仍隔离，文件执行冲突由同目录跨 workspace ref 的 READ/WRITE lease 协调。
