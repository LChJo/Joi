# ADR 0003: Avatar 与旧 Life 的非破坏迁移

- 状态：accepted
- 日期：2026-07-28

## Context

现有 SQLite、HTTP、事件和测试广泛使用 Life/lifeId。直接重命名物理表会扩大迁移和外键风险，但继续把 Life 当作 Agent/runtime 会与唯一 joi 冲突。

## Decision

新领域、应用、shared DTO、可写 API、事件与工具统一使用 Avatar。`LegacyLifeStoreAdapter` 作为反腐层，把旧 `lives`、`life_id` 和关联事实一对一映射为 Avatar 端口，保留原 id 与全部历史关系。

旧 `/api/v1/lives` 至少一个发布周期只读兼容；新创建和更新只允许 Avatar API。旧 `main_agent_connection_id` 回填为 `avatar_partner_policies.preferred_partner_id`，不再表达推理控制权。迁移只加不删、事务化、可重复，并覆盖空库、旧库、backfill 和失败回滚。

## Consequences

- 旧表、migration、legacy HTTP mapper 和历史 fixture 可继续出现 Life 词汇；其他新生产代码由架构扫描禁止新增 Life/lifeId/life.*。
- 兼容窗口结束后的物理重命名和旧 API 移除另立 removal task，不混入 JOI-01 首轮切换。
