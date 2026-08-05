# 发布验收报告

## JOI-01 当前结论

本报告同时记录旧 Life/Wake 基线、2026-07-28 的 JOI-01 自动化闭环和 2026-08-03 的 Avatar/Agent 信息流重构。仓库内验收项已经闭合：极简目标首页、Pi/Avatar/Agent/Partner/Work、本机与 A2A adapter、结果回流、附件、模型来源、Pi session compaction、Avatar 破坏操作确认、搭档排空生命周期与旧 Life 只读兼容均有自动化证据。真实 provider/Local Pi/A2A/强杀恢复/LAN 与平台发布门禁仍不得用模拟测试替代。

日期：2026-08-03
版本：0.1.0
环境：Windows 10.0.26200、Node.js/Electron 项目本地构建

## 结论

M0–M6 的可在当前仓库与单机环境完成部分已经实现并通过自动化门禁。M7 只完成了 Windows 构建链与未签名 NSIS 安装包；跨机器、真实 Agent、macOS、签名公证、人工视觉与长稳门禁仍是发布阻断项。因此版本保持 `0.1.0`，不得宣称完整 MVP 或生产可用。

## 已验证证据

| 门禁 | 结果 | 证据 |
|---|---|---|
| TypeScript / ESLint / 分层边界 | 通过 | `npm run typecheck`、`npm run lint`、architecture tests |
| 自动化测试 | 通过 | 133 个测试文件、517 项测试；domain、persistence、Pi compaction、Avatar/Agent information flow、Partner lifecycle、Local Pi/A2A、HTTP/SSE、renderer、security/recovery 与发布命令契约 |
| 覆盖率 | 通过 | statements 95.22%、branches 90.07%、functions 95.04%、lines 97.46% |
| Electron E2E | 通过 | 首次桌面 bootstrap、模型连接门禁、唯一 joi 首页、原生 Avatar 创建、Avatar → Agent 默认页与 960/768 px 无水平溢出；本轮 1 场景约 4.7 秒通过 |
| 生产构建与包内容 | 通过 | Vite renderer、Electron main/preload、33 个 migrations、品牌图标与静态资源检查；包内容 325 文件 |
| 时间线性能 | 通过（本机基线） | 100,000 条持久活动下首屏 100 条查询 `< 1s`；migration 016 提供 `(life_id, occurred_at, event_id)` 复合索引 |
| 备份恢复 | 通过（自动化） | SQLite online backup、SHA-256、原子发布、空间检查、quarantine、Artifact 恢复、会话撤销、Token 重确认、unknown Invocation |
| Windows unpacked | 通过 | `release-joi/win-unpacked`（本地忽略产物）；打包后 `joi.exe` 实际启动并返回标题 `joi`/私有 loopback renderer；品牌资源同时存在于 `extraResources` 与 renderer asar |
| Windows NSIS | 通过，未签名 | `release-joi/joi-0.1.0-win-x64.exe`，104,904,420 bytes，SHA-256 `C8C2ED28FB22C8879A9F2F3EEE4D7ACC0ED2ED4D46668D95BFAA86FB88498CA4` |

### JOI-01 本轮自动化证据

- 唯一全局 `JoiInputScheduler` 取代生产 composition 中的旧 Wake scheduler；旧节奏事件先转为 Avatar-scoped 持久输入。
- Pi `0.82.1` 锁版本，模型来源、安全 fallback、Avatar 稳定 session 与 SQLite restore 通过 contract/unit/integration。
- Local Pi Coding Agent 使用受控 workspace、prompt、tool allowlist、净化 bash 环境和 workspace lease；A2A 复用既有 gateway。
- Partner terminal result 先写不可变事件，再唤醒 joi；`work_reassign` 固定新 revision 并重新进入 outbox。
- 首页只保留短暂 `progressing`、待处理动作与目标 Avatar 卡片；终态目标可移除，右侧工作栏已删除。Avatar 默认展示全部 Agent，EPHEMERAL 终态 Agent 可删除展示记录，RESIDENT Agent 不可删除；Agent 详情是持久、只读、安全投影后的 Markdown/工具/产物信息流。
- v33 migration、备份恢复、包内容和 960/768 Electron E2E 已验证。
- Pi session 在完整 Turn 后压缩并持久化摘要元数据，provider 摘要失败时使用有界本地 checkpoint；恢复后保留 source/model revision 与最近完整对话边界。
- Avatar merge/archive 只形成持久待确认建议；拒绝不改事实，确认前检查非终态工作，merge 保留源记录并写重定向。
- Partner disable 使用 DRAIN 策略，立即拒绝新派发、保留在途；delete 要求先停用且在途归零，并追加不可变 DELETED revision。
- 旧 `/api/v1/lives` 仅保留 GET 兼容；新生产 Console 已移除 Life 写向导和详情入口，二级上下文使用原生 Avatar API。

## 安装与升级路径

- Windows 使用 per-user、非 one-click NSIS；允许选择目录，创建桌面与开始菜单入口，卸载默认保留用户数据。
- 同版本或更高版本覆盖安装复用 Electron `userData`。启动顺序先验证恢复请求与数据库，再前向执行 migration，避免调度读取半迁移数据。
- 更新或手动升级前应从设置页创建一致性备份。需要恢复时应用先隔离当前数据，再校验并应用备份；旧 LAN 会话撤销，Agent Token 必须重新输入，未知远端任务不会自动重发。
- 强制更新重启和备份恢复使用与显式退出相同的 listener/SQLite drain 顺序。
- macOS 目标已配置为 DMG，但必须在 macOS 构建机完成签名、公证、安装、升级和托盘验证后才能发布。

## 未执行 concerns

| Concern | 状态 / 后续动作 |
|---|---|
| 真实 AI Mana 主 Agent 与两个协作者 | 未提供真实端点或配套仓库；需完成 readiness、stream、interaction、Artifact、重启恢复全场景 |
| 第二台 LAN 浏览器 | 当前只有单机 loopback/双 listener 自动化；需在可信私网验证登录、SSE、消息、暂停和 interaction |
| macOS | 当前是 Windows 主机；DMG、托盘、开机启动、签名、公证与升级均未执行 |
| Windows 信任链 | 品牌图标已进入 EXE、托盘、renderer 与安装包；安装包仍为 `NotSigned`，发布前需 Authenticode 证书 |
| 视觉 QA | 768/960 Electron E2E、无水平溢出断言及 768 px 运行时截图检查已过；in-app browser provider 返回空浏览器列表，人工键盘、焦点与对比度验收仍未完成 |
| 长稳与性能 | 未执行 24 小时运行、多 Life 压测、并发 Alarm 峰值和真实网络抖动报告 |
| 自动更新分发 | 已实现安全重启/升级语义和可覆盖安装；尚未配置签名更新源或增量发布服务 |

## 发布前检查单

- [ ] 在 Windows 与 macOS 签名构建机完成 Authenticode、签名与公证产物（品牌图标已完成）。
- [ ] 全新安装、覆盖升级、卸载保留数据、备份恢复各执行一次。
- [ ] 用一台 Hub、两个 LAN Agents 和另一台浏览器完成 E2E-01 至 E2E-11。
- [ ] 执行 24 小时长稳、磁盘不足、端口占用、远端 429/503 与强杀恢复。
- [ ] 用 768 px 与 960 px 真实浏览器完成键盘、焦点、对比度和响应式截图检查。
- [ ] 确认日志、诊断、SSE、备份和安装日志中无 Token、正文、完整 Origin 或绝对业务路径。
