# ADR 0011: Legacy Life HTTP 写面拆除与退役路线

- 状态：accepted
- 日期：2026-08-19
- 关联：ADR 0003（Workbench 与旧 Life 迁移）、ADR 0009（唯一调度权威）

## Context

ADR 0003 把旧 Life 降级为只读兼容层：`api-handler` 在 `/api/v1/lives` 前缀上用 `legacy_life_read_only` 410 守卫拦截所有非 GET 请求。但守卫之后仍保留着约 380 行不可达的写分支（创建/更新/删除 Life、runtime 动作、messages、attachments、todo/alarm/memory 变更、collaborators、budget 扩展），以及只被这些死分支消费的 `wakeCoordinator`、`lifeRuntime`、`budgets`、`attachments` 依赖通路。死分支不产生行为，却是地雷：任何守卫顺序调整都会把它们救活，形成 ADR 0009 契约测试要防的"第二调度权威"。

## Decision

1. 删除 `/api/v1/lives` 守卫之后全部不可达写分支；保留只读 GET 面（lives 列表、单条、deletion-impact、primary-agent handoffs、events、activity、continuity 族、expressions、artifact 读取）。
2. `ApiDependencies` 移除 `wakeCoordinator`、`lifeRuntime`、`budgets`、`attachments` 字段与配套 helper；composition root 不再向 HTTP 层注入这些依赖。`BudgetService`、`LifeRuntimeService` 仍由 actor 树与紧急停止链路直接使用，服务本身不删。
3. `LegacyLifeStoreAdapter` 与 `LifeService` 的应用层方法（create/update/delete/archive/changePrimaryAgent 等）暂保留：数据兼容期未结束，且 renderer 客户端仍保留只读调用能力。
4. 契约测试 `tests/contract/http-api.test.ts` 锁定：POST/PATCH 任意 `/api/v1/lives*` 写路径返回 410 `legacy_life_read_only`，GET 列表保持 200。

## Consequences

- HTTP 面与 ADR 0003 的"只读兼容"承诺首次完全一致；守卫成为唯一写屏障，不再有可被救活的死代码。
- `partner.dispatch` 之外，HTTP 层不再能触发任何旧 Wake 侧效果；唯一调度权威由契约测试与代码结构双重锁定。
- 退役路线下一步（不在本 ADR 执行）：
  1. renderer `api.ts` 中无人调用的 lives 写客户端方法与 `tests/renderer` 对应用例一并移除；
  2. 至少一个发布周期后，评估只读 GET 面是否可以收敛为 Workbench 投影；
  3. `LifeService` 写方法与旧事件类型在确认无消费方后随迁移删除（遵守"迁移只加不删、不重建表"约束）。
