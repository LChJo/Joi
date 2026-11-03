# README 实现追踪矩阵

M0 Windows/macOS 可重复构建与打包：原生 Cargo 查找覆盖显式路径、`CARGO_HOME`、默认 rustup 目录及系统 `PATH`，不依赖 runner 预装位置；对应 `tests/contract/native-build-toolchain.test.ts`，双平台 CI 显式安装 Rust 并执行完整构建、E2E 和打包门禁。

桌面原生菜单（`docs/02-ux-specification.md`）：`electron-smoke.spec.ts` 在 Windows/Linux 断言窗口菜单栏隐藏；`isMenuBarVisible()` 不适用于 macOS，macOS 继续执行同一完整设置、工作台与响应式交互流程。

测试隔离与持久化验证：功能测试通过 `runtime-database-fixture.ts` 复制独立的当前空 schema，保留 WAL、FULL 同步、重开数据和全部业务断言；升级与恢复测试仍运行真实迁移，完整旧库升级场景在 CI 使用 60 秒预算。`sqlite-work-dependency-gate.test.ts` 覆盖依赖、取消级联与派发门禁；`evolution-service.test.ts` 完整执行 180 次成对评测及持久检查点，CI 为该完整流程提供 180 秒预算。

## 2026-10-23 自主进化 v2 验收追踪

| 验收 | 关键行为及反例 | 对应测试 |
| --- | --- | --- |
| AC-EVO-01 / 06 | 三模块注册操作、单模块改变、拒绝自由指令；保留人格/权限/验收边界及逐次协议 | `tests/unit/learning-policy.test.ts`、`tests/unit/pi-evolution-model.test.ts`、既有 Joi 工具契约 |
| AC-EVO-02 / 07 | 当前权威双版本、机械事实变化的新案例 ID、同源分组不泄漏、缺完成来源不补正例；排除取消/环境/执行问题 | `tests/unit/learning-case.test.ts`、`tests/integration/sqlite-method-learning-store.test.ts` |
| AC-EVO-03 | 共享日预算、稳定 outbox 身份与检查点原子性、未知用量、跨日续跑、协议暂停和明确恢复；取消遗留待办不挡空闲 | `tests/integration/sqlite-method-learning-store.test.ts`、`tests/integration/method-learning-service.test.ts`、`tests/integration/method-learning-service.recovery.test.ts`、`tests/integration/sqlite-evolution-store.test.ts` |
| AC-EVO-04 | 安全题与生产封存分开；至少五个独立来源组、各三次、质量/效率双通道；重复来源、硬违规、质量或已知配对成本退化必须拒绝 | `tests/unit/learning-evaluation.test.ts`、`tests/integration/method-learning-service.test.ts` |
| AC-EVO-04 | 依赖问题必须实际提交隔离工作计划；自依赖、环、未知/跨案例引用和可执行能力拒绝；重复取证计费且验收不降 | `tests/unit/learning-replay.test.ts`、`tests/unit/pi-evolution-model.test.ts` |
| AC-EVO-05 | 全局和本台设置/恢复入口分开、兼容旧接口、投影真实阻塞/成本/曝光，干跑范围明确 | `tests/contract/method-learning-http.test.ts`、`tests/contract/evolution-http.test.ts`、`tests/renderer/evolution-settings.test.tsx`、隔离 Electron E2E |
| AC-EVO-08 | 需求 READY 后稳定分组、合格同期控制、模型/来源一致、当前观察失效处理、实测收益才能晋升、跨台回退及安全父版本 | `tests/integration/method-learning-service.test.ts`、`tests/integration/method-learning-service.recovery.test.ts`、目标绑定/权威观察存储及 Joi coordinator 回归 |

本表定义工程完成门禁，不以列出测试文件代表所有场景已通过。最终证据须包含实际固定验证结果及未完成项。真实供应商逐次协议、完整学习成本、合格生产灰度收益和生产回退另行验收；结构案例与模型替身不证明真实长任务或实际用户质量已经改善。

2026-10-19 AC-37/44/48 目标详情交互：设计师评审 `docs/design/goal-detail-ux-review.md`；鼠标定位全文提示、固定右键菜单、边缘避让/外部滚动关闭，以及紧凑概览、限高分区详情、分页事实与交互保留，覆盖 `goal-detail-ux.test.tsx`、`goal-detail-presentation.test.tsx`、`goal-detail-loading.test.tsx` 与 Electron 真实交互/长地图/窄屏截图。

2026-10-19 AC-37/AC-44/AC-48 目标详情：完整安全目标标题的悬停/聚焦阅读与复制、分层路线图、同名路径保留、决策与雾区晋升、分页及刷新恢复，对应 `joi-goal-detail.test.ts`、`joi-goal-detail-http.test.ts`、`goal-detail-presentation.test.tsx`、`goal-detail-loading.test.tsx`；只读 Worker 透传及 WAL 快照对应 `runtime-workers.test.ts`，真实 Electron 标题提示框、菜单、节点关系与窄屏布局对应 `electron-smoke.spec.ts`。接口为 `GET /api/v1/joi/goals/:goalId/detail?offset=0&limit=50`，每个集合独立应用同一 offset/limit（默认 50，最大 100），返回完整安全标题、地图状态和层级、paths/decisions/fog、各集合总数及可选 nextOffset。缺失/已移除/派生输入返回 404，无会话 401，非法分页 400；首页 DTO 保持摘要。地图详情不返回原始消息或执行 payload。

国际化增量（AC-I18N-01 至 AC-I18N-06）：语言源与 CLI、客户端偏好、实时切换、错误兼容及验证证据统一追踪于[国际化验收](20-internationalization.md)，架构约束见 [ADR 0030](adr/0030-interface-internationalization.md)。

AC-WR-07 权限与执行需求一致性：领域声明和引擎能力对应 `work-execution-needs.test.ts`；无部分派发、只读核查及恢复冲突对应 `work-orchestration-service.test.ts`，同轮一次纠正对应 `joi-reasoning-tools.test.ts`；实际 Pi 工具裁剪、常驻实例权限刷新、拒绝终止及假 CLI 产物验证对应 `local-pi-partner-runtime.test.ts`，Claude/Codex 边界对应 `native-agent-sdk-contract.test.ts`；补充 Work 的并发、已有活跃恢复复用、后续恢复/改派回合复用原始计划回执、数据库关闭重开和原 READ 不变对应 `sqlite-work-plan-outbox.test.ts`。

AC-PERF-01 周期卡顿与窗口线程隔离：[ADR 0029](adr/0029-desktop-runtime-workers.md)。历史调度键、待派发/常驻/恢复保留对应 `workbench-agent-scan.test.ts`；内存执行结果收尾对应 `workbench-agent-component.test.ts`。实际迁移及历史规模查询计划对应 `sqlite-home-feed-query-scale.test.ts`，语义兼容对应 `sqlite-workbench-agent-feed.test.ts`。WAL 未提交写入与读取快照、线程繁忙时调用方响应、崩溃拒绝及安全错误对应 `runtime-workers.test.ts`；窗口与运行时组合边界对应 `runtime-worker-isolation.test.ts`、`composition-root.test.ts`、`actor-runtime-authority.test.ts`。隔离桌面启动、退出、备份及原生渲染使用既有 Electron E2E 门禁，跨线程 PDF 导出及 outbox 确认对应 `runtime-worker-export.spec.ts`；测试下载目录必须位于隔离 userData 内。

AC-WR-01..06 按需写入：[ADR 0028](adr/0028-demand-driven-workspace-writing.md)，关联 AC-14/33/46/53/54/62/67。领域准入、Shell 和未知工具分类对应 `workspace-write-scheduling.test.ts`；同目录读并发、FIFO 升级、不持读等写及过期代次对应 `sqlite-demand-driven-write.test.ts`、`sqlite-workspace-lease.test.ts`。暂停/容量释放、原实例恢复、重复 continuation、取消、真实数据库重开和检查点缺失对应 `agent-dispatch-component.test.ts`、`partner-instance-manager.test.ts`、`sqlite-partner-dispatch-instances.test.ts`、`native-checkpoint-store.test.ts`。三引擎 SDK 契约对应 `local-pi-partner-runtime.test.ts`、`native-agent-sdk-contract.test.ts`、`codex-workspace-capabilities.test.ts`；附件与产物边界对应 `partner-dispatch-attachment-staging.test.ts`、`work-run-directories.test.ts`；阶段与等待投影对应 `sqlite-workbench-agent-feed.test.ts`、`joi-home-single-entry.test.tsx`。原生 CLI 的隔离验证使用 `tests/native/local-workspace-write.test.ts`，实际原生写工具测试与协议恢复测试分别记录证据，不能互相替代。

AC-WR-03 / AC-WR-06 Windows 短路径与原生路径统一解析、工作区内写入及越界拒绝：`pi-coding-tool-factory.test.ts`；附件输入目录别名：`partner-dispatch-attachment-staging.test.ts`。

AC-STATS-01..06 Token 统计：[ADR 0021](adr/0021-token-statistics.md)。SDK 归一化和故障隔离对应 `sdk-usage-normalization.test.ts`、`sdk-usage.test.ts`、`native-agent-usage.test.ts`、`pi-runtime-usage.test.ts`、`a2a-usage.test.ts`；时区、聚合和对账对应 `statistics-policy.test.ts`，账本/恢复/归属/缺失标记对应 `statistics-ledger.test.ts`，认证和有界查询对应 `statistics-http.test.ts`。页面与安全 HTTP 客户端对应 `statistics-page.test.tsx`、`api-client.test.ts`；隔离 Electron 的筛选、当日明细、目标跳转和浅深主题三宽度截图对应 `tests/e2e/statistics.spec.ts`。真实供应商用量未返回时不得模拟为零，测试不调用真实模型。

AC-EVO-01..08 受限方法学习：[ADR 0020](adr/0020-bounded-strategy-evolution.md) 与[当前验收](07-roadmap-and-acceptance.md#2026-10-23-自主进化-v2结构决策重放与生产收益分离)。当前策略合同 v2 从真实权威事实生成结构决策案例，30 个安全场景与至少 5 个独立来源组的生产封存案例分别判定，再进入生产灰度；固定题库不能单独证明收益。既有 `evolution-*`、工具、Joi coordinator 和 Electron 设置页测试继续保护兼容与隔离；新增 `learning-policy.test.ts`、`learning-case.test.ts`、`learning-replay.test.ts`、`learning-evaluation.test.ts`、`sqlite-method-learning-store.test.ts`、`method-learning-service.test.ts`、`method-learning-http.test.ts` 对应当前合同。自动化与干跑只证明工程流程，真实供应商协议、实际收益及生产回退另验收，不以测试替身宣称效果成立。

AC-57 全文导出与安卓诊断入口：[规格与设备待验](19-result-export-acceptance.md)。对应 `tests/unit/result-export.test.ts`、`tests/integration/result-export-persistence.test.ts`、`tests/contract/result-export-http.test.ts`、`tests/renderer/result-export-menu.test.tsx`、`tests/e2e/result-export.spec.ts` 和 Flutter `result_export_test.dart` / `result_reader_test.dart`。复制仅最终 Markdown；文件导出使用快照、离线字体和下载/Joi，诊断图标按当前状态显示。

AC-57 原生 stdio 协议回归：`native/joi-remote/tests/sidecar_contract.rs` 必须启动真实 sidecar，以桌面 camelCase 命令验证 ready、QUIC peerOpen/peerFrame、send 回包、close/peerClose 与 shutdown；Rust 枚举同时指定 variant 与 field 的 camelCase。可选 relayUrl/relayAuthentication 有独立反序列化断言，防止静默丢弃配置。桌面原生构建在复制可执行文件前强制运行该契约，模拟 sidecar 测试不作为跨语言兼容证据。

AC-57 的 2026-09-07 首页增量证据：`remote-home-queries.test.ts` 覆盖能力命令校验、目标解析与游标失效/连接隔离；`remote-command-service.test.ts` 覆盖工作台透传、动作映射和 Unicode 长结果有界分页；`sqlite-workbench-agent-feed.test.ts` 覆盖同实例跨目标记录隔离；Flutter `widget_test.dart` 覆盖工作台发送、详情/产物/记录、回答/继续/移除和草稿保留，`remote_session_test.dart` 覆盖真实加密帧顺序、幂等键复用、成功回执与刷新分离及旧主机兼容。2026-09-30 增量由 `joi-home-single-entry.test.tsx` 覆盖桌面新增入口层级，`remote-command-service.test.ts` / `remote-home-queries.test.ts` 覆盖 `inputId` 绑定的受限创建、字段校验与越界拒绝，Flutter `widget_test.dart` / `remote_session_test.dart` 覆盖 capability 门禁、建议方案、加密创建命令、恢复原输入及部分失败提示。下表初版两命令限制由 ADR 0013 的 `home.v2` 增量取代；真机网络与多设备验收仍待执行。

## JOI-01 验收追踪（目标架构）

| AC | 目标 | 当前证据 |
|----|------|----------|
| AC-01 | 首页唯一 joi 输入 | 已自动证实：`joi-home-single-entry.test.tsx`、Electron E2E；工作台/搭档为次级页 |
| AC-02 | 输入先持久化、300 ms accepted、可恢复 | 持久化/幂等/重启恢复已证实；真实设备 300 ms 性能待验收 |
| AC-03 | 自动工作台归属与隔离 | 已自动证实：摘要路由、一次修复、预绑定结果不重路由、工作台 session 隔离 |
| AC-04 | Life 无损映射、主 Agent 降级首选搭档 | 已自动证实：migration 017/018、`joi-orchestration-migration.test.ts` |
| AC-05 | Pi stream/tool/queue/abort/compaction/session restore | 已自动证实：完整 Turn 后由 Pi 生成有界摘要，失败时确定性本地 checkpoint；压缩计数、累计裁剪量、消息尾部及 source/model revision 经 SQLite 恢复 |
| AC-06 | joi 无任意执行工具 | 已自动证实：全局 allowlist 不含 filesystem/bash/edit/write；执行工具只进 Local Pi Partner |
| AC-07 | Partner registry/revision 后派发 | 已自动证实：添加/更新/停用/删除均先追加不可变 registry revision；dispatch attempt 固定引用 revision；历史 revision 保留当时状态 |
| AC-08 | Local Pi/A2A 统一且敏感字段脱敏 | Hub contract 已证实：统一 runner/result、prompt/workspace 脱敏；真实两类搭档待验收 |
| AC-09 | Work DAG 与确定性并发硬边界 | 已自动证实：DAG waves、policy gate、READ/WRITE workspace lease 与到期恢复 |
| AC-10 | 连续输入在 Turn 边界安排 | 已自动证实：joi task component 单槽位串行安全边界（ADR 0009，取代 `JoiInputScheduler`），Work DAG 仍可并行 |
| AC-11 | Partner 结果先成为工作台 event | 已自动证实：`partner_result_events` → 预绑定 joi input → `work_reassign` |
| AC-12 | outbox 与稳定幂等 | local/A2A 均经 outbox、稳定 action/message id、terminal 去重已证实；真实四点强杀待验收 |
| AC-13 | Pi 凭据只进 safeStorage | 已自动证实：CredentialStore adapter、DTO/diagnostics/package secret scans |
| AC-14 | 无第三方 Pi Packages | 已自动证实：只锁定三项一方 Pi SDK；Skill 使用 SDK `loadSkillsFromDir/loadSkills/formatSkillsForPrompt`，显式路径加载固定 `includeDefaults=false`，无 package/extensions/context discovery；`local-skill-scanner.test.ts`、架构边界测试 |
| AC-15 | 旧 Life 只读兼容、新契约工作台 | 已自动证实：旧 Life GET 兼容保留，所有 `/api/v1/lives` 非 GET 返回 `legacy_life_read_only`；生产 Console 使用原生工作台列表/创建，不再进入 Life 写向导或详情 |
| AC-16 | 单 scheduler、工作台 thread 隔离 | 已自动证实：生产 composition 无 WakeCoordinator/WakeRunner；每工作台稳定隔离 Pi session |
| AC-17 | 决策只修复一次，破坏操作需确认 | 已自动证实：工作台路由只修复一次；`workbench_suggest_merge/archive` 仅创建持久待确认事实，用户确认前不改数据；在途工作阻止确认，merge 保留源事实并写重定向 |
| AC-18 | 复用 gateway/breaker/capacity/vault，退役 SSE | 已自动证实：现有 gateway/outbox/vault 继续复用；ADR 0009 后 `/api/v1/stream` 删除，renderer 固定节奏轮询，真实 breaker/结果联调待验收 |
| AC-19 | Pi 门禁与既有 HTTP 安全 | 已自动证实：无 READY 来源门禁、CSRF/session/body 限制和离线 inbox 恢复 |
| AC-20 | Card 本地优先与在途删除策略 | 已自动证实：Card 不覆盖本地字段；disable 采用 DRAIN、立即阻止新派发且保留在途；delete 要求先停用且在途为零，随后追加 DELETED revision |
| AC-21 | 工作台只拥有上下文 | 已自动证实：纯 domain aggregate；预算/调度/搭档策略独立关联 |
| AC-22 | 新代码无 Life 词汇泄漏 | 已通过 architecture boundary 与目标路径静态扫描；旧兼容模块保留 Life |
| AC-23 | 首次精确文案、7 个厂商入口、接入方案与协议 | 已自动证实：精确文案、恰好七个厂商入口、API/Coding Plan/Token Plan 与 OpenAI/Anthropic 分层选择；百炼两类套餐 endpoint 独立且无转发平台 |
| AC-24 | 固定 endpoint 与通用 URL 网络策略 | 已自动证实：官方 endpoint、localhost 例外、显式 RFC1918 IPv4 的 HTTP/HTTPS 自定义来源（仍须 API Key）、DNS 私网/metadata/redirect 拒绝与安全中英错误提示；`model-source-network-policy.test.ts`、`model-source-service.test.ts`、`i18n.test.tsx` |
| AC-25 | 多来源、主备顺序、revision/credential 边界 | 已自动证实：多源排序、不可变 revision、Turn pin 与 safeStorage reference |
| AC-26 | 版本化模型 preset 与自定义模型 fail closed | preset contract 已证实；custom 首 Turn 未观察到 tool call 时 fail closed |
| AC-27 | 首次验证和 composer 门禁 | 已自动证实：draft/验证/门禁、最小文本检查、不做 onboarding tool probe |
| AC-28 | 确定性 fallback 分类 | 已自动证实：仅 timeout/connect/429/5xx；auth/balance/config/refusal 不切换 |
| AC-29 | Turn 固定 revision 与安全切源 | 已自动证实：output/tool flag 持久化，副作用前才更新 source/model pin |
| AC-30 | 来源 CRUD/排序/重启恢复与历史不漂移 | 已自动证实：脱敏 CRUD/验证/停用/主备排序/重启恢复；设置页可替换 model/key，通用源可改名称/Base URL，空 key 保留旧凭据且修改形成待验证 DRAFT revision。删除已使用来源须保留历史 Turn 的 source/model revision，移除可用配置并清除凭据密文，剩余来源重新排序；重启或迟到的验证不得恢复已删除来源，删除失败须显示安全提示并允许重试。回归：`sqlite-model-source-repository.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-31 | 搭档配置卡片化、基础/高级页、知识库、复制与启用开关 | 已自动证实：Partner 作为无 cwd 的全局能力模板；PATCH 统一 disabled 开关、duplicate、知识库 CRUD 与正文脱敏；基础页保留名称、描述、提示词、知识库和技能，高级页保留引擎、模型、工具和供应商；继续提交 `cwd/workspaceRef` 返回 `partner_workspace_forbidden`；`partner-config-http.test.ts`、`partner-page.test.tsx`、`sqlite-partner-knowledge.test.ts` |
| AC-32 | 工作台私有搭档实例、joi 实例工具与隔离工作记忆 | 已自动证实：migration 027 为实例增加必填运行期 `workbenchId` 并将旧实例失效；ensure/list/dispatch/dispose 跨工作台返回 `partner_instance_workbench_mismatch`；工作记忆按 `(workbenchId, partnerId)` 隔离且管理 API/UI 不返回正文；`partner-instance-manager.test.ts`、`sqlite-partner-instances.test.ts`、`sqlite-partner-work-memory.test.ts`、`system-panel.test.tsx` |
| AC-33 | 本地 CLI 搭档引擎（Claude Code / Codex，经同源 agentsdk，ADR 0004） | 已自动证实：CLI 探测、运行时不注入 provider/密钥、ephemeral/resident、resume fallback、健康门禁、工具白名单和技能注入保持；Codex one-shot 使用 native conversation 避免 stdin 等待，resident 使用 `codex` backend 与 resumable turns，Claude Code 使用原生 `claude` backend。CLI stream 无 success result、异常或非成功 result 均转为稳定 `ENGINE/UNKNOWN` failure carrier，并在 Agent 对话显示安全 ERROR，禁止泄露原始输出或盲目重放。Joi 通过 `partner_list_skills` / `partner_set_skills` 选择本机搭档技能。Pi core catalog 复用 Pi SDK 的递归/frontmatter/collision 规则，只派发精确选中 Skill 的元数据，正文通过 `read` 按需加载；`read` 仅允许工作台与选中 Skill 根目录，收窄工具列表时 Skill 强制要求 `read`。保存与列表设置复用 exact validator，历史脏 revision 公开 `ACTION_REQUIRED` 配置状态，编辑器在失效引用或缺 `read` 时禁止提交；未知/旧引用在执行前归类为 `CONFIGURATION/NONE`，下游保留 failure carrier 并输出可操作提示。bash 继承精确非敏感基线；其他环境变量仅在当前精确选中 Skill 的合法 `metadata.joi_required_env` 声明、进程级 `JOI_PARTNER_ENV_PASSTHROUGH` 授权和 Joi 进程已有值三项交集内注入，未选择该 Skill 的其他 bash Partner 不可见；非法声明启动前失败。缺失凭据工具错误确定性转为 `WAITING_INPUT`，不再继续调用模型输出 `BLOCKED`；cwd 仍由当前工作台 context snapshot 提供，NONE 不注入文件工具；旧全局目录 picker 返回 410；`local-skill-scanner.test.ts`、`partner-registry-service.test.ts`、`partner-page.test.tsx`、`pi-coding-tool-factory.test.ts`、`partner-instance-manager.test.ts`、`partner-run-failure.test.ts`、`local-pi-partner-runtime.test.ts`、`mana-engine-contract.test.ts`、`sqlite-partner-dispatch-instances.test.ts`、架构边界测试 |
| AC-34 | 搭档页场景预设页签（内置 + 本机技能混排、限最近6、点选角色一键创建搭档） | 已自动证实：`shared/joi.ts` 的 `BUILTIN_SCENARIOS` 每场景声明 ≥2 个 `roles`（行为化自包含 brief：DO/验收标准/范围外）、`GET /api/v1/scenarios`（内置必现、技能映射单角色场景并按 `modifiedAt` 取最近 6 混排、skills 缺失仅内置）、新增 `POST /api/v1/scenarios/:id/partners` 按 roleIds 确定性创建搭档（复用 `PartnerRegistryService.add`、pi-core、201；未知场景 404、未知角色 400）；搭档页『场景预设』页签点击卡片展开角色勾选（默认全选）→『创建所选搭档』直达完成，不再经 joi 补充细节；`scenarios-http.test.ts`、`partner-page.test.tsx` |
| AC-35 | joi 自建团队并显式选模型、wayfinder 式编排提示词（ADR 0005） | 已自动证实：`model_list_sources` 工具仅返回 READY 源、`partner_create` 新增可选 `modelSourceId`/`modelIdOverride` 透传（引擎固定 pi-core）且并入 `JOI_REASONING_TOOL_NAMES`；失败 result Turn 可用 `partner_set_model` 追加新的 immutable Partner revision，Pi runtime 按 revision 固定的 READY source 实际选模后再 `work_reassign`；`buildJoiSystemPrompt` 编入 destination-first/逃生舱、HITL-AFK、Agent-Brief 自包含搭档提示词、派发、失败恢复与聚合纪律，并保留 custom-model fail-closed 与工作台上下文注入；`joi-reasoning-tools.test.ts`、`joi-system-prompt.test.ts`、`local-pi-partner-runtime.test.ts`、`single-joi-workbench-routing.test.ts` |
| AC-36 | 澄清就地解决 + 首页输入框融合 + 空态双出口 | 已自动证实：新增 `POST /api/v1/joi/messages/:inputId/clarify`（`workbenchId` 重设归属 / `text` 追加 `[用户补充]`，置回 `PENDING` 并复用 `handle` 重派；非澄清态 4xx），`JoiInboxService.clarify` 校验 + `SqliteJoiInboxRepository.clarify` 原子状态守卫；`clarification_reason_code` 经 `JoiInboxRecord`/`JoiAcceptedMessageDto.clarificationReasonCode` 透出，信息流澄清卡按原因码显示补充说明并提供工作台点选 chip 与就地补充框，成功后随刷新消失；composer 融合为聊天气泡；空/薄搭档引导提供『看场景预设』『去搭档页创建』两出口；`joi-clarify-http.test.ts`、`sqlite-joi-inbox-clarify.test.ts`、`joi-inbox-service.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-37 | 极简单栏首页与可删除目标卡 | 已自动证实：移除右侧工作状态与通用过程行；active Turn 统一显示 `progressing`，终态降低字号并在 15 秒后消失；每个原始目标聚合为一张工作台卡，同工作台多目标不合并；只有 inbox、Work、Partner Run 均终态才允许持久删除；合成结果输入不进入主页；`sqlite-workbench-agent-feed.test.ts`、`sqlite-joi-inbox-dismiss.test.ts`、`joi-home-single-entry.test.tsx`、`workbench-agent-http.test.ts` |
| AC-37 归档增量（2026-10-09） | 目标卡的「归档」与操作二级菜单 | 已自动证实：migration 068 的 `archived_at` 是 `dismissed_at` 的可逆对应物——只有终态且没有非终态 Work/Run 的目标可归档，归档后离开首页信息流、进入侧边栏「已归档」，可以在那里取消归档、继续或移除；继续（显式重试与定时续跑）在同一事务里清空该列，重新跑起来的目标不会继续隐身；卡片操作收进 `⋯` 二级菜单，`继续/取消任务/归档/移除` 按状态与 `canArchive`/`canDelete` 决定是否出现，归档比移除早一步可用（未定稿的失败卡可归档但不可移除）；归档页的卡片是紧凑形态（无进度条、无结果正文预览，改为显示归档时间），`goal-action-menu.spec.ts` 另以计算样式钉住 `⋯` 触发器的安静圆钮形态、并 hit-test 二级菜单不被卡片裁切；`sqlite-joi-inbox-archive.test.ts`、`joi-home-single-entry.test.tsx`、`http-route-manifest.test.ts`、Flutter `widget_test.dart`（`GoalActions` 菜单与 `ArchivedGoalsPage`） |
| AC-38 | 工作台 workspace binding 权威、受控上下文快照与结果先归档闭环（ADR 0006） | 已自动证实：migration 027 的 workspace binding/root、task projection、context snapshot、WorkResult 和升级取消；每个工作台只从自己的 opaque binding 解析 cwd，受管目录幂等创建/失败重试；主 joi 仅在 Workbench 尚未绑定或仍停留在默认受管目录时，可对用户请求明确给出的绝对目录直接绑定，用户已绑定的 BOUND 工作区不可被改写，未给出时回退受控目录选择器，工具与上下文不返回绝对路径；NONE/READ/WRITE 与 A2A 文件禁派；上下文 persona/路径脱敏；结果事务先更新事实/Work/工作台 projection 再通知，跨工作台 `work_read_result` 拒绝、分页游标严格校验，迟到结果不重开工作或进入整合；工作台上下文中心只显示安全元数据；`joi-orchestration-migration.test.ts`、`workbench-workspace-provisioner.test.ts`、`sqlite-dispatch-policy-gate.test.ts`、`workbench-context-assembler.test.ts`、`work-result-service.test.ts`、`sqlite-work-plan-outbox.test.ts`、`sqlite-partner-dispatch-instances.test.ts`、`workbench-context-http.test.ts`、renderer 测试 |
| AC-39 | 结构化澄清卡与可靠恢复（ADR 0007） | 已自动证实：migration 029 持久化具体问题；`user_ask` 生成可回答的 `question_required` 卡；工作区未 READY 时 `work_dispatch` 在计划提交前失败，若原始输入含绝对目录且该 Workbench 尚未绑定（非 BOUND）则 `workbench_bind_workspace` 直接绑定并在同一 Turn 继续，否则生成目录卡，目录按钮调用安全的工作台工作区 bind 后恢复同一输入；活跃输入期间的同 ID 通知在安全边界重跑一次；完成 Turn 不消费仍待澄清的 inbox；补充、回答、目录绑定或取消成功后操作卡立即退出当前主页，失败仍原位提示；migration 032 的 `dismissed_at` 供终态目标持久软删，且 migration 033 后还需关联 Work/Run 全部终态；现有工作台归属和 merge/archive 确认卡保持；`joi-task-component.test.ts`、`agent-dispatch-component.test.ts`、`work-orchestration-service.test.ts`、`joi-reasoning-tools.test.ts`、`sqlite-joi-inbox-clarify.test.ts`、`sqlite-joi-inbox-dismiss.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-40 | 工作台 → Agent → 只读对话三级信息架构（ADR 0008） | 已自动证实：migration 033 仅登记新本机实例/A2A run，不回填旧历史；工作台详情始终列出未删 Agent，使用 instance `IDLE/BUSY` 表示可用性；目标详情携带 `goalId` 时改由该 session 在目标中的活跃或最新 partner run 投影执行状态，终态 COMPLETED/FAILED 不被 resident IDLE 覆盖；一次性 Agent 仅终态可删，常驻不可删；对话投影支持 Markdown/GFM、tool call/result、artifact/error，禁用 raw HTML/远程图片和直接 composer；引擎内部推理、工具参数正文、A2A data payload 与凭据不进入展示面（工具调用可内联一行 ≤200 字符的摘要，属安全元数据而非参数正文，其中绝对路径缩写为「盘符/根 + 末三层」；完整命令与输出只在桌面按需读取，见 AC-61）；删除不影响 Work/Result/audit；`agent-conversation-presentation.test.ts`、`sqlite-workbench-agent-feed.test.ts`、`sqlite-partner-dispatch-instances.test.ts`、`workbench-agent-http.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-41 | 目标—Work 强关联与唯一权威终态 | 已自动证实：migration 034 回填可证明来源并对歧义/孤儿安全中止，数据库守卫与应用事务共同校验 Turn/input/工作台；每个 run 最早终态权威，冲突终态仅审计且不重复通知；`joi-orchestration-migration.test.ts`、`sqlite-work-plan-outbox.test.ts`、`work-result-service.test.ts`、`sqlite-workbench-agent-feed.test.ts` |
| AC-42 | 私有完整 Work brief 与受控机械验收 | 已自动证实：显示标题不再作为 Agent 唯一输入，原始请求引用、执行要求和 acceptance checks 只在私有派发链装配；BODY_PRESENT 专门验收正文型结果，ARTIFACT_PRESENT 由本地引擎采集工作区新增/修改文件元数据，相对路径在计划阶段拒绝绝对路径/越界段；workspace verifier 支持相对路径存在、精确字面和声明产物检查并阻止越界；候选 COMPLETED 验证失败转为权威 FAILED；`work-orchestration-service.test.ts`、`sqlite-partner-dispatch-instances.test.ts`、`workspace-output-artifacts.test.ts`、`workspace-work-verifier.test.ts`、`work-result-service.test.ts` |
| AC-43 | 目标级结果综合、部分失败降级、完成透出与安全滚动诊断 | 已自动证实：migration 036 持久化 result-set/member/outcome 与历史收敛，migration 043 以 `COMPLETED/BLOCKED` disposition 无损升级存量 outcome；同一 revision 仅一个隔离综合输入，重复通知/重启幂等，新权威结果递增 revision。综合 Turn 必须显式提交目标级 disposition，成功至少有一个已验收完成 Work；Joi 优先用成功证据回答原目标，非关键失败只在目标详情保留异常入口，当前 COMPLETED outcome 不再被失败 Work 计数覆盖。无安全下一步的关键证据缺失才阻塞，可安全补证的缺口由 AC-66 的 `RESULT_CONTINUE` 承接；恢复使 Work 活跃后旧 revision 不写 outcome。首页在 outcome 前显示 `FINALIZING`，当前 outcome 后展示有界 `completionSummary` 并允许删除；`WAITING_INPUT`/`WAITING_AUTH` 保持需要用户，`UNKNOWN` 终结为 `FAILED` 并继续综合；JSONL 诊断只接受 disposition、ID、状态、计数与安全原因码。`pi-runtime-contract.test.ts`、`joi-reasoning-tools.test.ts`、`single-joi-workbench-routing.test.ts`、`sqlite-goal-result-synthesis.test.ts`、`joi-orchestration-migration.test.ts`、`sqlite-workbench-agent-feed.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-44 | joi harness 持久化目标地图与复盘推进（ADR 0010） | 已自动证实：migration 037 四表（maps/paths/decisions/fog）纯 CREATE TABLE，存量完成 goal backfill 为 CLEARED 不触发追溯复盘；有 turn 无 map 的 goal 恰建图一次；每 (goal, revision) 至多一条 review input（三重门槛 + 同事务水位 + INSERT OR IGNORE，回放幂等）；review turn 派发经 goal-binding 绑回原 goal；harness component 以稳定 workId 为所有 goal Work 幂等建立 path、按 review 时序分层并由 Work 终态闭路；`MAP_CLEARED` 仅对应 RUNNING/WAITING review turn 可提交，事务同时要求最新 outcome 已综合、无活跃/未建图 Work 和无 OPEN path；CLEARED 反哺 `task_summary` 恰好一次（尾部 2000 截断）；琐碎空图静默清空不入复盘/反哺；历史 review 对 `COMPLETED` 结果在无活跃 Work、路径闭合且 Work-path 完整时自动清理旧澄清标记，不读取模型关键词、不重放副作用未知的历史 Turn；未进入专用 Work recovery 的历史异常 review 仅在 `side_effect_started=0` 时同 revision 幂等重排，否则隔离，副作用未知的 review 本身从不重放；blocked-goal recovery 入队后旧 review reconciler 让出修复所有权，避免重新制造 NEEDS_ATTENTION；`harness_refine_workbench` 只走既有 update 面（禁 name/projectLabel）并落 WORKBENCH_REFINE 审计；home-feed goal 卡合并 harness 有界投影且 review 输入不冒充 goal 卡；`sqlite-joi-harness-repository.test.ts`、`joi-harness-component.test.ts`、`joi-harness-review-body.test.ts`、`joi-reasoning-tools.test.ts`、`joi-orchestration-migration.test.ts`、`joi-actor-tick.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-45 | 旧产品实体名全局迁移为工作台 | 已自动证实：产品文案使用“工作台”，TypeScript 契约使用 `Workbench/workbenchId/workbench.*`，HTTP 使用 `/api/v1/workbenches`；migration 038 从 037 无损迁移表/列/外键/枚举/outbox，稳定 row/idempotency id 保留；术语边界、migration、shared/HTTP/renderer/actor 测试覆盖 |
| AC-46 | 工作台聚类命名、受管环境目录与 Agent 能力聚类命名分离 | 已自动证实：前端调试/分析工作台使用 `aimanadebug` 目录标签，受管目录创建/重建/provision 共用路径规则；角色型 `资深程序员搭档` 归类为 `编码工坊`，场景预设统一使用工坊类名称；`workbench-naming.test.ts`、`workbench-workspace-provisioner.test.ts`、`joi-reasoning-tools.test.ts`、工作台/搭档 renderer 回归覆盖 |
| AC-47 | 首页首问即时目标卡与澄清卡去重 | 已自动证实：未绑定 `PENDING` 输入经 home-feed 左连接入 `ARRANGING`/“等待归属”目标卡，Workbench 绑定后同 inputId 升级；未绑定 `CLARIFICATION_REQUIRED` 排除目标列表并保留 `unassignedActions`；`sqlite-workbench-agent-feed.test.ts`、`joi-home-single-entry.test.tsx`、`workbench-agent-http.test.ts` |
| AC-48 | `progressing` 旁安全进度摘要 | 已自动证实：home-feed 从 goal、Work、harness map/review 水位投影 `ROUTING/PLANNING/DISPATCHING/RUNNING/WAITING/FINALIZING/REVIEWING/EXTENDING`、Agent 数和 Work 完成/失败/总数；ACTIVE map 的当前层 outcome 显示“正在评审”，复盘追加 Work 显示“评审后补充执行”，只有 CLEARED map 才展示最终回答及终态操作。renderer 只映射安全阶段、计数和已用时间并保留 `progressing` 闪动，禁止 ETA、原始消息、模型标识、路径和错误正文。终态目标点击“继续”后在 retry HTTP 尚未确认时即时显示 `正在提交继续请求`，确认后切换为 `queued`/`正在安排`；同一事务重开 CLEARED map、保留历史与评审水位并复位清图/反哺水位，补充要求不得复用旧终态直接完成；拒绝时撤销临时提交态、展示安全错误并保留重试入口。保留 HTTP 轮询与本地即时反馈，不新增 SSE/WebSocket；`sqlite-joi-inbox-retry.test.ts`、`sqlite-joi-harness-repository.test.ts`、`sqlite-workbench-agent-feed.test.ts`、`joi-home-single-entry.test.tsx` |
| AC-49 | 默认 Pi core 受控网页研究能力 | 已自动证实：`BuiltinPiCodingToolFactory` 默认目录包含 `web_search`、`fetch_content`、`get_search_content`；`PiWebAccessToolFactory` 覆盖公开 URL 校验、DNS/重定向私网拒绝、超时/响应大小限制、HTML 可读性抽取、GitHub README、有限内存缓存与分页；`pi-web-access-tools.test.ts`、`pi-coding-tool-factory.test.ts`、`joi-reasoning-tools.test.ts`。适配器不动态加载第三方 Pi package，不读取 cookie/凭据，不 clone 或写 workspace。 |
| AC-50 | 首页持久展示普通直接回答 | 已自动证实：migration 042 的 `joi_turn_completions` 以 input/turn 外键、唯一性和 outcome CHECK 保存独立展示事实；Pi runtime 仅投影 `turn_complete` 安全 outcome 枚举，Coordinator 捕获最终文本、空回答同轮只修复一次并在持久化前有界脱敏；SQLite 同事务校验 input/turn 归属并完成 Turn/Inbox，home-feed 仅对已消费且无 result-set 的输入投影，重试隐藏旧结果，当前 Goal outcome revision 始终优先；既有 renderer 使用 `completionSummary` 显示卡片 Markdown 预览和全文抽屉。`single-joi-workbench-routing.test.ts`、`pi-runtime-contract.test.ts`、`sqlite-joi-turn-completion.test.ts`、`joi-home-single-entry.test.tsx`、`joi-orchestration-migration.test.ts`。 |
| AC-51 | 派发自动消歧与首页搭档选择卡 | 已自动证实：`work_dispatch` 在提交前将 one-shot ephemeral 与实例引用冲突机械收敛为无实例计划；一次模型纠正后仍属 partner/instance 可恢复失败时持久化 `partner_selection_required`，Coordinator 保留已提交的具体原因。`/clarify` 接收互斥 `partnerId`，应用层只允许 ACTIVE、配置有效搭档，SQLite 以 `expectedReasonCode` 原子守卫后追加稳定选择并重排原输入；renderer 从 snapshot 过滤可用搭档，展示名称/描述卡片，点击发送 ID，隐藏自由输入，无可用项显示管理提示；普通安全 prompt 优先于通用文案。`joi-reasoning-tools.test.ts`、`single-joi-workbench-routing.test.ts`、`joi-inbox-service.test.ts`、`sqlite-joi-inbox-clarify.test.ts`、`joi-clarify-http.test.ts`、`api-client.test.ts`、`joi-home-single-entry.test.tsx`。 |
| AC-52 | 本机 Pi 搭档进度感知超时 | 已自动证实：`PiPartnerEngineRuntime` 不再设置整次 Work/run hard deadline；Agent 消息与工具 lifecycle/update 事件刷新 20 分钟 idle deadline，连续无进度才 abort 为 `partner_run_idle_timed_out`。所有工具（包括内建控制工具）在运行时出口统一包裹不可放宽的 15 分钟 deadline，超时通过 AbortSignal 中止并向模型返回稳定 `partner_tool_timed_out`；成功终态释放 tool timer、idle timer 与 Agent 订阅。failure classifier 保留无副作用 timeout 的 transient 属性，`OBSERVED/UNKNOWN` 仍禁止自动重放。`local-pi-partner-runtime.test.ts`、`partner-run-failure.test.ts`。 |
| AC-53 | 等待动作可操作、精确恢复与 Actor/UI 状态一致 | 已自动证实：migration 044 的 `joi_user_action_requests` 把 question/recovery action 绑定到精确 input/Work/run 并迁移存量 WAITING；clarify 原子写 `RESOLVED`，Joi task 对该类动作绕过 model-source gate，Coordinator 不调用模型而以稳定 action id 恢复原 Work；Work resume 在崩溃重试时复用既有 dispatch attempt，并终结被取代的 WAITING run/attempt。Workbench attention reconciler 修复无动作 WAITING；home-feed 只有具体 clarification 才显示 `NEEDS_ATTENTION`，修复窗口保持 RUNNING；goal-scoped Agent 卡以该 goal 的活跃或最新 partner run 覆盖实例 IDLE，既覆盖 WAITING/RUNNING，也保持 COMPLETED/FAILED 终态；全局 Agent 卡仍保留 instance availability。Agent 远端 retry/orphan finalize 使用 fire-and-converge，根 tick 不阻塞；renderer 为恢复决策提供无自由输入的一键卡。`sqlite-joi-inbox-clarify.test.ts`、`single-joi-workbench-routing.test.ts`、`joi-task-component.test.ts`、`work-orchestration-service.test.ts`、`workbench-agent-component.test.ts`、`agent-dispatch-component.test.ts`、`sqlite-workbench-agent-feed.test.ts`、`joi-home-single-entry.test.tsx`。 |
| AC-54 | 多工作台共享物理工作目录 | 已自动证实：migration 045 移除 root_path 唯一所有权并保留非唯一查询索引；绑定 repository/HTTP 允许多个工作台以各自 opaque workspace ref 指向同一 root，安全 DTO 不返回路径。`SqliteWorkspaceLeaseManager` 通过私有 root 映射跨 ref 计算冲突域，保持 READ/READ 并发及 WRITE 排他；工作台上下文、会话、结果和跨台访问边界不变。`workbench-workspace-uniqueness.test.ts`、`sqlite-workspace-lease.test.ts`、`workbench-context-http.test.ts`、`joi-orchestration-migration.test.ts`。 |
| AC-55 | 搭档模型 pin 可编辑、可清除且可安全测试 | 已自动证实：Pi 搭档编辑器以受控字段同步 READY 模型源的 active model，PATCH 接受显式 `null` 清除旧 pin，保存后重读最新 immutable revision；registry 在 append 前拒绝非 READY 来源和来源/模型不匹配。`POST /api/v1/partners/:partnerId/test-model` 对 Pi 复用模型源固定极小验证；对 Claude Code/Codex 仅在用户点击后通过原生 backend 发起无工具最小真实调用，PATH health 不冒充调用成功。两者均不创建 Work/run/工作区副作用且只返回安全 DTO；native failure 被归一为认证、模型、限流、服务、进程、存储或通用原因码，settled diagnostics 仅含引擎、阶段、结果、耗时与原因码，renderer 显示对应安全操作提示。嵌套 Codex/Codux 启动会隔离上层会话的 `CODEX_HOME`/`CODEX_API_KEY` 与 managed-package 覆盖并回落到桌面用户 CLI 登录缓存；可执行文件跳过 App `node_modules/.bin`，仍从用户 PATH 安装解析。普通 shell 的主动配置保持原生继承。搭档卡区分模型测试与本地搭档可用性测试，A2A 不显示动作。`partner-registry-service.test.ts`、`partner-engine-catalog.test.ts`、`partner-model-probe-service.test.ts`、`mana-executable-resolver.test.ts`、`mana-engine-contract.test.ts`、`partner-config-http.test.ts`、`api-partner-client.test.ts`、`partner-page.test.tsx`。 |
| AC-56 | AI Berkshire 可移植大型场景预设包 | 已自动证实：内置目录归因 `xbtlin/ai-berkshire@2760dc48`（MIT），将二十个 canonical workflows 与 `investment-memo-craft` overlay 移植为六个子团队、十五位共享能力搭档且不引用来源绝对路径；migration 046 持久化稳定 pack/role 绑定，子团队/完整安装、重复复用、部分失败恢复、用户 revision 保留和停用状态降级均由 `ScenarioPackService` 收敛；`GET /api/v1/scenario-packs` 不返回 prompt，安装接口只接受团队卡选择。`financial_calculate` 使用 decimal.js 执行固定财务 operation，`research_audit` 只返回有界聚合结果，两者禁止任意表达式执行或正文回显；`ai-berkshire-scenario-pack.test.ts`、`sqlite-scenario-pack-installer.test.ts`、`pi-financial-research-tools.test.ts`、`scenarios-http.test.ts`、`partner-page.test.tsx`。 |
| AC-57 | 扫码绑定的受限 Android 原生远程入口（ADR 0013） | 已自动证实：Rust iroh host/controller 以自定义 ALPN 建立真实 QUIC 并隔离两个并发设备；Electron sidecar 票据携带 direct address 与默认 `remote.joilab.top` relay，设置页仍允许手动配置；十分钟一次性 `joi://pair`、HMAC/HKDF/AES-GCM、严格序号和 `feed.get/message.send` allowlist 保持；Android 只显示竖屏任务卡和文字 composer，凭据进入系统安全存储；arm64 Rust 动态库和 release APK 可构建。证据：`native/joi-remote/tests/*`、`native-remote-access-host.test.ts`、`remote-command-service.test.ts`、`remote-access-http.test.ts`、`apps/joi_mobile/test/*`。两台 Android 真机并发绑定、Wi-Fi 直连、5G 中继切换和逐台撤销仍属外部待验收；验收前 ADR 0012 代码只作回退保留。 |
| AC-58 | 编程、调研分析与内置 Skills 多套件目录 | 已自动证实：`PROGRAMMING_SCENARIO_PACK` 将功能实现、代码审查、Bug 诊断和架构改进收敛为四个团队/八位角色，`RESEARCH_ANALYSIS_SCENARIO_PACK` 将目标规划与研究综述收敛为两个团队/四位角色；动态 `builtin-skills` 套件按修改时间只取 Pi core 最近六个可用本机 Skill，并把精确 portable ref 挂到对应搭档。四个套件共用 `ScenarioPackService` 的稳定 pack/role 绑定、团队/完整安装、重复复用与用户 revision 保留语义；renderer 只呈现可展开套件，覆盖骨架、空态、失败和空安装禁用，旧 `/api/v1/scenarios` 保持兼容。`builtin-scenario-packs.test.ts`、`scenario-pack-service.test.ts`、`sqlite-scenario-pack-installer.test.ts`、`scenarios-http.test.ts`、`partner-page.test.tsx`。 |
| AC-59 | 搭档提示词显式查看、替换与追加 | 已自动证实：普通 Partner DTO 只新增 `promptConfigured`，正文和 `promptRef` 继续脱敏；`POST /api/v1/partners/:partnerId/prompt/reveal` 使用写权限验证与 no-store 响应按需读取。PATCH `REPLACE` 保持旧调用兼容，`APPEND` 由服务端读取当前正文、空行连接并创建新的 prompt row 与不可变 revision；空白、超长、无存储或记录缺失均 fail closed。编辑页只有点击后才读取，提供替换/追加单选、当前正文与安全失败文案，未触碰提示词时不发送 mutation。`partner-registry-service.test.ts`、`partner-config-http.test.ts`、`http-route-manifest.test.ts`、`api-partner-client.test.ts`、`partner-page.test.tsx`。 |
| AC-60 | 本机 pi-core Agent 运行时安全消息流 | Pi lifecycle 在**主时间线**只投影 assistant `text_delta`、工具名、完成/失败状态与一行 ≤200 字符的脱敏调用摘要；thinking、工具参数正文和原始结果不进入主时间线写路径。`toolCallId` 是不透明关联标识，与 `entryId`/`artifactRef` 同类，不属于禁载荷。每次工具完成另按 `(run_id, tool_call_id)` 单条落本机 `workbench_agent_tool_traces`（凭据写入前脱敏、绝对路径保留、单条 ≤8 KB 超出截断并标记），只经桌面写权限按需读取，见 AC-61。任务在模型执行前进入展示。事件按接收时间记录，文本增量保留首片时间，成功终态保留 live 时间线。`replaceRun` 按稳定 ID 更新变化项、保留 sequence，不重复重写未变化记录。会话默认打开最新 50 条，按 sequence 正序显示；向上滚动自动补载历史并保留位置，历史阅读不停止刷新，底部自动跟随输出。选中的 RUNNING/WAITING Agent 在请求完成后间隔 750 ms 刷新，不并发轮询，跨页新输出自动补齐；终态再刷新一次。`latest=true` 使用向前 keyset 游标，旧客户端默认分页兼容；目标详情按 goalId 隔离。不恢复 SSE/WebSocket。验收：`agent-conversation-live.test.ts`、`agent-message-stream.test.tsx`、`native-agent-events.test.ts`、`partner-instance-manager.test.ts`、`local-pi-partner-runtime.test.ts`、`tool-trace-presentation.test.ts`、`workbench-agent-http.test.ts` 及现有运行时回归。旧数据缺失的真实时间不推算补造。 |
| AC-61 | Agent/结论产物桌面快捷操作与紧凑工具记录 | 已自动证实：workspace 输出采集为文件和新目录保存内部 `workspace:` 引用；conversation 与 home-feed 仅返回 artifactId、名称、MIME、大小和类型。desktop-only write route 按 source/Workbench 权威关联查找并对绑定 root、relative path、realpath、存在性和类型 fail closed，LAN 返回 403；renderer 点击 OPEN、右键 REVEAL，目录可直接打开；工具调用/结果默认单行折叠，折叠行显示一行 ≤200 字符的摘要（绝对路径缩写为「盘符/根 + 末三层」）并标出正在运行的调用，完整的命令与输出只在桌面写权限下经 `POST /api/v1/workbenches/:workbenchId/agents/:agentId/tool-traces/:toolCallId/reveal` 按需读取（非 desktop 会话 403、no-store、凭据脱敏且保留路径、单条 ≤8 KB 并标出截断；正文只存本机 `workbench_agent_tool_traces`，不进首页、诊断、SSE 或远端）。`workspace-output-artifacts.test.ts`、`workbench-artifact-opening.test.ts`、`workbench-agent-http.test.ts`、`http-route-manifest.test.ts`、`api-client.test.ts`、`joi-home-single-entry.test.tsx`、`tool-trace-presentation.test.ts`、`sqlite-workbench-agent-traces.test.ts`。 |
| AC-62 | Claude/Codex 官方 Agent SDK 与统一安全事件表面 | 已自动证实：`@rd-efficiency/agentsdk` 依赖、store 和组合接线移除；Claude/Codex 官方适配器分别覆盖 partial streaming、工具生命周期、本机配置/认证（不强制环境 API key）、原生认证失败安全归因、模型原样传递、显式权限、start/resume 与用户 CLI 路径。Joi 自有 message/status/artifact/tool activity 事件不携带工具参数、命令、结果、reasoning、原始错误或绝对路径；应用 projector 继续生成现有对话 DTO。工具轨迹走独立于该事件表面的显式本机通道（`onToolTrace` 端口 → 本机 SQLite），不改变本条事件契约；该通道本轮只在 pi 引擎接线，Claude/Codex 适配器不接线。schema 047 保存 `engine_config_json` 并确定映射旧工具策略；session ref 使用 `native-agent:v1` 标签，旧引用不恢复。包契约确认 agentsdk 为空且排除 Claude/Codex 平台二进制。AC-33/AC-55 中原 agentsdk 运行时描述由本条取代，旧行仅保留历史验收上下文。`native-agent-sdk-contract.test.ts`、`native-agent-events.test.ts`、`sqlite-partner-registry.test.ts`、`package-contents.test.ts`、`partner-page.test.tsx`、架构边界测试。 |

| AC-64 | Agent 失败自愈、补充 Work 与首页降级（ADR 0016） | 已自动证实：migration 050 将恢复尝试按 source Work 持久化且最多两轮，补充 Work/outbox/recovery/evidence 同事务提交；`BLOCKED` outcome 不再进入 review，harness 为无活跃 Work 的阻塞目标创建专用 goal-bound recovery input 并清除伪造的 `work_dispatch_failed` 用户澄清。`work_supplement` 不接受历史 DAG key，自动携带同目标权威完成结果引用，并以源 Work 验收条件及访问模式为不可削弱下限；Markdown 正文不能替代所需 HTML/PDF。`partner_set_tools` 只创建内置工具 grant 的不可变 revision，仍受 Workbench、SSRF 与无凭据边界约束。Pi 失败后仍采集工作区变化，非正文验收通过可把 UNKNOWN/FAILED 收敛为完成；上下文和网页响应有界，常见 400 映射为 allowlist 安全原因码，未知 400 保留 `http_400`。首页隐藏派生 recovery input，并在恢复可用/在途时显示 `EXTENDING`；单 Agent 失败只在目标详情显示，恢复耗尽才保留目标级失败。`work-orchestration-service.test.ts`、`sqlite-work-plan-outbox.test.ts`、`sqlite-joi-harness-repository.test.ts`、`joi-reasoning-tools.test.ts`、`partner-run-failure.test.ts`、`workspace-work-verifier.test.ts`、`pi-web-access-tools.test.ts`、`local-pi-partner-runtime.test.ts`、`joi-home-single-entry.test.tsx`。 |
| AC-65 | 搭档真实权限、READY freshness 与 403 安全恢复 | 已自动证实：本机 Partner revision 在既有 `execution_policy_json` 保存 `ALL/CUSTOM`，旧空/非空工具列表兼容解释且历史 revision 不重写；新建与新装场景默认 ALL，CUSTOM 可为空，Skill+Pi CUSTOM 缺 read 时保存和派发均拒绝。Claude SDK 同时收到真实 `tools` 与 `allowedTools`；Codex 默认 workspace-write、网络和 live search 且 approval 固定 never。三引擎提示词列出最终启用、关闭/不可用能力。Pi READY 来源按五分钟与 source/model/credential revision 合并无工具探测，未 pin 可顺序换源、pin 失败停止；运行时 401/403 先摘除再复诊，403 只保留五类安全码。FAILED/UNKNOWN 始终追加独立 ERROR，既有 OBSERVED/UNKNOWN 产物验收和补充 Work 规则保持。`partner-registry-service.test.ts`、`sqlite-partner-registry.test.ts`、`partner-page.test.tsx`、`native-agent-sdk-contract.test.ts`、`local-pi-partner-runtime.test.ts`、`reasoning-source-selector.test.ts`、`pi-model-source-validator.test.ts`、`partner-run-failure.test.ts`、`sqlite-partner-dispatch-instances.test.ts`。 |
| AC-66 | 结果缺口自动续跑与保留当前结果（ADR 0017） | 已自动证实：migration 051 扩展 `RESULT_CONTINUE`/`CONTINUE` 与 `ACCEPTED_WITH_GAPS`，地图默认持久化两层续跑额度；额度内 review 自动安排下一证据层，额度耗尽才创建 revision-bound `GOAL_CONTINUATION` 动作。继续完善原子增加两层授权且不重路由原输入；保留当前结果原子消费动作、清图并投影 `COMPLETED_WITH_GAPS`，反馈记忆明确标为有缺口。中间 `CONTINUE` 不进入工作台近期结果，首页提供“继续完善/保留当前结果”，终态不残留 thinking。`pi-runtime-contract.test.ts`、`joi-reasoning-tools.test.ts`、`sqlite-goal-result-synthesis.test.ts`、`sqlite-joi-harness-repository.test.ts`、`sqlite-joi-inbox-clarify.test.ts`、`joi-harness-component.test.ts`、`joi-home-single-entry.test.tsx`、`remote-joi-app.test.tsx`。 |
| AC-67 | 编排确定性与运行时死线（评估 §11 修复） | 已自动证实：声明的 Work 依赖在派发时真正门控（前置全部完成才可认领），前置失败级联取消下游（migration 052）；策略拒绝不再静默，永久拒绝落可见终态，工作区租约竞争则保留 outbox 并每 5 秒自动复检且不消耗准备失败终结预算；工作区租约心跳续租、丢失即中止；claude-code/codex 有总/空闲死线且组件看门狗可中止；每个 Work 强制至少一个验收项并被合成/`work_read_result` 消费；`failTurn` 不再把已产生副作用的输入回置重放。详见 `14-joi-multi-agent-runtime-assessment.md` §11。`sqlite-work-dependency-gate.test.ts`、`sqlite-work-plan-outbox.test.ts`、`sqlite-workspace-lease.test.ts`、`native-agent-sdk-contract.test.ts`、`native-run-deadlines.test.ts`、`agent-dispatch-component.test.ts`、`sqlite-goal-result-synthesis.test.ts`、`joi-actor-tick.test.ts`。 |

AC-60 补充：首次打开执行记录时，外层长任务抽屉也定位到最新消息可见处；用户开始阅读历史后不抢夺位置。异常结束且没有最终快照时，保留已持久化历史，只追加具有稳定 ID 的终态错误/产物。覆盖 `electron-smoke.spec.ts` 的真实滚动验收及 `sqlite-partner-dispatch-instances.test.ts` 的异常终态回归。

本表随 RED→GREEN 证据更新；“旧基线可复用”不等于目标 AC 已完成。

日期：2026-08-06
事实源：`README.md`、`01-product-requirements.md`、`02-ux-specification.md`、`07-roadmap-and-acceptance.md`

## 结论与状态定义

当前里程碑为 JOI-01 M1–M3：M1（W0–W3）与 M2（W4–W5）已有仓库内自动化证据；M3 已完成 W6 自动化收敛，W7 的真实互操作、第二台 LAN 设备、macOS、签名/公证、24 小时长稳和人工视觉验收仍未完成。旧 M0–M7 表仅记录 Life/Wake 兼容基线，不得再用于宣称 JOI-01 或 MVP 完成。

- `已证实`：实现和同范围自动化证据同时存在。
- `已证实（外部待验收）`：Hub 一侧已证实，真实端点、设备或平台仍须 JOI-01 W7 验收。
- `外部`：当前环境无法提供所需硬件、端点、平台、证书或持续时间。

## PRD 功能需求

| ID | 状态 | 实现与验证证据 | 发布备注 |
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
| WEB-05 | 已证实 | 用户/表达/系统/Agent/Artifact 样式和 Wake/Turn/Flow/Delegation 安全投影；系统连续失败明确显示为“处理失败”而非“已取消”，并给出尝试次数、执行进度边界、安全诊断编号和下一步操作；activity/renderer tests | 人工视觉复核 |
| WEB-06 | 已证实 | LAN 设置受控草稿、RFC1918 网卡候选、风险前置校验、热切换/失败回滚、稳定错误码和诊断脱敏；`dual-listener.test.ts`、`settings-http.test.ts`、`settings-panel.test.tsx` | 第二设备与端口占用人工复核 |

## 非功能要求

| 要求 | 状态 | 证据 / concern |
|---|---|---|
| 持久性 | 已证实 | SQLite 事务、outbox、action/Alarm 原子提交、文件删除 staging/rollback |
| 恢复性 | 已证实（外部待验收） | messageId/taskId、get/resubscribe、unknown review、crash marker、备份 quarantine；真实强杀矩阵仍属 JOI-01 W7 |
| 性能 | 已证实（本机基线） | migration 016 时间线复合索引；`activity-pagination.test.ts` 在 100,000 条活动下要求首屏 100 条查询 `< 1s`；24h/多 Life 压测仍属 JOI-01 W7 |
| 资源 | 已证实 | 空队列不调用 Agent、WAL、可取消 Wake、容量门和配额 |
| 可观察 | 已证实 | Wake/Turn/Injection/Invocation/Flow/Action 稳定 id、因果引用和安全活动投影 |
| 隐私 | 已证实（外部待验收） | diagnostics/package/DTO/log 脱敏自动化；真实浏览器开发工具与安装日志待 JOI-01 W7 |
| 可移植 | 已证实（外部待验收） | 版本化备份、Artifact hash、session revoke、Token required；跨机恢复待 JOI-01 W7 |

## JOI-01 当前里程碑

| 里程碑 | 状态 | 结论 |
|---|---|---|
| M1（W0–W3） | 已证实（自动化） | 文档/ADR、模型源、工作台/Partner、迁移、首次连接、inbox 与最小首页闭环已有仓库证据 |
| M2（W4–W5） | 已证实（自动化） | Work DAG/outbox、本机 Pi 与 A2A adapter 已有仓库证据；真实端点仍归 W7 |
| M3（W6–W7） | 进行中 | W6 界面与信息架构已自动证实；W7 的真实环境、跨平台、签名和长稳门禁未闭合 |

## 历史兼容基线（旧 M0–M7）

下表仅保留旧 Life/Wake 运行时的建设证据，不与上表同名里程碑混算。

| 里程碑 | 状态 | 结论 |
|---|---|---|
| 旧 M0 | 已证实（Windows） | 工程、Harness、边界、CI 命令、测试隔离、生产构建和 Windows 打包通过；macOS 打开为外部 concern |
| 旧 M1 | 已证实 | persistence、双 listener、auth、CSRF、历史 SSE、Life CRUD、诊断和备份均有自动化证据 |
| 旧 M2 | 已证实（Hub） | Gateway/readiness/envelope/breaker/context/Artifact 完成；真实 AI Mana 和独立扩展待验收 |
| 旧 M3 | 已证实 | 生命周期、事件/Wake/action/repair/audit/capacity/outbox 完成 |
| 旧 M4 | 已证实（Hub） | continuity、memory、entity、schedule、Alarm、Todo、budget、delegate 完成；真实跨机/跨日待验收 |
| 旧 M5 | 已证实（自动化） | 共享控制台和核心 UI 路径完成；Electron E2E 在 960/768 px 完成无溢出断言及运行时截图检查，人工键盘/对比度仍保留 concern |
| 旧 M6 | 已证实（自动化） | marker、恢复、migration read-only mode、备份、托盘/drain、安全和诊断完成；强杀矩阵/长稳待发布验收 |
| 旧 M7 | 外部未完成 | Windows 未签名 NSIS 已构建；真实 Agents、第二设备、macOS、签名、公证、人工视觉、长稳和发布性能报告未执行 |

## E2E-01 至 E2E-11

`tests/e2e/electron-smoke.spec.ts` 现以目标架构为准：真实 Electron 完成 desktop bootstrap、管理员设置、模型网络门禁、全局 joi 首页、统一搭档目录与原生工作台创建；同时在 960/768 px 断言实际 viewport 与无水平溢出，并保存 768 px 运行时截图。旧 Life 写向导和详情不再是生产 Console 入口，历史数据只保留 GET 兼容；下表中的旧 Life/Wake 场景由底层 compatibility integration 证明，不等价于新的用户入口。

| E2E | 自动化证据 | 发布未闭合项 |
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
| E2E-10 备份恢复 | online backup/hash/quarantine/session/token/unknown integration；`backup-restore.test.ts` 验证排他复制使用全新产物目录、缺失产物形成空快照、失败不发布 | 干净机器恢复 |
| E2E-11 Endpoint 退避与审计 | shared breaker、Retry-After、activity projection tests | 真实网络抖动与 Agent |

## 当前发布 concerns

AC-67 搭档证据传递补充（2026-09-07）：`sqlite-partner-dispatch-instances.test.ts` 验证超过 320 字符的完整正文、超过十条结果、无工作区权限、恢复时重新加载、目标隔离、失败/取消/迟到/冲突/验收失败过滤，以及 A2A 私有上下文传递与展示隔离。

1. 提供真实 AI Mana 主 Agent、两个协作者和第二台 LAN 浏览器，执行 E2E-01 至 E2E-11。
2. 在 macOS 构建机完成 DMG、签名、公证、安装、升级和托盘验证。
3. 为 Windows 配置 Authenticode 证书；品牌图标已完成，当前 NSIS 仍为 `NotSigned`。
4. 连接可用的 in-app browser，完成 768/960 px、键盘、焦点、对比度和截图验收。
5. 执行 24 小时长稳、多 Life/Alarm 峰值、磁盘不足和真实网络故障报告。
## AC-63 Routine

AC-63 entry placement (2026-09-17): home goal cards do not show a scheduling action. The goal detail header places a `定时` action below `关闭`; it opens the existing continuation editor with the current goal selected. The Automation page remains an independent creation entry.

AC-63 blocked recovery regression (2026-09-17): before a new occurrence is due, unchanged continuation blockers must not update either the run or Routine row. A changed blocking reason is recorded once without moving the trigger timestamp. Delayed recovery preserves `triggeredAt` and records admission time in `queuedAt`, including exhausted one-time schedules. `goal_canceled` facts are excluded from automatic recovery scans; genuine subsequent occurrences may still coalesce without resuming the canceled goal. `tests/integration/automation.test.ts` verifies repeated ticks using SQLite `total_changes()`, reason transitions, occurrence merging, and single admission on recovery.

Routine supports daily/weekly/monthly cycles, fractional-hour intervals with a five-minute minimum, one-time execution and validated iCalendar RRULEs. Date bounds are inclusive and interpreted in the current system IANA timezone. Due occurrences are atomically merged into ordinary Joi `PENDING` inbox inputs with stable idempotency keys; offline/model-unavailable backlog is represented by one pending run and a merge count. APIs and UI expose only safe lifecycle and recent-run facts, with explicit prompt reveal.

AC-63 continuation increment (2026-09-13): every non-dismissed home goal card can seed a `GOAL_CONTINUATION` Routine from the card or Automation page. The Routine stores one fixed supplemental instruction and reuses the same goal/input/card. A due occurrence waits while the goal is active, coalesces missed occurrences, resumes only after completed or failed terminal state, and never automatically resumes a canceled goal. Removing the card atomically soft-deletes every linked continuation Routine. Target/type changes are rejected while a run is pending, running, or blocked. Integration coverage verifies same-card reuse, stale prior completion isolation, wait/coalescing, canceled behavior, and cascade soft-delete; renderer coverage verifies both creation entry points and derived Workbench behavior.

## 2026-10-13 总结停滞恢复

- AC-43 / AC-48 / AC-14 / AC-46 / AC-53 / AC-67：需求前置整理与参数纠正分别有界；空语义更新保留合同 revision；最终拒绝生成安全失败回执，只有取消历史且无在途工作/证据的旧目标只读显示 FAILED，由用户继续。证据：`tests/integration/joi-finalizing-recovery.test.ts`（真实 Pi 工具链、一次 Work/outbox、重复错误、继续后额度重置、幂等回执、活动 Turn/run/派生输入/完成证据/问题/取消保护）、`tests/renderer/joi-home-single-entry.test.tsx`（失败卡及显式继续）、`tests/integration/sqlite-home-feed-query-scale.test.ts`（目标范围查询与历史规模）。

## 2026-09-19 并发与阻塞恢复增量

- 执行状态一致性（AC-14 / AC-33 / AC-46 / AC-53 / AC-54）：真实 prepare 与受控运行中断言验证 Work/attempt/run 同步、历史状态只读兼容、混合队列展示、取消与提问竞态、重复派发和未 ACK 启动恢复；首页失败保留状态且禁止 Inbox 状态推断。证据：`sqlite-partner-dispatch-instances.test.ts`、`sqlite-work-dependency-gate.test.ts`、`sqlite-joi-inbox-cancel.test.ts`、`joi-home-feed-failure.test.tsx`、`joi-home-single-entry.test.tsx`。

- AC-14 / AC-33：本机 dispatch actor 改为按 attempt 管理多个运行槽，共享容量控制器验证全局 8、同搭档 4；每槽独立取消、watchdog、lease 续期、远端轮询和完成重试。Pi 工具顺序执行，`user_ask` 成功即终止本轮，版本化恢复回合通过内部 `goal_resume` 明确提交。证据：`agent-dispatch-component.test.ts`、`local-dispatch-capacity.test.ts`、`partner-instance-manager.test.ts`、`pi-runtime-contract.test.ts`、`joi-reasoning-tools.test.ts`。
- AC-46 / AC-54：规划 wave 只服从显式依赖；lease 冲突按 `work_run_directories.root_path` 判定，缺失时才回退 binding。独立受管目录允许并发，跨工作台同物理目录仍保持 READ/READ 共享与 WRITE 排他。证据：`work-dag-concurrency-policy.test.ts`、`sqlite-workspace-lease.test.ts`。
- AC-53：migration 058 为原始目标建立版本化执行门禁并迁移未解决问题；answer 只进入 REVIEWING，恢复输入核对完成后才原子 OPEN。Work 提交与执行启动均在事务边界复查门禁，暂停结果保留但不触发下游综合或完成投影；过期/重复回答与恢复保持幂等或拒绝。资源等待使用 `queued` 与“排队中”，不再冒充需要用户输入。证据：`sqlite-goal-execution-gate.test.ts`、`sqlite-work-dependency-gate.test.ts`、`sqlite-joi-inbox-clarify.test.ts`、`work-orchestration-service.test.ts`、`joi-home-single-entry.test.tsx`。

2026-10-14 AC-EVO-01/03/05 单调用修复：Pi adapter 的单调用提示词与协议请求约束、失败分型和用量保留由 `pi-evolution-model.test.ts` 覆盖；成功/失败/取消/重试及迟到响应记账、历史零值只读投影、旧评测器策略复验由 `evolution-service.test.ts` 覆盖；`evolution-http.test.ts` 校验真实 paused 的 HTTP 投影，`evolution-settings.test.tsx` 校验暂停与终止文案、失败分型及未知 Token。评测器版本 joi-orchestration-v2；不发真实模型调用，不自动开启或恢复进化预算。

2026-10-14 AC-WR-06 / AC-57 Android 展示同步：手机首页和任务详情消费主机已有 `work.executing/resourceWaiting/waitingReasons`，区分执行与资源排队，显示容量、读租约、写租约等待；搭档列表与实时记录消费 `executionPhase/waitReason`，显示四种执行阶段，完成后清除等待展示。缺字段旧主机继续使用 aggregate active 状态，未知枚举不显示原值，归档/恢复保留进度。Flutter `widget_test.dart` 覆盖窄屏、旧主机、显式零计数、四种阶段/等待、未知值与实时完成转换；配对、命令权限与任务状态机不变。

## 2026-10-15 工作台明确归属与双端选择（AC-14/33/46/47）

- 未绑定的新输入仅在路由明确判定唯一同项目或同职责范围时自动复用。关键词相似只用于候选排序，有效 ID 本身不足以授权自动归属。
- 无匹配、歧义、无效结构修复失败及新建建议进入持久的工作台选择；无工作台时同样等待确认，不自动创建通用工作台。生成草案仅包含名称、工程标签和范围，允许保留项目名，不截断原任务充当名称。
- 桌面与 Android 自动打开选择框；关闭保留待选状态并提供重开入口，同一问题不因轮询重复弹出。新建建议可编辑，确认前不派发 Work。首页手动选台只对本次发送生效，失败保留、成功清除；同目标继续与内部恢复保持原归属。
- 创建并绑定在同一数据库事务中验证问题版本和稳定幂等键；失败回滚，无重复工作台或孤立绑定。两端并发确认、重试和服务重建须保持相同结果，旧问题不得改变当前归属。新增可选草案字段及 workbench.choice.v1 能力，旧端继续使用兼容入口。
- 验证入口：workbench-assignment.test.ts、workbench-choice.test.ts、workbench-choice-dialog.test.tsx、joi-home-single-entry.test.tsx，以及 Android workbench_choice_test.dart、remote_session_test.dart。
