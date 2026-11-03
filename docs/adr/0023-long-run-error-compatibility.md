# ADR 0023：长任务异常的错误兼容，不做时长硬顶

- 状态：accepted
- 日期：2026-09-27
- 相关：ADR 0022（pi 原生压缩）、ADR 0016（agent 失败自愈）、ADR 0006（工作台私有搭档实例）

## 背景

ADR 0022 修的是那次事故的根因（搭档 run 的上下文被静默截断）。这一条修的是它在系统层面暴露出的另一半：**一个一直在动、但什么都没做出来的 run，现有机制看不见。**

那次 run 跑了 10 小时 52 分、2685 次模型调用、7972 次工具调用，前 6.5 小时没写出任何文件，最终零交付。而运行时的每一道防线问的都是同一个问题——「它还在动吗」——它一直在动：

- idle 是 20 分钟，每次 Agent 事件都会刷新它；
- dispatch watchdog 是 32 分钟，同样被 `onProgress` 续期；
- ADR 0022 的压缩管的是模型**能记住什么**，不是它在**做什么**。

## 调研：主流 agent harness 怎么处理

逐家核对了源码与官方文档（Claude Code / Agent SDK、OpenAI Codex CLI、OpenAI Agents SDK、OpenHands、SWE-agent、Aider、LangGraph、Google ADK、Gemini CLI、OpenClaw、Magentic-One、AutoGPT、Devin）。

**没有任何一家实现了「无进展检测」。** 全部是计数或预算——步数、成本、token、墙钟。三家默认开启的非墙钟护栏是：Google ADK 的 `_DEFAULT_MAX_LLM_CALLS = 500`、OpenAI Agents SDK 的 `DEFAULT_MAX_TURNS = 10`、LangGraph 的 `recursion_limit`（25 或 1000）。其余默认关闭或不存在：Claude Agent SDK 的 `max_turns` 与 `max_budget_usd` **默认都无限制**，Codex CLI **没有任何 turn/step 上限**，SWE-agent 根本没有 `max_steps`（`while not step_output.done:`），mini-SWE-agent 的 `step_limit` 默认 0 即无限。

**能拦住这次 run 的现存默认值只有一个**：ADK 的 500 次 LLM 调用（本次 2685 次，超 5.4 倍）。它是纯计数，不依赖「有没有进展」。

**这次故障在别处已有镜像**：OpenAI Codex 的开放 issue #34657——37 小时、6,300,749 tokens、一直在写规划文档、零可用交付。诉求原文是 "a goal-progress watchdog based on **deliverable evidence** rather than turn count"。也就是说这个缺口是被承认的、未修复的。

**重复动作检测救不了它**：OpenHands 的 `StuckDetector` 五类模式（`action_observation=4` / `action_error=3` / `monologue=3` / `alternating_pattern=6`）检测的是卡死，而这次每一次工具调用都不同、也没有交替模式；Gemini CLI 的 `TOOL_CALL_LOOP_THRESHOLD = 5` 同理。Claude Code 关于 loop detection 的需求被官方**关闭为 not planned**。

**「按交付物判定」有先例**：SWE-bench harness 用 `empty_patch_ids`（`model_patch == "" or None`）把零产出实例剔出评分——它不看跑了多久、调了多少次工具，只看产出是否为空。

**一条否决性证据**：论文《The Unreliable Progress Bar》——`agent frameworks should not control task flow on the strength of the model's state reports alone`，false completion 在九个部署里 6.2%–64.4%。这否掉了 Magentic-One 式的「让模型自评有没有进展」的进展账本。

**关于重放安全性**：「检测副作用后再决定能否重放」**没有任何实现者**。业界契约全是声明式的——Temporal 要求 Activity 幂等、LangGraph 明确「interrupt 之前的代码会重跑」、Restate 用 journal 跳过已完成步骤。joi 现有的 `sideEffectState` + 不自动重放已修改工作区，属于同一立场。

## 决策

### 1. 用产出证据判定，不用时长

新增 `src/main/infrastructure/pi/pi-run-progress.ts`。它按工具调用节奏取工作区快照并与上一次比较，判据复用 `collectChangedWorkspaceArtifacts` 的同一套规则（路径、大小、mtime），从而保证「运行时说它没产出」与「结果说它没产出」不会互相矛盾。

**只观察能写的 run。** 只读的 run 本来就不该产生文件，判它停滞会 100% 误报；没有工作区的 run 同理。这一条把研究类任务整类排除在外。

### 2. 先警告，再结束

阈值（`DEFAULT_RUN_PROGRESS_THRESHOLDS`，集中在模块顶部并注明取值理由）：

| 阶段 | 触发 | 行为 |
|---|---|---|
| 观察 | 每 25 次工具调用、且距上次探测 ≥30 s | 取快照并与上次比较 |
| 警告 | 连续 6 次探测（≈150 次工具调用）无变化 | `agent.steer(...)` 注入一条说明，**run 继续** |
| 结束 | 再连续 24 次探测（≈600 次工具调用）仍无变化 | abort，收敛为 `partner_run_stalled` |

警告文案同时给出两种读法（「还在收集上下文」与「卡住了」），并要求模型二选一地明确回答。**先警告是刻意的**：一个停止产出的 run 可能只是读得多，两者从外面无法区分，而一条消息的成本是零，杀掉一个 run 的成本是它做过的全部工作。这也正是「错误兼容」与「硬顶」的区别。

### 3. 计数只是外层兜底

`toolCallCeiling = 4000`。它夹在 ADK 等价的约 1500 次工具调用与本次事故的 7972 次之间：高到不会打断真正在干活的 run，低到能兜住一个「一直在产出但不收敛」的 run。计数分不清工作与空转，所以它排在证据判据之后，是最不得已的那一道。

**放弃了成本与墙钟两条。** 调研之后我改了主意：ADK 的先例是调用计数，成本需要新增按 run 累计的账（现在只有按次记账），而墙钟是最武断的一条——用时长判定「跑太久」会把合法的长活一起误杀，这正是最初那版方案被否掉的原因。

### 4. 结束是一次受控收敛，不是静默死亡

- 已经警告过（`markClosedOut` 只在警告之后才可能发生）；
- 收敛为 `partner_run_stalled`，`sideEffectState` 如实上报，**不伪造可重派**；
- 产出保留为 `partialArtifacts`；
- `safePartnerRunFailureBody` 新增该码的文案：验证已有产物，把剩余工作拆成更小的 Work，而不是原样重放。

**必须显式处理 abort。** `assistantFailureSignal` 只匹配 `stopReason === "error"`，而 abort 产生的是 `"aborted"`；不处理的话 run 会走完成功路径、报 `COMPLETED` 加空 body——正是这次事故的形态。两个 run 路径都在每个可能结束的步骤之后检查并抛出。

### 5. 不做「外部化进度文件」

调研中 Anthropic 与 OpenAI 都推荐把进度写进工作区（`claude-progress.txt`、`Plan.md` / `Documentation.md`）供下一个 session 读取。这里**没有做**，因为往用户的工作区写他没要求的文件是产品决策，不是运行时该单方面做的。resident 实例的压缩检查点已经承担了这个角色；若将来要做，它应该是显式的、由任务书要求的交付物。

## 后果

- **一个一直在动却什么都做不出来的 run，现在有两个上限**：产出证据（先警告后结束）与调用计数（兜底）。上限之间的次序是有意的——能分辨工作与空转的那个在前。
- **两条新诊断事件**：`joi.partner.progress_stalled`（警告，run 继续）、`joi.partner.run_closed_out`（结束，带触发原因）。前者让「忙而不产出」这个形态第一次变得可观测。
- **误报的两个已知边界**：① 一个合法地读很久再动手的 run 会先收到一条警告——这是可接受的，警告不改变 run 的行为；② 指纹是路径 + 大小 + mtime，**把同一份字节以同样的 mtime 写回文件**在理论上看不出变化。真实编辑几乎不可能命中，但这是判据的边界，记录在此。
- **仍然没有解决**：pi-core 没有总时长上限，native 引擎有 30 分钟。这一条维持不变——本 ADR 的立场是时长不是信号。
- 契约测试 `tests/contract/local-pi-partner-runtime.test.ts` 新增两条（会警告并结束 / 不冤枉在产出的 run），单元测试 `tests/unit/pi-run-progress.test.ts` 七条。结束用例在把观察接线摘掉后失败、接回后通过。
