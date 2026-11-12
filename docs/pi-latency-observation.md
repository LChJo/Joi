# Pi 分段耗时日志（CHAT-40）

日志事件为 `joi.pi.latency`，复用现有 JSONL 诊断，不改变工具策略、会话保存顺序或模型参数。

运行 `npm run dev` 后，在对话中重现等待问题。日志同时写入启动终端和 Electron userData 下的 `diagnostics/joi-flow.jsonl`，默认 Windows 位置可用 `%APPDATA%/joi/diagnostics` 找到。文件按现有策略轮转，保留当前文件及最近两个归档。仅按 `event` 过滤即可保留本次观测。

| stage | 意义 |
| --- | --- |
| `model_request` | 调用模型边界至底层 stream.result 完成；`first_event` 是首个事件被宿主消费，`first_delta` 是首个正文、推理或工具调用增量被消费。它们是宿主观测时间，不等于服务端计算耗时。 |
| `model_stream` | 流创建至宿主结束消费，包含宿主在消费期间等待事件回调的时间。`requestId` 指向对应 model_request 的 spanId。 |
| `tool` | 从工具执行开始事件至结束事件的墙钟耗时；`sdkDurationMs` 单独保留 Pi 的工具 execute 耗时。开始前或结束后的宿主回调可能另有成本。 |
| `session_save` | 克隆会话、保存排队及实际保存的等待；`eventType` 区分事件触发和 turn_cleanup。 |
| `context_prepare` | 请求上下文准备及可能发生的压缩等待。 |
| `live_event` | 展示发布回调，包括其等待的投影持久化；达到 100 ms 记录 slow，结束时按事件类型汇总 count、durationMs 和 maxMs。 |
| `progress_check` | 进展探测回调；采用同样的慢调用与汇总策略。 |
| `turn` | 完成准备后的运行及收尾，不包含引擎初始化、工作区快照或前置派发准入。 |

相同 `spanId` 配对 started/completed；`workId` 关联同一轮的模型与执行日志，`runId` 区分 READ/WRITE 阶段等实际执行。标识只用于观测，不作为重试或副作用幂等身份。结束状态为 completed、failed 或 canceled；只有 started 而未结束的记录可用于定位仍在等待的阶段。

所有耗时使用单调时钟。阶段可以嵌套，不能把全部 durationMs 直接相加。提供者可先填满事件队列，因此 model_request completed 可能早于首个事件被宿主消费。tool.sdkDurationMs 也不能代表整个用户等待。

日志不记录工具原始调用标识、参数、结果、正文、推理、路径或凭据；工具名、内部关联标识、固定阶段、状态和数字沿用既有诊断过滤。诊断 sink 失败不抛入执行链。

先收集复现日志，再分析各段占比。本次接入没有对真实会话瓶颈作出判断。
