# ADR 0002: 唯一 joi、Pi、Avatar 与搭档编排

- 状态：accepted
- 日期：2026-07-28

## Context

旧设计让每个 Life 绑定远端主 Agent，并由 Wake 链驱动。它要求用户先管理多个生命和 Agent，且把推理控制权分散在多个远端主体。目标体验要求用户只从首页输入，由系统理解上下文并安排工作。

## Decision

产品只有一个唯一全局 joi identity、system policy 与 scheduler。joi 以 Pi 为唯一主推理基座；routing 只读取 Avatar 摘要，execution 只装配选定 Avatar 的正文。Avatar 只保存人格、工程引用、记忆命名空间和任务上下文，不是 Agent 或 runtime。

旧主 Agent 降级为对应 Avatar 的首选搭档。本机 Pi 与远端 A2A 通过版本化 Partner Registry 统一派发。joi 只拥有结构化的 Avatar/Partner/Work/Memory/Schedule/User 工具，不注册任意 shell、文件读写或编辑工具。所有副作用经过 outbox 和稳定幂等标识。

首版不安装或自动发现第三方 Pi Packages，不引入第二套模型运行时，也不按任务自由切换模型。

## Consequences

- 单一身份不等于单一无限 transcript；Avatar-scoped thread 提供正文隔离。
- 模型可以提出规划，但权限、容量、预算、breaker、workspace lease 与引用合法性由确定性策略决定。
- 迁移期允许无副作用 shadow 比对，任何时刻只能有一个调度权威产生正式表达或外部副作用。
