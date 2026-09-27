# ADR 0008: 工作台目标卡与 Agent 展示对话

- 状态：Accepted
- 日期：2026-08-03
- 关联：ADR 0002（唯一 joi 与工作台编排）、ADR 0006（工作台私有实例与结果）、ADR 0007（结构化澄清）
- 修订：2026-08-05（目标级结果综合与完成透出）、2026-08-24（直接回答持久投影、搭档选择卡）、2026-09-26（工具轨迹私密正文按需读取）

## 背景

旧首页同时展示输入、Turn、Work、Partner Result 和右侧工作状态，同一事实以多种形态重复出现，用户无法稳定判断哪个对象值得保留。工作台详情只展示实例元数据；真正的本机与 A2A 执行结果散落在工作结果和运行表里，也缺少一条安全、可跨重启查看的对话投影。

## 决策

主页只展示三类对象：活跃或刚结束的 joi `progressing`、需要用户处理的澄清/确认、每个原始用户目标对应的一张工作台卡。过程状态不再各占一行，右侧工作面板移除。Turn 终态尾迹保留 15 秒并降低视觉权重。Agent 全部结束后，joi 按原始目标综合全部权威结果；综合期间目标卡保持 `FINALIZING`/progressing，综合完成后才展示 1–3 行有界完成结论。目标卡只有在当前 result-set revision 的目标级 outcome 已持久化，且 inbox、Work 和 Partner Run 均终态后才允许软删。

澄清必须尽可能转为结构化点击操作。派发层先在无副作用边界机械纠正互斥实例参数；仍确需用户决定搭档时，以 `partner_selection_required` 保存具体安全提示，首页从公开 snapshot 展示 ACTIVE、配置有效的搭档选择卡。点击只提交稳定 `partnerId`，应用层复验并原子匹配当前原因后继续原输入；该卡不显示自由输入，也不把内部 reason 退化成“请补充要求”的通用文案。

点击目标卡进入工作台。工作台默认页签列出它启动过且未被删除的所有 Agent，本机 instance 与远端 A2A run 使用相同卡片契约。`EPHEMERAL` 只有终态可删，`RESIDENT` 不可删；上下文编辑降为次级页签。点击 Agent 才进入只读对话，不允许绕过 joi 直接续聊。

新增独立展示表而不改变运行事实权威。Migration 033 不回填历史，只让迁移后的新 instance/run 创建 Agent session。执行适配器把任务、最终 Markdown、工具名、文本工具结果、产物和错误转换为规范化条目；内部 reasoning、工具参数正文与 A2A data part 不进入这些展示条目，**展示条目**的凭据在持久化前脱敏，绝对路径缩写为「盘符/根 + 末三层」。工具轨迹是另一类独立的私密正文通道：它不属于展示条目，凭据在持久化前脱敏、绝对路径保留（本机调试必需），单条 ≤8 KB 超出截断并标记，只在本机落 `workbench_agent_tool_traces`，只在桌面上按写权限按需读取，不进入首页、诊断、SSE 或远端。条目以稳定 ID 幂等写入并按大小分块。删除展示 Agent 不级联删除 Work、Run、Result、event 或审计事实。

Migration 034–036 补足展示面的事实来源：Work 强关联原始目标、每个 run 只有一个权威终态；目标级 result-set revision 在所有 Work 终态后生成唯一综合输入；joi 在隔离 session 中仅用结果读取与完成工具形成目标级 outcome。首页不从单个 Agent 结果或共享 Pi session 猜测结论。原始请求、私有 Work brief、结果正文和完整路径不进入首页或诊断，诊断只保留安全字段并滚动持久化。

Migration 042 为不创建 Work 的普通回答增加独立 `joi_turn_completions` read model。Pi runtime 只把 `turn_complete` 的安全 outcome 枚举交给 Coordinator，不透出工具 payload；Coordinator 捕获本轮最终文本并用与 Goal outcome 相同的有界 Markdown 脱敏规则处理，SQLite 在同一事务中校验 Turn 属于 Input、完成 Turn/Inbox 并按 `input_id` 幂等写 projection。Home feed 仅在 Input 为 `CONSUMED` 且没有 result-set 时使用该值；Goal outcome 的当前 revision 永远优先。首页不得反查共享 reasoning transcript，诊断不得携带 completion 正文。

## 后果

主页会随工作结束和用户删除逐渐恢复空白，不再承担历史审计器职责，同时在用户删除前提供 joi 的正式完成反馈。完整运行事实仍在原领域模型中，展示对话是可删、最小权限的 read model。升级前执行不会突然生成不完整对话；新执行从 migration 033 起完整记录。前端 Markdown 禁用 raw HTML 和远程图片，并限制外链导航。
