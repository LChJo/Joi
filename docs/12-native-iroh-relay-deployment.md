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

## 当前部署与回滚

2026-08-27 已在 `121.40.20.202` 部署上述配置：双域名 TLS、两次 relay-only 数据交换和 Nginx 校验均通过。服务器保留以下回滚副本：

- `/etc/iroh-relay/config.toml.bak-20260827-2055`
- `/etc/nginx/stream.conf.bak-20260827-2055`

回滚必须同时恢复两份文件，执行 `nginx -t`，然后 reload Nginx 并 restart iroh。旧浏览器回退仍位于 `remote.joilab.top:8443`，在 Android 真机门禁完成前不要删除。
