# ADR 0013: Android 原生控制端复用 iroh 直连与中继

## 2026-09-30：工作台归属卡受限创建

- 握手新增独立 `workbench.create` capability；旧主机仍可使用 `home.v2`，手机不会展示一个不受支持的创建入口。
- `workbench.create` 只接受建议方案所需的 `name/personaSummary/projectLabel/scopeSummary` 和当前 `inputId`。主机必须先确认该输入仍处于 `CLARIFICATION_REQUIRED`，且原因属于工作台选择/创建/未找到；其他状态、原因和超长字段一律拒绝。
- 创建复用应用层 `WorkbenchRegistryService`，回包只含 `workbenchId/name/scopeSummary/updatedAt`。手机随后通过既有 `message.clarify` 恢复同一输入；若创建已成功而恢复失败，新工作台保留在本地目录中并提示用户选择它继续，客户端不自动重放创建动作。
- 这是首页工作台归属澄清的窄入口，不是远程工作台管理：不开放任意创建表单、编辑、归档、工作目录、文件或设置命令。

## 2026-09-07：首页能力增量

- 握手可选能力 `home.v2`；无该能力的桌面继续使用旧版 feed/send。
- allowlist 增加 `catalog.get`、`goal.get`、`goal.agents`、`agent.conversation`、`read.next`，以及 `message.clarify/retry/cancel/dismiss/closeHistoricalReview`。发送可选已有工作台；动作复用桌面 inbox 状态门禁，不增加文件/设置权限。
- 只读 JSON 快照用连接绑定、60 秒有效的游标分块；每块 12,000 UTF-16 单位且不拆代理对，响应低于 96 KiB，底层仍限制 256 KiB。单快照最多 16 MiB、每连接最多 8 个、全局最多 64 个；关闭/撤销时释放。记录查询同时约束工作台、目标和搭档实例。
- 只返回用户可展示投影，正文和记录继续脱敏；不暴露引擎私有推理和原始载荷。Flutter 原生 Markdown 禁止远程图片加载，仅允许用户点击 HTTP(S) 链接，产物只显示元数据。
- 两端加密收发按连接串行，旧会话结果不更新新会话。发送确认和刷新独立；未确认的相同草稿/工作台复用幂等键。其他动作不自动重放，结果不确定时提示刷新确认。
- 首页前台约 2 秒刷新，当前活跃搭档记录约 1 秒刷新；保留草稿与阅读位置，后台暂停。能力增量仍属于 AC-57，不能替代真机验收。

- 状态：accepted
- 日期：2026-08-27
- 取代：ADR 0012（浏览器 WebSocket 远程入口）
- 关联：ADR 0008（展示投影）、ADR 0009（唯一调度权威）

## Context

浏览器入口依赖额外的 HTTPS/WSS 网关、域名和移动运营商链路可达性，实际发布路径复杂且不稳定。产品目标改为提供 Android App，并采用与 Codux 相同的连接行为：同一网络内优先点对点直连，无法直连时自动回退到 Joi 自有的 `remote.joilab.top` iroh 中继。同一桌面 Joi 必须允许多台独立手机同时绑定和恢复连接。

本实现只参考连接行为与公开 iroh API，独立编写 Joi 协议和界面，不复制 Codux 的 GPL 源代码。

## Decision

1. `native/joi-remote` 是独立 Rust 核心，固定 ALPN `/joi/remote/1`，使用 iroh endpoint address 同时携带局域网地址与中继 URL。Android 和桌面共享该核心。
2. Electron 通过受控 NDJSON sidecar 使用 iroh。sidecar 只转发有界、不透明 JSON 帧，并按 transport connection id 隔离多个手机连接；节点私钥由 Electron credential vault 加密持久化，且不进入参数、日志或 HTTP DTO。
3. 桌面二维码使用 `joi://pair`，包含十分钟、一次有效的应用层配对密钥和 iroh transport ticket。每台 App 获得独立 device id 与密钥；绑定可逐台撤销。
4. 保留 Joi 已有的双向 HMAC-SHA-256 证明、HKDF-SHA-256 会话派生、AES-256-GCM、严格递增序号和 `connectionId + sequence` AAD。iroh 的加密传输不替代应用层设备授权。
5. Android 凭据存入系统安全存储。初版仅有任务卡和文字输入；2026-09-07 起按下述 `home.v2` 增量扩展受限首页能力。
6. 旧浏览器远程源码和已部署网关在 Android 真机验收前保留作回退；验收通过后删除 WebSocket relay、`/remote/` renderer 和相关部署资产。
7. 默认中继为 `https://remote.joilab.top`，用户仍可手动配置其他 HTTPS relay。ECS 上同一 iroh 1.0.x 实例以多域名证书同时服务 `remote` 与兼容保留的 `cudex`；默认客户端不内置共享 Bearer，公开 relay 必须配置连接与单客户端流量上限。

## 2026-09-07 公网 TLS 握手兼容性

- 同一台 Windows 主机、同一 ECS 的 443：旧 ring 配置的强制中继测试 15 秒未上线；仅对齐 Codux 依赖元数据中的 iroh-relay 1.0.2 / rustls 0.23.40 仍失败，不能把版本差异视为原因。
- Node 对照保持证书验证与目标不变：经典 X25519 握手被重置，提供混合 X25519MLKEM768 并保留 X25519 时成功。仅增加合成握手长度的诊断也改变结果，说明是公网路径对握手形态的兼容性问题，尚未确定产生重置的设备；不声称服务端要求后量子算法。
- 采用 iroh 官方支持的 `tls-aws-lc-rs` 后端，明确启用 rustls `prefer-post-quantum`，保留 iroh 原来的 metrics、portmapper、fast-apple-datapath。不添加自定义密码学、TLS 分片、代理或额外服务器；证书链、主机名、SNI 与应用层授权保持不变。公开 API 依据：[iroh 1.0.2 features](https://docs.rs/crate/iroh/1.0.2/source/Cargo.toml.orig)、[rustls 默认密钥交换](https://docs.rs/rustls/0.23.43/rustls/manual/_05_defaults/index.html)。
- 修复须由配置回归测试和真实公网 `deployed_relay` 双端收发共同验证。两端均清除 IP transport，防止同机直连掩盖中继失败。Android/桌面共享该依赖配置；实际手机扫码和移动网络切换仍需真机验收。

## 2026-09-07 分片读取取消安全

- 真实本地 QUIC 回归复现：FFI 的两秒路径检查和主机的 outbound 分支取消 `read_exact` 时，局部头部/正文进度丢失，后续合法字节被错当作新帧并断连。
- 两端每个接收流持有独立 `FrameReader`，使用取消安全的 `RecvStream::read`，在下一次 await 前持久化已读位置；完整解码后才重置状态。不新增后台任务、不改变线路协议、授权或重试预算。
- 帧长度仍为四字节大端、上限 256 KiB；空帧、超限、截断与无效 JSON 仍关闭流。回归覆盖半头/半正文跨 FFI timer、FFI send、主机 outbound，以及下一帧对齐与半帧关闭。
- 该修复解决已稳定复现的传输缺陷，不替代安装新版两端后的 Android 跨网扫码验收。

## Consequences

- 局域网直连不经过 ECS；公网无法打洞时只依赖现有 iroh 中继，无需 Cloudflare、DCDN 或额外 Web 网关。
- 多台手机通过独立连接、独立序列和独立设备密钥并行工作；撤销一台设备不影响其他设备。
- Android APK 需要交叉编译并打包 Rust `arm64-v8a` 动态库；桌面安装包必须携带对应平台的 sidecar。
- 中继仍可观察流量时间与大小并拒绝服务，但不能读取任务或消息正文。已接管手机系统、桌面系统或二维码现场的攻击不在本方案防御范围内。
- AC-57 的自动化证据不能替代 Android 真机在 Wi-Fi 与移动网络上的扫码、恢复、直连/中继切换和撤销验收。
- ECS 的部署、验证和回滚方法见 `docs/12-native-iroh-relay-deployment.md`。
