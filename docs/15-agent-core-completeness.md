# 三种 Agent Core 与 A2A 的完备性评估

> 评估日期：2026-09-27 · 评估对象：`master` 工作树（`5206321`，即 ADR 0022 / 0023 落地之后）

---

## 0. 方法与置信度

本文对照 `PartnerEngineRuntime` 这一个端口下的**四条执行路径**，逐维度核对能力是否对等。

**四条路径**

| 路径 | 实现 | 形态 |
|---|---|---|
| `pi-core` | `src/main/infrastructure/pi/pi-partner-engine-runtime.ts` | 进程内 pi Agent，joi 拥有会话与上下文 |
| `claude-code` | `src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.ts` | spawn 本地 `claude` CLI，会话寄存在 CLI |
| `codex` | `src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.ts` | spawn 本地 `codex` CLI，会话寄存在 CLI |
| A2A | `src/main/infrastructure/a2a/partner-dispatch-delivery-adapter.ts` | 远端伙伴，**不是**一个 engine，而是与 `LOCAL_PI` 并列的第二条 `kind` 分支 |

**置信度分档**（与 `docs/14` 同一标准）：标记【核实】的由我在写本文时直接读源码确认；标记【转述】的来自并行测绘 agent 的报告，我未逐行复核，读时请自行验证。

---

## 1. 对等性矩阵

| 能力 | pi-core | claude-code | codex | A2A |
|---|---|---|---|---|
| 上下文压缩（joi 侧） | **有**（`pi-context-manager.ts`，ADR 0022） | 无，CLI 自管 | 无，CLI 自管 | 无，远端自管 |
| 静默丢失风险 | 已消除（有损裁剪必留显式标记） | joi 不可见 | joi 不可见 | joi 不可见 |
| 失速/无产出检测 | **有**（ADR 0023） | 无 | 无 | 无 |
| idle 超时 | 20 min | 20 min | 20 min | 仅 32 min watchdog |
| total 硬顶 | **无** | 30 min | 30 min | 无 |
| 单次工具超时 | 15 min | 无 | 无 | 无 |
| resident 恢复 | `partner_instance_messages`（joi 自有） | CLI `resume` | CLI `resumeThread` | `invocation` recover |
| 恢复失败后果 | 起空历史，面小 | **静默开新 session** | **静默开新 session** | breaker / recover |
| 失败分类 | 有 | 有 | 有 | 有（默认 UNKNOWN） |
| `sideEffectState` 精度 | **精确**（观测触发） | **按能力预置 UNKNOWN**【核实】 | 按 sandbox 预置 | **无观测**，恒 UNKNOWN |
| 工具策略语义 | 进程内白名单硬拦 | SDK `allowedTools` | **无名单**，sandbox 开关 | 不适用 |
| OS 级沙箱 | **无**【核实】 | 部分（plan / acceptEdits） | **有**（`sandboxMode`） | N/A（禁文件访问） |
| `effectiveModelLimits` 生效 | **有**【核实】 | 无 | 无 | N/A |
| `NativeAgentEvent` 全量 | 有 | 有 | 有 | 部分（拼文本） |
| `tool_activity` 带 summary | 有 | **无**【核实】 | **无** | 无 |
| `onToolTrace` 私密通道 | **有** | 无 | 无 | 无 |
| 凭据不入事件/日志 | 是 | 是 | 是（额外剥 env） | 是 |
| capacity / SSRF 防护 | N/A | N/A | N/A | **有** |

---

## 2. 真实的不完备（可能造成线上问题）

### 2.1 pi-core 的写工具没有路径边界 【核实】

pi 的 `bash` / `edit` / `write` 不做任何路径限制，而系统提示词**明确鼓励**写工作区之外：

> 「The assigned workspace is your home base: create work files there by default. **When the task requires it, you may also read and write paths outside the workspace**（for example user directories, installed skill folders, or configuration files）…」
> —— `pi-partner-engine-runtime.ts:814`

约束只有提示词本身，外加要求事后申报。相比之下 codex 有 OS 级 `sandboxMode`，claude 至少有 CLI 自己的边界。**pi 一旦被配置了写工具，就能在 joi 进程的权限内写任意路径。**

这不是「零授权即可写」——revision 层已经授权了写工具。但它意味着**同一条授权在三个引擎上的实际风险不同**，而 pi 是最宽的那个，且没有任何兜底。这是相对 codex 的深度防御缺口，也是本次评估里我认为最值得单独处理的一条。

### 2.2 native 引擎的可恢复性系统性低于 pi 【核实部分】

`claude-agent-sdk-partner-engine-runtime.ts:108` 在 run 开始时按「工具列表里有没有变更类工具」把状态预置为 `UNKNOWN`：

```ts
tracker.sideEffectState = tools.some((tool) => CLAUDE_MUTATING_TOOLS.has(tool)) ? "UNKNOWN" : "NONE";
```

而 `retryable` 要求 `sideEffectState === "NONE"`。后果：一个配置了写工具的 native partner，**哪怕在任何工具执行之前**就因连接失败、resume 失败或超时而结束，也会被判 `UNKNOWN` → 不可自动重派，只能人工补救。pi 在同样情形下是 `NONE` → 可重派。

方向是安全的（宁可不重放），但这意味着 native partner 更容易停在需要人工介入的终态。**没有 ADR 明文说明这是有意的产品取舍。**

### 2.3 native resident 的记忆脆弱且不可感知 【转述 + 核实代码路径】

历史寄存在用户 CLI 的 session 里，joi 不持有、不能读也不能修复。CLI 侧 session 过期即**静默**开启新会话（`native-agent-session-reference.ts` 对非法引用返回 `undefined`）。ADR 0014 记录了「这是有意的安全切换」，但代价是：对话记忆丢失且 joi 无法察觉。

### 2.4 native 的工具调用可观测性偏弱 【核实】

`tool_activity` 事件只带 `toolCallId` / `toolName` / `state`，**没有 summary**（`claude-agent-sdk-partner-engine-runtime.ts:199`），而 pi 的同类事件带一行 ≤200 字符的脱敏摘要。叠加 ADR 0014 明文规定 `onToolTrace` 私密通道「Claude/Codex 适配器不接线」，结果是：native partner 排障时只能看到工具**名字**，看不到它做了什么。这个差异是有意的（隐私边界），但**「连摘要都没有」不是同一条决策的必然结果**——摘要是脱敏后的一行文本，与私密正文是两回事。这是我认为可以单独修的第二条。

### 2.5 pi-core 没有 total 硬顶

native 引擎有 30 分钟总时长上限，pi-core 没有。**这一条在 ADR 0023 之后从「缺口」变成了「有意的差异」**：ADR 0023 的立场是时长不是信号，并用产出证据 + 调用计数替代。但三引擎之间仍然是三种不同的收敛语义，值得在文档里说清楚而不是留成隐含差异。

---

## 3. 有意的差异（有 ADR 或注释背书）

| 差异 | 依据 |
|---|---|
| native 不做 joi 侧压缩、认证与恢复交给 CLI | ADR 0014 决策段 |
| `effectiveModelLimits` 只对 pi 生效 | ADR 0014；native 的窗口由 CLI 决定，joi 设的 `contextWindow` 对它们**不生效**，设置页显示的限额对 native partner 仅供参考 |
| `onToolTrace` 只给 pi | ADR 0014 逐字规定，2026-09-26 修订再次确认 |
| codex 用 sandbox 而非工具白名单 | ADR 0014 |
| A2A 禁止文件工作、永不持 workspace lease | `dispatch-policy.ts`：「A2A never touches workspace files」 |
| native 写型 partner 保守判 UNKNOWN | 代码注释表明是刻意保守；**但缺一条 ADR 明文**（见 2.2） |

---

## 4. A2A 的定位

A2A 与本地引擎的差别不是「能力更弱」，而是**信任边界不同**：

- 它在 `dispatch-policy` 层被禁止获取工作区访问权，因此**永不持有 workspace lease**，也拿不到本地引擎那套文件保障；
- `sideEffectState` 恒 `UNKNOWN`——远端做了什么 joi 一无所知，这是诚实的；
- 它独有本地引擎没有的防护：capacity gate、connection breaker、出站网络策略（私网/元数据地址拦截）。

因此 A2A **不是一个「不完备的本地引擎」，而是一条不同的路径**，用「能力对等」去衡量它本身就不合适。它在自己的约束下是完备的。唯一值得补的是文档：`docs/05-a2a-integration.md` 没有把「无文件访问 ⇒ 无 lease ⇒ 无产出证据」这条推论写出来，而 ADR 0023 的产出证据判据同样不适用于它。

---

## 5. 结论

**同一份 partner revision 的同一个字段，在三个引擎上含义不同。** `tools` 在 pi 上是进程内白名单、在 claude 上是 SDK 允许列表、在 codex 上**没有对应物**（能力由 sandbox 开关决定）。配置 UI 是同一套，语义是三套。这是当前架构最本质的不对等，也是 2.1 / 2.2 / 2.4 的共同来源。

在这种前提下谈「完备」，答案分三层：

1. **在各自的设计约束内**，四条路径都是完备的——没有一条存在「声明了却不生效」的能力。
2. **在「同一配置跨引擎行为一致」这个意义上**，不完备：`tools` 语义、`contextWindow` 生效范围、`sideEffectState` 精度三处都不一致。
3. **具体到可能导致线上问题的**，本文只认两条，按建议处理顺序：

### 建议处理顺序

1. **pi 写工具补路径边界**（2.1）。当前 pi 是唯一「授权写即无限制」的引擎，且在本次事故里它正是在无人看护下连续跑了十小时。最小做法是在 `pi-coding-tool-factory` 的 `write` / `edit` 上做工作区边界校验，越界写降级为显式拒绝并在 tool result 里说明；`bash` 无法做静态边界，但可以在提示词之外补一条「越界写会在结果里被标出」的运行时检查。
2. **native 的 `tool_activity` 补一行脱敏摘要**（2.4）。与 `onToolTrace` 的隐私边界不冲突——摘要是脱敏后的一行文本。pi 已有 `toolCallSummary` 的实现可以先复用。
3. **给 2.2 补一条 ADR**。当前它是「代码保守但没人写清楚」，而它直接决定 native partner 的可恢复性。
4. **补 `docs/05` 关于 A2A 的推论**（第 4 节）。

---

## 6. 明确未验证的

- native 引擎 `resume` 时 joi 的 `boundBackgroundSections` 是否会与 CLI 已恢复的历史重复注入——静态读不出来，需要实跑或查 SDK 契约。
- `observedRouteLimits` 是**进程内** map（`pi-model-budget.ts`），进程重启即丢；是否需要持久化属产品取舍。
- native 引擎的 `usage` 记账（`sdk-usage.ts`）未纳入本次凭据/限额维度的逐行核对。
