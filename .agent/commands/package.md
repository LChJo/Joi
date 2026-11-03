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
