# ADR 0004: 搭档执行引擎多元化（Pi core 与本地 CLI 引擎）

- 状态：accepted（2026-08-01 修订：Mana SDK 由"内置二进制"改为"驱动用户本机 Claude Code / Codex"）
- 日期：2026-07-31
- 关联：ADR 0002（唯一 joi、Pi、Avatar 与搭档编排）

## Context

ADR 0002 确立 joi 以 Pi 为唯一主推理基座，首版不引入第二套模型运行时。搭档配置卡片化之后，用户希望部分本机搭档改由 AImana 同源 Agent SDK（`@rd-efficiency/agentsdk`，claude-agent-sdk 的内部协议层封装）执行，以复用其常驻会话与工具生态，同时保持 joi 自身的推理与调度不变。实测进一步明确：所谓"同源 SDK 引擎"应**驱动用户本机已安装的 Claude Code 或 Codex**，直接复用其登录、转发或订阅配置，而非随应用内置一份无登录的二进制。

## Decision

**joi 的推理基座保持 Pi-only**：routing/execution turn、Avatar 路由、结构化工具集与压缩策略不变（ADR 0002 明确重申，不被本 ADR 修改）。

**搭档执行引擎三值化**：领域 `PartnerEngine = pi-core | claude-code | codex`，由 `PartnerEngineRuntime` 端口统一抽象（含 `toolOptions()` 供白名单点选），`PartnerInstanceManager` 按 revision 的 engine 路由。实现为 Pi core（`infrastructure/pi/pi-partner-engine-runtime.ts`，默认）与本地 CLI 引擎（`infrastructure/mana/local-cli-partner-engine-runtime.ts`，按协议 `claude`/`codex` 各构造一个实例，共享同一 `ConversationStore`）。

本地 CLI 引擎的约束与边界：

- 可执行文件由 `local-cli-executable-resolver.ts` 探测用户系统 PATH（移植参照项目 `ai_mana_front_debug` 的方案：win32 按 `PATHEXT` 展开、codex 解析 npm shim 后的原生 `codex.exe`、macOS 回退 `/Applications/Codex.app`）。**不再有内置二进制回退**：探测不到即引擎不可用。
- **不注入 joi 的 provider/密钥**：本地 CLI 引擎的 query/会话选项不传 `ProviderConfig`，模型名仅作为可选覆盖（`engineModelId`）；认证与 endpoint 完全交给用户本机 `~/.claude` / `~/.codex` 配置，从而复用其转发或订阅服务。供应商字段在高级页对这两个引擎隐藏，仅 Pi core 显示，并提供"管理大模型网络"跳转设置页。
- SDK 与其类型只能进入 `src/main/infrastructure/mana/`，由 architecture-boundaries 的包限制规则强制；Pi SDK 同步追溯限制在 `src/main/infrastructure/pi/`。
- 健康探测 fail-closed：CLI 未检测到时引擎 UNAVAILABLE；创建/更新该引擎搭档返回 409，派发失败记 FAILED，Pi core 搭档不受影响。
- 常驻实例用 `createConversation({ turns: "resident" })` 保持热会话，重启后经持久化的 conversation id 与 SQLite `ConversationStore`（`mana_sdk_conversations` / `mana_sdk_transcript`）恢复；恢复失败回退新建会话。
- 工具白名单经 SDK 的 `allowedTools` 生效（不勾选 = 不限制），高级页按引擎列出各自原生工具名；Pi core 仍经 `beforeToolCall` + 工厂过滤（空选择 = 全部工具）。
- 技能按引擎扫描本机已安装技能（`infrastructure/skills/local-skill-scanner.ts`，来源 `~/.claude/skills` / `~/.codex/skills` / `~/.agents/skills`），以点选复选框呈现，选中项注入系统提示词；仅本机引擎注入，对远端 A2A 不发送（知识库同此策略）。
- 存储兼容：`engine` 列保留旧 CHECK 取值 `PI_CORE`/`MANA_SDK`（表示 SDK 驱动），新增 `cli_protocol` 列（`CLAUDE`/`CODEX`）记录所 spawn 的 CLI，领域层双向映射为三值，避免 SQLite 表重建（migration 026）。
- **已知并接受的风险**：agentsdk 没有 Pi 的 `beforeToolCall` 等价物，本地 CLI 搭档的工具约束主要由 `permissionMode: "acceptEdits"`、cwd 与 `allowedTools` 承担；codex 的工具名集合随 CLI 版本可能漂移，白名单为 best-effort  curated 列表，Pi core 保持默认引擎。

## Consequences

- joi 的工具面新增 `partner.create/create_instance/list_instances/dispose_instance/inspect_revision`；`work.dispatch` 可按实例与 session 策略派发。这些工具的建议权不变，硬边界（实例上限、租约、DRAIN、outbox）仍由确定性策略执行。
- 本地 CLI 搭档的会话记录进入 SDK 自有的 ConversationStore 表；joi 的搭档工作记忆以 `externalSessionRef`（`local_cli:{actionId}` 的 conversation id / `partner_instance_messages:{instanceId}` / `local_pi:{actionId}` / `a2a_invocations:{id}`）作为会话真实数据源台账。
- 依赖来自内部 registry（`@rd-efficiency` scope）；无对应 CLI 的环境引擎显示"未检测到"，产品功能降级而不报错，用户可改回 Pi core 或安装并登录对应 CLI。
