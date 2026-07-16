# 发布验收报告

日期：2026-07-16
版本：0.1.0
环境：Windows 10.0.26200、Node.js/Electron 项目本地构建

## 结论

M0–M6 的可在当前仓库与单机环境完成部分已经实现并通过自动化门禁。M7 只完成了 Windows 构建链与未签名 NSIS 安装包；跨机器、真实 Agent、macOS、签名公证、人工视觉与长稳门禁仍是发布阻断项。因此版本保持 `0.1.0`，不得宣称完整 MVP 或生产可用。

## 已验证证据

| 门禁 | 结果 | 证据 |
|---|---|---|
| TypeScript / ESLint / 分层边界 | 通过 | `npm run typecheck`、`npm run lint`、architecture tests |
| 自动化测试 | 通过 | 57 个测试文件、191 项测试；domain、persistence、A2A、HTTP、renderer、security/recovery、joi 品牌与发布命令契约 |
| 覆盖率 | 通过 | statements 96.00%、branches 90.00%、functions 97.85%、lines 97.49% |
| Electron E2E | 通过 | 首次桌面 bootstrap、管理员设置、一次性 ready Agent、Life 三步出生、详情/待办/作息；960/768 px 均无水平溢出 |
| 生产构建与包内容 | 通过 | Vite renderer、Electron main/preload、16 个 migrations、品牌图标与静态资源检查；包内容 145 文件 |
| 时间线性能 | 通过（本机基线） | 100,000 条持久活动下首屏 100 条查询 `< 1s`；migration 016 提供 `(life_id, occurred_at, event_id)` 复合索引 |
| 备份恢复 | 通过（自动化） | SQLite online backup、SHA-256、原子发布、空间检查、quarantine、Artifact 恢复、会话撤销、Token 重确认、unknown Invocation |
| Windows unpacked | 通过 | `release-joi/win-unpacked`（本地忽略产物）；打包后 `joi.exe` 实际启动并返回标题 `joi`/私有 loopback renderer；品牌资源同时存在于 `extraResources` 与 renderer asar |
| Windows NSIS | 通过，未签名 | `release-joi/joi-0.1.0-win-x64.exe`，104,904,420 bytes，SHA-256 `C8C2ED28FB22C8879A9F2F3EEE4D7ACC0ED2ED4D46668D95BFAA86FB88498CA4` |

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
