# ADR 0009: actor 树 + 单根 tick 遍历更新，去通知回调与 SSE

- 状态：Accepted
- 日期：2026-08-05
- 关联：ADR 0002（唯一 joi 与唯一调度权威）、ADR 0005（编排方式）、ADR 0006（工作台私有实例与结果闭环）

## 背景

既有编排靠三类通知回调黏合：`processJoiInput`（内存 notify 队列）、dispatch handler 的 `onResult` 回流、各域 `notifyJoi` 闭包；UI 侧另有 SSE 推送通道。回调链在挂死或崩溃时静默停滞：partner 执行挂死时 work 永远 RUNNING、跨 turn 工具闭包错挂、turn 失败回 PENDING 后无人重取。可靠性事实（inbox 状态机、transactional outbox、结果事务）本就持久化，回调只是提速层，却承担了控制流职责。

## 决策

术语固定：

- **actor**：树节点（joi → workbench → agent），不持有定时器、不互相发消息；唯一协调介质是 SQLite 事实表。
- **component**：actor 内的遍历更新单元，接口 `update(ctx)`；周期行为用组件内节流时间戳表达。
- **tick**：唯一根循环（2s，重入守卫），按 joi → workbench → agent 顺序串行收敛。joi 仍是唯一调度权威；不同工作台的 agent actor 可并发持有在途执行，但调度决定只出自 joi 的推理 turn 与遍历规则。

joi actor 持 task component（扫 PENDING 输入、串行单槽位驱动 `JoiCoordinator.handle`、孤儿 turn 回收）、workbench component（名册 reconcile）、rhythm component（折叠既有幂等 tick）。workbench actor 持 agent component（agent 聚合、待确认信息聚合、workbench 级实例 sweep、结果综合发现）。agent actor 是 leaf，partner 执行（cowork）在这一层：`claim → prepare → ack outbox → run（fire 不 await）→ 后续 tick 收敛终态`。

长 async 一律 fire 不 await，用 settled 标志跨 tick 收敛；tick 只 await 毫秒级事务。outbox 在 `prepare` 全持久化后即刻 ack；ack 前崩溃靠 outbox 重投，ack 后崩溃靠启动首 tick 的孤儿扫描（instance DISPOSED/缺失 → UNKNOWN 终态；RESIDENT IDLE → 续跑；A2A → recover 至终态），守住「ActionDispatched 必有终态」。

renderer 纯轮询（1.5s/2.5s），SSE 传输退役：删除 `/api/v1/stream` 与 broker；`appendSseEvent` 冻结（保留签名、不再写 `sse_events`、返回合成事件）；结果事务不再写 SSE 投影。`sse_events` 表保留不重建（migration 执行器不重建表）。

## 后果

- 输入接受到处理、结果到综合的延迟上限 = 1 个 tick（≤2s），ADR 记录该延迟预算。
- 控制流与观测分离：诊断事件表新增 `joi.task.*`、`joi.agent.*`、`joi.partner.orphan_found` 等命名事件，只观测不影响控制流。
- AC-10 串行边界由 task component 单槽位表达；AC-39 rerun 等价由「clarify/failTurn 置回 PENDING → 下 tick 重取」表达。
- 新增 `src/main/application/actors/` 目录纳入分层边界检查；application 层覆盖率门槛（≥90%）适用于 actor/component 代码。
- 旧 Wake/SSE 读取测试改写为事实表断言或 404 契约；契约测试 `actor-runtime-authority` 锁定 `new ActorTree(`/`actorTree.tick(`、无 `new JoiInputScheduler(`、无 `/api/v1/stream`。

## 2026-08-25 补充：动作与投影收敛

每轮工作台 actor 先从权威 Work/Run 事实修复缺失的用户动作，再由首页和 Agent 查询投影状态。首页只有存在具体 clarification/action 时才能显示 `NEEDS_ATTENTION`；孤立 WAITING 在修复窗口内仍是后台 RUNNING。常驻实例的 IDLE 只是引擎空闲事实，若其关联 run 正在 RUNNING/WAITING，Agent 卡必须以后者为准。

“长 async 不 await”同样适用于 waiting-remote retry 与 orphan finalize：组件只登记 in-flight/settled，Promise 在后续 tick 收敛；进行孤儿收尾时暂停同 Agent 新 claim，但不能阻塞根 actor 遍历其他组件。

## 2026-10-20 补充：临时模型连接恢复

根周期每十秒有界扫描已配置来源，临时 `DEGRADED` 距上次健康更新一分钟后登记 `model.source.recover` outbox，以来源/模型/凭据版本及健康更新身份去重。专用后台 dispatcher 单并发执行既有固定无工具验证，不受待处理目标或零 READY 门控影响，也不进入根周期的 await 链；成功后由原调度自然认领输入，失败保留安全健康事实并在一分钟后重检。健康提交沿用 revision、状态和更新时间 CAS，用户编辑、禁用或手工验证优先；紧急停止与退出取消探测并保留队列。鉴权、配置错误和禁用来源不自动探测。运行健康只公开计数和安全状态，已配置且暂时降级区别于未配置；左下角跟随轻量状态轮询展示与清除异常。
