# 路线图与验收

2026-09-17 AC-57 增量：PC/Android 对最终结果提供快照阅读、原始 Markdown 复制、A4 PDF 和 1080px 分段 PNG 导出，默认下载/Joi。PC 使用 desktop-only API、正文摘要校验和持久 outbox；Android 本地离线排版与 MediaStore/SAF 保存。Android 各页右上角统一当前状态 i 诊断入口。规格与真机待验项目见 [全文导出验收](19-result-export-acceptance.md)。

## AC-63 Routine 定时任务

Routine 的周期、RRULE、日期边界、Workbench 可用性、原子 inbox 触发、补偿合并、幂等和安全投影以 `docs/10-requirements-traceability.md` 的 AC-63 为发布门禁；它复用唯一 Joi root scheduler，不引入第二条执行链。

## AC-64 Agent 失败自愈

单 Agent 失败只在目标详情展示；首页只在 Joi 两轮持久恢复均耗尽且目标无法完成时展示目标级失败。`OBSERVED/UNKNOWN` 不重放原 Work，先收集并验证现有产物，缺口通过无历史 DAG 依赖的补充 Work 修复；补充 Work 必须自动继承源 Work 的验收条件和访问模式下限，正文不得替代 HTML/PDF 等文件交付。内置工具可由 Joi 生成不可变 Partner revision 自动开放，但凭据、cookie、私网和 Workbench 外路径仍禁止。恢复可用或在途时首页保持 `EXTENDING`，内部 recovery input 不形成独立目标卡；`BLOCKED` outcome 不进入 Wayfinder review，存量内部派发澄清由专用 recovery input 自动解锁。详见 ADR 0016。

## AC-65 搭档实际权限与模型来源新鲜度

2026-09-20 验证兼容性增量（AC-55/AC-65）：DeepSeek 官方 Responses 端点的固定无工具探测必须显式关闭默认思考，普通探测首轮输出上限为 64 token，强制思考套餐为 256 token。存在有效非空白正文即判定 READY，达到输出上限不单独构成失败；超时、取消或供应商错误仍优先判失败。无有效正文且达到输出上限或仅有思考时，允许以 1024 token 重试同一固定无工具请求一次，不携带上一轮回复；两次共用原 15 秒总超时（强制思考套餐 30 秒），不改变思考配置或业务推理。无思考的正常空回复不重试。最终仍无正文时返回 `empty_response` / `response_truncated`，UI 不得误报网络不可达，提示不得包含响应正文或思考内容。模拟 transport 经真实 Pi SDK 覆盖官方端点、相似域名隔离、有正文截断成功、有限重试、强制思考套餐与共用超时。

新建 Pi Core、Claude Code 和新安装场景搭档默认开启各自全部可用工具；`CUSTOM` 必须能表示包括空集在内的真实工具集合，旧 revision 继续按空列表为全开、非空为自定义解释且不得原地改写。Claude 必须同时用 SDK `tools` 限制可见工具、用 `allowedTools` 免交互授权；Codex 新建默认 `workspace-write`、网络开启、实时搜索、`approvalPolicy=never`，但不得开放 `danger-full-access`。三种本机引擎每次运行都注入不可被用户提示词或 Skill 覆盖的实际权限段。

Pi READY 来源只有最近五分钟内按 source/model/credential revision 完成无工具验证才可直接派发；过期验证按 revision 合并探测。未固定搭档可跳过探测失败来源，固定来源必须停止并返回安全配置原因。运行中 401/403 先把来源移出派发集合，再做一次无工具诊断；403 只持久化 `auth_forbidden`、`model_access_forbidden`、`region_forbidden`、`request_policy_forbidden` 或 `http_403`。终态 FAILED/UNKNOWN 即使已有 engine conversation 也必须追加独立安全 ERROR；`OBSERVED/UNKNOWN` 继续遵守 AC-64 的产物验收与补充 Work 门禁。

## AC-66 结果缺口自动续跑与用户兜底

综合证据不足但下一证据层明确、无需用户判断、凭据或扩权时，Joi 必须提交 `RESULT_CONTINUE`，不得误记为硬失败。每个 Wayfinder 目标默认持久授权两层自动续跑，重启和重复 tick 不得重置或重复消费额度；额度内由 review 安排下一层 Work。额度耗尽后首页原目标卡必须提供“继续补齐/接受现状”：前者再授权两层且不重路由原始输入，后者原子清图并形成 `COMPLETED_WITH_GAPS`，保留缺口摘要且不得反哺为“达成”。详见 ADR 0017。

## AC-67 编排确定性与运行时死线

Work 依赖必须在派发时门控并在前置失败后级联取消；策略拒绝不得留下永远无法认领的 `PLANNED` Work。工作区租约竞争是正常的调度排队：等待 Work 必须保留在 outbox、短周期自动复检，并在当前持有者释放租约后自动派发，不得计入通用准备失败上限或被终结为失败。活跃租约持续心跳，租约丢失时中止；本机运行由引擎死线和组件看门狗共同收敛。每个 Work 必须具有且消费机械验收项，已产生副作用的 Turn 不得被输入恢复重复派发。

## 0. JOI-01 实施路线

2026-09-22 的受限策略进化增量以 ADR 0020 的 AC-EVO-01..06 为验收门禁：声明式单模块修改；工作台与目标版本隔离；预算预设（关/低/中/高，默认低档每日 50 次）、单槽位空闲执行、持久调用 outbox 与断点恢复；开发/封存独立评测和量化晋升；前十个可评价目标的退化监测与回退；安全设置 API/UI；取消自主修改人格/职责的工具入口。真实模型运行效果不能由模型替身测试替代，预算为“关”不发起真实模型实验。

JOI-01 是当前目标架构任务，按 W0-W7 串行收敛：W0 文档/ADR；W1 Pi 与 provider contract；W2 Model Source/工作台/Partner 领域及迁移；W3 首次连接、inbox 与最小首页闭环；W4 Work DAG/并发/outbox；W5 Local Pi/A2A 搭档；W6 唯一首页与次级管理 UI；W7 兼容切换、安全与发布验证。

纵向里程碑为 M1=W0-W3、M2=W4-W5、M3=W6-W7。底层组件完成不能替代“首页输入 -> 工作台归属 -> Pi -> 派发/结果”的可演示闭环。全部 AC 的唯一追踪矩阵位于 `docs/10-requirements-traceability.md`。

旧 M0-M7 记录保留为现有 Life/Wake 运行时的已验证基线和可复用能力，不代表 JOI-01 已完成。

2026-08-03 的信息架构增量以 AC-37/AC-40 为门禁：首页必须保持单栏可清理，具体执行只能沿“目标工作台卡 → Agent 卡 → 只读展示对话”下钻；原始引擎消息和 A2A payload 不得跨越展示投影边界。

2026-09-10 的工作台移除以 AC-40/WEB-04 为门禁：列表和详情提供“移除工作台”，单次确认明确归档后果，保留历史记录与工作目录；服务端事务拒绝仍拥有未结束 Work 的工作台，失败不产生待确认请求。重复提交复用稳定归档记录；成功退出详情并从列表移除，失败保留界面并允许重试。覆盖 `workbench-context-http.test.ts`、`workbench-change-service.test.ts` 与 renderer 测试。

2026-08-05 的编排收敛增量以 AC-41/AC-43 为门禁：Work 必须强关联原始目标且每个 run 只有一个权威终态；执行 Agent 接收私有完整 brief，可机械验证的任务必须验收后才能完成；同一目标的全部权威结果按 revision 只综合一次，首页仅展示 joi 持久化的目标级完成结论。

2026-08-06 的 harness 增量以 AC-44 为门禁：每个 (goal, revision) 至多一条复盘输入（水位与幂等键双保险，重启回放不重投）；CLEARED 地图的完成反哺恰好一次；`MAP_CLEARED` 只清 ACTIVE 地图且仅复盘 turn 可提交；复盘派发的工作绑回原 goal，结果闭环不断；复盘 turn 可代表 goal 提交 work（goal-binding 校验接受 goal 派生输入），无关 turn 冒充仍被拒。

2026-08-26 的 Wayfinder 状态链修复继续以 AC-44/AC-48 为门禁：当前层 outcome 在 map ACTIVE 时只能投影为 `REVIEWING`，复盘新增 Work 后为 `EXTENDING`，不得短暂标记最终完成；每个 goal-bound Work 由 harness component 以稳定 workId 幂等建立 path，并由 Work 终态闭路；`MAP_CLEARED` 在存储事务内重验复盘 turn、最新综合水位、无活跃/未建图 Work 和无 OPEN path。只有 map CLEARED 后首页才显示最终结果并开放继续/删除。

2026-08-26 的目标 Agent 终态投影以 AC-40/AC-53 为门禁：工作台全局 Agent 页继续用 `IDLE/BUSY` 表示 resident instance availability；从目标详情携带 `goalId` 查询时，卡片必须显示该 session 在该 goal 中的活跃或最新 partner run 状态。已完成 run 必须保持 `COMPLETED`，不能因实例已回到可复用 IDLE 而伪装成尚无执行结果。

2026-08-06 的可靠性修复：失败 turn 收尾必须中止其推理会话（残留流状态不得毒化后续 turn）；同一输入连续即时失败超过上限即停摆，禁止 failTurn→重投 的无限崩溃环；`joi-task-component.test.ts` 锁定停摆上限，`sqlite-work-plan-outbox.test.ts` 锁定 goal-binding 双向语义。2026-08-20 起 migration 040 将该停摆持久化为独立失败事实，不再伪造成用户取消；首页显示安全原因码、自动尝试次数、是否已启动执行和固定处理建议。

2026-08-06 的术语迁移以 AC-45 为门禁：产品文案统一为“工作台”，代码契约统一为 `Workbench/workbenchId/workbench.*`，HTTP 统一为 `/api/v1/workbenches`；migration 038 无损升级 037 的表、列、外键、枚举和待处理 outbox。旧 migration 001–037 只作为升级事实保留旧物理名，不再定义当前产品术语。

2026-08-07 的 UNKNOWN 收敛修复以 AC-41/AC-43 为门禁：只有 `WAITING_INPUT`/`WAITING_AUTH` 可保持 Work `WAITING` 并显示需要用户；不可恢复的 `UNKNOWN` 必须终结为 `FAILED`，继续 result-set 综合且不得制造无操作入口的“需要你”。migration 039 修复 schema 038 的存量错误状态、活跃任务投影与尚未综合的 UNKNOWN result member。

2026-08-19 的搭档失败恢复增量以 AC-35/AC-41/AC-43 为门禁：失败结果只公开 `phase/reasonCode/retryable/sideEffectState`；仅 timeout/connect/429/5xx 且未观察到工具或文件副作用时，Joi 可把 READY model source 固定到新的 immutable Partner revision，并以同一 Work、全新 action/dispatch attempt 重派。鉴权、余额、配置、Skill、安全拒绝及副作用 `OBSERVED/UNKNOWN` 禁止盲目重放；恢复后旧 result revision 不得提前写入目标完成 outcome。

2026-09-03 的搭档权限与 403 自愈增量以 AC-65 为门禁：新建本机搭档默认全开，显式 `CUSTOM` 才按实际列表收窄且可关闭全部工具；运行提示必须与最终 SDK/工具参数一致。Pi 来源增加五分钟 freshness gate 与 revision 级并发合并，运行时 401/403 立即摘除并无工具复诊；403 原文只在内存分类，不进入 revision、结果或诊断。已有 engine conversation 不得覆盖终态错误事实。

2026-08-20 的 Pi Skill 派发修复以 AC-14/AC-33 为门禁：Skill catalog、frontmatter、递归发现和 prompt catalog 必须复用锁定版本的 Pi SDK；只向 Pi 暴露被选中 Skill 的 `name/description/location`，正文由 Agent 通过 `read` 按需加载。显式 Skill 路径加载必须关闭默认 package/project discovery；`read` 只能访问工作台与被选中 Skill 根目录。旧引用、同名碰撞、加载失败或收窄工具列表遗漏 `read` 必须在模型/工具启动前收敛为 `CONFIGURATION/NONE`，并向用户说明可安全修正后重试。搭档保存和搭档设置列表同时复用 exact Skill validator；历史脏 revision 以脱敏 `ACTION_REQUIRED` 配置状态展示，编辑器在移除失效引用或启用 `read` 前禁止提交，避免用户到派发时才发现。bash 只继承精确非敏感运行基线；脚本型 Skill 的其他环境变量保持默认拒绝，必须由当前精确选中的 Skill 通过 `metadata.joi_required_env` 声明、由 `JOI_PARTNER_ENV_PASSTHROUGH` 按变量名授权且已被 Joi 进程继承，三项同时满足才可注入，不能泄露给其他 bash Partner。非法声明必须在启动前失败；命中缺失凭据错误必须收敛为 `WAITING_INPUT`，显示变量名、授权与完整重启动作，不得交由模型以 `BLOCKED` 文本伪装成完成。
2026-08-21 的 Pi core 网页研究增量以 AC-49 为门禁：默认工具目录直接提供受控 `web_search`、`fetch_content`、`get_search_content`，无需切换 engine；适配器仅访问公开 HTTP(S)，在 DNS/重定向阶段拒绝 loopback/私网/链路本地和凭据 URL，并限制超时、响应大小、搜索结果和 runtime 内存缓存。HTML 先做可读性抽取，GitHub 仓库根 URL 优先读取公开 README，不执行 clone、cookie 注入或外部文件写入；第三方 Pi package 不被动态加载。

2026-08-18 的命名与环境收敛以 AC-46 为门禁：工作台命名聚焦长期工作聚类和运行环境，Agent 命名聚焦可复用能力聚类；前端调试/分析工作创建的受管目录固定为 `aimanadebug`，角色型 `资深程序员搭档` 归类为 `编码工坊`，创建与重建必须使用同一规则。

2026-08-18 的首页首问投影收敛以 AC-47 为门禁：输入持久化为 `PENDING` 后，在 Workbench 尚未绑定前也必须以 `ARRANGING`/“等待归属”目标卡进入 home-feed；绑定后沿同一 `inputId` 升级，未归属 `CLARIFICATION_REQUIRED` 只进入“需要你”列表，不能重复显示。

2026-08-18 的首页进度可见性收敛以 AC-48/AC-64 为门禁：`progressing` 必须同时显示由持久化事实推导的阶段、Agent 数、Work 完成/总数和已用时间；单 Agent 失败计数只在目标详情展示，首页只展示目标级不可恢复失败。其余只展示安全枚举和计数，不展示 ETA、原始执行消息、模型标识、路径或错误正文；继续使用 HTTP home-feed 轮询与本地操作后的即时刷新，不新增 SSE/WebSocket。终态目标提交“继续”后必须先即时显示 `正在提交继续请求`，服务端确认后再进入 `queued`/`正在安排`；接口失败时撤销提交态并保留可重试错误，提交往返本身不得形成静默 gap。

2026-08-24 的直接回答结果收敛以 AC-50 为门禁：`DIRECT_ANSWER`、`TEAM_READY` 与无工具普通回答必须把非空最终 Markdown 有界脱敏后写入独立 Turn completion；写入与 Turn/Inbox 完成同事务且校验 input/turn 归属。首页仅在输入已消费且没有 result-set 时投影该 completion；当前 revision 的 Goal outcome 始终优先，重试期间不得展示旧回答，诊断不得记录回答正文。

2026-08-24 的搭档选择交互收敛以 AC-51 为门禁：`instanceId/sessionPolicy` 冲突可无副作用机械修正时必须先自动修正；一次纠正后仍需用户决定搭档时持久化 `partner_selection_required`，首页只列出 ACTIVE 且配置有效的搭档卡。点击以稳定 `partnerId` 原子匹配当前澄清并继续原输入，该卡不得显示自由输入框，具体安全 prompt 不得再被通用派发文案覆盖。

2026-08-24 的搭档长任务超时收敛以 AC-52 为门禁：本机 Pi 搭档不设置整次 Work/run 总时限；消息或工具事件持续产生时可一直运行，连续 20 分钟无任何进度才 abort 并返回 `partner_run_idle_timed_out`。每个工具调用独立限制为 15 分钟且不能被工具参数放宽，超时形成 `partner_tool_timed_out`；所有 timer、订阅与 AbortSignal 在终态后释放，既有副作用重放禁令保持不变。

2026-09-11 AC-52 调度兜底修正：Pi 的消息流与工具生命周期进度通过无正文回调刷新外层 watchdog，不依赖对话展示投影；持续有进度的运行不得被 32 分钟总时长截断。连续 32 分钟无进度的调度仍以不可重放 UNKNOWN 收敛，Pi 引擎自身 20 分钟 idle 与工具 15 分钟限制先行生效；Claude/Codex 保留原生总时限。回归覆盖超过一小时的持续进度、停止进度后的兜底以及临时/常驻实例的进度传递。

2026-08-25 的等待动作与 Actor 状态收敛以 AC-53 为门禁：搭档进入 `WAITING_INPUT` 时必须同时持久化绑定精确 input/Work/run 的用户动作；问题回答或恢复决策原子解析为 `RESOLVED`，无需模型源即可用同一稳定 action id 恢复原 Work，崩溃重试不得生成第二次派发。无动作的孤立 WAITING 由工作台 actor 修复为一键“继续原工作”卡，在修复窗口内不得谎报“需要你”；Agent 展示状态同时读取权威 run，不能被 resident instance 的 IDLE 覆盖。所有远端重试和孤儿收尾跨 tick 收敛，根 tick 不等待长 I/O。

2026-08-25 的共享工作目录收敛以 AC-54 为门禁：工作台 workspace binding 仍是各自 cwd 权威，但不得对物理 root 建立跨工作台排他所有权；多个工作台绑定同一目录必须成功，绝对路径仍不得进入 DTO/诊断。不同 workspace ref 指向同一 root 时，READ/WRITE lease 必须落入同一冲突域，保持多读并发、写与其他活动访问互斥。

2026-08-25 的搭档模型配置与连通性收敛以 AC-55 为门禁：本机 Pi 搭档切换模型源时必须同步显示该来源的 active model，更新接口以显式 `null` 清除旧 pin，保存成功后读取最新 immutable revision；应用层在追加 revision 前拒绝非 READY 来源或来源/模型不匹配。搭档卡可发起固定极小、无工具、无 Work/run、无工作区副作用的模型验证，并仅展示持久化的安全状态、来源/模型、时间和稳定原因码；A2A 不提供伪连通测试。Claude Code 与 Codex 必须由用户显式点击后启动各自原生 backend 的无工具最小真实调用，PATH 探测不能作为测试成功；超时或未收到成功 result 必须返回安全失败状态。

2026-08-24 的部分失败目标综合收敛继续以 AC-43 为门禁：综合 Turn 必须显式提交目标级 disposition；成功至少基于一个已验收完成 Work，并由 Joi 语义判断现有证据足以回答原目标。当前 COMPLETED outcome 的权威性高于失败 Work 计数，首页仍标记完成并把异常降级为可点击搭档入口；无安全下一步的关键缺口才写 BLOCKED，存量 outcome 无损回填为 COMPLETED。可安全补证的缺口按 AC-66 使用 `RESULT_CONTINUE`。

2026-08-26 的 AI Berkshire 大型场景预设包以 AC-56 为门禁：内置快照必须可脱离来源 checkout 运行，二十个 canonical workflow 与写作 overlay 收敛为六个子团队、十五位共享搭档；安装以 pack/role 稳定绑定并可从部分失败继续，重复安装不得覆盖用户 revision、启用停用搭档或产生重复角色。搭档页提供子团队和完整套件的一键安装；财务计算与研究审计只通过固定、有界、不可执行任意代码的工具完成。

2026-08-27 的 Android 原生远程入口以 AC-57 为门禁：桌面与 Android 使用独立实现的 iroh transport，同网优先点对点直连、失败后自动走默认的 `remote.joilab.top` 中继，同时允许手动配置其他 HTTPS relay；`joi://pair` 票据十分钟且一次有效。应用层继续使用 HMAC/HKDF/AES-GCM、严格递增序号和 `feed.get/message.send` allowlist；每台 App 有独立设备密钥，可同时连接并逐台撤销。App 只提供竖屏首页任务卡与文字提交，不依赖浏览器、Cloudflare、DCDN 或额外 WebSocket 网关。详见 ADR 0013。

2026-08-28 的多场景套件目录以 AC-58 为门禁：价值研究套件继续保留，原六个内置场景分别收敛为编程与调研分析套件，Pi core 最近六个可用本机 Skill 动态收敛为内置 Skills 套件。所有套件复用稳定 pack/role 绑定、子团队和完整安装语义，重复安装不得覆盖用户 revision 或产生重复角色；主目录退役平铺场景卡，但旧 scenario HTTP 契约继续兼容。无 Skill、加载失败和安装中状态必须可解释且不得触发空安装。

2026-08-29 的搭档提示词查看与编辑以 AC-59 为门禁：普通搭档列表不得返回提示词正文或私有引用，只返回是否已配置。编辑页必须由用户显式点击后，才通过受 session、Origin 与 CSRF 保护且禁止缓存的接口读取当前提示词；读取失败不得显示内部异常。用户可选择完整替换或仅追加新指令，追加必须由服务端基于当前活跃 revision 合并并以空行分隔，两种操作都生成新的私有 prompt row 与不可变 Partner revision，未实际修改提示词时保存其他字段不得重写提示词。

2026-08-29 的 Agent 运行时消息流以 AC-60 为门禁：本机 pi-core Agent 启动后必须立即写入任务展示快照，并把 assistant `text_delta`、工具名和工具完成/失败状态按有界节奏更新到同一 run；thinking、工具参数、原始工具结果、A2A payload 和凭据不得进入 live DTO，工具摘要里出现的绝对路径必须先缩写为「盘符/根 + 末三层」。流式快照和终态完整投影都按 `(agentId, runId)` 事务替换，不得按 token 无限追加或重复内容；展示写入失败不得改变 Work/run 权威结果。renderer 只对当前选中的 RUNNING/WAITING Agent 做 750 ms HTTP 轮询并拒绝迟到响应，终态停止，不恢复 SSE/WebSocket。

2026-08-29 的产物快捷操作与工具记录降级以 AC-61 为门禁：本机运行采集新建/修改文件和新建目录的内部 workspace 相对引用，Agent 工作记录与最终结论只显示不含路径的稳定产物元数据；桌面窗口点击打开、右键定位，目录点击打开目录。动作接口必须是 write-auth、desktop-only，并按 Agent/goal、Workbench、权威结果和真实 workspace root 重新解析，拒绝缺失、遍历与符号链接逃逸。LAN 不显示可操作按钮且调用返回 403。工具调用/结果默认压缩为一行（其中的绝对路径缩写为「盘符/根 + 末三层」），安全正文仅在显式展开后显示。

2026-08-30 的本地 CLI 执行修复继续以 AC-33/AC-55 为门禁：Codex one-shot 必须使用原生 Codex conversation 并正常结束 stdin，Codex resident 不得配置为 Claude backend 或 Claude-only resident driver；Claude Code 保持原生 Claude backend。CLI stream 只有收到 success result 才算完成，异常、非成功 result 或无终态都必须携带稳定 `ENGINE` failure facts 回流，副作用未知时禁止自动重放，并在对应 Agent 工作记录中显示安全 ERROR 条目。可用性 probe 必须把 native error 归一为稳定安全原因码并写入不含原文的 settled diagnostics，使登录、模型、限流、服务、进程与存储故障可区分、可追踪。Electron 由 Codex/Codux 会话启动时，Codex 子进程必须隔离上层会话专用的 home/API key 与 managed-package 覆盖并使用桌面用户正常 CLI 登录缓存；可执行文件不得来自宿主 managed package 或 App 自身 `node_modules/.bin`，必须继续使用用户 PATH 安装。非嵌套 shell 配置不得被改写。

2026-08-31 的官方 Agent SDK 切换以 AC-62 为门禁：生产依赖不得包含 `@rd-efficiency/agentsdk`；Claude/Codex 分别通过官方 SDK 和用户 CLI 运行。供应商 stream 必须先归一为 Joi 自有安全事件再投影到 Agent 记录，工具参数/命令/结果、reasoning、原始错误、凭据和绝对路径不得跨越端口。Claude 交由用户 CLI 解析本机配置与认证（兼容环境 `ANTHROPIC_API_KEY`），不得仅因进程缺少 API key 拒绝已安装引擎，并按标签恢复 session；Codex 原样传递模型，以显式只读/工作区可写、网络和 web search 权限映射 ThreadOptions，approval 固定 never。schema 047 保存显式配置并为旧工具列表提供确定兼容映射；旧无标签 session ref 必须开启新 session。probe 使用同一官方适配器，生产包保留 JS bridge 但排除平台 CLI 二进制。

## 1. 当前状态

| 阶段             | 状态   | 产物                          |
| ---------------- | ------ | ----------------------------- |
| JOI-01 M1（W0–W3） | 完成（自动化） | 文档/ADR、模型源、工作台/Partner、inbox 与最小首页闭环 |
| JOI-01 M2（W4–W5） | 完成（自动化） | Work DAG/outbox、本机 Pi 与 A2A adapter；真实互操作仍属 W7 |
| JOI-01 M3（W6–W7） | 进行中 | W6 界面收敛已有自动化证据；W7 真实环境与发布门禁未闭合 |
| AI Mana 配套扩展 | 外部未完成 | 当前仓库只有协议与 Hub adapter 证据 |

开发已经在本仓库中开始。当前证据与未执行 concerns 见[发布验收报告](09-release-validation-report.md)；不得把未执行的真实环境门禁当作 MVP 完成。

## 2. 推荐工程结构

创建工程时采用单仓库、单 package 管理：

```text
joi/
├── docs/
├── src/
│   ├── main/
│   │   ├── domain/
│   │   ├── application/
│   │   ├── infrastructure/
│   │   │   ├── a2a/
│   │   │   ├── persistence/
│   │   │   ├── scheduler/
│   │   │   └── security/
│   │   └── interfaces/http/
│   ├── preload/
│   ├── renderer/
│   └── shared/
├── tests/
│   ├── domain/
│   ├── integration/
│   ├── contract/
│   ├── renderer/
│   └── e2e/
└── resources/migrations/
```

领域层不得依赖 Electron、SQLite、HTTP 或 A2A SDK。公共 DTO 和 schema 放在 `src/shared`，但数据库记录与远端 SDK 类型不能直接跨到 renderer。

## 3. 历史兼容基线：旧 M0–M7

本节保留原 Life/Wake 运行时的建设与验收记录，供兼容层和可靠性能力追溯。这里的“完成”只表示当时范围内的仓库证据，不是上文 JOI-01 M1–M3 的状态，也不能推出当前 MVP 已发布。

### 旧 M0：工程与 Harness（自动化完成）

目标：建立可重复开发、测试和打包的空工程。

交付：

- Electron + React + TypeScript + Vite 工程。
- lint、typecheck、unit、integration、renderer、e2e、production build 命令。
- 项目 Harness、模块边界、ADR、CI 和 Windows/macOS 打包骨架。
- 可机器校验的 import boundary rules；新增未分类生产目录默认失败。
- 测试数据库、临时 userData 和凭据替身，禁止测试访问真实用户数据。

门禁：空应用能启动、打包并在 Windows/macOS 打开；Domain 导入 Electron/SQLite/HTTP/A2A SDK 的反例测试会失败；所有验证命令为 0。

### 旧 M1：持久化、HTTP 与单管理员（自动化完成）

目标：建立不依赖 Agent 的 Runtime 基础。

交付：

- SQLite migration、Repository、事务、outbox、runtime lease。
- loopback + 可选 LAN 双 listener。
- 管理员口令、桌面 bootstrap、LAN session、CSRF、SSE cursor。
- Life CRUD、Agent Connection 空壳、诊断和备份 manifest。

门禁：LAN listener 失败不影响桌面；重启后 Life 与 SSE 序号保持；Token/口令不出主进程。

### 旧 M2：A2A Gateway 与 AI Mana 配套扩展（Hub 自动化完成；外部扩展与真实互操作待验收）

目标：建立真实局域网 Agent 调用和可信主 Agent协议。

joi 仓库交付：

- Card/Token onboarding、network policy、Card 漂移。
- stream/get/cancel/resubscribe、幂等 messageId、input/auth、Artifact。
- 按 Agent Connection/credentialVersion 共享的 429/503 breaker 与 `Retry-After`。
- `WakeEnvelope`、`LifeActionEnvelope` schema、readiness 与 fenced fallback。

AI Mana Front 独立交付：

- 识别 `urn:aimana:digital-life-runtime:v1`。
- 无副作用 readiness。
- 受信任运行时指令和结构化 DataPart 输出。
- 保持普通 A2A/Workspace/Space 客户端兼容。

门禁：真实 AI Mana Agent readiness、流式动作、重启恢复、Token 轮换和 Card 漂移全通过；两个 Life 共用连接时只打开一个脱敏 breaker，冷却期间事件不丢失。

### 旧 M3：事件与唤醒内核

目标：形成最小持续生命循环。

交付：

- Life lifecycle、持久事件队列、Arbiter、Wake/WakeTurn。
- EventTypeRegistry、运行中 event signal、Wake liveness 和失败退避。
- Context assembler、Wake/Turn/Injection/FlowEvent 审计、ActionProcessor、一次 repair、意识残留。
- 用户消息、出生、恢复、表达、sleep 与紧急停止。
- 每生命单主 Wake、Hub/Endpoint 并发和 outbox dispatcher。

门禁：生命能出生、回复、休眠、自设一次性闹钟并在重启后再次醒来；运行中插话不取消当前调用、不重复渲染且不提前消费；任一 Turn 的输入引用和动作因果链可以从审计记录重建。

### 旧 M4：事务、记忆、作息与协作（Hub 自动化完成；真实跨机互操作待旧 M7）

目标：完成“跨天连续 + 多 Agent”的产品闭环。

交付：

- Affair、Todo、Alarm、Schedule、等待关系。
- Alarm occurrence 到 Event 的原子/幂等投递。
- 活动记录、意识残留、情景记忆、语义记忆、概念卡优先、FTS5 召回和记忆代谢。
- 主 Agent + 协作者 allowlist、异步 delegate、结果事件。
- 受预算自治、安静时段、空闲探索和每日重置。

门禁：两个协作者并行完成后主 Agent被新事件唤醒；context 过期后用有界记忆重建；等待中的 Affair 不阻塞其他事务；多个同时到期 Alarm 在锁冲突或投递失败后不丢不重。

### 旧 M5：完整 Web 体验

目标：让核心能力无需阅读协议即可使用。

交付：

- 首次设置、Agent 添加、三步生命创建。
- 全部生命、活动时间线、输入框、状态侧栏。
- 事务/待办、记忆、作息/闹钟、Agents、设置与诊断。
- input/auth、Artifact、失败重试、预算追加和紧急停止。
- 768 px LAN 浏览器和 960 px 桌面窗口响应式行为。

门禁：新用户 10 分钟内创建并启动生命；所有状态有文本反馈；键盘可完成主要路径；用户消息与协议状态不混杂。

### 旧 M6：恢复、安全与桌面生命周期

目标：从演示升级为可长期运行的本机产品。

交付：

- crash marker、启动恢复、unknown invocation 人工处理。
- 一致性备份、quarantine 恢复、migration 回滚。
- 托盘、开机启动、显式退出、强更重启语义。
- SSRF、凭据、Artifact、日志、Origin/CSRF 和会话硬化。
- 资源上限、磁盘不足、健康状态和脱敏诊断。

门禁：在各关键事务点强制杀进程后均能恢复；备份恢复不重复远端副作用；安全测试全绿。

### 旧 M7：真实环境验收与发布

目标：完成第二台机器和真实 Agents 的闭环。

交付：

- Windows、macOS 安装包与升级路径。
- 一台 Hub、至少两台/两个局域网 Agents、一台 LAN 浏览器的测试报告。
- 性能、长稳、恢复、隐私与发布检查单。

门禁：本页第 6 节的端到端场景全部通过，遗留 concerns 明确记录，不把未执行门禁标为通过。

## 4. 历史基线测试策略

### 4.1 测试层次

| 层                      | 覆盖内容                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| Domain unit             | 状态机、EventTypeRegistry、Wake liveness、退避、预算、动作校验、记忆评分、时间规则 |
| Persistence integration | migration、事务、外键、幂等、outbox、lease、崩溃点                                 |
| A2A contract            | Card、stream/get/cancel/resubscribe、readiness、Envelope、interaction、Artifact    |
| HTTP contract           | auth、CSRF、DTO、错误码、游标、SSE 重连                                            |
| Renderer                | 创建向导、时间线、状态、input/auth、设置、响应式                                   |
| Electron e2e            | 首次设置、托盘、窗口关闭、LAN listener、更新重启、备份恢复                         |
| Interop manual          | 真实 AI Mana、第二机器、网络中断、Token/Card 变化                                  |

关键回归测试必须单独命名并长期保留：

- 同一运行中消息只进入持久事件和轻量信号，不重复成为 session/user message。
- Agent 未读取、Wake 休眠或 Hub 崩溃前，事件不得提前 CONSUMED。
- in-process marker、Turn heartbeat、startup grace 与 stale 四条 Wake liveness 路径。
- ActionDispatched 必须有 Observation、ToolError 或 ExecutionFailed 结局。
- 429/503 breaker 跨 Life 共享、正确解析两种 Retry-After 且不保存明文凭据。
- Alarm 投递 event/outbox 失败后仍可重试；并发 tick 只产生一个 occurrence event。

### 4.2 质量门禁

- TypeScript strict，不允许新增未解释的 `any`。
- lint 与格式检查零错误。
- Domain、application 和新生产模块 statements/branches 均至少 90%。
- 所有 migration 必须有空库、上一个发布版本和失败回滚测试。
- 所有外部副作用路径必须有“提交前崩溃、发送后无响应、收到终态前崩溃”测试。
- 文档相对链接、EventTypeRegistry schema 和分层依赖矩阵必须进入 CI。
- 包内容检查不得包含测试 Token、真实 userData、开发 `.env` 或源码绝对路径。

建议固定命令：

```text
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:e2e
npm run build:prod
npm run package:verify
```

## 5. 历史基线需求追踪

| 需求组          | 主里程碑 | 必须验收                           |
| --------------- | -------- | ---------------------------------- |
| LIFE / WEB 基础 | M1、M5   | 创建、启停、LAN 登录、状态展示     |
| AGENT           | M2       | Card/Token、readiness、漂移、停用  |
| EVENT / ACTION  | M3       | 持久事件、Wake、repair、表达与停止 |
| MEMORY / RHYTHM | M4       | 召回、代谢、闹钟、作息、预算       |
| 多 Agent 协作   | M4       | 异步 delegate、结果回流、部分失败  |
| 恢复与安全      | M2、M6   | 幂等、Task 恢复、SSRF、备份、凭据  |
| 桌面与发布      | M6、M7   | 托盘、强更、双平台包、第二机       |

## 6. 历史基线端到端验收场景

### E2E-01：出生与首次休眠

连接支持扩展的主 Agent，创建生命并出生。生命处理 `system.birth`、表达第一条消息、写意识残留、设置闹钟并进入 SLEEPING。

### E2E-02：运行中插话

主 Agent执行长任务时用户发送两条消息。当前 Invocation 不被取消；消息立即显示为已持久化事件，只通过轻量 eventId 信号通知运行循环，并在下一 Turn/Wake 按原顺序各读取一次。Agent 真正读取前事件不标记 CONSUMED；在信号发送后强制终止 Hub，重启后消息仍可被读取且不重复渲染。

### E2E-03：跨天自我唤醒

主 Agent设置未来闹钟。关闭窗口、保持托盘运行，到点自动唤醒；随后重启应用，生命仍能从残留和记忆继续。

### E2E-04：多 Agent 协作

主 Agent同时委派两个协作者。一个成功、一个失败；成功结果与失败分别形成事件，主 Agent选择降级方案并向用户表达，不丢失主 Affair。

### E2E-05：input/auth

协作者先请求普通 input，再请求 auth。主 Agent可处理普通问题；auth 只能由用户处理。回答/授权均绑定原 interaction，重启后仍可恢复。

### E2E-06：远端与 Hub 崩溃

在发送前、接受后、stream 中和动作提交后四个点分别终止 Hub。恢复后通过 outbox/messageId/taskId 得到唯一结果，不产生重复副作用。

### E2E-07：context 过期

远端清理主 Agent context。下一次调用识别 task/context not found，创建新 context，注入有界 persona/Affair/残留/记忆并继续。

### E2E-08：预算与安静时段

耗尽自主唤醒额度后生命进入 BUDGET_PAUSED；用户消息仍被接受但若无调用额度则明确等待。安静时段内部记忆整理可运行，普通表达延迟发送，空闲探索不运行。

### E2E-09：LAN 控制面

第二台局域网设备用管理员口令登录，接收 SSE、发送消息、回答 interaction、暂停生命。浏览器开发工具、网络响应和存储中均不存在 A2A Token。

### E2E-10：备份恢复

创建包含生命、记忆、事务和 Artifact 的备份，恢复到干净数据目录。数据与 hash 正确，Web 会话被撤销，Agent 要求重新输入 Token，旧远端未知 Task 不自动重发。

### E2E-11：Endpoint 退避与审计

两个 Life 共用同一 Agent Connection。远端依次返回带数字秒和 HTTP-date 的 429/503；Hub 只打开一个共享 breaker，较短冷却不覆盖较长冷却，期间消息仍进入事件队列。冷却后调用恢复，并可从 Wake、Turn、Injection 和 FlowEvent 重建从消息到正式动作的因果链，日志中不存在 Bearer、正文或完整 Origin。

### E2E-12：Android 原生远程扫码、切路与撤销

2026-09-07 AC-57 增量：支持选择已有工作台或自动路由发送；阅读完整展示正文、已保存结论、目标内搭档记录与产物信息；回答澄清、继续已结束对话、取消、按桌面允许状态移除和关闭历史复核。`home.v2` 声明能力，旧桌面降级。只读快照按连接分页、响应小于 96 KiB；发送回执与刷新分离，未确认的相同草稿/工作台复用幂等键，动作不自动重放。前台首页约 2 秒、当前活跃记录约 1 秒刷新，后台暂停，过期会话结果不得覆盖新会话。不得新增运行中插话、文件访问或管理配置。

2026-09-07 AC-57 扫码恢复：初始原生票据必须保留配置的中继地址，不依赖异步上线时序（地址存在不代表中继在线）。首次连接在发送配对握手前断开时仍重试 pair；发送后确认丢失时尝试不含 pairingId 的 resume，被拒绝后可回到 pair，保持二维码一次有效策略。验证主机证明后才保存恢复凭据。首配总计两分钟未成功则返回扫码入口并提示，不清除已有持久凭据。升级两端后应从新版桌面生成新二维码；旧票据不会自动补上中继地址。自动化覆盖真实 sidecar 票据、首配故障与确认丢失；真机跨网验收仍需实际 Android 设备。

2026-09-09 AC-57 连接生命周期：控制端按 relay 配置复用有界端点缓存，首拨失败后在同端点有限等待上线及重拨，单次失败只关闭本次连接，不能关闭其他活动连接。关闭 FFI 句柄须立即取消包括拨号在内的原生任务；全部拨号失败仅淘汰对应端点。中继离线不得阻止可达局域网直连。原生拨号/就绪总预算 28 秒，Flutter 外围预算 45 秒，连接后应用握手独立 15 秒；仍受首配两分钟总上限约束。诊断版本 remote-diag-3/nativeDiagnosticsV3 暴露静态重拨/上线结果及失败码。真实 QUIC 回归覆盖挂起首拨后成功、端点复用与关闭隔离、取消、耗尽预算和离线 LAN；另跑生产连接器公网中继收发。访客隔离 Wi-Fi、普通 LAN、蜂窝三场景以真机验收为准。

2026-09-07 AC-57 公网 TLS 兼容性：两端共享 Rust 核心使用 AWS-LC 后端，优先提供 X25519MLKEM768，同时保留 X25519 等经典算法协商；HTTPS 仍验证证书链、主机名并发送 SNI。禁止通过关闭证书校验、明文 relay 或额外代理修复连接。离线回归应检查实际主机 TLS 配置，公网验收必须运行 `deployed_relay` 强制中继双端收发测试，不能以 HTTP 健康检查替代。具体证据与边界见 ADR 0013。

2026-09-07 AC-57 分片接收：路径检查、手机发送和主机发送不得丢弃接收中的半帧；取消后必须保留头部与正文进度，后续完整帧仍正确对齐。自动化须覆盖真实 QUIC 与导出 FFI，验证两秒 tick、并发发送、半帧关闭和非法长度/截断的拒绝行为；不得通过增大超时或取消安全边界掩盖断连。

桌面启用原生远程并生成二维码；两台 Android App 依次绑定后可同时看到与本机首页一致的任务卡并提交文字，重启后使用系统安全存储中的独立凭据恢复。同一 Wi-Fi 显示直连，关闭 Wi-Fi 后可经 iroh 中继恢复。第二次使用原二维码失败；桌面撤销其中一台后，该连接关闭且不能恢复，另一台不受影响。桌面状态 API、诊断和 sidecar/中继输出均不存在节点私钥、设备密钥、票据或正文。

2026-09-08 AC-57 连接诊断增量：手机保留最近失败与至多 40 条白名单阶段/错误记录，显示尝试次数并可复制，不再把未连接的首页显示为“没有任务”。区分原生端点创建/拨号/开流、配对握手、凭据保存和首页加载；Android 原生上下文状态进入诊断。桌面设置展示当前运行最近 50 条记录，并将白名单事件写入轮转 joi-flow 日志；原生 QUIC 到达证据先于应用层握手。严禁包含设备标识、地址、二维码、异常原文、凭据或业务正文；未知错误归一为固定代码。真机根因以两端同一时间段的诊断证据确定，不用自动化通过替代。第二版诊断须在等待入站握手前记录 quicIncoming，按类型区分超时、重置、关闭、QUIC/TLS/身份验证失败；真实对端关闭回归验证分类，TLS 分类由类型化错误测试覆盖，错误原因原文不得输出。

## 7. 发布门禁（继续适用）

2026-09-22 统计页增量以 ADR 0021 的 AC-STATS-01 至 AC-STATS-06 为门禁：设置下方提供独立统计入口，按本地时区、日期、工作台、模型和用途筛选 Token 总量、输入/输出趋势、日历/时段热力图、模型排名、工作台目标状态和高消耗目标 Top 10。只计供应商报告的 Token，输入包含缓存、输出包含推理，细分不重复累加；缺失用量显示未知，不补算历史正文。累计快照去重，失败/取消保留已报告消耗，恢复未终结调用为中断，持久采集异常必须可见。目标完成统计以目标最终收口为准，综合结果完成但仍在评审或继续执行时不得提前计数。全套固定门禁及浅深主题三种宽度视觉复核通过后才可交付。

2026-09-07 的搭档证据传递修复继续以 AC-67 为门禁：执行与恢复时，从私有结果存储加载同一 input/Workbench 下其他已完成 Work 的最新派发权威正文及产物元数据，不能把 320 字符摘要当作全文或要求用户手动粘贴已有结果。无工作区权限也必须获得完整已存正文；本机各引擎与 A2A 共用执行上下文。失败验收、迟到、冲突、已取消、执行中及其他目标的正文不得注入；正文不进入 safe snapshot、展示 DTO 或诊断。文件产物元数据不等于文件内容。

一个里程碑只有在以下证据齐全时才能标记 DONE：

- 需求与测试的追踪关系。
- 自动化命令、数量、失败数和覆盖率。
- 受影响平台的手工证据。
- 未执行项目明确标为 concern，不写成“默认通过”。
- 无高优先级数据丢失、重复副作用、凭据泄露或跨 Life 越权问题。

MVP 发布后仍明确不包含多用户、云同步、外部消息渠道、Agent 自动发现/配对、自我修改代码、向量数据库和通用公网管理面。ADR 0013 的受限 Android 原生远程入口是唯一公网传输例外。

2026-09-09 主 joi Skill 加载以 AC-14/AC-33 为门禁：设置新增技能页，复用 Pi SDK 本机目录扫描，显式勾选并持久化 portable refs，默认空集合；无效引用禁止保存且可移除。每次主推理刷新选中技能元数据，正文只通过 joi_read_skill 按需读取；未选中、已撤销、失效引用拒绝读取。技能不扩张主 joi 的 shell/文件/网络权限，CLI 与外部副作用继续经搭档 Work/outbox，依赖和登录状态不能以“已加载”冒充执行成功。UI/HTTP 不返回 Skill 正文或本机绝对路径。测试覆盖保存、重建服务、空选择、每轮刷新、失效/撤销拒绝与设置交互。lark-project 的真实可用性分开报告目录识别、依赖、CLI、鉴权与业务执行证据。
2026-09-09 默认运行目录修复以 AC-14/AC-33/AC-46 为门禁，并取代旧的固定受管执行目录规则：本地任务创建、恢复和改派必须按搭档配置将访问等级提升至所需的 READ/WRITE；无指定目录时，每个新 Work 在用户主目录 `joi/runs/日期时间_UUID/` 创建目录，持久记录后由 dispatch outbox 幂等准备，恢复与重试复用。BOUND 工作台的新任务固定使用指定目录。上下文恢复、附件、验收与产物打开均解析对应 Work 的目录，不暴露绝对路径。带 Skill 但缺少工作目录必须在模型启动前报告配置错误。验证包括同时间并发创建不重名、固定目录、重启复用，以及从 NONE 派发经真实 read/bash 读取 Skill、写文件、验证及打开产物的完整链路。
2026-09-09 新输入隔离以 AC-14/AC-33/AC-46 为门禁：同一工作台重新提交相同提示词也创建独立目标与 Joi 会话，不自动复用旧任务对话；会话键包含持久 input/goal id，原输入澄清、恢复及内部目标评审保持同目标连续性，结果综合会话也按目标隔离。主提示词不注入工作台旧任务摘要；搭档快照的活跃任务与近期结果仅包含当前目标所属 Work。可复用长期工作台/搭档配置，但不能把旧任务的“排队中”作为本次已完成答复。回归覆盖重复原文的新输入、同输入继续、跨目标快照排除与同目标证据保留。
2026-09-09 Agent 工具流简化沿用 AC-33：连续同名工具的调用与结果折叠为一条 `工具名 ×N`，N 按调用次数计数，不将调用/结果配对重复计数；展开保留结果和失败说明，文字、产物、其他工具保持原顺序并打断分组。合并仅作用于展示，不改变运行状态、任务调度或持久记录。

2026-09-19 任务并发与阻塞恢复以 AC-14/AC-33/AC-46/AC-53/AC-54 为门禁：同工作台和同搭档的独立 Work 可使用各自受管运行目录并发，本机共享容量固定为全局 8、同搭档 4；resident 实例仍以原子 BUSY 占用保持单会话串行。资源不足、物理目录 lease 冲突和 resident 忙只形成稳定“排队中”，不消耗失败预算，也不得阻塞同 actor 中其他可运行 Work。目录冲突以已持久化的 Work 运行目录为准，历史记录缺失时才回退工作台 binding；同一物理目录继续保持多读、写排他。

2026-09-19 阻塞问题恢复继续以 AC-53 为门禁：每个原始目标持久化 `WAITING_INPUT → REVIEWING → OPEN` 执行门禁与版本化 question id。提问事务原子关闭门禁，顺序工具流在 `user_ask` 成功后停止；已持久启动的 run 可保存结果，但新派发、自动补充、综合、评审和目标完成必须暂停。回答只把门禁推进到 REVIEWING，并创建稳定恢复输入；Joi 核对已有结果和排队 Work 后必须显式调用 `goal_resume`，旧卡片、重复回答、失败或重启均不能提前打开门禁。首页将资源等待显示为“排队中”，将 WAITING_INPUT 单独显示为“需要你”，回答前不得投影完成态。

2026-09-19 执行状态一致性修复沿用 AC-14/AC-33/AC-46/AC-53/AC-54：持久启动事务同步 Work、当前 dispatch attempt 与 run 为 RUNNING，并重查取消、终态、替代尝试及目标门禁。容量、租约和指定实例占用等待不得提前变成运行态。首页兼容历史 READY/PLANNED 与当前 RUNNING run 不一致的数据，混合运行与排队时显示执行中，但阻塞门禁优先；不批量重写或重放历史任务。取消未运行 Work 必须核对实际运行事实；整目标取消和迟到结果归档保持原行为。启动落库与 outbox 确认之间崩溃时，仅补确认并交现有恢复路径处理，不重复启动。首页读取失败保留最后成功状态并提供重试，不以 Inbox ROUTED/CONSUMED 推断排队或完成。

2026-09-10 AC-47/AC-48 排序增量：首页目标卡按最近开启时间倒序，同时间按目标 ID 倒序稳定排列；新任务以创建时间为准，用户继续/重试时持久更新开启时间。进度、评审、综合结果和完成状态刷新不得改变卡片顺序。历史目标无开启记录时回退创建时间。

2026-09-20 评审收口修复沿用 AC-46/AC-53/AC-64：评审正常结束但 Work-path 事实稍后才同步完整时，后台必须自动补做安全清图，不得只扫描 FAILED 评审而使目标永久显示 REVIEWING。只有当前已综合结果明确为 COMPLETED、全部 Work 已终态、路径齐全且关闭、评审无活跃 Turn、目标未取消/归档/失败且执行门禁未关闭时允许完成；扫描后到写入之间新增工作、路径、评审回合、新结果 revision 或关闭门禁时必须拒绝收口。12 项完成、3 项非关键失败且已有完成综合可正常收口，不能按完成数不等于总数判定仍在执行；重复扫描无重复写入、不重放评审或历史 Work。

2026-09-20 回答后的恢复评审继续以 AC-53 为门禁：恢复输入因副作用后失败或耗尽重试而终止时，原目标必须退出无期限 REVIEWING，转为带新 question version 的明确中断提示和“重试评审”操作。重试保留已有回答、工作和结果，仍须由匹配的恢复回合调用 goal_resume 才可开放执行；不得自动重放旧回合。后台定期扫描应修复重启前已遗留的终止恢复输入；不得影响仍在排队/运行、已取消/归档/失败、已开放或已提出新问题的目标。成功开放时应同时将原目标 ROUTED 输入收为 CONSUMED，交由已有工作和结果综合继续收口。
