# Pi v1.5.2：工具等待时间的官方证据

调研日期：2026-11-12。范围仅为 `earendil-works/pi` 的 `v1.5.2` 官方文档、源码，以及本仓库安装的同版本 `@earendil-works/pi-agent-core`、`@earendil-works/pi-coding-agent` 发布物。以下链接均固定到该 tag；本笔记没有访问 Electron userData、会话内容或凭据，没有运行真实模型请求，也没有更改生产行为。

## 结论

简单工具的用户可见等待包含模型生成调用、工具执行、事件处理，以及模型读取结果后的下一轮回答。不能把这整个区间都解释为文件或 shell 操作耗时。Pi 没有承诺 `read`、`ls` 或 `bash` 必须等待若干秒；是否异常需要分段计时。本笔记只确定官方机制，Joi 的实际配置、持久化成本和原始会话耗时需要另行验证。[官方事件流程](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/README.md#event-flow)

## 模型往返与同轮工具

一次 assistant 消息可以包含多个工具调用。常规流程是模型生成完整 assistant 消息 → 执行这一批工具 → 把结果加入上下文 → 下一次模型请求。不是每一个同批工具之间都必须模型往返；模型如果每次只给一个工具，则连续工具通常对应连续模型请求。整个批次的最终结果都设置 `terminate: true`、`finishTurn` 要求结束、取消或出错等情况可提前结束。[官方流程与终止规则](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/README.md#with-tool-calls)

v1.5.2 的 `Agent` 默认 `toolExecution: "parallel"`。全局指定 `"sequential"`，或本批任意工具声明 `executionMode: "sequential"`，都会使整批顺序执行。并行模式仍先逐个进行参数验证与 `beforeToolCall`，全部准备完后才并发执行；完成事件按实际完成顺序发出，toolResult 消息按 assistant 原顺序提交。因此，仅从结果排列顺序不能判断是否并行。[默认配置](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent.ts#L249)、[官方并行语义](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/README.md#with-tool-calls)

## streaming、工具事件和准确耗时

`message_update` 内的 `text_*`、`thinking_*`、`toolcall_*` 是模型响应流；`toolcall_end` 代表模型完成该调用内容的生成，不代表本地工具执行结束。执行发生在完整 assistant 消息结束之后。`tool_execution_start` 在参数准备及 hook 前发出；`tool_execution_update` 才是工具自己的增量结果；`tool_execution_end` 在执行、增量事件等待与 `afterToolCall` 后发出。[响应流映射](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts#L362)、[执行与结束事件](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts#L777)

`tool_execution_end.durationMs` 和 toolResult 的 `durationMs` 只计 `tool.execute()` 的调用耗时；不计准备、hook、等待增量事件处理和结束事件处理。start → end 的墙钟时间可能更长，特别是并行模式还有整批预检等待。拒绝、未知工具等没有真正执行的结果可能没有此字段。[计时实现](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts#L777)、[并行批处理](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent-loop.ts#L555)

`Agent.subscribe()` 的异步 listener 会按订阅顺序被 `await`，并不是发出事件后立即继续。慢 listener 会阻塞后续流消费和事件处理；assistant `message_end` 的 listener 尚未完成时，工具预检不会开始。`agent_end` 的 listener 完成后，运行才进入 idle。若宿主在每个增量中返回数据库或文件写入 Promise，这些等待会形成反压；这是官方执行语义导出的诊断方向，不能据此单独断言某个 Joi 会话的根因。[订阅契约](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent.ts#L252)、[逐一等待 listener](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent.ts#L536)

## 三种工具的本地执行路径

| 工具 | v1.5.2 默认实现 | 官方证据 |
| --- | --- | --- |
| `read` | Node 文件访问与读取；普通文本可通过文件 stream 处理，图片另有检测和处理路径，不启动 bash | [read.ts](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/read.ts#L56) |
| `ls` | Node `readdir`，随后逐项 `await stat` 判定目录；默认输出上限 500 项；不启动 shell | [ls.ts](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/ls.ts#L73) |
| `bash` | 每次调用解析 shell 配置、检查 cwd，然后 spawn 新子进程，流式收集 stdout/stderr；不是常驻 shell | [bash.ts](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/bash.ts#L100) |

Windows 默认优先 Git Bash 的已知安装位置，再通过 PATH 查找 `bash.exe`；PATH 查找使用同步 `where`，设置 5000 ms 超时，这不是固定等待五秒。常规 bash 参数是 `-c`，没有默认 `-l`；传统 WSL launcher 特例使用 `-s` 和 stdin 传递命令。若模型命令自己写了 `bash -lc ...`，它会在工具启动的 shell 内另起 login shell；额外成本属于该命令及机器环境，不能归因于 Pi 默认添加 `-l`。[shell 选择及参数](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/utils/shell.ts#L20)

shell 主进程退出后还需处理 stdout/stderr。如果子进程继承管道，官方 helper 在 exit 后按输出是否静默重新计时，静默宽限为 100 ms；正常管道结束或 close 可以更早完成，不是每条命令固定额外等待 100 ms。[管道结束处理](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/utils/child-process.ts#L15)

## 官方 prompt 对 read、cat 和 ls 的引导

`read` 的官方 prompt contribution 明确建议用 read 查看文件，替代 cat/sed。默认 prompt 仅在有 bash/PowerShell、且没有 grep/find/ls 专用工具时，加入用 shell 列目录和搜索的规则；`ls` 工具本身没有额外 guideline。因此，“官方永远推荐 bash ls”不适用于所有工具配置。[read guideline](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/read.ts#L18)、[动态规则](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/system-prompt.ts#L74)

官方 `createCodingTools()` 为 read/bash/edit/write；`createReadOnlyTools()` 为 read/grep/find/ls；`createAllTools()` 另外提供 powershell。是否启用 ls 影响 prompt 生成条件，不能只看 SDK 导出了哪些工具。[工具集合](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/tools/index.ts#L185)

## createAgentSession 与自建 Agent

`createAgentSession()` 提供 session 生命周期、资源发现、设置、历史、扩展、compaction 等组合；不传覆盖项时会建立默认的文件型设置及持久会话等组件。`prompt()` 等待整次运行完成，流式 UI 应先订阅事件。换用这个工厂并没有官方的降低单工具延迟保证。[SDK 配置与生命周期](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md#configuring-a-session)

直接 `new Agent({ initialState: { systemPrompt, tools }, ... })` 只建立核心 transcript、工具声明和运行循环，不会自动套入 coding-agent 的默认 prompt 或资源发现。已有 messages 以 system 开头时，还需注意初始 prompt 不会再被插到最前。因此，把官方工具对象交给自建 Agent，并不自动获得 read/cat 等自然语言指南。[Agent 初始状态](https://github.com/earendil-works/pi/blob/v1.5.2/packages/agent/src/agent.ts#L74)

工厂自身也先建立空 prompt 的 Agent，然后由 AgentSession 从 resourceLoader、工具元数据等组装 prompt。`customPrompt` 会替换默认 preamble，并跳过默认 tools/rules/docs；append、项目上下文、skills、cwd 仍可能追加。只有 `forceSystemPrompt` 的路径才将 prompt 视为完整不透明文本。自定义 prompt 时必须明确希望保留哪些工具指南。[session 组装](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/agent-session.ts#L1683)、[prompt 分支](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/src/core/system-prompt.ts#L139)

官方 SDK 示例通过 `DefaultResourceLoader.systemPromptOverride` 替换基础文本，并用 `appendSystemPromptOverride` 控制追加内容；扩展也能修改有效 prompt。不能把“SDK 默认 prompt”视作所有嵌入方式的实际 prompt，应检查宿主最后传给模型的安全结构与工具选择，而非把原始 prompt 写入日志。[自定义 prompt 示例](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/examples/sdk/03-custom-prompt.ts)

## 建议的无内容计时方式

这是基于上述边界提出的排查方法，不是官方延迟指标。只记录随机 run/call 标识、工具名、阶段、单调时钟时间、数值 duration 和成功/失败类别，不记录参数、结果正文、prompt、路径或凭据。

1. 区分 provider 请求开始、首个模型事件、assistant 消息结束，定位模型/网络等待。
2. 分别记录工具 preflight、execute 和 after hook，使用官方 `durationMs` 对照宿主的 start → end。
3. 对每类异步 listener 单独计时，定位 streaming、持久化和展示回调是否阻塞循环。
4. 单独测临时合成文件的 `read`/`ls`/`bash`，区分本地执行成本；这种基线不能证明真实会话的等待分布。

## Joi 接入核对与本机合成测量

以下为本仓库代码核对与实测，区别于上文官方事实。截图没有逐次执行时间，不能证明原始会话的瓶颈。

- [运行适配器](../src/main/infrastructure/pi/pi-partner-engine-runtime.ts) 显式设 `toolExecution: "sequential"`，放弃同批工具的默认并行；这是受支持的策略，不是 API 误用。每次只生成一个调用时，改并行也不会减少模型往返。涉及写入与权限门禁时，不能直接全量改并行。
- 同一适配器在 `message_end` 和 `tool_execution_end` listener 返回 `saveSession()`；先 `structuredClone` 全部消息，再等待保存。[SQLite 会话存储](../src/main/infrastructure/persistence/sqlite-conversation-store.ts) 对全部消息 JSON 序列化并比较公共前缀，SQL 仅追加或替换变化后缀。不能误称每次全量重写数据库，但克隆、序列化、事务和等待均处于运行链上。
- 实时发布器会等待展示回调；[对话服务](../src/main/application/joi/conversation-service.ts) 通常按 100 ms 最小间隔决定是否保存投影，思考生命周期等事件可强制保存。该间隔是刷新节流条件，不是固定 sleep。慢存储会产生反压，实际成本尚未测量。
- [工具指南](../src/main/infrastructure/pi/pi-coding-guidance.ts) 已要求 read 替代 cat/sed、优先专用工具，并在 [合约测试](../tests/contract/conversation-pi-session.test.ts) 验证实际请求。截图中的本地文件 cat 偏离此建议；飞书 CLI 调用本身仍合理地使用 bash，且含网络请求，不能按纯 cd/ls 的成本估计。
- [展示组件](../src/renderer/ConversationOutput.tsx) 显示工具状态和思考阶段耗时，没有投影官方工具 `durationMs`；[对话页](../src/renderer/ConversationPage.tsx) 每 700 ms 轮询变更，再获取详情。截图中的 1.03 秒属于思考阶段，129245/984000 是字符估算及预算，均不能代替工具或模型耗时。

在本机 Node 中直接调用安装的 Pi 1.5.2 工具，使用临时目录内 100 行合成文本，每项连续 10 次；不请求模型、不使用真实用户数据。脚本完成后删除其自建文件与空目录。测量涵盖 tool.execute 外围墙钟时间，未涵盖 Joi hook、会话存储与界面。

| 操作 | 中位耗时 | 最大耗时 |
| --- | ---: | ---: |
| 原生 read | 1.90 ms | 5.08 ms |
| 原生 ls（单文件目录） | 0.38 ms | 0.89 ms |
| bash true | 93.81 ms | 144.18 ms |
| bash cat 合成文件 | 104.46 ms | 148.54 ms |
| bash 内再启动 bash 读取文件 | 138.41 ms | 144.48 ms |

另用真实 Pi Agent、fauxProvider 和一个空工具做差分探针，不访问网络。无等待 listener 时整轮约 5 ms；对 message_end/tool_execution_end 共 5 次回调各注入 100 ms，整轮变成约 522 ms；两次工具事件 durationMs 均为 0。该探针证实 await listener 机制能独立放大用户等待，不代表真实 SQLite 已有相同延迟。

运行 `npx vitest run tests/contract/conversation-pi-session.test.ts`：11 项通过。没有更改生产代码，未执行开发里程碑的完整构建/打包门禁，也未进行原会话性能验收。

建议先补齐 provider、execute、hook、listener 和 UI 可见时间的无内容分段测量，确认实际占比后再决定优化。当前证据支持“存在可优化的调用策略和观测缺口”，不支持“已定位截图根因”或“Pi 规定简单工具必须等待很久”。
