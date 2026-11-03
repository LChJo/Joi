# joi · Agent 命令兼容入口

按任务拆分的 AI 命令文档位于 [`.agent/commands/`](commands/README.md)：

- [开发运行](commands/dev.md)
- [验证](commands/verify.md)
- [打包](commands/package.md)
- [清理](commands/clean.md)

本文件保留为兼容摘要。所有命令都从仓库根目录执行，Node.js 与 npm 版本要求以 `package.json#engines` 为准。

## 安装与运行

```powershell
npm ci
npm run dev
```

- `npm run dev`：开发模式，启动 Vite、Electron TypeScript watch 与 Electron 窗口。
- `npm run app:run`：先构建生产资源，再用 Electron 本地运行生产形态。
- `npm start`：`npm run dev` 的别名。

## 验证

```powershell
npm run check
npm run check:boundaries
npm run test:e2e
```

原生远程与 Android App 另外执行：

```powershell
cargo test --manifest-path native/joi-remote/Cargo.toml
cd apps/joi_mobile
flutter analyze
flutter test
cd ../..
npm run build:mobile:android
```

## 打包

```powershell
npm run package:win
npm run package:mac
npm run package:dir
```

- `npm run package:win`：在 Windows 生成 x64 NSIS 安装包。
- `npm run package:mac`：必须在 macOS 主机生成 DMG。
- `npm run package:dir`：生成当前平台的 unpacked 应用。
- `npm run build:mobile:android`：交叉编译 arm64 iroh 核心，验证 Flutter，并生成 Android release APK。
- `npm run package`：按当前平台选择 Windows NSIS、macOS DMG 或其他平台 unpacked 输出。
- 统一入口为 `node scripts/package-app.mjs --target <current|win|mac|dir> [--output <repo-relative-dir>]`。
- 打包入口会重新生成品牌图标、生产构建、执行包内容审计，并清理目标输出目录，默认产物位于 `release-joi/`。

## 清理

```powershell
npm run clean
```

仅删除仓库内可重建的构建、测试、覆盖率、TypeScript 缓存和 `release*` 产物；不会删除 `node_modules`、源码或用户数据。
