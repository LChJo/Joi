# 验证

本文件是本地验证范围的选择依据。根据实际 diff、受影响调用方和验收标准，选择能证明改动正确的最小充分检查集；所有通过结论必须来自实际命令结果。

## 选择范围

1. 先确定改了什么行为、影响哪些模块和调用方、对应哪条验收标准。运行前简述选定的测试文件和检查及其理由。
2. 行为修改先用定向回归复现失败，再实现修复。文档、注释等不改变运行行为的修改只做相应内容检查。
3. 按下表组合适用项。涉及多个边界时取相关范围的并集；共享类型、入口或公共辅助函数要检查直接消费者。
4. 选定检查通过后结束验证。仅在新增修改、检查失败或存在具体未覆盖风险时扩大或重跑；小修复或普通里程碑交付不自动升级为全量验证。
5. 交付时说明实际运行及结果，以及与本次风险相关但未验证的项目。测试均使用合成数据、临时目录和凭据替身。

| 改动范围 | 测试范围 | 检查范围与升级条件 |
|----------|----------|--------------------|
| 文档、Agent 提示词、注释 | 仅在修改影响已有文档契约时运行对应契约测试 | 检查 diff、链接、命令与规则一致性；无需应用测试或构建 |
| 局部 React 展示、表单或交互逻辑 | 相关 renderer 测试；表单提交检查真实 payload，覆盖失败与成功路径 | TypeScript 改动执行 typecheck，代码执行定向 lint；普通 DOM 行为由组件测试覆盖 |
| 领域规则、应用服务 | 对应 unit 测试；涉及持久化、事务、outbox 或幂等时补对应 integration 测试 | typecheck、定向 lint；状态机、权限与并发修改覆盖相应不变量 |
| SQLite、迁移、存储查询 | 临时数据库上的相关 integration 测试，覆盖升级、读写与事务一致性 | typecheck、定向 lint；不读取真实用户数据库 |
| HTTP、共享 DTO、远程协议 | 对应接口/契约测试及直接受影响的服务、renderer 或移动端消费者测试 | typecheck、定向 lint；跨客户端契约按实际消费者扩展 |
| import 边界、新增生产目录、模块职责或入口调整 | 相关模块与调用方回归 | 增加 `npm run check:boundaries`；静态检查按语言选择 |
| 语言资源、生成器、语言切换 | 对应 i18n 或受影响组件测试 | `npm run i18n:check`；按实际客户端补 typecheck 或 Flutter 检查，只有切换/布局涉及真实窗口行为才增加桌面验证 |
| Electron 生命周期、preload、窗口、原生菜单、系统交互或真实布局 | 相关 Electron E2E 文件或原生冒烟场景 | 构建其依赖的最新产物，再运行选定场景；普通前端逻辑修改不触发此项 |
| 构建脚本、依赖、资源加载、Worker 产物或发布配置 | 对应脚本/契约测试和直接消费者回归 | 先验证受影响构建目标；影响生产组装时执行 `npm run build:prod`，影响包内容时执行 `npm run package:verify`，安装器问题才运行相应打包目标 |
| Rust、Android 或原生桥 | 对应 crate/test target 或 Flutter 测试文件 | 按目标补 `cargo check`、`flutter analyze` 或原生构建；设备、平台与公网验收仅在改动涉及对应链路时运行 |
| 大范围公共重构、全局测试/编译配置或无法隔离影响的依赖更新 | 扩到受影响测试目录，必要时运行全量 Vitest | 根据具体风险选择覆盖率、生产构建与 E2E，不因全量 Vitest 自动运行全部平台检查 |

## 常用定向命令

命令中的文件是范围示例，实际选择以本次 diff 和验收标准为准：

```powershell
npx vitest run tests/renderer/automation-panel.test.tsx
npx vitest run tests/unit/automation-service.test.ts tests/integration/automation.test.ts
npx vitest run tests/contract/product-release-contract.test.ts
npm run typecheck
npx eslint src/renderer/AutomationPanel.tsx tests/renderer/automation-panel.test.tsx --max-warnings 0
```

需要整个受影响类别时使用 `npm run test:renderer`、`npm run test:integration` 或 `npm run test:contract`；全仓 lint 仅在规则变更或影响广泛时使用 `npm run lint`。

Electron 场景使用 `npm run test:e2e -- tests/e2e/electron-smoke.spec.ts`。该脚本会先执行生产构建；已有与当前代码一致的构建时直接使用 `npx playwright test tests/e2e/electron-smoke.spec.ts`。涉及真实窗口的修改选择对应文件，不默认跑整个 E2E 目录。

覆盖率用于检查改动中的分支缺口、覆盖率配置变化或明确的全量/发布验收。局部检查可将 `--coverage.include=src/renderer/AutomationPanel.tsx` 与对应测试文件一起传给 Vitest，使覆盖范围与测试范围一致；局部通过不能声称全仓覆盖率达标。

## 全量与发布验证

显式请求全量验收、发布验收或上述范围分析确认影响无法隔离时，才运行相应的完整检查。CI 继续遵循 `.github/workflows/ci.yml`，发布还须遵循产品及平台验收要求。一次本地完整桌面验证可复用同一构建：

```powershell
npm run i18n:check
npm run typecheck
npm run lint
npm run check:boundaries
npm run test:coverage
npm run build:prod
npx playwright test
node scripts/package-verify.mjs
```

`npm run test` 是全量 Vitest，`npm run test:coverage` 已包含同一套测试，无需为同一代码状态接连执行两者。`npm run test:e2e` 和 `npm run package:verify` 都内置生产构建；需要组合验证时复用最新构建，避免再次构建。源码、依赖或构建配置变化后不得复用旧产物。

`npm run check` 是耗时的全量组合入口，不用于日常局部修改；它不包含 E2E 和架构边界检查。完成选定范围不代表未运行的平台或完整发布验收已通过。

## 原生远程与 Android

以下按相关改动触发，普通桌面或文档修改无需执行。

本机浏览器的独立验收使用合成 localhost React 页面、临时用户目录和指定的浏览器程序，不读取个人 profile 或真实 Electron userData。普通测试默认跳过此项：

```powershell
$env:JOI_BROWSER_SMOKE = "1"
$env:JOI_BROWSER_SMOKE_EXECUTABLE = "<Chrome for Testing 程序的绝对路径>"
npx vitest run tests/native/local-browser.test.ts
Remove-Item Env:JOI_BROWSER_SMOKE,Env:JOI_BROWSER_SMOKE_EXECUTABLE
```

该项验证中文输入、点击状态变化、React 组件树、截图、控制台和网络观察，以及取消后自有进程与临时 profile 收尾；它不验证任意生产网站或个人登录会话。

本地按需写入的原生引擎测试使用临时工作区、独立原生 CLI 配置目录和本机回环模型替身，不需要真实供应商凭据：

```powershell
$env:JOI_NATIVE_WRITE_TESTS = "1"
npx vitest run tests/native/local-workspace-write.test.ts
Remove-Item Env:JOI_NATIVE_WRITE_TESTS
```

Codex 原生写工具的额外冒烟测试需在 Windows 沙箱工具能够启动的环境显式开启 `JOI_NATIVE_TOOL_SMOKE=1`。该项验证实际文件写入及产物归属；核心原生测试验证只读隔离、结构化请求和原线程恢复，不等同于该项写入证据。普通测试默认跳过原生 CLI 测试；验收时应单独记录开启后的结果和环境限制。

```powershell
cargo test --manifest-path native/joi-remote/Cargo.toml
Set-Location apps/joi_mobile
flutter analyze
flutter test
Set-Location ../..
```

公网中继变更还必须显式运行以下外部验收（普通 `cargo test` 默认忽略它）。两个端点禁用 IP 直连，验证真实中继上线及双向收发；仅 `/ping` 成功不算通过：

```powershell
$env:JOI_RELAY_SMOKE_URL = "https://remote.joilab.top"
cargo test --manifest-path native/joi-remote/Cargo.toml --test deployed_relay -- --ignored --nocapture
Remove-Item Env:JOI_RELAY_SMOKE_URL
```

成功标准：命令退出码均为 `0`，没有被忽略的失败或未说明的环境跳过项。
