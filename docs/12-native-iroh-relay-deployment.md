# Joi 原生 iroh 中继部署

本页是 ADR 0013 的正式 ECS 运维基线。默认客户端连接 `https://remote.joilab.top`；`https://cudex.joilab.top` 保留给既有 Codux 客户端和兼容回归。两个域名指向同一 ECS、同一 iroh relay，不经过 Cloudflare、DCDN 或 Node WebSocket 网关。

## 端口与分流

```text
TCP 80                 -> iroh-relay ACME / captive portal
TCP 443 + remote SNI   -> Nginx stream -> 127.0.0.1:9443 iroh-relay
TCP 443 + cudex SNI    -> Nginx stream -> 127.0.0.1:9443 iroh-relay
TCP 8443               -> 旧浏览器 relay（仅真机迁移门禁前回退）
127.0.0.1:9090         -> iroh metrics，不对公网开放
```

安全组只需要继续允许公网 TCP 80/443；8443 仅在旧浏览器回退保留期间开放。Joi 桌面不需要入站端口。

## iroh 配置

`/etc/iroh-relay/config.toml`：

```toml
http_bind_addr = "0.0.0.0:80"
metrics_bind_addr = "127.0.0.1:9090"
access = "everyone"

[limits]
accept_conn_limit = 40.0
accept_conn_burst = 80

[limits.client.rx]
bytes_per_second = 524288
max_burst_bytes = 2097152

[tls]
https_bind_addr = "127.0.0.1:9443"
hostname = ["cudex.joilab.top", "remote.joilab.top"]
cert_mode = "LetsEncrypt"
contact = "运维联系邮箱"
cert_dir = "/var/lib/iroh-relay/certs"
```

默认 App 不携带服务器共享令牌，所以 relay 使用 iroh 的公开接入模式。应用层仍有独立设备证明和 AES-GCM；relay 只能转发加密流量。速率限制用于控制公开服务资源消耗，指标端口必须保持 loopback。

## Nginx SNI 配置

`/etc/nginx/stream.conf`：

```nginx
stream {
    map $ssl_preread_server_name $joi_tls_backend {
        remote.joilab.top 127.0.0.1:9443;
        default 127.0.0.1:9443;
    }

    server {
        listen 0.0.0.0:443;
        proxy_pass $joi_tls_backend;
        ssl_preread on;
        proxy_connect_timeout 5s;
        proxy_timeout 1h;
    }
}
```

Nginx 只做 TCP/SNI 转发，TLS 在 iroh 终止。iroh 负责双域名 ACME 证书和续期；不要把 ACME 私钥或缓存复制进仓库。

## 发布与验证

替换前分别备份两个配置文件。先执行 `nginx -t`，再 reload Nginx、restart iroh；任一步失败立即恢复两份备份并重启原服务。

```text
systemctl is-active iroh-relay
systemctl is-active nginx
nginx -t
ss -lntup | grep -E ':(80|443|9443)\b'
```

TLS 验证必须确认同一证书的 SAN 同时包含两个域名。HTTP 200 只证明入口服务存在，不能替代数据面验证。仓库提供一个默认忽略的 relay-only 测试，它禁用全部 IP 直连，并让两个 iroh endpoint 经中继交换双向字节：

```text
JOI_RELAY_SMOKE_URL=https://remote.joilab.top cargo test --manifest-path native/joi-remote/Cargo.toml --test deployed_relay -- --ignored --nocapture
JOI_RELAY_SMOKE_URL=https://cudex.joilab.top cargo test --manifest-path native/joi-remote/Cargo.toml --test deployed_relay -- --ignored --nocapture
```

两条命令都通过，才表示 Joi 默认中继可用且 Codux 兼容入口未被破坏。

## 手机持续重连：两端诊断（remote-diag-3）

1. 重新构建并安装两端（APK 必须重建 Rust 动态库，不能只更新 Dart）。手机点击“连接诊断”应看到 `remote-diag-3`，记录包含 `nativeDiagnosticsV3`；前者确认 Dart、后者确认 Rust 连接策略版本。
2. 桌面打开“设置 → 手机连接 → 连接诊断”，保持页面打开，重新生成二维码，用手机扫码一次，等待一次失败后立即在手机点击“复制诊断”。不要分享二维码或连接码。
3. 对照两端的时间：手机 `endpointDial + nativeConnectTimeout/connectFailed` 且桌面没有 `quicAccepted`，优先检查实际网络、端点地址与中继；有 `quicAccepted` 但无 `helloAccepted` 则检查传输流；有 `handshakeReceived` 后出现 `pairingUnavailable/deviceUnavailable/proofInvalid`，则检查配对/恢复与证明；`handshakeReady` 后手机 `hostProofInvalid/credentialWriteFailed`，则聚焦手机验证/安全存储；`firstCommandReceived` 后失败再检查业务协议。
4. `androidContextMissing` 表示开始连接时尚未安装 Android 原生网络上下文，需要检查 Android 初始化；它不是公网不可达的证明。`transportReady` 仅表示桌面传输已启动，不表示手机在线。
5. 桌面记录写入用户数据目录的 `diagnostics/joi-flow.jsonl`（沿用 2 MiB × 3 文件轮转），事件名 `joi.remote.connection`。只提取该事件的 `at/code/sequence`；不要上传完整用户数据目录、remote-access.json 或其他业务日志。

手机只保留本次进程最近 40 条阶段记录及最近失败，重启后清空；桌面设置显示当前运行最近 50 条，历史在轮转日志。记录只有时间、阶段、计数、固定错误码，未知错误不输出原文。先留证据再重启；这些信息用于缩小故障范围，不能仅凭“重连中”断定根因。

第二版桌面在等待入站握手前记录 `quicIncoming`，`quicFailed` 或 `streamFailed` 后紧跟类型化原因：`quicTimedOut`（底层超时）、`quicReset`、`quicLocallyClosed`、`quicPeerApplicationClosed`、`quicPeerTransportClosed`、`quicVersionMismatch`、`quicTransportError`、`quicAuthenticationFailed`。TLS alert 分为 `quicTlsNoApplicationProtocol`、`quicTlsHandshakeFailure`、`quicTlsProtocolVersion`、`quicTlsCertificateRejected` 和其他 `quicTlsAlert`；无法识别为 `quicUnknownError`。TLS 类别可能来自本地或对端报告，不等于已查明具体故障设备；绝不输出对端 reason 或异常原文。

第三版控制端缓存一个 relay 配置对应的 Endpoint，pair/resume 与重连复用其网络身份；切换配置或全部重拨失败后淘汰缓存，现存连接不被其他连接关闭。首先直接拨号（6 秒），失败后在同一端点等待 relay online（最多 4 秒），随后重拨（6 秒、8 秒，两次重拨前均有最多 4 秒就绪等待）。这保留了中继离线时立即使用局域网的能力，最长拨号/就绪预算 28 秒；并非按同网段猜测可达性，也不强制所有连接走中继。

`endpointRetry` 表示同端点重拨，`endpointRelayWait` 表示等待中继，`relayReady/relayReadyTimeout` 区分等待结果；每次拨号失败记录类型化原因。`quicTimedOut` 也可表示本次有界拨号超时，不代表路由器已被定位为故障。Flutter 原生连接预算改为 45 秒，连接成功后另给应用握手 15 秒，首配总计两分钟保持不变。关闭 FFI 句柄会取消正在拨号的任务，不再等连接返回才消费 Close。

一次扫码后保持前台约 60 秒，复制手机诊断并保存电脑对应记录；并发尝试没有跨端关联 ID，不能只按行号一一配对。必须分别复验普通局域网 direct、蜂窝 relay、隔离访客 Wi-Fi relay。自动化中“首拨被挂起后重拨成功”和公网测试不能代替最后一项真机验收。

## 当前部署与回滚

2026-08-27 已在 `121.40.20.202` 部署上述配置：双域名 TLS、两次 relay-only 数据交换和 Nginx 校验均通过。服务器保留以下回滚副本：

- `/etc/iroh-relay/config.toml.bak-20260827-2055`
- `/etc/nginx/stream.conf.bak-20260827-2055`

回滚必须同时恢复两份文件，执行 `nginx -t`，然后 reload Nginx 并 restart iroh。旧浏览器回退仍位于 `remote.joilab.top:8443`，在 Android 真机门禁完成前不要删除。
