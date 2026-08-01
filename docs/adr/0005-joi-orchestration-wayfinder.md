# ADR 0005: joi 编排提示词采纳 wayfinder 方法论（场景预设与自建团队）

- 状态：accepted
- 日期：2026-08-01
- 关联：ADR 0002（唯一 joi、Pi、Avatar 与搭档编排）、ADR 0004（搭档执行引擎多元化）

## Context

搭档系统（ADR 0004 之前后）落地后，joi 已能用 `partner.create` 自建搭档（带 "joi 创建" 徽标、用户可见可删），但实测暴露三个缺口：

1. 没有搭档时，首页与搭档页只会提醒"先建 2-3 个工作搭档"，把组建团队的认知负担全甩给用户，缺少"一键起点"。
2. `partner.create` 不能选模型——工具 schema 无 model 字段、引擎硬编码 `local-pi`、模型永远跟随全局首选；而底层 `partner-registry-service.add()` 已支持 `modelSourceId/modelIdOverride/engine`，只是工具层没透传。
3. joi 的编排系统提示词（内联在 `joi-coordinator.ts`）只教了实例复用与失败重派，缺少"如何为一个目标组建一支分工明确、提示词自包含的团队"的方法论。

参照项目 `E:/Ai/skills`（Matt Pocock 的 skills 仓库）的 `wayfinder` 技能提供了可迁移的编排方法论：destination-first + 逃生舱、把工作分为 HITL/AFK 且只把 AFK 并行 fan-out、子 agent 提示词是自包含契约、以 "Agent Brief" 骨架（行为化而非流程化、耐久优于精确、完整验收标准、显式范围外）撰写 brief、结果经上下文指针汇总成一个有主见的答复。该仓库并无"场景包"概念，其等价物是"router + 命名 flow + 小而可组合的 skill"。

## Decision

**joi 的推理基座与硬边界保持不变**：joi 仍 Pi-only（ADR 0002 重申，永不持 shell/fs 工具，仅建 `local-pi` 搭档）；实例上限、workspace 租约、DRAIN、outbox、源失败回退与 fail-closed 等确定性机制一律不动。本 ADR 只改"建议性"的提示词与工具面。

**首页场景预设**：新增 `GET /api/v1/scenarios`，返回内置精选场景（`src/shared/joi.ts` 的 `BUILTIN_SCENARIOS`，destination-first 预置提示词）加上"为辅"的技能派生场景（接口层经已注入的技能扫描器把本机已装技能映射成快捷起点）。渲染端点击卡片**只把提示词预填进输入框**，用户补充后再发送，不自动提交。场景不落库、不可在此编辑，其文案只在该回合作为用户输入进入 joi，不进系统提示词。

**joi 显式选模型**：新增 `model.list_sources` 工具，仅返回 `READY` 模型源的安全字段（sourceId、displayName、kind、protocol、primary、activeModel.id）；`partner.create` 增可选 `modelSourceId`/`modelIdOverride` 并透传给注册服务；两者并入 `JOI_REASONING_TOOL_NAMES`。joi 建的搭档引擎固定 pi-core，不暴露 engine 字段（不建 A2A/claude/codex）。

**编排提示词整体重写**：把系统提示词抽成可测纯函数 `src/main/application/joi/joi-system-prompt.ts` 的 `buildJoiSystemPrompt`，编入 wayfinder 方法论——工头不是工人；destination-first 且"目标很小就别建队、直接答或反问"（逃生舱）；HITL/AFK 分类（仅 AFK 可派发、可并行，绝不代用户回答 HITL）；组建团队时先 `partner.list_available` 复用、不合适时才 `partner.create`，并用 Agent-Brief 骨架为每位搭档写自包含提示词（贴进其所需一切）；经 `model.list_sources` 选 READY 源；ephemeral 默认、resident 仅用于续话、复用 IDLE、claim-before-work、失败先读记忆摘要再 reassign；结果聚合为一个有主见的答复。原有功能教学（Turn 边界、模板/实例、失败重派）与 custom-unverified-tools 的 fail-closed 指令、Avatar 上下文注入语义全部保留。

**明确不做**：不引入 wayfinder 的 issue-tracker / 共享 map 落库（"claim-before-work / 共享索引"以提示词纪律近似，不加新存储）；`user.ask` 仍未实现，沿用既有"以可见回复代替主动提问"；场景不做用户可编辑/落库、不做多语言。

## Consequences

- joi 的工具面新增 `model.list_sources`，`partner.create` 获得可选模型字段；建队能力从"只能跟随全局首选"升级为"可为每位搭档显式选源"，但对用户的可见性与可撤销性不变（joi 徽章、可编辑/停用/删除）。
- 提示词整体重写影响 joi 的**所有**回合（不仅场景），属建议性改动：以单测锁定关键不变量（`joi-system-prompt.test.ts`、`joi-reasoning-tools.test.ts`），并经 `single-joi-avatar-routing.test.ts` 确认 Avatar 上下文注入不回归；确定性硬边界兜底最坏情况。
- 场景预设为无状态只读端点，复用既有技能扫描器与鉴权门禁，无新增迁移、无新增存储面。
- 弱模型可能建队过猛或选源不当：由逃生舱教学、实例上限与既有源失败回退共同约束。
