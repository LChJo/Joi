# Pi 桌面开源项目：会话托管与结果结算调研

日期：2026-11-17。目标：为“Joi 管流程和结果，Pi 管单个执行”的重构选择成熟接入模式。结论输入见 [重构 spec](pi-session-ownership-spec.md)，前置本地事实见 [SDK 接入审计](pi-sdk-integration-audit.md)。

## 方法与证据边界

调研以维护者仓库、发布页、固定提交源码、测试和 CI 定义为依据。筛选同时考虑桌面交付、会话生命周期测试、上游兼容维护及与 Joi 的适配成本，不以 Star 数或界面截图替代成熟度判断。GitHub REST API 本次限流，改用公开 Git 的固定源码快照和发布网页；没有执行这些项目的安装脚本、依赖或应用，也未验证它们在本机的真实模型性能。发现测试与 CI 不等于本次运行过其测试。

| 项目 | 固定源码快照 | 版本及工程证据 | 定位 |
|---|---|---|---|
| minghinmatthewlam/pi-gui | `faf8edd6d7a7e3bf3c508d6f600a22d3821ac108`，2026-10-28 | manifest 1.0.1；公开 [v1.0.1](https://github.com/minghinmatthewlam/pi-gui/releases/tag/v1.0.1)；三平台桌面、独立 SDK driver、生命周期/取消/恢复测试、CI 与 release workflow；MIT | 首要 SDK 架构参考 |
| DLYZZT/pi-desktop | `ec7ecc14005f8a47ab214a7bc901a77549f404a7`，2026-11-11 | manifest 0.5.1、Pi 1.5.0；公开 [v0.5.1](https://github.com/DLYZZT/pi-desktop/releases/tag/v0.5.1)；三平台构建、SDK 升级回归、事件及统计测试；Apache-2.0 | 首要事件/统计参考 |
| nonlooped/nativepi | `10b5bf4f7d00455180fe1504889f7c40470af82b`，2026-11-17 | manifest 与 release commit 为 1.21.0、Pi 1.5.2；[稳定发布入口](https://github.com/nonlooped/nativepi/releases/latest)、三平台打包、RPC 进程及会话测试、CI/release workflow；MIT。本次未成功读取该版本发布页的具体资产 | 进程边界与原生历史参考 |
| bytesbay/pi-gpui | `08f1818d93fe76119ea8624fe93ef92a3a6978ca`，2026-11-15 | manifest 0.2.5；公开 [v0.2.5](https://github.com/bytesbay/pi-gpui/releases/tag/v0.2.5)；Rust 内联测试及 Linux CI/打包；MIT；macOS/Linux，未支持 Windows | RPC 对照，不作为 Joi 主实现模板 |

“首要参考”表示可复核的实现与维护基础，不表示生产可靠性认证。另检视 FaqFirebase/pi-desktop 的官方介绍，其明确标为 alpha，且主要通过 RPC 适配 Pi/OMP；本次不将其作为比上述 SDK driver 更成熟的主模板。[项目定位](https://github.com/FaqFirebase/pi-desktop#pi-and-omp-engines)

## 1. pi-gui：把桌面 driver 与完整 SDK runtime 分开

它通过官方 services/session/runtime 工厂组合会话，以 SessionManager 创建、打开和恢复历史，不自行实现模型工具循环。桌面保存索引和界面快照，会话文件保持原始事实权威。其 SDK 依赖声明为 `^1.4.0`，本次只采用职责模式，不能把浮动依赖当成 Joi 已验证的版本。[工厂接线](https://github.com/minghinmatthewlam/pi-gui/blob/faf8edd6d7a7e3bf3c508d6f600a22d3821ac108/packages/pi-sdk-driver/src/npm-package-fallback.ts)、[会话监督器](https://github.com/minghinmatthewlam/pi-gui/blob/faf8edd6d7a7e3bf3c508d6f600a22d3821ac108/packages/pi-sdk-driver/src/session-supervisor.ts)、[版本声明](https://github.com/minghinmatthewlam/pi-gui/blob/faf8edd6d7a7e3bf3c508d6f600a22d3821ac108/packages/pi-sdk-driver/package.json)

`agent_end` 只记录待结算 outcome，保持同一运行身份；`agent_settled` 才产生完成/失败通知。取消有独立结果，不混入成功或运行故障。生命周期测试验证一次失败后 SDK 重试仍维持原 run，恢复前不发布失败，最终只发布一次完成。[结算实现](https://github.com/minghinmatthewlam/pi-gui/blob/faf8edd6d7a7e3bf3c508d6f600a22d3821ac108/packages/pi-sdk-driver/src/session-supervisor.ts#L2905)、[恢复测试](https://github.com/minghinmatthewlam/pi-gui/blob/faf8edd6d7a7e3bf3c508d6f600a22d3821ac108/packages/pi-sdk-driver/test/pi-boundary-lifecycle.test.mts)

上下文与总用量来自 SDK `getSessionStats()`；非消息 usage 条目触发只读刷新，不以桌面估算替代。值得采用的是读取 Pi 事实和保持结算身份，Joi 仍须自行满足 Work/attempt 归属及不重复入账，不能直接拿整个会话累计量当作当前 Work 消耗。[用量适配](https://github.com/minghinmatthewlam/pi-gui/blob/faf8edd6d7a7e3bf3c508d6f600a22d3821ac108/packages/pi-sdk-driver/src/session-usage.ts)

## 2. DLYZZT/pi-desktop：官方工厂、退役订阅和统计对账

Agent Host 通过官方 `createAgentSessionServices()` 与 `createAgentSessionFromServices()` 构造会话，再转发 SDK 事件。桌面与 Host 之间的 RPC 不意味着重新启动另一套 Agent CLI。[services 接线](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/agent-host/desktop-session-services.ts)、[会话构造](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/agent-host/rpc-manager.ts)

事件绑定按源实例和 session ID 管理，替换时退役旧订阅并丢弃旧批次；结束通知以 `agent_settled` 为准，同一轮通知去重。这适合 Joi 的 HTTP/SSE 投影、实例恢复及迟到事件处理。[事件绑定](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/agent-host/session-event-bindings.ts)

其统计回归把普通 assistant usage、独立 usage entry、compaction 和 branch summary 一起与 SDK 对账，说明压缩费用不能只从正文回复统计。[统计测试](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/agent-host/session-stats.test.mjs)、[统计实现](https://github.com/DLYZZT/pi-desktop/blob/ec7ecc14005f8a47ab214a7bc901a77549f404a7/src/agent-host/session-stats.ts)

不整体采用其工具审批、浏览器预算和额外路由工作流。这些是该产品的定制，不能借“成熟项目”名义重新放进 Joi 的单个 Pi 执行内部。

## 3. NativePi：进程包装不等于执行策略包装

它为打包后的 Electron fork Pi Host，通过 RPC/扩展 UI 帧传递命令与事件。维护者说明不用上游 RpcClient 的原因是可执行文件选择和 UI 帧要求；这些是 transport/界面需求，并非重新实现压缩的理由。主程序读取 SessionManager 管理的历史，设置界面通过 Pi 设置或 RPC 控制原生自动压缩。[进程客户端](https://github.com/nonlooped/nativepi/blob/10b5bf4f7d00455180fe1504889f7c40470af82b/apps/desktop/src/main/pi/client.ts)、[Pi 设置](https://github.com/nonlooped/nativepi/blob/10b5bf4f7d00455180fe1504889f7c40470af82b/apps/desktop/src/main/piSettings.ts)

进程生命周期测试覆盖退出与 stdout 收尾竞态、重复 stop、后续请求拒绝及通道故障。可以采用这些测试情形，不能把“进程 exit”自动解释成搭档成功。[生命周期测试](https://github.com/nonlooped/nativepi/blob/10b5bf4f7d00455180fe1504889f7c40470af82b/apps/desktop/src/main/pi/client.lifecycle.test.ts)

该快照对 Pi 1.5.2 有补丁，实际目标是 session-manager 的会话信息扫描缓存，不是改写 Agent 循环。本方案不复制这个补丁，也不引入 NativePi 的扩展 UI 宿主或完整编排层。[补丁声明](https://github.com/nonlooped/nativepi/blob/10b5bf4f7d00455180fe1504889f7c40470af82b/package.json)

## 4. Pi GPUI：薄 RPC 客户端的边界对照

每个聊天通过已安装的 `pi --mode rpc` 执行；历史、工具、恢复和压缩留在 Pi。它在 `agent_settled` 后清除运行态并请求统计，正文/工具/压缩事件只更新展示。[进程启动](https://github.com/bytesbay/pi-gpui/blob/08f1818d93fe76119ea8624fe93ef92a3a6978ca/src/pi.rs#L306)、[事件投影](https://github.com/bytesbay/pi-gpui/blob/08f1818d93fe76119ea8624fe93ef92a3a6978ca/src/chat.rs#L876)

它证明 native UI 无需接管 Pi 内部状态机；但依赖外部 Pi 安装且缺 Windows 支持，不适合作为 Joi 自有模型连接和离线打包的直接替换。

## 选择：官方 SDK runtime + 单一原生会话权威

采用 pi-gui 和 DLYZZT 的官方 SDK 工厂组合方式，借鉴四者的 session authority、settled boundary、只读状态投影与可恢复统计。继续使用 Joi 既有 worker 和基础设施边界，不新增桌面 UI 框架、第三方完整宿主或私有 Pi fork。

本机已通过导出检查确认，锁定的 Pi 1.5.2 提供 `createAgentSession`、`createAgentSessionServices`、`createAgentSessionFromServices`、`createAgentSessionRuntime`、AgentSessionRuntime 和 SessionManager；不需要为套用参考代码先升级 Pi。实际改造仍须用锁定版本的类型和合成 provider 验证。[上游 SDK](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sdk.md)、[设置](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/settings.md)、[会话](https://github.com/earendil-works/pi/blob/v1.5.2/packages/coding-agent/docs/sessions.md)

参考项目都不是 Joi 的 WorkResult、outbox 或业务统计实现。Joi 必须保留结果事务、幂等身份、取消与迟到结果规则，以及模型配置和工作台隔离；这些属于主流程，而非 Pi 内部工作过程。`agent_settled` 是结算前提，不是业务验收通过的充分条件。

## 对 spec 的约束

1. Pi 独占会话历史、投影、压缩、模型恢复与工具循环；Joi 不保留另一套活跃压缩器。
2. Workbench 提供上下文与工程归属；Partner revision 提供技能、工具与能力资源，通过官方配置/扩展入口组合。
3. 观察回调不得通过抛错、等待投影存储、修改决策返回值或直接赋值 Agent 钩子来暂停/改写执行。
4. Work 的租约与能力上限在运行前完成准入，不再靠第一次 Shell/写工具触发 abort/checkpoint/resume。
5. 以 SDK settled + 唯一结果事务完成入账；用量从完整 SDK 事实增量归属、幂等采集，并与 SDK 总量核对。
6. 主 Joi 自身若继续用 Pi 推理，其会话也交给官方管理；业务调度权威仍由 Joi application/domain 保持。

以上是本次设计决定，不代表参考项目全部满足 Joi 的约束，也不代表重构已经实现。
