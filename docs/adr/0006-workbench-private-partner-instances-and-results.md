# ADR 0006: 工作台私有搭档实例、工作区与结果闭环

- 状态：Accepted
- 日期：2026-08-02
- 关联：ADR 0002（唯一 joi 与工作台编排）、ADR 0004（搭档引擎多元化）

## 背景

旧实现把 `workspace_ref` 放在 Partner revision 上，并允许搭档实例与工作记忆按 Partner 全局复用。这会让同一个能力模板携带工程目录，也会使常驻会话、cwd 和结果跨工作台混用。旧结果事件还可能先唤醒 joi、再补写工作状态，无法证明“结果事实先归档”。

## 决策

Partner revision 只表达全局能力模板：引擎、模型、提示词、技能、工具和知识库。新 revision 不读写 cwd；旧 `partner_revisions.workspace_ref` 仅留作审计。工作台是 cwd 唯一权威，每个 ACTIVE 工作台具有 opaque workspace binding，实际根路径只在基础设施私表中。创建受管目录通过稳定 outbox 副作用执行，状态为 `PROVISIONING → READY | FAILED`。

每个 `PartnerInstance` 必须绑定 `workbenchId`。确保、枚举、派发、续话和销毁都校验工作台；跨工作台使用统一返回 `partner_instance_workbench_mismatch`。默认派发创建临时实例，常驻实例仅供同一工作台续话。工作记忆按 `(workbenchId, partnerId)` 隔离。

Work 权限为 `NONE | READ | WRITE`。`NONE` 不申请工作区 lease，可派给本机或 A2A；`READ/WRITE` 自动绑定该工作台工作区并申请 lease，只允许本机引擎，工作区未 READY 时以 `workbench_workspace_not_ready` 阻止。调用方不再提交 `workspaceRef`。

每次派发前创建受控 `WorkbenchContextSnapshot`，只包含档案元数据、人格 revision 引用、工程标签、当前/活跃工作、最近结果摘要、记忆摘要引用和 opaque workspace ref。persona、记忆正文、结果正文和绝对路径不得进入 shared DTO、日志、SSE、outbox 或 A2A payload；本机引擎仅通过基础设施 resolver 得到 cwd。

引擎统一返回终态、正文和 artifact 元数据。结果事务固定写入：`WorkResult` 事实与受限正文 → Work 状态 → 工作台任务投影 → 持久事件。事务提交后才发布 SSE、写 joi inbox 和调度。inbox 只含 `resultId/status/有界摘要`；joi 仅能用 `work_read_result(resultId, cursor?)` 在当前工作台内分页读取正文。迟到结果仍归档，但不能重开已取消 Work 或自动进入 joi 整合。

## 迁移与后果

Migration 027 新增 workspace binding/root、task projection、context snapshot、工作台范围内 memory 和 WorkResult 表，为实例增加 `workbench_id`，并给所有 ACTIVE 工作台排队创建受管目录。升级时旧非终态 Work、dispatch、run 和实例统一失效；旧远端 RUNNING run 通过稳定 cancellation outbox 尝试取消。历史 Partner cwd 不回填。

管理面新增工作台上下文中心和安全工作区操作。Partner 编辑页、创建工具和 API 删除 cwd；继续提交 `cwd/workspaceRef` 明确返回 `partner_workspace_forbidden`。工作记忆、persona 和结果正文不再由管理 UI/API 返回。
