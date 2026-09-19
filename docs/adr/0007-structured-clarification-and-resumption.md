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

## 2026-08-25 补充：等待必须带可执行动作

`WAITING_INPUT` 不能只靠 Work/Run 状态和一段提示文案表达。Migration 044 增加 `joi_user_action_requests`，把问题或恢复决策绑定到精确的 input、Work 和 partner run；OPEN → RESOLVED → APPLIED 是恢复的权威事实。用户回答问题时继续使用文本，存量断链等待则展示单一“继续原工作”动作，不要求用户猜测需要补充什么。

RESOLVED 动作属于确定性命令：task actor 即使没有 READY model source 也会执行，Coordinator 不调用路由或推理模型。其稳定 action id 同时作为恢复 dispatch 的幂等 id；若进程在 dispatch 事务后、动作完成事务前崩溃，重试读取已有 attempt，不创建第二个外部副作用。新 attempt 提交时必须终结被取代的 WAITING run/attempt。

## 2026-09-19 补充：目标级执行门禁与版本化恢复

澄清不再只暂停 Joi 的当前 Turn。Migration 058 以原始 goal input 为键持久化 `WAITING_INPUT`、`REVIEWING`、`OPEN` 三态门禁，并保存稳定 question id、递增版本和唯一恢复 input。`user_ask` 与 WAITING_INPUT 写入同一事务；回答必须匹配问题编号和版本，只把门禁推进到 REVIEWING。Joi 在恢复 input 中核对已有结果和未启动 Work：计划仍适用则保留原标识，要求改变则先取消受影响 Work；只有该版本恢复 Turn 的 `goal_resume` 能原子打开门禁。仍缺信息时再次提问并保持暂停。

门禁在 Work 计划提交事务、dispatch claim、run 启动事务、结果综合、harness review 和目标完成处复查。问题事务之前已有持久 run 的任务可以完成并保存权威结果；门禁关闭期间这些结果不加入综合 membership，OPEN 后由正常扫描重新发现。资源容量、目录 lease 或 resident BUSY 与 HITL 严格分离：前者保持 outbox 排队，不创建问题、不增加执行失败预算。
