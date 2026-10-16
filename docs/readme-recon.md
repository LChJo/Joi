# digital-life（joi）README 重写勘察报告

> 勘察对象：仓库根目录（当前 Workbench 绑定的工作区）。
> 勘察方式：只读源码、配置与文档；未修改任何业务代码、构建配置、依赖清单或现有 README，未安装依赖。
> 本报告仅作为后续「中英双语 README 重写」与「README 配图」两个工作的依据。所有结论均标注来源文件；无来源的内容不写入。

---

## 1) 项目定位

**joi 是一个运行在个人电脑上的常驻、事件驱动的数字生命 Runtime Hub（Electron 桌面应用 + 内嵌同构 Web UI），为个人单用户提供唯一入口的智能编排中枢：持久保存身份/人格/事件/记忆/作息/事务/预算，把人类消息、定时任务、搭档结果统一变成持久事件，由唯一全局 joi 通过 Pi 规划并派发本机 Pi 搭档或局域网 A2A 搭档执行。**

来源与依据：

| 结论 | 来源 |
| --- | --- |
| 包名 `joi`、版本 `0.1.0`、`private: true` | `package.json`（`name`/`version`/`private`） |
| 官方一句话描述 | `package.json#description`：`joi is a persistent, event-driven digital life runtime hub for personal computers.` |
| 产品定位标题与一句话简介 | `README.md` 第 1–3 行（`# joi · 唯一入口的个人智能编排中枢` + 引用块） |
| 目标形态（唯一全局 joi / 工作台 / Partner / Work / outbox） | `README.md`「JOI-01 目标形态」；`docs/adr/0002-unique-joi-pi-workbench-orchestration.md` |
| 术语权威定义（joi、Pi、Workbench、Partner、PartnerInstance、Work、WorkResult、Model Source、harness、Android 原生远程） | `docs/00-sources-and-glossary.md` §0 |
| 产品定义与目标用户 | `docs/01-product-requirements.md` §0/§1/§2 |
| 「产品面向个人单用户；桌面应用本机常驻，内嵌 Web UI，并可把同一控制台开放给可信局域网浏览器」 | `README.md`「我们要构建什么」末段 |
| 不是聊天页、不是固定流水线 | `README.md`「我们要构建什么」 |
| 产品范围事实源声明 | `AGENTS.md`「Source of truth」 |
| 当前完成度不是「完整 MVP」 | `README.md`「项目状态」；`docs/09-release-validation-report.md`「结论」 |

---

## 2) 技术栈与运行环境

### 2.1 运行时与包管理

| 项 | 值 | 来源 |
| --- | --- | --- |
| Node.js | `>=22.19.0` | `package.json#engines.node` |
| npm | `>=11.0.0` | `package.json#engines.npm` |
| 强制引擎校验 | `engine-strict=true` | `.npmrc` |
| 本机实测 | Node `v24.12.0`、npm `11.6.2` | 只读命令 `node --version` / `npm --version` |
| CI 使用 Node | `24` | `.github/workflows/ci.yml`（`setup-node` `node-version: 24`） |
| 包管理器 | npm（`package-lock.json`，脚本用 `npm ci`） | `package.json`、`.agent/commands/dev.md` |
| 模块体系 | ESM（`"type": "module"`） | `package.json#type` |

### 2.2 语言 / 桌面壳 / 前端

| 层 | 技术 | 版本 | 来源 |
| --- | --- | --- | --- |
| 语言 | TypeScript | `6.0.3`（devDep） | `package.json#devDependencies` |
| 严格模式 | `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等 | — | `tsconfig.base.json` |
| 桌面壳与主进程 | Electron | `43.1.1` | `package.json#devDependencies`、`src/main/index.ts` |
| UI 框架 | React + react-dom | `19.2.7` | `package.json#dependencies` |
| 构建器 | Vite + `@vitejs/plugin-react` | `8.1.4` / `6.0.3` | `package.json`、`vite.config.ts` |
| UI 组件库 | `@radix-ui/themes` | `3.3.0` | `package.json#dependencies` |
| 图标 | `@phosphor-icons/react` | `2.1.10` | `package.json`、`src/renderer/Console.tsx` |
| Markdown 渲染 | `react-markdown` + `remark-gfm` | `^10.1.0` / `^4.0.1` | `package.json` |
| 二维码（配对） | `qrcode.react` | `^4.2.0` | `package.json` |
| 精确小数 | `decimal.js` | `^10.6.0` | `package.json` |
| HTML 解析/抽取 | `linkedom`、`@mozilla/readability` | `^0.18.12` / `^0.6.0` | `package.json` |

### 2.3 主进程后端

| 能力 | 技术 | 来源 |
| --- | --- | --- |
| 持久化 | **`node:sqlite`** 的 `DatabaseSync` + `backup`（非 better-sqlite3） | `src/main/infrastructure/persistence/runtime-database.ts:6` |
| Schema 迁移 | SQL 文件 + 单调版本号，`resources/migrations/` 共 75 个 `NNN_*.sql`（当前最大 `075_workbench_choice.sql`） | `resources/migrations/`、`resources/migrations/README.md` |
| Hub API | 原生 `node:http` + HTTP `/api/v1`（renderer 轮询收敛；SSE 传输已于 ADR 0009 退役） | `src/main/interfaces/http/runtime-listeners.ts`、`src/main/interfaces/http/routes/index.ts` |
| 中继 WebSocket | `ws` | `^8.18.3`（`package.json`）、`src/relay/remote-relay-server.ts` |
| 凭据存储 | Electron `safeStorage` | `src/main/infrastructure/security/electron-credential-vault.ts` |
| 国际化 | `intl-messageformat` `12.1.3` + `@formatjs/icu-messageformat-parser` `3.5.21` | `package.json`、`scripts/i18n.mjs` |

### 2.4 Agent / 模型 / 协议依赖（本仓库的核心第三方依赖）

| 依赖 | 版本 | 用途 | 来源 |
| --- | --- | --- | --- |
| `@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent` | `0.87.1` | 唯一主推理基座 Pi 与 Pi Coding Agent 搭档 | `package.json#dependencies`、`src/main/infrastructure/pi/`（31 个文件） |
| `@a2a-js/sdk` | `0.3.14` | A2A 协议 `0.3.x` 客户端 | `package.json`、`src/main/infrastructure/a2a/`、`docs/05-a2a-integration.md` |
| `@anthropic-ai/claude-agent-sdk` | `0.3.251` | Claude 原生搭档引擎 | `package.json`、`src/main/infrastructure/mana/claude-agent-sdk-partner-engine-runtime.ts` |
| `@openai/codex-sdk` | `0.151.0` | Codex 原生搭档引擎 | `package.json`、`src/main/infrastructure/mana/codex-agent-sdk-partner-engine-runtime.ts` |

### 2.5 测试 / 质量工具

| 工具 | 版本 | 来源 |
| --- | --- | --- |
| Vitest + `@vitest/coverage-v8` | `4.1.10` | `package.json#devDependencies`、`vitest.config.ts` |
| jsdom、`@testing-library/react`、`@testing-library/jest-dom` | `29.1.1` / `16.3.2` / `6.9.1` | `package.json`、`tests/setup.ts` |
| Playwright（Electron E2E） | `1.61.1` | `package.json`、`playwright.config.ts`、`tests/e2e/*.spec.ts` |
| ESLint + typescript-eslint | `10.7.0` / `8.64.0` | `package.json`、`eslint.config.mjs` |
| 覆盖率门槛 | statements/branches/functions/lines 均 `90` | `vitest.config.ts#test.coverage.thresholds` |
| 测试文件总数 | 255 个（unit 115、integration 88、contract 36、e2e 9、renderer 4、architecture 1、native 1、relay 1） | 只读统计 `tests/**/*.{test,spec}.ts` |

### 2.6 打包与原生组件

| 组件 | 技术 | 来源 |
| --- | --- | --- |
| 桌面安装包 | `electron-builder` `26.15.3`（Windows NSIS / macOS DMG） | `package.json#build` |
| 原生远程传输（Rust） | crate `joi-remote`，edition 2024，`iroh = "=1.0.2"`、`rustls`、`tokio`、`sha2`、`hmac`、`base64`、`jni`（Android） | `native/joi-remote/Cargo.toml` |
| 移动端（Flutter/Dart） | `joi_mobile`，Dart SDK `^3.11.5`，依赖 `flutter_secure_storage`、`mobile_scanner`、`cryptography`、`ffi`、`pdf`、`printing`、`image`、`flutter_markdown_plus` | `apps/joi_mobile/pubspec.yaml` |
| 离线字体 | Noto Sans SC（SIL OFL 1.1） | `resources/fonts/README.md`、`resources/fonts/NotoSansSC.ttf` |

### 2.7 许可证现状（README 需如实说明）

- **仓库根目录没有 `LICENSE` 文件**（`ls LICENSE*` 无结果）。
- `package.json` **没有 `license` 字段**，且 `"private": true`。
- `native/joi-remote/Cargo.toml` 声明 `license = "UNLICENSED"`。
- 仅存在第三方许可证文本 `resources/licenses/ai-berkshire-MIT.txt`（AI Berkshire 场景包随附 MIT）。
- 结论：README 的 License 章节必须写「未提供根许可证 / 私有仓库」，**不得**声称 MIT 或 Apache。

---

## 3) 目录结构

顶层（排除 `node_modules/`、`.git/`、`dist/`、`coverage/`、`release-*/`、`test-results/`、`tmp/` 等生成物）：

```text
digital-life/
├── .agent/            # 面向 AI Agent 的命令索引（commands/README.md + dev/verify/i18n/package/clean）
├── .claude/           # 本地 Agent 运行时状态（.gitignore 忽略）
├── .codux/            # 本地审查工作树（忽略）
├── .github/workflows/ # CI：quality（windows-latest + macos-latest）
├── apps/
│   └── joi_mobile/    # Flutter Android 受限远程客户端（lib/、test/、android/、l10n/、assets/）
├── docs/              # 产品/架构/协议/验收文档包（00–20）+ adr/ + design/
│   ├── adr/           # 30 篇架构决策记录（0001–0030）
│   └── design/        # 品牌与 Android 预览（含真实截图 PNG）
├── native/
│   └── joi-remote/    # Rust iroh 远程传输 crate（src/、tests/、Cargo.toml）
├── public/            # 静态 favicon（icon.png）
├── resources/
│   ├── branding/      # 应用图标源（icon.svg / icon.png）
│   ├── fonts/         # 离线导出字体 NotoSansSC.ttf（OFL）
│   ├── licenses/      # 第三方许可证文本
│   ├── locales/       # 唯一 i18n 源目录（en/、zh-CN/、manifest.json）
│   ├── migrations/    # 75 个 SQLite migration + README.md
│   └── native/win32/  # 构建产出的 iroh sidecar（忽略）
├── scripts/           # 构建/打包/i18n/边界审计脚本（.mjs/.cjs/.py）
├── src/
│   ├── main/          # Electron 主进程：domain / application / infrastructure / interfaces / composition
│   ├── preload/       # 桌面窄桥（index.cts）
│   ├── relay/         # 浏览器远程中继（index.ts、remote-relay-server.ts）
│   ├── renderer/      # React 同构 UI（桌面 + 局域网 + 远程网页）
│   └── shared/        # 跨层 DTO 与 i18n（11 个 DTO 模块 + i18n/）
├── tests/             # unit / integration / contract / renderer / architecture / native / relay / e2e / fixtures / support
├── AGENTS.md          # 仓库 Agent 指南：事实源、分层边界、固定验证命令
├── README.md          # 现有唯一 README（中文）
├── eslint.config.mjs / vitest.config.ts / playwright.config.ts / vite.config.ts
├── tsconfig.base.json / tsconfig.{electron,renderer,relay,tests}.json / tsconfig.json
└── package.json / package-lock.json
```

`src/main/` 分层职责（由 `AGENTS.md`「Required boundaries」与 `scripts/architecture-boundaries.mjs` 强制）：

| 目录 | 职责 | 关键文件 |
| --- | --- | --- |
| `src/main/domain/` | 纯 TypeScript 领域模型，禁止 Electron/Node/SQLite/HTTP/A2A | `domain/work`、`domain/workbench`、`domain/partners`、`domain/model-sources`、`domain/automation`、`domain/evolution`、`domain/statistics`、`domain/text` |
| `src/main/application/` | 编排 ports 与领域行为，不实现传输/SQL/Electron 生命周期 | `application/joi`（14）、`application/partners`（17）、`application/actors`、`application/work`、`application/ports`（41） |
| `src/main/infrastructure/` | 实现 ports：Pi、SQLite、safeStorage、A2A、iroh、artifact | `infrastructure/pi`（31）、`infrastructure/persistence`（44）、`infrastructure/a2a`、`infrastructure/mana`、`infrastructure/remote`、`infrastructure/workspace` |
| `src/main/interfaces/` | HTTP `/api/v1` → application 映射与共享 DTO | `interfaces/http/routes/`（14 个路由族） |
| `src/main/composition/` | 组合根与桌面 runtime worker | `composition/runtime-host.ts`、`runtime-worker.ts`、`desktop-runtime-client.ts`、`wire-*.ts` |

`src/renderer/` 主要文件职责：

| 文件 | 职责 |
| --- | --- |
| `main.tsx` | 入口：按 `window.digitalLifeDesktop` 与 `/remote` 路径分流桌面/远程 |
| `App.tsx` | 启动状态机（booting/login/setup/ready/error） |
| `Console.tsx` | 主控制台：侧栏导航 + 各页面 + 设置页签 |
| `JoiHome.tsx` | 首页信息流、工作台管理、已归档、模型来源管理 |
| `PartnerPage.tsx` | 搭档页（含「场景预设」页签） |
| `AutomationPanel.tsx` | 定时任务（Routine） |
| `StatisticsPage.tsx` | 统计页 |
| `EvolutionSettings.tsx` | 自主进化设置 |
| `JoiSkillSettings.tsx` | 技能设置 |
| `RemoteJoiApp.tsx` / `remote-connection.ts` | 浏览器远程 UI 与连接 |
| `ResultExportMenu.tsx` | 结果导出 |
| `api.ts` | `/api/v1` 客户端 |
| `i18n.ts` / `copy.ts` | 前端 i18n 绑定 |
| `Onboarding.tsx` | 首次设置与登录门 |

---

## 4) 入口与运行路径

### 4.1 真实入口点

| 入口 | 文件 | 说明 |
| --- | --- | --- |
| Electron 主进程 | `src/main/index.ts`（`package.json#main` → `dist/electron/main/index.js`） | 创建 BrowserWindow、托盘、单实例锁、启动 runtime |
| Runtime 组合根 | `src/main/composition/runtime-host.ts` | 建库、迁移、HTTP listener、actor 根循环 |
| 渲染进程 | `src/renderer/main.tsx`（`index.html` 引用） | React 根 |
| 预加载桥 | `src/preload/index.cts` | 仅暴露窄桌面桥（bootstrap nonce、runtime info） |
| 远程中继 | `src/relay/index.ts` → `dist/remote-relay/relay/index.js` | 独立 Node 服务 |

### 4.2 安装 / 构建 / 启动 / 测试 / 打包命令（**原样取自 `package.json#scripts`，不得改写**）

```text
npm ci                     # 安装（来源：README.md、.agent/commands/dev.md）
npm run dev                # 开发态：build:electron + vite(127.0.0.1) + tsc watch + electron
npm start                  # dev 的等价别名
npm run app:run            # 完整生产构建后用 Electron 本地运行
npm run build:renderer     # vite build
npm run build:electron     # tsc -p tsconfig.electron.json
npm run build:relay        # tsc -p tsconfig.relay.json
npm run build:native:desktop  # 构建 iroh sidecar（需要 Rust Cargo）
npm run build:mobile:android  # 构建 Android APK（需要 Flutter + NDK）
npm run build:prod         # rimraf dist && native:desktop && renderer && electron && relay
npm run typecheck          # tsc -b tsconfig.json
npm run lint               # eslint . --max-warnings 0
npm run test               # vitest run
npm run test:coverage      # vitest run --coverage
npm run test:renderer      # vitest run tests/renderer
npm run test:integration   # vitest run tests/integration
npm run test:contract      # vitest run tests/contract
npm run test:e2e           # build:prod && playwright test
npm run check:boundaries   # node scripts/architecture-boundaries.mjs
npm run check              # typecheck && lint && test && test:coverage && build:prod && package:verify
npm run package            # node scripts/package-app.mjs（当前平台）
npm run package:win        # Windows NSIS
npm run package:mac        # macOS DMG（仅 macOS 构建机）
npm run package:dir        # 当前平台 unpacked
npm run package:verify     # build:prod && node scripts/package-verify.mjs
npm run remote:relay       # node dist/remote-relay/relay/index.js
npm run remote:relay:package  # build:prod && node scripts/package-remote-relay.mjs
npm run i18n               # node scripts/i18n.mjs
npm run i18n:check         # node scripts/i18n.mjs check
npm run i18n:stats         # node scripts/i18n.mjs stats
npm run assets:icons       # electron scripts/render-app-icon.cjs
npm run clean              # node scripts/clean-artifacts.mjs
```

`AGENTS.md`「Fixed validation commands」与 `.agent/commands/verify.md` 的固定门禁为：

```text
npm run typecheck
npm run lint
npm run test
npm run test:coverage
npm run test:e2e
npm run build:prod
npm run package:verify
```

### 4.3 端口与网络

| 项 | 值 | 来源 |
| --- | --- | --- |
| Loopback API/UI 端口 | `43130`（`isTest` 时为 `0` 随机端口） | `src/main/composition/runtime-host.ts:105` 与 `:278` |
| Vite 开发服务器 | `127.0.0.1:43715`，`strictPort: true`，`/api` 代理到 `http://127.0.0.1:43130` | `vite.config.ts` |
| 局域网 Web 端口 | 默认 `43130`，用户选择 RFC1918 地址 | `docs/01-product-requirements.md` §3、`docs/06-security-and-operations.md`、`README.md`「默认运行策略」 |
| 远程中继端口 | 默认 `8787` | `src/relay/index.ts:9` |

### 4.4 环境变量清单

| 变量 | 作用 | 默认值 | 来源 |
| --- | --- | --- | --- |
| `JOI_TEST` | 测试模式：隔离 userData、跳过单实例锁、loopback 随机端口 | 未设置（视为 `0`） | `src/main/index.ts:18-28` |
| `VITE_DEV_SERVER_URL` | 开发态加载 Vite URL 而非内嵌 UI | 未设置 | `src/main/index.ts:117` |
| `JOI_RELAY_HOST_TOKEN` | 中继主机令牌 | `""` | `src/relay/index.ts:7` |
| `JOI_RELAY_BIND_ADDRESS` | 中继绑定地址 | `127.0.0.1` | `src/relay/index.ts:8` |
| `JOI_RELAY_PORT` | 中继端口 | `8787` | `src/relay/index.ts:9` |
| `JOI_RELAY_STATIC_DIRECTORY` | 中继静态目录 | `dist/renderer` | `src/relay/index.ts:10` |
| `JOI_PARTNER_ENV_PASSTHROUGH` | 允许透传给搭档进程的敏感环境变量名（逗号分隔） | `""` | `src/main/infrastructure/pi/pi-coding-tool-factory.ts:34-38` |
| `JOI_AGENTS_SKILLS_DIR` / `JOI_CLAUDE_SKILLS_DIR` / `JOI_CODEX_SKILLS_DIR` | 覆盖三类本机 Skill 扫描目录 | 未设置时回退默认根 | `src/main/infrastructure/pi/pi-sdk-skill-catalog.ts:32` |
| `TAVILY_API_KEY` | 示例敏感值（仅经 `JOI_PARTNER_ENV_PASSTHROUGH` 授权后进入搭档 bash） | 未设置 | `src/main/infrastructure/pi/pi-coding-tool-factory.ts:34` |
| `JOI_NATIVE_WRITE_TESTS` | 开启原生写工具测试 | 未设置（跳过） | `tests/native/local-workspace-write.test.ts:14`、`.agent/commands/verify.md` |
| `JOI_NATIVE_TOOL_SMOKE` | 开启 Codex 原生写工具冒烟 | 未设置（跳过） | `tests/native/local-workspace-write.test.ts:15` |
| `JOI_RELAY_SMOKE_URL` | 公网中继外部验收目标 | 未设置（`#[ignore]`） | `native/joi-remote/tests/deployed_relay.rs:9-12` |
| `CARGO` / `ANDROID_HOME` / `ANDROID_NDK_HOME` | 原生构建工具链定位 | 未设置时自动探测 | `scripts/build-native-remote.mjs` |
| `CSC_IDENTITY_AUTO_DISCOVERY` | CI 关闭代码签名自动发现 | 未设置 | `.github/workflows/ci.yml` |

注意：**仓库不存在 `.env.example`**（`.gitignore` 保留 `!.env.example` 例外但文件缺失），`.env` / `.env.*` 被忽略。README 不应虚构 `.env` 用法。

### 4.5 应用内可配置项（非环境变量，存 SQLite）

| 配置 | 说明 | 来源 |
| --- | --- | --- |
| 管理员密码（最小长度 6） | 首次设置 | `src/shared/product.ts`（`ADMIN_PASSWORD_MIN_LENGTH`） |
| `uiLocale` | `system` / `en` / `zh-CN`，桌面可写 | `docs/20-internationalization.md`、`src/shared/system-settings.ts` |
| 局域网监听地址/开关 | 仅 RFC1918 | `src/main/interfaces/http/runtime-listeners.ts`、`src/shared/system-settings.ts` |
| 开机启动 | `launchAtLogin` | `src/main/index.ts`、`src/shared/system-settings.ts` |
| 模型来源（6 家厂商 + 通用平台；普通 API / 官方 Coding-Token Plan；OpenAI-compatible / Anthropic-compatible 协议） | `ModelSourceKind = kimi \| glm \| qwen \| doubao \| minimax \| deepseek \| generic-openai`；`ModelSourceProtocol = openai \| anthropic` | `src/main/domain/model-sources/model-source.ts:6,8` |
| 默认运行策略（主唤醒并发 1、协作者并发 4、单 Endpoint 2、每日自主唤醒 24、每日 A2A 100、空闲探索门槛 120 分钟/上限 3、安静时段 23:00–07:00） | 可按数字生命修改 | `README.md`「默认运行策略」（表） |

---

## 5) 核心功能清单（每条注明代码出处）

### 5.1 面向用户的功能

| 功能 | 代码出处 |
| --- | --- |
| 首页信息流：目标卡（`ARRANGING`/`progressing`/`REVIEWING`/`EXTENDING`/`FINALIZING`）、需你处理、归档 | `src/main/application/joi/joi-home-feed-service.ts`、`src/renderer/JoiHome.tsx`、`docs/03-system-architecture.md` §0.2 |
| 工作台（Workbench）管理：创建/合并/归档/删除、工作区绑定、双端归属选择 | `src/main/application/joi/workbench-management-service.ts`、`workbench-workspace-service.ts`、`workbench-change-service.ts`、`src/renderer/WorkbenchChoiceDialog.tsx` |
| 搭档（Partner）目录与实例：全局无 cwd 模板、工作台私有实例（EPHEMERAL/RESIDENT）、场景预设包 | `src/main/application/partners/partner-registry-service.ts`、`partner-instance-manager.ts`、`scenario-pack-service.ts`、`src/renderer/PartnerPage.tsx` |
| Work 工作项与 DAG、READ/WRITE/NONE 权限、lease、依赖门控、恢复 | `src/main/domain/work/`、`src/main/application/work/`、`resources/migrations/052_work_dependency_gate.sql`、`050_work_recovery.sql` |
| 工作台 Agent 会话信息流（只读安全投影：Markdown/工具/产物） | `src/main/application/partners/workbench-agent-service.ts`、`agent-conversation-presentation.ts`、`src/renderer/Console.tsx`、`docs/adr/0008-workbench-agent-information-flow.md` |
| 定时任务 Routine（唯一 Joi scheduler 管理入口） | `src/main/application/automation/`、`resources/migrations/049_joi_automations.sql`、`src/renderer/AutomationPanel.tsx` |
| 统计页：Token 用量、日历/时段热力图、模型排名、工作台与高消耗目标 | `src/main/application/statistics/`、`src/main/domain/statistics/`、`src/renderer/StatisticsPage.tsx`、`docs/adr/0021-token-statistics.md` |
| 自主进化设置（四档额度、灰度、评测进度） | `src/main/application/evolution/`、`src/renderer/EvolutionSettings.tsx`、`docs/adr/0020-bounded-strategy-evolution.md` |
| 技能设置（扫描 `~/.agents/skills`、`~/.claude/skills`、`~/.codex/skills`） | `src/main/infrastructure/skills/local-skill-scanner.ts`、`src/main/infrastructure/pi/pi-sdk-skill-catalog.ts`、`src/renderer/JoiSkillSettings.tsx` |
| 模型来源引导与门禁（首次无可用源时先完成连接） | `src/main/application/model-sources/`、`src/main/infrastructure/pi/provider-presets.ts`、`src/renderer/Onboarding.tsx`、`docs/02-ux-specification.md` §0 |
| 结果导出（A4 PDF / 1080px PNG，桌面与 Android 离线） | `src/main/infrastructure/artifacts/electron-result-export.ts`、`src/renderer/ResultExportMenu.tsx`、`scripts/verify-result-export.py`、`docs/19-result-export-acceptance.md` |
| 界面语言即时切换（桌面/局域网/远程网页/Android 各自独立） | `resources/locales/`（en 与 zh-CN 各 19 个命名空间）、`src/shared/i18n/`、`scripts/i18n.mjs`、`docs/20-internationalization.md` |
| 首次设置 / 登录 / 恢复模式 | `src/renderer/Onboarding.tsx`、`src/main/interfaces/http/recovery-mode-handler.ts`、`src/main/interfaces/http/routes/auth-routes.ts` |
| Android 原生远程（二维码一次性绑定、iroh 直连/中继） | `apps/joi_mobile/lib/`、`src/main/infrastructure/remote/`、`native/joi-remote/`、`docs/adr/0013-native-iroh-remote-control.md` |
| 浏览器远程中继 | `src/relay/`、`docs/11-browser-remote-relay-deployment.md`、`docs/12-native-iroh-relay-deployment.md` |

### 5.2 面向开发者的能力

| 能力 | 代码出处 |
| --- | --- |
| 分层架构边界强制（domain 纯净、renderer 不导入 Electron/Node/SQLite/A2A） | `AGENTS.md`「Required boundaries」、`scripts/architecture-boundaries.mjs`、`tests/architecture/` |
| HTTP `/api/v1` 路由族：auth、joi、workbench、partner、automation、model-source、statistics、evolution、result-export、remote、system、agent、legacy-life | `src/main/interfaces/http/routes/index.ts`、`routes/*.ts`（14 个文件） |
| 桌面 runtime worker 隔离与 RPC | `src/main/composition/runtime-worker.ts`、`desktop-runtime-client.ts`、`src/main/infrastructure/runtime/worker-rpc.ts`、`docs/adr/0029-desktop-runtime-workers.md` |
| 事件驱动 actor 根循环（单一 root tick） | `src/main/application/actors/actor-tree.ts`、`joi-actor.ts`、`workbench-actor.ts`、`agent-actor.ts`、`docs/adr/0009-actor-tree-single-root-tick.md` |
| outbox 先持久化后副作用 + 幂等 | `src/main/application/ports/`、`AGENTS.md`「Development discipline」 |
| SQLite 迁移与备份/恢复 | `resources/migrations/`、`src/main/infrastructure/operations/backup-service.ts`、`docs/06-security-and-operations.md` §10-11 |
| i18n 生成与覆盖率检查（生成 TypeScript 与 Flutter ARB） | `scripts/i18n.mjs`（`stats`/`check`/`generate`/`locale`/`key`/`sync`）、`src/shared/i18n/generated.ts` |
| 打包内容审计与校验 | `scripts/package-verify.mjs`、`scripts/package-contents.mjs`、`scripts/package-app.mjs` |
| 本机 Skill 渐进披露与路径白名单 | `src/main/infrastructure/pi/pi-sdk-skill-catalog.ts`、`pi-filesystem-boundary.ts` |
| 受控只读网页工具（`web_search`/`fetch_content`/`get_search_content`） | `src/main/infrastructure/pi/pi-web-access-tools.ts`、`docs/03-system-architecture.md` §0 |

---

## 6) 现有文档与资产现状

### 6.1 README 类文件

| 文件 | 语言 | 覆盖内容 | 状态 |
| --- | --- | --- | --- |
| `README.md` | **仅中文** | 标题+一句话简介、JOI-01 目标形态（含 ADR 链接）、项目状态、界面语言、本地开发（环境要求/`npm ci`/`npm run dev`/`app:run`/固定质量命令）、我们要构建什么、核心原则 6 条、MVP 能力 8 条、系统概览（**Mermaid 流程图**）、默认运行策略表、文档导航（10 篇）、明确不在 MVP 中、事实基线 | 唯一根 README |
| `.agent/commands/README.md` + `dev/verify/i18n/package/clean.md` | 中文 | Agent 命令索引与使用约束 | 面向 Agent |
| `.agent/commands.md` | 中文 | 旧兼容摘要 | 兼容保留 |
| `apps/joi_mobile/README.md` | 中文 | Android 端说明与构建命令 | 子项目 README |
| `resources/migrations/README.md` | 中文 | migration 演进说明（060–074） | 子目录 README |
| `resources/fonts/README.md` | 中文 | 字体来源与许可 | 子目录 README |
| `apps/joi_mobile/assets/fonts/README.md` | 中文 | 字体资产说明 | 子目录 README |

**不存在 `README.zh-CN.md`，也不存在任何英文 README。**

### 6.2 docs 目录（60 个 git 跟踪文件）

- 编号文档 18 篇：`docs/00-sources-and-glossary.md` … `docs/20-internationalization.md`（缺 16/17/18 编号）。
- ADR 共 29 篇：`docs/adr/0001` … `docs/adr/0030`（编号不连续，且存在两个 `0014-*`）。
- 设计资料：`docs/joi-brand-assets.md`、`docs/joi-voice-guidelines.md`、`docs/joi-architecture.html`（30 KB 独立架构 HTML）。
- `docs/design/`：`joi-android-c-package-verification.md`、`joi-c-package-verification.md`、`joi-avatar-options.md`、`joi-avatar-options.html` + 6 张 PNG。
- 归档/状态类：`docs/09-release-validation-report.md`、`docs/10-requirements-traceability.md`（70 KB）。

### 6.3 许可证

- **无根 `LICENSE` / `COPYING`**。
- `resources/licenses/ai-berkshire-MIT.txt`（第三方场景包 MIT）。
- `resources/fonts/OFL.txt`（Noto Sans SC，SIL OFL 1.1）。
- `native/joi-remote/Cargo.toml` → `license = "UNLICENSED"`。

### 6.4 图片 / 截图资源现状

**git 跟踪的图片仅 23 个**（`git ls-files | grep -iE '\.(png|jpg|svg|ico)$'`）：

| 类别 | 文件 | 真实性 |
| --- | --- | --- |
| 品牌 | `resources/branding/icon.svg`、`resources/branding/icon.png`、`public/icon.png`、`src/renderer/joi-avatar.png`、`src/renderer/joi-wordmark.svg` | 设计资产 |
| Android 真机预览 | `docs/design/joi-android-home.png`、`docs/design/joi-android-pairing.png` | **真实 Flutter 组件渲染截图**（390×844，合成控制器，见 `docs/design/joi-android-c-package-verification.md`） |
| 头像候选 | `docs/design/joi-avatar-option-a/b/c.png`、`joi-avatar-options.png` | 设计候选 |
| 移动资产 | `apps/joi_mobile/assets/joi-portrait.png`、`joi-wordmark.png`、10 张 `ic_launcher*.png` | 派生资产 |

**桌面端真实运行截图当前不在 git 中**，但**已存在于工作区**（被 `.gitignore` 忽略的 `test-results/`，时间戳 2026-10-15 23:39–23:40），例如：

- `test-results/e2e-sidebar-light-home.png`、`e2e-sidebar-dark-workbench.png`
- `test-results/e2e-joi-composer-960.png`、`e2e-joi-skills-960.png`、`e2e-tool-choices-960.png`
- `test-results/e2e-model-source-960.png`、`e2e-model-source-setup-960.png`、`e2e-evolution-960.png`
- `test-results/statistics-light-1440.png`、`statistics-dark-960.png`、`statistics-hourly-1440.png`
- `test-results/i18n-desktop-{en,zh-CN}-{light,dark}.png`
- `test-results/e2e-agent-stream-latest.png`、`e2e-goal-stream-latest.png`、`e2e-console-768.png`、`e2e-workbench-removal-768.png`

这些是 Playwright `_electron.launch()` 对**真实 Electron 应用窗口**的 `page.screenshot()` 输出（`tests/e2e/electron-smoke.spec.ts:114,162-319`、`tests/e2e/i18n.spec.ts:36-37`、`tests/e2e/statistics.spec.ts`），属于「真实运行截图」，不是示意图。

### 6.5 现有 README 已覆盖 / 缺失概览

**已覆盖**：一句话简介、产品目标形态、核心原则、MVP 能力、Mermaid 架构图、默认运行策略表、文档导航、范围外声明、事实基线、本地开发命令、i18n 说明。

**缺失/不足**：
1. 无英文版本，无 `README.zh-CN.md` 与语言互链。
2. 无徽章（CI/Node/Electron/React/License）。
3. 无目录（TOC）。
4. 无一张图片/截图；Mermaid 之外的视觉说明为零。
5. 无技术栈表格（Electron/React/TS/SQLite/A2A/Pi/iroh/Flutter 版本与来源）。
6. 无目录结构说明。
7. 无环境变量/端口配置章节。
8. 无面向最终用户的安装说明（`release-joi/joi-0.1.0-win-x64.exe` 存在但 README 未提；未签名事实未说明）。
9. 无「为什么」动机章节（超长期任务、回合制、中断/恢复，见 `docs/00-sources-and-glossary.md` §2.1）。
10. 无贡献指南 / 开发纪律（`AGENTS.md` 内容未进 README）。
11. 无 License 章节（且仓库无根 LICENSE，必须如实说明）。
12. 无 FAQ / 故障排查（`docs/06-security-and-operations.md` §12 有素材）。
13. 无测试与覆盖率现状说明。
14. 现有中文 README 有大量历史/兼容叙事（旧 Life/Wake、M0–M7），与流行 README「先讲清是什么、怎么跑」的惯例顺序不一致。

---

## 7) 配图可行性判断

### 7.1 是否存在可无交互启动的界面？

| 界面 | 是否存在 | 无交互启动方式 | 依据 |
| --- | --- | --- | --- |
| 桌面 GUI（Electron） | ✅ | `npm run dev`（开发态）或 `npm run app:run`（生产形态）；E2E 用 Playwright `_electron.launch({ args: ["."] })` 自动驱动 | `package.json#scripts`、`tests/e2e/electron-smoke.spec.ts:2` |
| 内嵌/局域网 Web UI | ✅（但依附桌面进程） | 桌面 runtime 在 loopback `43130` 提供 `/api/v1` + 静态 renderer；局域网需用户选 RFC1918 地址 | `src/main/composition/runtime-host.ts:105`、`src/main/interfaces/http/static-renderer-handler.ts`、`runtime-listeners.ts` |
| 浏览器远程网页 | ⚠️ 需要中继 + 主机令牌 | `npm run remote:relay`，需 `JOI_RELAY_HOST_TOKEN` 与已配对的桌面 | `src/relay/index.ts`、`docs/11-browser-remote-relay-deployment.md` |
| Android 原生 App | ⚠️ 需要 APK/模拟器/真机 | `npm run build:mobile:android`（需要 Flutter + Android NDK） | `apps/joi_mobile/README.md`、`scripts/build-joi-mobile.mjs` |
| 纯 CLI 交互界面 | ❌ 无 | — | 无 CLI 入口；`src/main/index.ts` 只创建窗口与托盘 |

### 7.2 本机能否获取真实运行截图？

**结论：可以，且有直接证据。** 本机已具备全部前提：

| 前提 | 实测状态 | 来源 |
| --- | --- | --- |
| `node_modules` 已安装 | ✅ 存在 | 只读 `ls` |
| Electron 已安装 | ✅ `43.1.1` | `node_modules/electron/package.json` |
| Playwright 已安装 | ✅ `1.61.1` | `node_modules/@playwright/test/package.json` |
| Playwright 浏览器 | ✅ `~/AppData/Local/ms-playwright` 有 chromium/firefox/webkit（Electron 场景其实不需要） | 只读 `ls` |
| 生产构建产物 | ✅ `dist/electron/main/index.js`、`dist/renderer/index.html`、`dist/remote-relay/relay/index.js` | 只读 `ls` |
| iroh sidecar | ✅ `resources/native/win32/joi-remote-sidecar.exe`（15 MB） | 只读 `ls` |
| Rust 工具链 | ✅ `~/.cargo/bin/cargo.exe` 存在（`build:native:desktop` 需要） | 只读 `ls ~/.cargo/bin` |
| Node/npm 版本 | ✅ Node `v24.12.0`、npm `11.6.2`，满足 `engines` | 只读命令 |
| **真实截图已产出** | ✅ `test-results/*.png` 共 34 张，2026-10-15 23:39–23:40，由 `npm run test:e2e` 生成 | `tests/e2e/*.spec.ts`、只读 `ls -la test-results/*.png` |
| E2E 通过证据 | ✅ `.codux-review-e2e.log`、`docs/09-release-validation-report.md`、`docs/20-internationalization.md`「本轮验收」记录 11 项 E2E 通过 | 上述文件 |

**推荐取图路径（供后续「配图」工作使用，本报告不执行）**：

1. **首选（最省事、最真实）**：运行 `npm run test:e2e`（内部先 `build:prod`），把 `test-results/` 中选定 PNG 复制到 README 图片目录（如 `docs/images/`）并在 README 中引用。注意 `test-results/` 被 `.gitignore` 忽略，**必须复制到被跟踪的目录**否则图片不真实存在。
2. **备选（更可控）**：新增一个仅用于截图的 Playwright Electron 脚本/规格，用 `JOI_TEST=1` 隔离 userData，自动走完首次设置后对「joi 首页 / 搭档页 / 统计页 / 设置页」逐页 `page.screenshot()`。
3. **架构/流程配图**：README 现有 Mermaid 可直接渲染（GitHub 原生支持）；若需 PNG/SVG，可从 `docs/03-system-architecture.md` §0 的文本流程与 `docs/joi-architecture.html` 派生，或本地渲染 Mermaid。**但这类图必须标注为「架构/流程图」，不得冒充截图。**

**阻碍与注意事项**：

- Electron 截图需要图形会话（Windows 桌面）。本机具备（E2E 刚刚成功产出 PNG）。
- `npm run test:e2e` 会先执行 `build:prod`，其中 `build:native:desktop` 需要 Rust Cargo（本机 `~/.cargo/bin/cargo.exe` 存在）；若无 Rust，可绕过构建直接 `npx playwright test`（`dist/` 已就绪）。
- `npm run package:mac` 与 iOS 相关不可行（非 macOS 主机）。
- E2E 使用**临时隔离 userData**（`src/main/index.ts:23-30`），截图**不含真实用户数据/凭据**，可安全提交。
- 部分 E2E 截图（如 `e2e-model-source-setup-960.png`）展示的是首次设置门禁界面，选图时需挑选能代表产品能力的页面（首页信息流、搭档页、统计页、设置页）。
- **不得**用 `docs/design/joi-avatar-option-*.png` 之类设计稿或手绘示意图冒充运行截图。

---

## 8) 现有 README 的缺口清单（对照流行开源项目 README 惯例）

| # | 惯例章节 | 状态 | 说明 / 依据 |
| --- | --- | --- | --- |
| 1 | 项目标题 + 徽章（Badges） | **缺失** | `README.md` 无任何徽章；CI 名 `quality`（`.github/workflows/ci.yml`）可作为徽章来源 |
| 2 | 一句话简介（One-liner） | **已有（需更新）** | 有 `# joi · 唯一入口的个人智能编排中枢`；建议补充 `package.json#description` 英文版 |
| 3 | 目录（TOC） | **缺失** | 文档已较长，无 TOC |
| 4 | 背景 / 为什么（Motivation） | **缺失** | 素材在 `docs/00-sources-and-glossary.md` §2.1 |
| 5 | 特性（Features） | **已有（需更新）** | 有「MVP 能力」「核心原则」，但缺当前 JOI-01 视角的特性分组与代码出处 |
| 6 | 系统架构（Architecture） | **已有（需增强）** | 有 Mermaid 图 + 「系统概览」；缺分层表、技术栈表、目录结构 |
| 7 | 技术栈（Tech Stack） | **缺失** | 需从 `package.json`/`Cargo.toml`/`pubspec.yaml`/`vitest.config.ts` 汇总 |
| 8 | 目录结构（Project Structure） | **缺失** | 需新增 |
| 9 | 快速开始（Quick Start） | **部分已有（需拆分）** | 有「本地开发」（`npm ci`/`npm run dev`/`app:run`）；缺「面向最终用户下载安装」路径 |
| 10 | 配置（Configuration） | **缺失** | 无环境变量/端口/应用内设置章节 |
| 11 | 使用示例（Usage） | **缺失** | 无示例输入/输出、无截图演示 |
| 12 | 截图 / 演示图（Screenshots） | **缺失** | README 无任何图片；可获取真实截图（见 §7） |
| 13 | 测试与质量（Testing） | **缺失** | `npm run test*` 仅在命令块出现；无测试/覆盖率现状说明 |
| 14 | 构建与打包（Build & Package） | **部分已有** | 有 `package:verify`/`package:win`/`package:mac`/`package:dir`；缺 Android/中继打包与签名现状 |
| 15 | 常见问题（FAQ） | **缺失** | 素材见 `docs/06-security-and-operations.md` §12 |
| 16 | 贡献指南（Contributing） | **缺失** | `AGENTS.md` 有开发纪律与固定门禁，未进 README |
| 17 | 路线图（Roadmap） | **已有（需更新）** | 「项目状态」提到 M1–M3；可链接 `docs/07-roadmap-and-acceptance.md` |
| 18 | 许可证（License） | **缺失** | 无根 LICENSE；必须如实声明「私有 / 未提供根许可证」 |
| 19 | 致谢 / 第三方（Acknowledgements） | **缺失** | 有 `resources/licenses/ai-berkshire-MIT.txt`、字体 OFL、A2A/Pi/iroh 依赖可致谢 |
| 20 | 语言互链（Language switch） | **缺失** | 无 `README.zh-CN.md`，无 `English | 简体中文` 链接 |
| 21 | 文档导航（Docs index） | **已有（需更新）** | 已有 10 篇链接；`docs/` 实际有 18 篇编号文档 + 30 ADR，且缺 `11`–`15`、`19`、`20` 的链接 |
| 22 | 范围外声明（Out of scope） | **已有** | 「明确不在 MVP 中」 |
| 23 | 事实基线 / 引用来源 | **已有（需更新）** | 「事实基线」日期为 2026-07-15，落后于当前 ADR 0030 与 i18n/工作台术语（2026-10-15） |

---

## 附：后续两个并行工作的输入要点

**给「双语 README 重写」**：
- 必须新增 `README.zh-CN.md` 并把 `README.md` 改为英文（或反之），两篇互链、信息等价。
- 所有命令/版本/环境变量/端口只能取自本报告 §2、§4，并标注来源文件。
- 必须修正现有 README 的过时叙事（旧 M0–M7、Life/Wake 兼容期表述），以 `docs/00-sources-and-glossary.md` §0 术语为准。
- License 章节必须写「未提供根许可证 / `private: true` / `UNLICENSED`」。

**给「README 配图」**：
- 优先使用 `npm run test:e2e` 产出的真实 Electron 截图，并复制到被 git 跟踪的目录（如 `docs/images/`）。
- 架构/流程图可用 Mermaid 或从 `docs/03-system-architecture.md` 派生，但**必须与截图区分标注**。
- 不得使用设计稿、头像候选图或手工示意图冒充运行截图。
