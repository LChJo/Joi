# Joi 方案 C 交付校验

用户选定「深绿版画」后，同一肖像已应用于侧栏头像、窗口和托盘图标、favicon 与 Windows 安装包图标。业务功能未调整。

## Windows 安装包

- 文件：[joi-0.1.0-win-x64.exe](../../release-joi-c-sketch-20261010-143249/joi-0.1.0-win-x64.exe)
- 大小：133,310,786 bytes（127.14 MiB）。
- SHA-256：`2D802B6023222EA33777F40B6B2AE33FA56EE107C7205CCFD40239844F8D7A45`
- Authenticode：`NotSigned`，安装程序和应用可执行文件均未签名。
- 打包命令：`npm run package:win -- --output release-joi-c-sketch-20261010-143249`，退出码 0。
- 输出使用独立目录，既有安装包保留。

## 验证

- typecheck、lint、架构边界、diff 检查通过。
- 全量测试：237 文件、1781 项通过；7 项 E2E 通过。
- 覆盖率：语句 94.43%、分支 90.02%、函数 93.03%、行 96.87%，门禁通过。
- 生产构建与 `npm run package:verify` 通过，审计 597 个文件。
- 侧栏 PNG 与 C 原图的 256px 缩小版本相同；应用 PNG 为 1024px，四角透明、中心不透明。
- resources、public、dist 与安装包内图标的 SHA-256 相同：`F83E5DB7B241616F5FAFA499B88B5E0E75E2146326F55D064B917E2EEF795BEB`。
- 图标 SVG 与 PNG 渲染缓存匹配，重复 `assets:icons` 使用一致的缓存。
- 已从打包后的 `joi.exe` 提取 32px 图标，目视确认使用 C 肖像。
- Electron 测试及图标生成使用临时 userData；未启动真实用户数据下的应用。

本地源码与生产构建已更新。安装后的应用图标通过此安装包更新；素材与预览见 [候选记录](joi-avatar-options.md)。
