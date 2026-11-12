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

等价别名：

```powershell
npm start
```

## 运行本地生产形态

```powershell
npm run app:run
```

该命令先执行完整生产构建，再用 Electron 启动本地应用。成功标准是构建退出码为 `0`，Electron 进程正常启动且没有启动期错误。
