# 验证

根据改动风险先运行定向测试，交付里程碑前再执行完整固定门禁。所有通过结论必须来自本轮实际命令结果。

## 定向验证

```powershell
npm run typecheck
npm run lint
npm run test:renderer
npm run test:integration
npm run test:contract
npm run check:boundaries
```

只运行与改动相关的测试文件时，可将文件路径追加到 Vitest：

```powershell
npx vitest run tests/contract/product-release-contract.test.ts
```

## 固定质量门禁

必须按 `AGENTS.md` 执行：

```powershell
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:e2e
npm run build:prod
npm run package:verify
```

架构边界另行执行：

```powershell
npm run check:boundaries
```

`npm run check` 是常用组合入口，但不包含 `test:e2e` 和 `check:boundaries`，不能单独替代上述完整门禁。

## 原生远程与 Android

```powershell
cargo test --manifest-path native/joi-remote/Cargo.toml
Set-Location apps/joi_mobile
flutter analyze
flutter test
Set-Location ../..
```

成功标准：命令退出码均为 `0`，没有被忽略的失败或未说明的环境跳过项。
