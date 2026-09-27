# ADR 0014：Claude/Codex 官方 Agent SDK 适配与 Joi 事件表面

- 状态：accepted
- 日期：2026-08-31
- 取代：ADR 0004 中基于 `@rd-efficiency/agentsdk` 的本地 CLI 实现部分

## 背景

共享 agentsdk 间接锁定旧 Codex SDK/CLI，并引入 Joi 不拥有的 conversation store 与供应商消息结构。它让 App 内依赖可能遮蔽用户 PATH 上的新 CLI，也使 Claude/Codex 的权限、恢复和错误语义难以分别按官方能力表达。

## 决策

- 删除 `@rd-efficiency/agentsdk`、Mana conversation store 代码与组合根接线；历史 025 表保留但不再读写。
- Claude Code 由 `@anthropic-ai/claude-agent-sdk` 的 `query` 驱动，启用 partial messages，显式使用用户 PATH 中的 Claude 可执行文件。认证交由用户 CLI 按本机配置处理，保留 SDK 默认设置来源与进程环境（包括显式 `ANTHROPIC_API_KEY`）；Joi 不读取或复制登录凭据，也不以环境 API key 是否存在作为前置门禁；resident 通过官方 `resume` 恢复。
- Codex 由 `@openai/codex-sdk` 的 `Codex/startThread/resumeThread/runStreamed` 驱动，模型名原样传递，系统提示词进入 `config.developer_instructions`。只使用用户安装的 Codex CLI；嵌套启动时继续移除四个上层 Codex 环境覆盖。
- 应用层定义 Joi 自有、A2A 风格的安全事件：message、status、artifact、tool activity。基础设施必须先丢弃工具参数、命令、结果、reasoning、供应商错误正文和完整绝对路径，再越过端口；应用 projector 再转换为现有 Agent conversation DTO。tool activity 事件另携带不透明的 `toolCallId` 与一行 ≤200 字符的摘要——两者都不属于上述禁载荷类别；摘要里的绝对路径缩写为「盘符/根 + 末三层」。本机 pi 引擎还有一个显式、可选、**非事件**的工具轨迹通道用于本机调试：它在基础设施内先脱敏凭据、限定单条 ≤8 KB，只写本机 SQLite 并按需读取，因此事件层仍然"先丢弃工具参数、命令、结果"；Claude/Codex 适配器不接线。
- Codex 不再使用工具白名单 UI，改为显式 `sandboxMode`、network、web search 权限；approval 固定 `never`，禁止 `danger-full-access`。配置写入不可变 revision 的 `engine_config_json`。
- 新 Codex revision 默认 workspace-write、network=false、web=disabled。旧空工具列表映射为兼容的 workspace-write/network=true/web=live；旧非空列表仅 shell/apply_patch 赋予 workspace-write，仅 web_search 赋予 network/live。
- 官方会话引用格式固定为 `native-agent:v1:<claude|codex>:<id>`。旧无标签引用不恢复、不重放历史正文；成功 turn 后写入新引用。
- probe 必须调用相同官方适配器，使用无工具最小请求；只返回和记录稳定原因码。
- 生产包保留两个 SDK 的 JavaScript bridge，同时排除 Codex CLI 包及 Claude/Codex 平台二进制。

## 后果

Claude 与 Codex 能独立升级并按官方契约测试；用户 CLI 所有权与 App 依赖边界清晰。旧 resident 会话第一次运行会开启新官方 session，这是有意的安全切换，不进行 transcript 转换。官方 SDK 仍可能把 CLI 包作为 npm 传递依赖安装到开发树，但 resolver 不选择 App `node_modules/.bin`，打包清单也显式排除平台二进制。

## 2026-09-26 修订（AC-60 / AC-61 / AC-62）

工具 activity 事件新增不透明 `toolCallId` 与一行 ≤200 字符脱敏摘要（不含参数正文）。pi 引擎另接一条非事件的 `onToolTrace` 本机通道，把每次工具调用的完整命令与输出（凭据脱敏、路径保留、单条 ≤8 KB）落 `workbench_agent_tool_traces`，只在桌面按写权限按需读取。

## 2026-09-27 修订（路径缩写）

事件表面与展示投影对绝对路径的处理从「整段丢弃」改为「缩写后显示」：conversation 条目、tool activity 摘要、WorkResult 摘要、首页卡片结论、统计标签、workbench 上下文快照以及 LAN/远端响应统一缩写为「盘符/根 + 末三层」（`src/main/domain/text/path-abbreviation.ts`，幂等，重复脱敏不会继续吃掉路径段）。凭据的掩码规则一字未改；`onToolTrace` 私密通道仍保留完整路径，因此「摘要里看不到的东西，展开后仍看得到」这一对比仍然成立。诊断链路不受影响，仍整条拒写含路径的事件。上一条修订中「载荷禁止条款逐字不变」由此被本条取代。

## 2026-09-18 修订（AC-33 / AC-55 / AC-62）

已配置的 Claude 不应被环境 API key 检查误判为未安装。health 只检查用户 CLI；probe、ephemeral 和 resident 统一交由原生 CLI 处理认证。仅用户发起的无工具真实 probe 成功才代表调用可用；原生认证失败继续归一为安全原因码。
