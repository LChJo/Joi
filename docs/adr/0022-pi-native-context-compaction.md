# ADR 0022：用 pi 原生压缩替换 joi 手写的上下文裁剪

- 状态：accepted
- 日期：2026-09-27
- 相关：ADR 0004（搭档引擎的多样性）、ADR 0014（原生 Agent SDK 适配）、ADR 0021（token 统计）

## 背景

一个 pi 搭档 run 连续运行 **10 小时 52 分 / 9056 条消息 / 2685 次模型调用**，最终**零交付**：任务要求的 git commit 与交付报告都没有产出。它在中途反复声称「我的工作树正在被并发修改——我第一次创建的报告文件消失了，而之前那个大的未提交 diff 被还原了」，并开始调查。

磁盘取证否定了这个判断：它 12 次写/编辑全部按时间戳落在磁盘上（`src/data/legacy/*.ts`、`src/context/manager.ts`、`src/runtime/execution.ts`、`src/ui/session-view-shared.ts`、`src/ui/Shell.module.scss`），`git stash list` 为空，`reflog` 停在开工之前，`git worktree list` 只有一条普通工作树。**没有任何并发，也没有任何还原。** 丢的是历史，不是文件。

根因是两个事实相乘：

1. `pi-partner-engine-runtime.ts` 的 ephemeral 与 resident 两条路径都挂 `transformContext: boundPartnerModelContext(...)`。`pi-model-budget.ts` 的 `boundModelContext` 在超出 `CONTEXT_MAX_MESSAGES = 32` 时只保留最新 32 条消息，再往前找最近一条 `user` 消息当锚点，**其余静默丢弃**，不留下任何标记。
2. 搭档 run 全程只调用一次 `agent.prompt(request.taskProjection)`，中途不再插入 user 消息。锚点因此永远是**最初那份任务书**。

于是每次请求模型看到的都是「10 小时前的任务书 + 最近约 16 轮工具调用」。它在磁盘上看到自己几小时前写的文件，却不记得写过——而没有标记的缺口让它无法区分「我的历史被裁剪了」与「别的进程改了我的文件」，它选了后者。同一次 run 里这个误判至少出现三次（`21:43Z`、`01:29Z`、`03:39Z`）。

pi 官方在同一天修过同一类缺陷（issue #10075：agent 丢失了自己刚交付的报告，表现得像这段对话从未发生）。

## 决策

### 1. 复用 pi 的压缩子系统，不再自己写阈值

pi 从包根导出 `DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`、`estimateContextTokens`、`estimateTokens`、`generateSummary`、`serializeConversation`，以及一套结构化摘要模板（`## Goal / ## Constraints & Preferences / ## Progress / ## Key Decisions / ## Next Steps / ## Critical Context`）。joi 此前只用了其中的 `generateSummary` 一个函数，其余全靠自造。

现在搭档侧的 `transformContext` 由 `src/main/infrastructure/pi/pi-context-manager.ts` 承担：pi 的判定决定何时压缩，pi 的摘要调用产出内容，摘要以 `previousSummary` 逐次增量更新（pi 会切到它的 update 模板），而不是每次重读整个前缀。

**不引入 pi 的 session 树。** `prepareCompaction`/`compact` 需要 `SessionTreeEntry[]`，采纳它意味着把 `partner_instance_messages` 迁到 pi 的 session 仓储——那是存储层重构，而缺陷出在「长期不压缩」这个决策上，不在切点算法上。真正值钱的是那三个 session-agnostic 的纯函数。

### 2. 压缩必须做成请求级，绝不能缩短 `agent.state.messages`

这是本决策的硬约束，来自两处调用点：run 结束时 `body = assistantText(agent.state.messages)`，UI 时间线由 `replaceRun(...)` 用 `draftAgentConversation(request.taskProjection, body, agent.state.messages)` 整体重写。缩短转录会让最终交付物和整条会话时间线一起缺段。

因此压缩状态（切点、摘要、计数）**存在 agent 之外**：ephemeral run 随 run 生灭，resident 实例挂在 warm 条目上、与它同生共死。`transformContext` 只组装请求。

### 3. 有损裁剪必须显式声明

摘要调用失败、或摘要之后仍然超预算时，请求仍要丢消息——但丢的同时在请求里写明：丢了多少条、因为哪个体积预算、以及**这不是别的进程改了你的工作区**。措辞直接针对上面那次误判。「静默」正是让错误推断变得可用的原因。

### 4. 字符预算作为独立触发条件保留，不能被 token 估计取代

pi 的 `estimateTokens` 把 CJK 按约四字符一 token 计价，且对 `system` 消息返回 0。joi 的路由以中文为主，system 提示词可以占到窗口的三分之一，所以单靠 token 估计会**系统性晚触发**。字符预算是覆盖这个偏差的独立判据。

同类修正还有两处：`compactionReserveTokens` 把 pi 的 `reserveTokens` 默认值按窗口比例收窄（小窗口上它会大于整个窗口，使 `shouldCompact` 恒真）；保留尾必须同时满足 token 与字符两个预算，否则会出现「压缩掉历史、又立刻把刚摘要过的消息丢掉」。

### 5. 切点可以落在 assistant 消息上

原规则只允许落在 `user` 消息上，理由是请求不能以孤立的 tool result 开头。但搭档 run 只有一条 user 消息，这条规则使压缩**永远无法触发**。规则放宽为 user 或 assistant——保留尾永远继承它前面的锚点，所以以 assistant 开头是安全的；真正非法的只有落在 tool result 上。

### 6. 回合侧共用同一套原语，但保留各自的触发与持久化

`pi-compaction.ts` 承载两者共用的部分：摘要调用、checkpoint 消息（pi 的分隔符 + `[joi session checkpoint]` 标记）、checkpoint 判定（同时读块状与旧的纯字符串形状）、以及那段声明丢失的措辞。

两侧**不同**的是合法的：回合侧拥有 session，可以在 Turn 边界重写转录；搭档 run 只能重塑请求。触发也不同——回合侧保留 `clampMaxTokensToContext` 的 headroom 检查，它防的是**另一个**失败模式（输入挤满窗口 → provider 把 `max_tokens` 夹到 1 → 回合被截断），与窗口百分比不是同一件事，不应为了形式上的一致而删除。

回合侧同时补上了它自己的静默丢失路径：Turn 中途由 `boundRequestByChars` 兜底裁剪，此前同样不留痕迹。同一类缺陷，同一类措辞。

### 7. 升级 pi 到 0.87.x 单独进行，且放在最后

0.87.x 是一次**转录架构变更**，不是版本号递增：

- `AgentState.systemPrompt` 变为只读；系统提示词与工具声明移入 `state.messages[0]` 的 system 消息。
- `streamFn` 收到的是 `TranscriptContext`，其中**没有** `systemPrompt` / `tools`。
- `generateSummary` 的参数表位移（`signal` 槽位被删除，尾部新增必填的 chord `Context`）——只补 `undefined` 而不重排前几位会编译通过、语义错乱。
- `AgentOptions` 新增 `finishTurn` 与 `prepareRequest`（0.82.1 的 `agent.js` 里这两个名字出现 0 次）。

其中一条会**引入新的静默丢失**：`boundRequestByChars` 的锚点规则判断 `messages[0].role === "user"`，在新形状下判为「无锚点」，于是每次裁剪会把整条系统提示词连同运行时权限边界一起丢掉。该锚点已在升级之前单独修复（`6d80669`），两个版本下都正确。

真正的压缩修复在 0.82.1 上即可完成，所以升级排在其后单独一棒：这样回归测试变红时，能分清是策略错了还是 API 迁移错了。

## 后果

- **搭档 run 的记忆不再等于最近 16 轮工具调用。** 长 run 会按 pi 的阈值压缩，摘要随 `## Progress / ## Next Steps` 增量更新，模型每次都能看到自己的任务与已完成的工作。
- **新增三条诊断事件**：`joi.partner.context_compacted`、`joi.partner.context_summary_failed`、`joi.partner.context_truncated`。第三条的存在意味着「有损裁剪」永远是可观测的；第二条意味着「摘要路由持续失败」不会被误当成正常。
- **代价**：压缩会额外花一次模型调用（增量更新把它摊薄到每次压缩一次，而不是每发请求一次）。摘要质量依赖模型，弱模型可能丢关键路径——缓解是 pi 的模板要求保留精确文件路径，且兜底路径不删消息、只声明。
- **未解决**：pi-core 仍然没有总时长上限（native 引擎有 30 分钟）。见下一节。
- 契约测试 `tests/contract/local-pi-partner-runtime.test.ts` 与 `tests/contract/pi-runtime-contract.test.ts` 各新增了针对本次事故的用例，它们在修复前失败、修复后通过。

## 待决

**pi-core 的总时长上限。** 一次 run 可以同时续走 idle（20 分钟）与 dispatch watchdog（32 分钟），因为两者的「进展」都由 Agent 事件刷新——一个持续吐字节的 run 在理论上可以无限运行。把 native 引擎的 30 分钟硬顶照搬过来是错的方向：这次事故的 run 有真实的长任务形态，硬顶会误杀合法的长活，而且它砍不掉「一直在动、没有产出」这一类。

正确的方向是**错误兼容而非硬顶**：识别无进展/重复动作/无产出的形态，据此提示模型或诚实收敛。具体机制待独立评审后确定，届时本节会被一份新的 ADR 取代或补全。
