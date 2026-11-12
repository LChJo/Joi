# Pi 编码能力与 Harness 补充调研

调研日期：2026-11-12。原始范围：官方文档、官方源码，以及官方文档直接链接的维护者技能仓库。原始调查包含隔离工具钩子原型；后续章节分别记录已接入的第三方能力与浏览器替代方案调查，不把文档能力或接口验证称为真实任务性能收益。

## 结论与版本边界

Pi 的编码能力不只在 `pi-agent-core`：官方 `pi-coding-agent` SDK 已提供会话、资源加载、技能、项目指令、扩展钩子，以及可选 Codemode/MCP。官方将 Pi 定位为可扩展的最小 Harness，并把一些工作流留给扩展和包。[官方定位](https://github.com/earendil-works/pi/blob/v1.5.2/README.md#pi)、[SDK](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md)

查询时 GitHub 标记的最新发布是 **v1.5.2，发布日期 2026-11-10**；主任务已核对 Joi 固定的 `pi-agent-core`、`pi-ai`、`pi-coding-agent` 也是 1.5.2。本报告的核心能力依据均固定到该标签，不能把 `main` 后续提交直接当成已安装行为。[官方发布](https://github.com/earendil-works/pi/releases/tag/v1.5.2)、[版本记录](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/CHANGELOG.md#152---2026-11-10)

## 先区分 ReAct 与 React

- **ReAct 智能体范式**：论文讨论推理与行动交替、从环境反馈继续处理任务。Pi 官方描述的循环是请求模型、执行工具、记录结果、按需要继续下一轮。可以据此把 Pi 称为“ReAct 式工具循环”，这是对行为的归纳；本次没有找到官方名为 `ReAct` 的独立模块或需要开启的模式，不能据此断言它复现了论文全部提示方法。[ReAct 原论文](https://arxiv.org/abs/2210.03629)、[Pi 的 Agent loop](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/how-pi-works.md#agent-loop)
- **React 前端框架**：本次检查的官方技能说明、SDK 示例和扩展示例索引，未发现专门用于 React 编码的官方内置技能或 React 项目模板。已有通用资源机制可承载 React 规范、组件约束、测试流程；这属于适配方案，不是“Pi 不会写 React”的证据。[技能机制](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/skills.md)、[SDK 示例索引](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md#examples)、[扩展示例索引](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/examples/extensions/README.md)

## 官方已提供的层次

| 能力 | 已核实事实 | 对 Joi 的意义或限制 |
|---|---|---|
| Agent 循环与并发 | Core 提供工具执行、事件、上下文转换；工具执行默认 `parallel`，可全局或按工具设为 `sequential`。[Core 文档](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/README.md#with-tool-calls) | 循环已经存在；并发与否还取决于宿主配置和工具状态约束。 |
| 会话与资源 | `AgentSession` 管理会话、队列、压缩和扩展；`ResourceLoader` 可由宿主提供。[SDK 配置](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md#configuring-a-session) | 可以选择性复用，无须把产品持久化和权限职责全部交回 CLI 默认实现。 |
| 技能与模板 | 技能先公布名称、说明和路径，再按需读全文；提示模板是可复用的 Markdown 命令，包可分发多类资源。[Skills](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/skills.md#understand-how-skills-load)、[模板](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/prompt-templates.md)、[包](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/packages.md) | 可承载编码规范、调查和验证步骤；模型自动选择技能仍可能遗漏。 |
| 项目指令 | 官方会加载 `AGENTS.override.md`、`AGENTS.md`、`CLAUDE.md`；这些上下文文件与项目资源信任的边界不同。[上下文与信任](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/security.md#understand-project-trust) | 如由 Joi 自管，应明确读取范围、优先级与可信度，不能靠设置 `cwd` 便认定指令已注入。 |
| 扩展与完成复核 | 扩展可拦截工具、转换上下文；`agent_before_settle` 可添加条目并请求继续，`agent_settled` 只用于最终通知。[扩展事件](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_settled) | 有接入“复核证据后完成”的接缝；是否通过验收仍须宿主定义，有条件、有限次地续跑。 |
| Codemode | JavaScript 在 QuickJS 内编排工具、批处理并过滤输出；脚本本身没有 Node、文件系统或网络接口。[Codemode](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/codemode.md) | 是减少零碎编排和模型可见输出的候选能力；不等于底层动作减少，也不保证提速。 |
| MCP 与工具发现 | 官方支持 stdio、streamable HTTP 和工具暴露策略；SDK 需显式加入 Codemode、Tool Search、MCP 扩展，并绑定扩展生命周期。[MCP](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/mcp.md)、[官方 SDK 示例](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/examples/sdk/14-codemode-mcp.ts) | 已安装 SDK 不代表这些功能已启用；需要时分别接入，不能默认放开所有服务器。 |
| 子智能体与计划模式 | 核心默认不内置；官方提供子智能体、计划模式的扩展示例。子智能体示例以独立 Pi 进程隔离上下文，支持单个、并行、链式调用。[官方定位](https://github.com/earendil-works/pi/blob/v1.5.2/README.md#pi)、[示例索引](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/examples/extensions/README.md)、[子智能体示例](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/examples/extensions/subagent/README.md) | “官方有示例”“Joi 装了独立子智能体包”“宿主已运行该能力”需要分别核实。 |
| 权限 | 官方明确没有内置的文件、进程、网络、凭据访问权限系统；项目信任不限制工具的 OS 权限。[根 README](https://github.com/earendil-works/pi/blob/v1.5.2/README.md#permissions--containerization)、[安全说明](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/security.md#understand-project-trust) | Joi 的权限、outbox 和幂等边界是宿主职责，不能由默认 CLI 行为替代。 |
| 行为评测 | 仓库有基于 `vitest-evals` 的行为评测、隔离文档对照实验；该 workspace 标为 `private: true`。[评测说明](https://github.com/earendil-works/pi/blob/v1.5.2/packages/evals/README.md)、[包声明](https://github.com/earendil-works/pi/blob/v1.5.2/packages/evals/package.json) | 可借鉴评测方法；不是安装 Core 后自动具备的编码质量保证。 |
| Durable Harness | 另有 `pi-durable`，提交会话与任务状态并支持重启恢复；官方明确标为实验 API。[Durable](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md) | 是独立架构方向，不应作为本次性能调整的顺手替换。 |

## React 前端验证与 Web UI 的新增线索

官方 1.5.2 技能文档直接链接到维护者的独立仓库 `badlogic/pi-skills`。其中 `browser-tools` 提供 CDP 导航、页面 JavaScript、截图等，可用于真实浏览器中的前端验证；技能列表没有 React 专项条目。应称其为“官方文档指向的可选技能资源”，不能称为 Core 内置浏览器工具。[官方链接位置](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/skills.md#validate-and-share-a-skill)、[资源列表](https://github.com/badlogic/pi-skills#available-skills)、[Browser Tools](https://github.com/badlogic/pi-skills/blob/main/browser-tools/SKILL.md)

这套脚本的启动器当前写死 macOS Chrome 路径，并使用 `mkdir`、`rm`、`rsync`；对 Joi 的 Windows 环境需要适配，不能照搬。技能还提供复制个人浏览器 profile 的选项，Joi 若评估浏览器能力应继续使用可丢弃 profile 和受控工具入口。本次没有运行这些脚本或读取个人 profile。[启动器源码](https://github.com/badlogic/pi-skills/blob/main/browser-tools/browser-start.js)

历史 `@earendil-works/pi-web-ui` 在 v0.75.3 的说明是聊天界面组件，基于 **mini-lit Web Components**，并非 React 编码技能；本次 v1.5.2 的同一路径返回 404，不能把旧包当作当前已集成能力。[历史源码](https://github.com/earendil-works/pi/blob/v0.75.3/packages/web-ui/README.md)

另一个当前官方示例 `pi-durable-cloudflare` 确有 React 客户端，用于显示会话、流式回答和工具进度。它展示如何用 React 做 Agent 产品界面，不能据此推出 Agent 具有 React 专项编码或浏览器验证能力；示例本身也声明不用于直接生产部署。[官方示例](https://github.com/earendil-works/pi-durable-cloudflare#where-to-look)

## 与 Joi 当前接入的对应关系

以下本地事实由主任务核对，外部研究没有替代对执行路径的测试：

| Joi 事实 | 本地证据 | 判断 |
|---|---|---|
| 已创建 `AgentSession`，使用内存会话并关闭 SDK 自动压缩。 | [joi-pi-session.ts](../src/main/infrastructure/pi/joi-pi-session.ts#L17) | 不是只装 Core 的裸循环；有一部分官方会话层。 |
| 关闭 SDK 的 extensions、skills、context files、prompt templates 自动发现；未发现 `bindExtensions` 接入。 | [joi-pi-session.ts](../src/main/infrastructure/pi/joi-pi-session.ts#L20) | 官方完整 CLI 资源与内置扩展没有随 SDK 自动生效。 |
| 宿主自行解析技能并格式化给 Pi。 | [pi-sdk-skill-catalog.ts](../src/main/infrastructure/pi/pi-sdk-skill-catalog.ts#L155) | 不能把禁用 SDK 技能发现误写成“Joi 没有 Skills”。 |
| Runtime 多处设置 `toolExecution: sequential`。 | [pi-partner-engine-runtime.ts](../src/main/infrastructure/pi/pi-partner-engine-runtime.ts#L526)、[另一处配置](../src/main/infrastructure/pi/pi-partner-engine-runtime.ts#L650) | 可调查只读工具的受控并发；全局改并发前须确认写入、权限确认和共享状态约束。 |
| 宿主覆盖 `agent.beforeToolCall`，经 LocalWriteGate 处理工具调用。 | [pi-partner-engine-runtime.ts](../src/main/infrastructure/pi/pi-partner-engine-runtime.ts#L712) | 引入嵌套工具前必须检查同一 gate 是否覆盖新路径。 |
| 未发现宿主自动读取项目 `AGENTS.md` 等指令的路径。 | [工作台上下文构造](../src/main/infrastructure/persistence/sqlite-workbench-context-repository.ts#L287) | 这是已检查路径中的待补缺口，不能表述为“任何情况下都没有项目上下文”。 |
| Renderer 的 iframe 用于用户预览。 | [ConversationWorkspace.tsx](../src/renderer/ConversationWorkspace.tsx#L100) | 用户能看到网页不等于 Agent 能检查 DOM、截图或执行浏览器验证。 |

据此，更准确的诊断是：**Joi 已有工具循环和自管 Harness，但部分官方资源与工具编排层未接入；哪些影响当前编码任务，需要用固定任务评测。** 不能仅凭工具调用总数判定缺少 ReAct，也不能仅凭包已安装判定完整 Harness 已到位。

## Codemode 已验证的接入约束

1. **宿主 gate 与嵌套调用。** 官方 Codemode 经 `ctx.executeTool()` 执行嵌套工具，沿 SDK 扩展链传递 `parentToolCallId` 和取消信号；源码直接调用会话私有 `_beforeToolCall`，与事后覆盖 `agent.beforeToolCall` 的宿主入口不同。[嵌套契约](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/extensions.md#calling-other-tools)、[源码](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/agent-session.ts#L664) 主任务在已安装 1.5.2 上完成隔离内存原型：外层工具调用仅增加内存计数的内层工具。禁止逻辑只放宿主 `beforeToolCall` 时，宿主仅看到外层、内层执行一次；禁止逻辑放 SDK `tool_call` 扩展时，扩展看到两层、内层执行零次。原型使用模拟 provider、临时空目录及内存设置/凭据/会话，Node 退出码 0，已清理。**这是已经验证的接入约束，不是当前 Joi 已暴露漏洞：Joi 目前没有启用该嵌套能力。** 正式接入前须先写失败回归，将权限、outbox、稳定幂等、取消和审计贯穿嵌套路径。
2. **Codemode 与并发是两个配置维度。** 官方 `AgentSession` 把 `agent.toolExecution === "sequential"` 传给嵌套执行器；执行器会将这些调用排队。因此保留 Joi 的全局串行时，脚本写 `Promise.allSettled()` 也不会自动获得底层工具并发。即便如此，批处理和结果过滤仍可能减少模型往返；收益大小必须实测。[AgentSession 配置传递](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/agent-session.ts#L744)、[嵌套排队源码](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/nested-tool-calls.ts#L187)

## 后续可验证的范围，尚未实施

建议先用固定模型、固定仓库快照和同一编码任务记录：模型往返数、工具次数、输入输出 token、端到端耗时、验收通过率，以及取消/拒绝写入是否仍有效。对那次 53 次 bash 调用，应先区分独立读取、依赖前步输出的调查、实施与验证，再评估资源注入、只读并发、Codemode 的分别贡献；本次没有证据给出节时百分比。

优先研究可控补充：宿主注入项目指令和工具专属规则、有限的完成复核边界、只读并发或批处理，以及有实际前端任务时的浏览器验证。官方当前系统提示源码按工具贡献 `promptGuidelines`，没有可直接援引的旧版通用“优先 grep/find/ls”规则；应检查 Joi 实际提示和工具说明，不套用旧版本印象。[当前系统提示构造](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/system-prompt.ts#L81)

Durable 若以后单独评估，需要注意：官方也明确外部副作用的可重放工具仍需自身幂等，持久化执行不能替代 Joi 的副作用契约。[Durable 嵌套与重放](https://github.com/earendil-works/pi/blob/v1.5.2/packages/durable/README.md#calling-tools-from-tools)

尚未完成：真实任务 A/B、浏览器技能的 Windows 适配验证、嵌套调用 gate 的集成测试，以及默认资源发现与 Joi 自管上下文的去重/优先级设计。本次对 React 专项资源的否定结论仅限已检查的官方文档与示例索引，不代表整个生态不存在相关包。

## 已接入的对话扩展列表（2026-11-12）

包目录中的 `brower-loop` 对应 `@onkernel/browser-loop`。目录收录不代表 Pi 官方维护这三个第三方包；本轮核对发布包源码后，固定 OpenWiki 0.9.0、Browser Loop 0.12.1、CC Safety Net 2.7.11，并保留宿主 Pi 1.5.2。[Pi 包目录](https://pi.dev/packages)

| 包 | 发布包的接口与约束 | Joi 接入 |
| --- | --- | --- |
| OpenWiki | 提供 Pi 工具和工作流 Skill，宿主编写文档的流程不需要另一组模型凭据。0.9.0 要求 Node >=22.22.0。 | 适配 `HostSessionManager` 的十项协议工具，使用当前模型执行工作流，不启动独立 CLI/MCP 子进程。仓库根目录固定为工作台，工作台必须绑定 Git 根目录。 |
| Browser Loop | 正确包名是 `@onkernel/browser-loop`，云浏览器执行需要 Kernel API Key。0.12.1 的 Pi 绑定依赖 Pi 0.83.0。 | 使用普通函数工具声明与 `LoopExecutionResources`，不加载它的会话/供应商绑定，不更换 Joi 模型或流接口。Kernel SDK 固定 0.147.0，采用 17 项浏览器工具。 |
| CC Safety Net | Pi 集成在 `tool_call` 前分析命令和文件工具；该防护不是 OS 沙箱。 | 复用 2.7.11 的同一核心评估器，在宿主 gate 内执行检查；返回固定阻止说明，省去 CLI 审计文件和原始证据格式化。异常时阻止执行。 |

来源：[OpenWiki 发布包适配器](https://cdn.jsdelivr.net/npm/openwiki@0.9.0/dist/integrations/pi/openwiki.js)、[OpenWiki 包清单](https://cdn.jsdelivr.net/npm/openwiki@0.9.0/package.json)、[Browser Loop 包文档](https://pi.dev/packages/@onkernel/browser-loop)、[Browser Loop 包清单](https://cdn.jsdelivr.net/npm/@onkernel/browser-loop@0.12.1/package.json)、[CC Safety Net Pi 接口](https://cdn.jsdelivr.net/npm/cc-safety-net@2.7.11/dist/pi/index.js)、[防护能力说明](https://ccsafetynet.com/docs).

子代理与三项扩展放在同一列表，三项新扩展默认关闭。选择作为每轮配置保存在现有 JSON 快照中，不需要数据库迁移；仅通过白名单 ID 选择预置依赖，不接受 npm 地址或本地扩展路径。所有工具仍受搭档 ALL/CUSTOM 策略和工作台权限约束。原生搭档不接入这些 Pi 工具，子代理只能继承父执行显式选择的宿主工具，SDK 的任意扩展发现仍关闭。

Browser Loop 使用启动 Joi 时的 `KERNEL_API_KEY`，值不进入模型上下文、对话配置或诊断。首次执行浏览器工具才创建云会话，截图/读页面也先取得 WRITE 租约；未配置 Key 时返回明确错误。每次执行使用新浏览器，结束/取消时等待创建收尾并删除自有资源，历史 tab/ref 不跨执行重用。创建请求关闭 SDK 自动重试，同次执行保留失败的创建 Promise，避免连接结果未知时自动重复创建。真实云端创建结果未知时无法保证服务端已经清理，浏览器自身设有 600 秒超时。

云浏览器与桌面工作区的本机预览独立。本接入没有创建本机开发服务隧道，云端不能直接访问这台电脑的 `localhost`；前端验证需要提供云端可访问的测试地址。

OpenWiki 的 `begin` 恢复持久 run；跨执行继续时应再次 `begin`，不重放已完成页。当前核心协议不提供中途取消文件操作的信号，取消等待已发起操作收尾；已发生事实继续保存在宿主私有历史和包的持久 run。包内模块路径与 CC Safety Net 的文件工具评估接口不是通用稳定 API，因此版本锁与实际 SDK 回归是升级条件，不能直接改为 `latest`。

本轮验证使用临时 Git、SQLite、用户目录、模拟模型和浏览器 API 替身；验证实际 SDK 工具清单、关闭后移除、权限收窄、危险命令/敏感读取被阻止、Wiki run 恢复及浏览器取消收尾。没有调用真实 Kernel 账户，也没有把接口通过称为浏览器任务质量提升。

## Browser Loop 密钥与本机浏览器替代方案

用户提供的 `https://pi.dev/packages/@onkernel/browser-loop` 正是当前接入的包。它使用 Kernel 浏览器执行服务，文档明确要求 `KERNEL_API_KEY`，与所选模型供应商的凭据分开；示例通过 Kernel SDK 创建浏览器。包开源不代表云执行无需凭据。Joi 的适配器也走这条云端创建路径，没有本机 CDP 模式或 localhost 隧道。[包的安装与执行契约](https://pi.dev/packages/@onkernel/browser-loop)、[本地适配器](../src/main/infrastructure/pi/pi-browser-loop.ts)

目录中的 `153.7K/mo` 是月下载量，不能当作 GitHub 星数。查询时 Browser Loop 仓库为 14 星；`pi-agent-browser-native` 为 249 星；它使用的上游 Vercel `agent-browser` 约 49.9k 星。这些是查询时的显示值，不能据此推断 Windows 或 Joi 接入已验证。[Browser Loop 仓库](https://github.com/kernel/browser-loop)、[Pi 适配包仓库](https://github.com/fitchmultz/pi-agent-browser-native)、[上游仓库](https://github.com/vercel-labs/agent-browser)

| Pi 包 | 本机模式与安装 | 前端用途与限制 |
| --- | --- | --- |
| `pi-agent-browser-native` 0.9.22 | 单独安装 `agent-browser` CLI 并下载 Chrome，再安装 Pi 包。本机浏览器不使用 Kernel Key；可选 Exa/Brave 搜索另需其密钥。 | 导航、交互、截图及可发现的 QA/Electron 工具。最新版明确把原生 Windows 列为尽力支持，已有会话锁与恢复后 Electron 清理测试失败，不能称为本环境开箱即用。 |
| `pi-browser-debug` 2.0.0 | Pi 安装后，一次下载 Playwright Chromium；可启动隔离浏览器，或连接本机 loopback CDP，不依赖云浏览器凭据。 | 九项工具覆盖观察、交互、截图、页面 JS、控制台与请求失败。仓库仅 2 星，文档未给 Windows 验收矩阵；这是较小的适配候选，并非高星成熟度保证。 |
| `browser-goblin` 0.5.1 | Node >=24，包固定 `agent-browser` 0.39.2；有 Chrome 时可使用，否则下载对应版本浏览器。 | 自带响应式 QA、控制台/网络/Web Vitals、截图产物和四个技能，符合本机前端任务。包装仓库查询时为 0 星，未找到明确 Windows 资格验证声明。 |

来源：[Native 包当前文档与 Windows 限制](https://pi.dev/packages/pi-agent-browser-native)、[Debug 工具与安装](https://pi.dev/packages/pi-browser-debug)、[Debug 仓库](https://github.com/nandafirmans/pi-browser-debug)、[Goblin 工作流及后端版本](https://pi.dev/packages/browser-goblin)、[Goblin 仓库](https://github.com/sagardampba2022w/browser-goblin)。以上为文档核查，没有安装或运行这些替代包。

上游 `agent-browser` 本身提供 Windows x64 原生二进制，也支持本机 Chrome。当前官方文档额外提供 React 组件树、组件状态、重渲染记录、Suspense 与 Web Vitals 检查；React 检查须在页面脚本执行前启用 DevTools hook，且各 Pi 包固定的后端版本不一定具备最新上游的全部命令。[平台与本机安装](https://agent-browser.dev/installation)、[React 能力及前置条件](https://agent-browser.dev/react)

针对 Joi 的本机 React 验证，优先评估本机 `agent-browser` 后端，参考 Goblin 的 QA 工作流或 Debug 的小工具接口，这是基于上述约束的适配判断。Joi 仍关闭 Pi SDK 的任意扩展发现，不能把在 Pi CLI 中安装成功等同于已接入 Joi；正式接入需保留宿主权限、会话隔离、取消收尾及产物边界。此次仅补充调查，当前已提交的 Browser Loop 选择保持原样。[Joi 会话资源边界](../src/main/infrastructure/pi/joi-pi-session.ts)
