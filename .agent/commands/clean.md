# 清理

用于删除仓库内可重新生成的构建、测试、覆盖率、TypeScript 缓存和 `release*` 产物。

```powershell
npm run clean
```

只清理选定的临时产物、保留历史安装包及已有构建时：

```powershell
npm run clean -- --only .cache .vite coverage playwright-report test-results tmp temp
```

`--only` 仅接受脚本白名单中的产物名称；未知路径、源码路径和空目标在删除前拒绝。

## 安全边界

- 该命令不删除 `node_modules`、源码、真实 Electron `userData` 或用户凭据。
- 不用手写递归删除命令扩大清理范围；需要新增清理目标时，先修改并审查 `scripts/clean-artifacts.mjs` 的受限列表。
- 清理后如需恢复可运行状态，按任务需要重新执行构建、测试或打包命令。

成功标准：命令退出码为 `0`，且输出只包含脚本允许的仓库内可重建目标。
