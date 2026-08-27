# ADR 0012: 浏览器远程入口使用独立盲中继与端到端设备会话

- 状态：superseded by ADR 0013
- 日期：2026-08-26
- 关联：ADR 0008（展示投影）、ADR 0009（唯一调度权威）

## Context

用户希望像 Codux 一样通过二维码从远端接入 joi，但目标客户端是普通手机浏览器，不安装远程 App；远程能力可简化为查看 joi 首页任务卡和输入文字。

Codux 当前远程链路基于 `iroh-relay` 的原生协议、自定义 ALPN 和原生控制端。浏览器 WebSocket/WebCrypto 不能直接成为 iroh 节点，Codux 的 web tunnel 也仍需要原生控制端，因此复用现有 iroh 端口不能完成“扫码后直接在浏览器使用”。直接把 joi 的 LAN `/api/v1` 反代到公网会扩大 Cookie、CSRF、设置、文件和诊断等权限面，也违反 renderer/API 信任边界。

## Decision

1. 新增独立的 JOI 浏览器 WebSocket 网关。它可与现有 iroh-relay 部署在同一 ECS，但使用独立进程和 TLS 入口；不修改、不替换 iroh-relay。
2. joi 主进程是唯一 host，只建立出站 WSS。它使用保存在 Electron credential vault 中的独立中继令牌认证 `/host`，然后登记随机持久 `hostId`。
3. 绑定由桌面生成十分钟、一次有效票据。二维码 URL 的敏感字段全部位于 fragment；网关和反向代理不接收 fragment。浏览器绑定成功后移除 fragment，并在本 Origin localStorage 保存可撤销的设备凭据。
4. 浏览器和主机以设备密钥完成 HMAC-SHA-256 双向证明，以 HKDF-SHA-256 和双方随机数派生每连接 AES-256-GCM 密钥。业务帧以 `connectionId + sequence` 作为 AAD，严格递增序号拒绝重放。
5. 网关仅在内存维护 `hostId -> socket` 与 `connectionId -> socket`，只转发有界 JSON 包装和不透明帧；不持久化、不解析业务命令、不记录标识或内容。
6. 主机解密后的 application 边界只有两条命令：`feed.get` 读取既有安全首页 DTO，`message.send` 携带浏览器生成的稳定 idempotency key 提交既有 joi inbox。未知命令 fail closed。
7. 远程 React 入口通过 `/remote/` 加载，只显示任务卡、需要用户处理的摘要、连接状态和文字 composer。它不导入 Node/Electron，不取得桌面会话、LAN Cookie、CSRF、中继主机令牌或任何管理 API 权限。
8. 设备密钥由主机使用 safeStorage 加密保存并可逐个撤销。中继令牌、设备密钥、票据、正文和业务密文不得进入 HTTP DTO、诊断或日志。

## Consequences

- 手机浏览器可直接扫码，无需安装 App；主机不需要公网入站端口或 NAT 穿透。
- 中继被动失陷可观察流量时间与大小并可拒绝服务，但不能解密业务内容或伪造主机证明。流量分析和已经接管浏览器配置文件/主机 OS 的攻击不在本方案防御范围内。
- 远程功能不是远程桌面，也不是完整管理面；任何新增命令都必须单独更新 allowlist、威胁模型、AC-57 和契约测试。
- 运维需要一个额外 Node 服务和 HTTPS/WSS 入口。现有 iroh-relay 继续占用原端口；推荐用独立域名的 8443 TLS 入口，或在经验证的 SNI 反向代理迁移后共享 443。
- 首次公网发布仍需在真实 ECS 上完成 DNS、证书、systemd、反向代理、手机扫码和撤销验收；仓库内自动化不能替代该门禁。
