# 开发运行

用于安装依赖、启动 Electron 开发态，或以生产构建在本机运行 joi。

## 环境

- Node.js `>=22.22.0`
- npm `>=11.0.0`
- 所有命令从仓库根目录执行

## 首次安装或锁文件更新后安装

```powershell
npm ci
```

`npm ci` 严格按 `package-lock.json` 安装依赖。没有明确依赖变更时，不改用会更新锁文件的安装方式。

## 启动开发态

```powershell
npm run dev
```

该命令构建 Electron 主进程，并启动 Vite、Electron TypeScript watch 与 Electron 窗口。它是持续运行命令；Agent 应保留并监控进程，任务结束或需要打包时再正常停止。

Vite 默认监听 `127.0.0.1:43715`，并将 `/api` 代理到 `127.0.0.1:43130`。Electron 会等到 Vite 成功提供 renderer 入口后才启动。启动验收以桌面窗口能完成初始化并进入应用为准。

测试时使用临时 `userData` 和空闲端口。下面的两个端口是示例，启动前需确认可用。请在用于测试的专用 PowerShell 会话中执行：

```powershell
$env:JOI_TEST = "1"
$env:JOI_DEV_PORT = "43716"
$env:JOI_DEV_API_PORT = "43131"
npm run dev
```

需要跨重启保留隔离 dev 的数据时，启动前将 `JOI_DEV_USER_DATA_DIR` 设置为该实例专用目录的绝对路径。该选项只用于 `JOI_TEST=1` 的本地 Electron 开发态。后续重启复用同一目录，每个运行中的实例使用独立目录。

检查开发态首次设置、登录初始化与对话入口时，使用 `npm run build:electron`，然后执行 `npx playwright test tests/e2e/dev-startup.spec.ts`。该用例使用独立的 Vite 和 API 端口。

等价别名：

```powershell
npm start
```

## 本机浏览器

对话扩展中的 Agent Browser 预置固定版本的原生执行器。首次需要浏览器且没有合适 Chrome 时执行：

```powershell
npm run browser:install
```

它使用上游安装器下载 Chrome for Testing 到独立的 `~/.agent-browser/browsers` 安装缓存。Joi 只在该缓存中查找浏览器程序，不加载用户的扩展配置或个人浏览器 profile。安装后可离线启动，访问网站仍取决于网站连接。本机 Chromium/Chrome 也可通过 `JOI_AGENT_BROWSER_EXECUTABLE` 的绝对路径指定；不需要 Kernel API Key。每次对话执行的浏览器数据都使用另一个临时目录，结束后关闭并清理。

## 运行本地生产形态

```powershell
npm run app:run
```

该命令先执行完整生产构建，再用 Electron 启动本地应用。成功标准是构建退出码为 `0`，Electron 进程正常启动且没有启动期错误。
