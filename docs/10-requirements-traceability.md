# README 实现追踪矩阵

## JOI-01 验收追踪（目标架构）

| AC | 目标 | 当前证据 |
|----|------|----------|
| AC-01 | 首页唯一 joi 输入 | 已自动证实：`joi-home-single-entry.test.tsx`、Electron E2E；Avatar/搭档为次级页 |
| AC-02 | 输入先持久化、300 ms accepted、可恢复 | 持久化/幂等/重启恢复已证实；真实设备 300 ms 性能待验收 |
| AC-03 | 自动 Avatar 归属与隔离 | 已自动证实：摘要路由、一次修复、预绑定结果不重路由、Avatar session 隔离 |
| AC-04 | Life 无损映射、主 Agent 降级首选搭档 | 已自动证实：migration 017/018、`joi-orchestration-migration.test.ts` |
| AC-05 | Pi stream/tool/queue/abort/compaction/session restore | 已自动证实：完整 Turn 后由 Pi 生成有界摘要，失败时确定性本地 checkpoint；压缩计数、累计裁剪量、消息尾部及 source/model revision 经 SQLite 恢复 |
| AC-06 | joi 无任意执行工具 | 已自动证实：全局 allowlist 不含 filesystem/bash/edit/write；执行工具只进 Local Pi Partner |
| AC-07 | Partner registry/revision 后派发 | 已自动证实：添加/更新/停用/删除均先追加不可变 registry revision；dispatch attempt 固定引用 revision；历史 revision 保留当时状态 |
| AC-08 | Local Pi/A2A 统一且敏感字段脱敏 | Hub contract 已证实：统一 runner/result、prompt/workspace 脱敏；真实两类搭档待验收 |
| AC-09 | Work DAG 与确定性并发硬边界 | 已自动证实：DAG waves、policy gate、READ/WRITE workspace lease 与到期恢复 |
| AC-10 | 连续输入在 Turn 边界安排 | 已自动证实：唯一 `JoiInputScheduler` 串行安全边界，Work DAG 仍可并行 |
| AC-11 | Partner 结果先成为 Avatar event | 已自动证实：`partner_result_events` → 预绑定 joi input → `work.reassign` |
| AC-12 | outbox 与稳定幂等 | local/A2A 均经 outbox、稳定 action/message id、terminal 去重已证实；真实四点强杀待验收 |
| AC-13 | Pi 凭据只进 safeStorage | 已自动证实：CredentialStore adapter、DTO/diagnostics/package secret scans |
| AC-14 | 无第三方 Pi Packages | 已自动证实：只锁定三项一方 Pi SDK；无 ResourceLoader/package discovery |
| AC-15 | 旧 Life 只读兼容、新契约 Avatar | 已自动证实：旧 Life GET 兼容保留，所有 `/api/v1/lives` 非 GET 返回 `legacy_life_read_only`；生产 Console 使用原生 Avatar 列表/创建，不再进入 Life 写向导或详情 |
| AC-16 | 单 scheduler、Avatar thread 隔离 | 已自动证实：生产 composition 无 WakeCoordinator/WakeRunner；每 Avatar 稳定隔离 Pi session |
| AC-17 | 决策只修复一次，破坏操作需确认 | 已自动证实：Avatar 路由只修复一次；`avatar.suggest_merge/archive` 仅创建持久待确认事实，用户确认前不改数据；在途工作阻止确认，merge 保留源事实并写重定向 |
| AC-18 | 复用 gateway/breaker/capacity/vault/SSE | 已自动证实：现有 gateway/outbox/vault/SSE replay；真实 breaker/结果联调待验收 |
| AC-19 | Pi 门禁与既有 HTTP 安全 | 已自动证实：无 READY 来源门禁、CSRF/session/body 限制和离线 inbox 恢复 |
| AC-20 | Card 本地优先与在途删除策略 | 已自动证实：Card 不覆盖本地字段；disable 采用 DRAIN、立即阻止新派发且保留在途；delete 要求先停用且在途为零，随后追加 DELETED revision |
| AC-21 | Avatar 只拥有上下文 | 已自动证实：纯 domain aggregate；预算/调度/搭档策略独立关联 |
| AC-22 | 新代码无 Life 词汇泄漏 | 已通过 architecture boundary 与目标路径静态扫描；旧兼容模块保留 Life |
| AC-23 | 首次精确文案、7 个厂商入口、接入方案与协议 | 已自动证实：精确文案、恰好七个厂商入口、API/Coding Plan 与 OpenAI/Anthropic 分层选择、无转发平台 |
| AC-24 | 固定 endpoint 与通用 URL 网络策略 | 已自动证实：官方 endpoint、localhost 例外、SSRF/DNS/redirect 检查 |
| AC-25 | 多来源、主备顺序、revision/credential 边界 | 已自动证实：多源排序、不可变 revision、Turn pin 与 safeStorage reference |
| AC-26 | 版本化模型 preset 与自定义模型 fail closed | preset contract 已证实；custom 首 Turn 未观察到 tool call 时 fail closed |
| AC-27 | 首次验证和 composer 门禁 | 已自动证实：draft/验证/门禁、最小文本检查、不做 onboarding tool probe |
| AC-28 | 确定性 fallback 分类 | 已自动证实：仅 timeout/connect/429/5xx；auth/balance/config/refusal 不切换 |
| AC-29 | Turn 固定 revision 与安全切源 | 已自动证实：output/tool flag 持久化，副作用前才更新 source/model pin |
| AC-30 | 来源 CRUD/排序/重启恢复与历史不漂移 | 已自动证实：脱敏 CRUD/验证/停用/主备排序/重启恢复；设置页可替换 model/key，通用源可改名称/Base URL，空 key 保留旧凭据且修改形成待验证 DRAFT revision |
| AC-31 | 搭档配置卡片化、基础/高级页、知识库、复制与启用开关 | 已自动证实：migration 023 的 description/engine/model 列与 `partner_knowledge_docs`；PATCH 统一 disabled 开关、duplicate、知识库 CRUD 与正文脱敏；卡片网格、模式选择与 2-3 个搭档引导；基础页两列对齐（名称｜工作路径、描述｜提示词）、工作路径原生目录点选、技能按引擎扫描点选、移除能力标签，高级页工具白名单按引擎点选与供应商"管理大模型网络"跳转；`partner-config-http.test.ts`、`partner-page.test.tsx`、`sqlite-partner-knowledge.test.ts` |
| AC-32 | 搭档实例生命周期、joi 实例工具与隐形工作记忆 | 已自动证实：migration 024 的 `partner_instances`/`partner_instance_messages`/`dispatch_attempts.instance_id`/工作记忆表；常驻实例消息持久化与驱逐后重建、崩溃恢复（常驻回 IDLE、单次置 DISPOSED）、实例上限与空闲清扫；`partner.create/create_instance/list_instances/dispose_instance/inspect_revision` 工具与 `work.dispatch` 实例透传；工作记忆 32 条上限、节拍摘要、确定性 fallback 与只读调试端点；`partner-instance-manager.test.ts`、`partner-work-memory-service.test.ts`、`joi-reasoning-tools.test.ts`、`sqlite-partner-instances.test.ts`、`sqlite-partner-work-memory.test.ts`、Pi 引擎常驻续话契约 |
| AC-33 | 本地 CLI 搭档引擎（Claude Code / Codex，经同源 agentsdk，ADR 0004） | 已自动证实：`@rd-efficiency/agentsdk@5.9.17` 安装；`local-cli-executable-resolver.ts` 探测用户本机 PATH 上的 claude/codex（含 codex 原生包与 macOS Codex.app），运行时不注入 provider/密钥、用 CLI 自身配置；ephemeral 单次 query、resident 常驻会话复用与 resume 失败回退、CLI 未检测 fail-closed 健康门禁；工具白名单经 `allowedTools`、选中技能经扫描器注入；migration 025 的 SQLite ConversationStore round-trip 与 migration 026 的 `cli_protocol` 存储映射；`GET /api/v1/engines`（带工具集）、`/engines/:engine/skills`、`/system/pick-directory` 与创建/更新未检测引擎 409 门禁；包限制规则锁定 agentsdk/pi SDK 各自目录；`mana-executable-resolver.test.ts`、`sqlite-mana-session-store.test.ts`、`mana-engine-contract.test.ts`、架构边界测试 |
| AC-34 | 首页场景预设（内置精选 + 本机技能映射，点击预填不发送） | 已自动证实：`shared/joi.ts` 的 `BUILTIN_SCENARIOS`、`GET /api/v1/scenarios`（内置必现、技能经 env 覆盖扫描映射、skills 缺失仅内置）、渲染端点击卡片预填输入框且不自动发送；`scenarios-http.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-35 | joi 自建团队并显式选模型、wayfinder 式编排提示词（ADR 0005） | 已自动证实：`model.list_sources` 工具仅返回 READY 源、`partner.create` 新增可选 `modelSourceId`/`modelIdOverride` 透传（引擎固定 pi-core）且并入 `JOI_REASONING_TOOL_NAMES`；`buildJoiSystemPrompt` 编入 destination-first/逃生舱、HITL-AFK、Agent-Brief 自包含搭档提示词、派发与聚合纪律，并保留 custom-model fail-closed 与 Avatar 上下文注入；`joi-reasoning-tools.test.ts`、`joi-system-prompt.test.ts`、`single-joi-avatar-routing.test.ts` |

本表随 RED→GREEN 证据更新；“旧基线可复用”不等于目标 AC 已完成。

日期：2026-08-01
事实源：`README.md`、`01-product-requirements.md`、`02-ux-specification.md`、`07-roadmap-and-acceptance.md`

## 结论与状态定义

当前仓库中 M0–M6 的 Hub 本机可实现行为已经落地，并由 domain、integration、contract、renderer、Electron E2E、构建或包审计证实。MVP 发布验收仍未完成：真实 AI Mana、第二台 LAN 设备、macOS、签名/公证、24 小时长稳和人工视觉验收属于 M7 外部门禁，不得由模拟测试替代。

- `已证实`：实现和同范围自动化证据同时存在。
- `已证实（外部待验收）`：Hub 一侧已证实，真实端点、设备或平台仍须 M7 验收。
- `外部`：当前环境无法提供所需硬件、端点、平台、证书或持续时间。

## PRD 功能需求

| ID | 状态 | 实现与验证证据 | M7 / 发布备注 |
|---|---|---|---|
| LIFE-01 | 已证实 | Life 校验、persona version、`initialGoal`/头像/原则/角色和三步向导；`domain-validation.test.ts`、`renderer-shell.test.tsx` | 无 |
| LIFE-02 | 已证实 | 所有连续性表按 `life_id` 隔离；主 Agent context 按 Life/Affair 持久化；memory entity/link；`event-wake-persistence.test.ts`、`a2a-gateway-lifecycle.test.ts`、`continuity-actions.test.ts` | 无 |
| LIFE-03 | 已证实 | start/pause/resume/stop/archive/delete、删除影响摘要、活动取消及受控文件事务删除；`life-management-completeness.test.ts`、`user-attachments.test.ts`、renderer 危险操作测试 | 无 |
| LIFE-04 | 已证实 | 暂停态换绑、4 KiB UTF-8 有界交接、Token/context 排除和新 context 隔离；`life-management-completeness.test.ts` | 无 |
| LIFE-05 | 已证实 | 卡片投影状态、主 Agent、未处理事件、预算和下次唤醒；`life-management-completeness.test.ts`、`renderer-shell.test.tsx` | 无 |
| AGENT-01 | 已证实（外部待验收） | 完整 Card URL + Bearer Token onboarding；`agent-onboarding.test.ts`、`onboarding.test.tsx` | 真实端点互操作 |
| AGENT-02 | 已证实（外部待验收） | A2A 0.3、transport/auth/origin/network policy；`a2a-discovery.test.ts`、`network-policy.test.ts` | 真实 AI Mana |
| AGENT-03 | 已证实 | Electron `safeStorage`、无明文 fallback、renderer DTO/诊断/包脱敏；auth、package、diagnostics tests | 浏览器开发工具需第二设备复核 |
| AGENT-04 | 已证实（外部待验收） | readiness 与 `COLLABORATOR_ONLY`；`agent-onboarding.test.ts` | 配套扩展在独立仓库 |
| AGENT-05 | 已证实（外部待验收） | 敏感 Card drift → `RECONFIRM_REQUIRED`；`agent-onboarding.test.ts` | 真实漂移 |
| AGENT-06 | 已证实 | 测试、刷新、轮换、停用、启用、绑定影响和安全删除；`agent-onboarding.test.ts`、renderer Agents 测试 | 无 |
| AGENT-07 | 已证实（外部待验收） | 共享持久 breaker、429/503、数字秒/HTTP-date、最长冷却、事件保留；`connection-breaker.test.ts`、`a2a-gateway-lifecycle.test.ts` | 真实 Endpoint 压测 |
| EVENT-01 | 已证实 | UI 消息先写 `LifeEvent`，Wake 再领取；`http-api.test.ts`、`event-wake-persistence.test.ts` | 无 |
| EVENT-02 | 已证实 | 类型、来源、优先级、时间、状态、Life/Affair/attachment 关联和安全活动摘要；`activity-pagination.test.ts` | 无 |
| EVENT-03 | 已证实 | partial unique index、lease、单主 Wake 和运行中轻量 signal；`event-wake-persistence.test.ts` | 无 |
| EVENT-04 | 已证实 | 优先级/去重/预算/暂停/安静时段；Hub 4、Endpoint 2、Life collaborator 4 容量门；arbiter、rhythm、capacity tests | 真实并发压测 |
| EVENT-05 | 已证实 | 50 events / 64 KiB 有界 claim；`event-wake-persistence.test.ts`、`a2a-envelope.test.ts` | 无 |
| EVENT-06 | 已证实 | 空 claim 回到 `SLEEPING` 且不调用 Agent；`wake-runner.test.ts`、`wake-coordinator.test.ts` | 无 |
| EVENT-07 | 已证实 | 版本化 registry、schema、priority、merge、context、retry；未知类型 fenced；`event-type-registry.test.ts` | 无 |
| EVENT-08 | 已证实 | eventId-only signal，下一 Turn 重新查询；`event-wake-persistence.test.ts` | 无 |
| EVENT-09 | 已证实 | process marker、Turn heartbeat、startup grace、stale repair；`wake-liveness-retry.test.ts`、`wake-audit-repair.test.ts` | 长稳阈值校准 |
| MEMORY-01 | 已证实 | 不可变事件/action 与 memory revision；`action-processor.test.ts`、`continuity-actions.test.ts` | 无 |
| MEMORY-02 | 已证实 | 成功/部分成功 Wake 原子保存 consciousness residue；协议失败不伪造残留 | 无 |
| MEMORY-03 | 已证实 | 情景/语义/Card、source event、Affair、时间、置信度、entity/link；`continuity-actions.test.ts` | 无 |
| MEMORY-04 | 已证实 | FTS5、CJK fallback、实体标签、时间、Affair 与置信度召回；`continuity-actions.test.ts` | 无 |
| MEMORY-05 | 已证实 | 默认 03:00 schedule 和结构化 metabolism action；schedule/continuity tests | 真实跨日长稳 |
| MEMORY-06 | 已证实（外部待验收） | 持久主 context、128 KiB WakeEnvelope、context not-found 后一次有界重建；`a2a-gateway-lifecycle.test.ts` | 真实远端 context 清理 |
| MEMORY-07 | 已证实 | Card 优先、原始活动不变、来源投影和可修订摘要；`continuity-actions.test.ts`、renderer memory tests | 无 |
| RHYTHM-01 | 已证实 | 三条默认 schedule、编辑 API/UI、幂等 tick；`rhythm-settings.test.ts`、`renderer-shell.test.tsx` | 无 |
| RHYTHM-02 | 已证实 | 用户/Agent 一次性、间隔、DAILY/WEEKDAYS/WEEKENDS/WEEKLY 闹钟，Life timezone 与 DST 校验；alarm/rhythm tests | 真实跨日 |
| RHYTHM-03 | 已证实 | Todo 标题/状态/due/Affair/assignee 全量 API/UI，逾期事件化；todo tests | 无 |
| RHYTHM-04 | 已证实 | per-Life quiet settings、内部维护/紧急 override、普通表达延迟、idle 禁止；quiet/alarm/rhythm tests | 真实跨夜 |
| RHYTHM-05 | 已证实 | 24/100/3 默认值和 per-Life 持久默认编辑；`rhythm-settings.test.ts` | 无 |
| RHYTHM-06 | 已证实 | human/auth/recovery 不耗 autonomy，仍耗 Invocation；`rhythm-policy.test.ts` | 无 |
| RHYTHM-07 | 已证实 | `BUDGET_PAUSED`、追加、日重置；`budget-service.test.ts` | 真实跨日 |
| RHYTHM-08 | 已证实 | occurrence unique、event 成功后推进、并发幂等和失败可重试；`alarm-scheduler.test.ts` | 无 |
| ACTION-01 | 已证实 | 严格 action schema 与原子 ActionProcessor；`a2a-envelope.test.ts`、`action-processor.test.ts` | 无 |
| ACTION-02 | 已证实 | `express` 独立投影，协议状态不成为正式回复；renderer/timeline tests | 无 |
| ACTION-03 | 已证实 | delegate 有界上下文、仅显式 Artifact 转发；用户附件受控上传、消息原子绑定、hash 复验；delegation/attachment tests | 真实协作者 |
| ACTION-04 | 已证实 | 完成/失败/input/auth/Artifact 均先生成事件；`continuity-actions.test.ts`、`interaction-service.test.ts` | 真实 stream |
| ACTION-05 | 已证实 | Origin/MIME/大小/文件名/realpath/hash、500 MiB Affair quota、授权预览/下载/转发；artifact/attachment tests | 真实大文件压测 |
| ACTION-06 | 已证实（外部待验收） | 无通用审批；auth 仅用户恢复并绑定原 Task；interaction service 与 renderer tests | 真实 Agent auth |
| WEB-01 | 已证实 | Electron 与 LAN 共用 React build 和 `/api/v1`；static handler、dual listener、Electron E2E | 第二设备 |
| WEB-02 | 已证实 | LAN password + HttpOnly session；desktop 一次性 nonce；auth contract/integration/E2E | 第二设备 |
| WEB-03 | 已证实 | SSE sequence/cursor/replay、7 天清理、过期 cursor `stream_reset` 和快照刷新；HTTP/renderer tests | 第二设备断网 |
| WEB-04 | 已证实 | 删除、归档、换绑、Agent 删除、恢复均展示后果并保持单次确认；renderer tests | 人工可用性复核 |
| WEB-05 | 已证实 | 用户/表达/系统/Agent/Artifact 样式和 Wake/Turn/Flow/Delegation 安全投影；activity/renderer tests | 人工视觉复核 |

## 非功能要求

| 要求 | 状态 | 证据 / concern |
|---|---|---|
| 持久性 | 已证实 | SQLite 事务、outbox、action/Alarm 原子提交、文件删除 staging/rollback |
| 恢复性 | 已证实（外部待验收） | messageId/taskId、get/resubscribe、unknown review、crash marker、备份 quarantine；真实强杀矩阵仍属 M7 |
| 性能 | 已证实（本机基线） | migration 016 时间线复合索引；`activity-pagination.test.ts` 在 100,000 条活动下要求首屏 100 条查询 `< 1s`；24h/多 Life 压测仍属 M7 |
| 资源 | 已证实 | 空队列不调用 Agent、WAL、可取消 Wake、容量门和配额 |
| 可观察 | 已证实 | Wake/Turn/Injection/Invocation/Flow/Action 稳定 id、因果引用和安全活动投影 |
| 隐私 | 已证实（外部待验收） | diagnostics/package/DTO/log 脱敏自动化；真实浏览器开发工具与安装日志待 M7 |
| 可移植 | 已证实（外部待验收） | 版本化备份、Artifact hash、session revoke、Token required；跨机恢复待 M7 |

## 里程碑

| 里程碑 | 状态 | 结论 |
|---|---|---|
| M0 | 已证实（Windows） | 工程、Harness、边界、CI 命令、测试隔离、生产构建和 Windows 打包通过；macOS 打开为外部 concern |
| M1 | 已证实 | persistence、双 listener、auth、CSRF、SSE、Life CRUD、诊断和备份均有自动化证据 |
| M2 | 已证实（Hub） | Gateway/readiness/envelope/breaker/context/Artifact 完成；真实 AI Mana 和独立扩展待验收 |
| M3 | 已证实 | 生命周期、事件/Wake/action/repair/audit/capacity/outbox 完成 |
| M4 | 已证实（Hub） | continuity、memory、entity、schedule、Alarm、Todo、budget、delegate 完成；真实跨机/跨日待验收 |
| M5 | 已证实（自动化） | 共享控制台和核心 UI 路径完成；Electron E2E 在 960/768 px 完成无溢出断言及运行时截图检查，人工键盘/对比度仍保留 concern |
| M6 | 已证实（自动化） | marker、恢复、migration read-only mode、备份、托盘/drain、安全和诊断完成；强杀矩阵/长稳待 M7 |
| M7 | 外部未完成 | Windows 未签名 NSIS 已构建；真实 Agents、第二设备、macOS、签名、公证、人工视觉、长稳和发布性能报告未执行 |

## E2E-01 至 E2E-11

`tests/e2e/electron-smoke.spec.ts` 现以目标架构为准：真实 Electron 完成 desktop bootstrap、管理员设置、模型网络门禁、全局 joi 首页、统一搭档目录与原生 Avatar 创建；同时在 960/768 px 断言实际 viewport 与无水平溢出，并保存 768 px 运行时截图。旧 Life 写向导和详情不再是生产 Console 入口，历史数据只保留 GET 兼容；下表中的旧 Life/Wake 场景由底层 compatibility integration 证明，不等价于新的用户入口。

| E2E | 自动化证据 | M7 未闭合项 |
|---|---|---|
| E2E-01 出生与首次休眠 | event/Wake/action/continuity/wake-runner integration | 真实主 Agent |
| E2E-02 运行中插话 | persistent event + eventId signal + crash-safe claim tests | 跨进程强杀 + 真实长 stream |
| E2E-03 跨天自我唤醒 | Alarm/schedule/recovery tests | 托盘跨夜 |
| E2E-04 多 Agent 协作 | delegation success/failure/artifact event tests | 两个真实协作者 |
| E2E-05 input/auth | interaction lifecycle、resume、renderer tests | 真实 Agent auth + 重启 |
| E2E-06 远端与 Hub 崩溃 | outbox/messageId/taskId/recover/unknown tests | 四点进程强杀矩阵 |
| E2E-07 context 过期 | bounded context rebuild integration | 真实远端清理 |
| E2E-08 预算与安静时段 | budget/quiet/alarm/idle tests | 真实跨夜 |
| E2E-09 LAN 控制面 | dual listener/auth/SSE/HTTP contract | 第二台 LAN 浏览器与 DevTools |
| E2E-10 备份恢复 | online backup/hash/quarantine/session/token/unknown integration | 干净机器恢复 |
| E2E-11 Endpoint 退避与审计 | shared breaker、Retry-After、activity projection tests | 真实网络抖动与 Agent |

## 当前发布 concerns

1. 提供真实 AI Mana 主 Agent、两个协作者和第二台 LAN 浏览器，执行 E2E-01 至 E2E-11。
2. 在 macOS 构建机完成 DMG、签名、公证、安装、升级和托盘验证。
3. 为 Windows 配置 Authenticode 证书；品牌图标已完成，当前 NSIS 仍为 `NotSigned`。
4. 连接可用的 in-app browser，完成 768/960 px、键盘、焦点、对比度和截图验收。
5. 执行 24 小时长稳、多 Life/Alarm 峰值、磁盘不足和真实网络故障报告。
