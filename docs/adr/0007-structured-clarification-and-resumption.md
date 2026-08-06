# ADR 0007: 结构化澄清与可靠恢复

- 状态：Accepted
- 日期：2026-08-02
- 关联：ADR 0002（唯一 joi 与工作台编排）、ADR 0005（wayfinder 式编排）、ADR 0006（工作台工作区）

## 背景

旧澄清只保存原因码，界面统一显示工作台点选和自由文本。joi 的 `user_ask` 虽在工具清单中却没有实现，因此普通回复中的问题不能形成可恢复交互。文件工作因工作台工作区未就绪而被策略拒绝时，也没有专用目录操作。更严重的是：用户在同一输入的 Turn 尚未完全退出时补充信息，scheduler 会把同 ID 通知当作重复事件丢弃，导致输入已经回到 `PENDING` 却不再执行。

## 决策

澄清是 inbox 的持久状态，不是仅存在于一次模型回复中的 UI 文案。`joi_inbox_messages` 增加可选 `clarification_prompt`；原因码决定操作形态：工作台归属卡、`workbench_workspace_not_ready` 工作目录卡、`question_required` 问题回答卡。`user_ask` 只能提交一个有界的具体问题并立即停止当前安排。Turn 完成逻辑不得消费仍为 `CLARIFICATION_REQUIRED` 的输入。

需要文件权限而工作区未 READY 时，Work plan 在任何 dispatch plan、attempt 或 outbox 提交前整体失败。`work_dispatch` 将该错误转换为同一输入的工作目录澄清。目录卡调用现有工作台工作区 bind 写接口打开系统目录选择器；渲染端、shared DTO、HTTP 响应、日志与事件均不接触绝对路径。绑定完成后，卡片通过原 clarify 接口恢复同一输入。

`JoiInputScheduler` 继续保持全局串行和已排队去重。当相同输入在自身活跃处理期间收到通知时，只记录一个 rerun 标记；当前 `handle` 到达安全边界后再把该 ID 入队一次。这样补充不会与当前 Turn 并发，也不会因短暂重叠而丢失。

## 后果

Migration 029 只新增可空问题字段；旧澄清记录保持兼容。首页不再用一种通用控件覆盖所有 HITL：目录卡、问答卡和工作台归属卡各自只呈现完成当前阻塞所需的操作。merge/archive 仍使用独立的持久确认卡，不并入自由文本澄清。
