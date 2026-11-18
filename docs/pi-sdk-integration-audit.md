# Pi 1.5.2 接入边界审计

日期：2026-11-17。范围：普通对话的 Pi 接入、项目锁文件、本地安装包、上游固定版本文档和源码。本文不修改运行行为，不把合成验证等同于真实模型任务质量验证。

后续用户已确定采用 Pi 原生托管，不再选择保留 Joi 压缩器的路线。目标设计见 [重构 spec](pi-session-ownership-spec.md) 和 [桌面项目调研](pi-desktop-session-research.md)；下文保留本次审计事实，不代表重构已实施。

## 判断

Joi 已经接通 Pi 的工具执行循环，也实际使用了 `pi-coding-agent` 的工具与 AgentSession。但当前实现是 Joi 深度定制的 Harness，不等于完整 Pi CLI 的默认运行方式。工具循环的基础接法成立；会话层创建以后又覆盖其请求、工具、上下文与结束钩子，属于需要明确维护的接入边界。优先检查这些边界，再考虑增加重复调用检测或计数上限。

三个包 `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent` 在 `package.json`、锁文件和本地安装包中都是 1.5.2。外部依据固定到 v1.5.2，安装包行为以本地代码和合成验证为准。[本地依赖](../package.json)、[上游 SDK](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md)

## 上游负责什么

| 层次 | 已提供的处理 | 不能从中推导的保证 |
|---|---|---|
| pi-agent-core / Agent | 工具参数校验、调用、结果记录、事件、工具后继续请求模型、取消和循环钩子 | 任意模型都能在有限步内收敛；每隔若干次工具必须输出正文 |
| pi-coding-agent / AgentSession | 会话、规范历史投影、资源与扩展、自动压缩、恢复与重试；CLI 模式也复用这一层 | 宿主覆盖钩子或关闭功能以后仍保留完整默认行为 |
| 内置 grep / bash | grep 基于 ripgrep，尊重 gitignore；bash 执行给定 Shell 命令并处理输出、失败、取消和可选超时 | 将 bash 中的递归 grep 自动改写为内置 grep，或优化任意 Shell 管道 |

依据：[Agent loop](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts)、[SDK](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md)、[CLI 集成](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/cli-integration.md)、[grep](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/grep.ts)、[bash](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/bash.ts)。

## 本地接入核对

### 1. 工具执行与正常会话入口确实复用了上游

[工具工厂](../src/main/infrastructure/pi/pi-coding-tool-factory.ts) 使用上游 `createBashTool`、`createReadTool`、`createGrepTool` 等工厂。普通对话创建 AgentSession，并通过 `session.prompt()` 执行，随后等待 `waitForIdle()`。它没有在外层重新实现一套模型工具调用协议。[会话适配](../src/main/infrastructure/pi/joi-pi-session.ts)、[运行时](../src/main/infrastructure/pi/pi-partner-engine-runtime.ts)

SDK 官方推荐用 `createAgentSession()` 组合模型、资源、设置和会话；直接构造 `new AgentSession()` 并非仅凭构造方式就能判错，但宿主要承担工厂原本完成的接线。当前 raw Agent 没有显式配置工厂使用的 coding-agent `convertToLlm`，而 Joi 检查点被特意编码为普通 user 消息；不能直接启用 SDK 压缩并假设 SDK 特有消息一定正确进入请求。[上游工厂](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/sdk.ts)、[本地检查点](../src/main/infrastructure/pi/pi-compaction.ts)

### 2. AgentSession 创建后，四项 SDK 钩子被替换

`createJoiPiSession()` 返回后，普通对话运行时设置自己的 `beforeToolCall`，替换或删除 `finishTurn`，并通过 `#installRequirementsPrompt()` 重设 `prepareRequest` 和 `transformContext`；这里没有组合保存的 SDK 回调。[本地实现](../src/main/infrastructure/pi/pi-partner-engine-runtime.ts)

上游 AgentSession 在这些边界中安装工具扩展处理、规范历史投影、边界决策和请求投影。后装宿主回调会使对应 SDK 回调不再直接参与执行；应当逐项审查组合关系。[上游 AgentSession](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/agent-session.ts)

这不是“四项 SDK 功能全部失效”的证明：上游仍安装了 `prepareNextTurnWithContext`，`turn_end` 事件也有边界派发回退。现有还原和重试测试通过。回退是否等价于原钩子中的决策返回值、后续启用扩展时是否兼容，需要更直接的行为回归；不能只检查事件出现或回调名称。

### 3. 摘要异常的所有者是 Joi

[会话设置](../src/main/infrastructure/pi/joi-pi-session.ts) 同时使用 `compaction.enabled: false` 和 `setAutoCompactionEnabled(false)`。这是 [ADR 0033](adr/0033-conversation-context-sessions.md) 与 [ADR 0034](adr/0034-background-summary-policy.md) 的既定决定。上游默认启用自动压缩，管理 cut point、CompactionEntry 和下一次历史投影；这些并未在本地普通对话中按默认策略执行。[上游设置](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/settings.md)、[上游压缩](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/compaction.md)

Joi 调用上游 `generateSummary()` 作为生成助手，但另行决定候选、8,000 字符目标、后台运行、校验、冷却、检查点和截断投影。`pi-context-manager.ts` 将 `summary.length > summaryMaxChars` 直接判为 `summary_exceeds_capacity`。因此，该事件属于 Joi 的接收策略，不是 Pi 原生自动压缩返回的故障分类。[生成适配](../src/main/infrastructure/pi/pi-compaction.ts)、[接收校验](../src/main/infrastructure/pi/pi-context-manager.ts)

前一轮日志诊断观察到的五次摘要输出均超过 8,000 字符，随后被拒收，与此条件吻合。将“目标长度”同时当作一字不能超过的接收上限，使稍长但可能有效的摘要被全部拒绝；是否可以接受仍应同时验证实际容量、完整性及净节省。历史反复截断可能增加重新探索，这是推断，尚未完成同模型对照实验。

### 4. 任务不收敛不是上游默认承诺覆盖的异常

上游循环在模型继续请求工具时继续运行；默认没有语义进展判定或定期正文要求。Joi 的工作区变化观察、工具调用上限与补正文提示都是额外宿主策略。日志中 360 次工具调用、零正文不能单独证明工具协议接入失效，也不能仅靠换成官方工厂保证解决。[上游循环](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts)、[本地进展观察](../src/main/infrastructure/pi/pi-run-progress.ts)

## 验证与限制

- 隔离探针使用已构建运行时、真实安装的 SDK、合成 provider 和已核实位于系统临时目录内的可丢弃工作区；没有模型网络请求，也不访问真实用户数据。实际运行路径中，SDK 安装的 `beforeToolCall`、`prepareRequest`、`finishTurn`、`transformContext` 均被替换；自动压缩为关闭；Joi 策略进入实际请求；上游默认提示词前缀未进入实际请求。探针完成且临时目录已清理。
- `npx vitest run tests/contract/conversation-pi-session.test.ts`：16 项通过。该文件覆盖会话隔离、恢复、流式正文、检查点及部分重试/权限边界，不是 SDK 全功能等价证明。
- 本次只有审计文档及其模型证据更新；未修改生产代码，未运行构建、桌面 E2E、全量测试或真实供应商任务对照。

## 建议的职责调整

若普通对话的产品目标是复用完整 Pi 编码体验，优先用 `createAgentSession()` 和显式依赖创建一个会话所有者，以 ResourceLoader、工具配置及受支持扩展注入 Joi 的模型、资源和权限。保持 SessionManager 为规范历史入口；宿主保留 DTO、授权、取消与 durable journal 边界。自定义工具的安全实现仍需要由宿主提供。[官方组合入口](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md)、[完整配置示例](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/examples/sdk/12-full-control.ts)

压缩必须有一个所有者：要么完整交还 SDK，并验证必要上下文与 SDK 消息转换；要么保留 Joi 策略并修正它的接收条件。禁止只打开 SDK 自动压缩而保留第二套活动压缩器。迁移属于后续行为变更，应更新 ADR，并先添加覆盖真实请求、规范投影与钩子决策的失败回归。

即便转交上游，模型如何选择工具、何时汇总结论仍需独立评估。确有业务预算需求时，再通过受支持边界增加可配置的产品策略；不能把外层计数器当作接入正确性的替代证明。
