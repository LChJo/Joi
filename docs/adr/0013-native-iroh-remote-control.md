# ADR 0013: Android 原生控制端复用 iroh 直连与中继

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
5. Android 凭据存入系统安全存储。App 只展示竖屏任务卡、链路状态和文字输入；主机 allowlist 仍只有 `feed.get` 与 `message.send`。
6. 旧浏览器远程源码和已部署网关在 Android 真机验收前保留作回退；验收通过后删除 WebSocket relay、`/remote/` renderer 和相关部署资产。
7. 默认中继为 `https://remote.joilab.top`，用户仍可手动配置其他 HTTPS relay。ECS 上同一 iroh 1.0.x 实例以多域名证书同时服务 `remote` 与兼容保留的 `cudex`；默认客户端不内置共享 Bearer，公开 relay 必须配置连接与单客户端流量上限。

## Consequences

- 局域网直连不经过 ECS；公网无法打洞时只依赖现有 iroh 中继，无需 Cloudflare、DCDN 或额外 Web 网关。
- 多台手机通过独立连接、独立序列和独立设备密钥并行工作；撤销一台设备不影响其他设备。
- Android APK 需要交叉编译并打包 Rust `arm64-v8a` 动态库；桌面安装包必须携带对应平台的 sidecar。
- 中继仍可观察流量时间与大小并拒绝服务，但不能读取任务或消息正文。已接管手机系统、桌面系统或二维码现场的攻击不在本方案防御范围内。
- AC-57 的自动化证据不能替代 Android 真机在 Wi-Fi 与移动网络上的扫码、恢复、直连/中继切换和撤销验收。
- ECS 的部署、验证和回滚方法见 `docs/12-native-iroh-relay-deployment.md`。
