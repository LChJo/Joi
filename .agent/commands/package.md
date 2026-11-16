# 打包

用于生成桌面安装包、当前平台解包目录、Android APK 或浏览器远程中继包。打包前应停止正在运行的开发态 Electron 进程，避免文件占用或构建状态互相干扰。

## 桌面端

生产构建需要 Rust stable 与 Cargo。原生构建依次查找 `CARGO` 指定的可执行文件、`CARGO_HOME/bin`、用户目录的 `.cargo/bin` 和系统 `PATH`；CI 在 Windows/macOS 上显式安装 Rust 工具链。

```powershell
# 根据当前平台选择安装包目标
npm run package

# Windows x64 NSIS 安装包，只在 Windows 执行
npm run package:win

# macOS DMG，只在 macOS 执行
npm run package:mac

# 当前平台 unpacked 应用
npm run package:dir
```

统一脚本入口：

```powershell
node scripts/package-app.mjs --target <current|win|mac|dir> [--output <repo-relative-dir>]
```

桌面产物默认写入 `release-joi/`。入口会生成品牌图标、执行生产构建、审计包内容，并清理本次目标输出目录。

## GitHub Release

同步升级 `package.json`、`package-lock.json` 顶层和 `packages[""]` 的版本后推送 `main`，或在 `main` 手动运行 **Actions → quality**。工作流先以只读权限比较稳定版本与 GitHub Latest；仅更高版本（或尚无已发布版本）才生成并上传安装包、运行发布任务。同版本、降版本、PR 和其他分支保留全部质量门禁，跳过安装包与 Release；手动运行不能绕过版本门禁。

双平台质量门禁和安装包生成成功后，工作流自动发布 `v<version>` Release，附 Windows `.exe`、macOS `.dmg` 和 `SHA256SUMS.txt`，并设为 Latest。发布任务再次比较 Latest，并通过 GitHub 自动生成相对上一版本的版本说明；正文同时保留下载格式、校验和、签名状态与来源提交。生成失败或说明为空时停止发布。无需配置个人 Token。

已发布版本不会被后续提交覆盖。上传中断保留草稿；在同一提交重跑可继续并补齐版本说明，不同提交必须使用新版本或由维护者处理未公开草稿。发布版本的安装包分别保留为 14 天 Actions Artifacts。安装包默认仍未完成 Windows 正式签名及 macOS 公证。

## Android

```powershell
npm run build:mobile:android
```

该命令交叉编译 arm64 iroh 核心，运行 Flutter 静态检查与测试，并生成 Android release APK；产物位于 `release-joi-mobile/`。

## 浏览器远程中继

```powershell
npm run remote:relay:package
```

产物位于 `release-joi-remote-relay/`。

## 产物验收

- 打包命令必须以退出码 `0` 完成，并通过脚本内置的包内容审计。
- 报告产物文件名、大小、SHA-256 和签名状态；没有证书时不得声称安装包已签名。
- Windows 正式发布仍需 Authenticode 签名；Android 商店发布仍需正式签名配置；macOS 必须在 macOS 主机完成签名、公证和验收。
