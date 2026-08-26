# 浏览器远程中继部署

本页部署 ADR 0012 的 JOI 浏览器网关。它与 Codux 的 `iroh-relay` 是两个服务：保留现有 `cudex.joilab.top`、TCP 443/80 和 UDP 7824，不把浏览器 WebSocket 接到 iroh 端口。

## 1. 推荐拓扑

首个非破坏性部署使用同一 ECS 的独立域名和 TLS 端口：

```text
手机浏览器 ── HTTPS/WSS ── remote.joilab.top:8443 ── nginx/Caddy ── 127.0.0.1:8787 joi-remote-relay
桌面 joi   ── WSS ──────── remote.joilab.top:8443 ───────┘

Codux 原生客户端 ── HTTPS/QUIC ── cudex.joilab.top:443/7824 ── iroh-relay（保持不变）
```

为 `remote.joilab.top` 增加指向现有 ECS 公网 IP 的 A 记录，并在安全组仅新增 TCP 8443。证书应使用 DNS-01 或已有可导出的通配符 PEM 签发，避免抢占 iroh-relay 使用的 80/443；不要假设 iroh 的 ACME 缓存可以直接作为 nginx PEM 使用。

若未来要共享 443，应先在维护窗口引入支持 SNI 的统一入口并把 iroh 与 JOI 都迁到明确的后端端口，完成 QUIC/ALPN 回归后再切换。本次不采用该高影响方案。

## 2. 构建发布包

在开发机执行：

```powershell
npm ci
npm run remote:relay:package
```

产物位于 `release-joi-remote-relay/`，包含编译后的网关、远程 React 静态资源和最小 `package.json`。上传后在服务器目录执行 `npm install --omit=dev`。服务器 Node 必须满足仓库 `engines`。

## 3. 服务配置

生成一个与 Codux iroh token 不同的高熵令牌，例如 `openssl rand -base64 48`。只把值写入服务器 `/etc/joi-remote-relay.env`（root:root，0600）和桌面 joi 设置，不提交仓库或命令历史。

环境文件字段：

```text
JOI_RELAY_HOST_TOKEN=<独立高熵令牌>
JOI_RELAY_BIND_ADDRESS=127.0.0.1
JOI_RELAY_PORT=8787
JOI_RELAY_STATIC_DIRECTORY=/opt/joi-remote-relay/dist/renderer
```

systemd 单元示例：

```ini
[Unit]
Description=JOI browser remote relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=joi-relay
Group=joi-relay
WorkingDirectory=/opt/joi-remote-relay
EnvironmentFile=/etc/joi-remote-relay.env
ExecStart=/usr/bin/node dist/remote-relay/relay/index.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/opt/joi-remote-relay

[Install]
WantedBy=multi-user.target
```

nginx 8443 入口示例（证书路径按实际 CA 调整）：

```nginx
server {
    listen 8443 ssl;
    server_name remote.joilab.top;
    ssl_certificate /etc/letsencrypt/live/remote.joilab.top/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/remote.joilab.top/privkey.pem;

    access_log off;
    client_max_body_size 128k;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 75s;
    }
}
```

## 4. 桌面接入

在 joi 桌面设置的“远程访问”中填写：

- 中继地址：`https://remote.joilab.top:8443`
- 中继令牌：服务器 `JOI_RELAY_HOST_TOKEN` 的值
- 启用远程访问

状态变为“已连接”后生成二维码并用手机浏览器扫码。二维码十分钟内只可成功绑定一次；绑定后可在桌面设备列表撤销。

## 5. 发布验收与回滚

发布前后依次验证：

1. `curl https://remote.joilab.top:8443/health` 只返回固定 `{"status":"ok"}`。
2. 不带或带错误 Bearer 的 `/host` WebSocket 被拒绝；普通 `/connect` 在主机离线时不泄露配置。
3. 手机扫码能看到任务卡并发送文字，刷新可恢复；旧二维码第二次绑定失败；桌面撤销后连接关闭且不能恢复。
4. nginx、systemd journal、浏览器 Network URL 和桌面状态响应中不存在中继令牌、fragment 密钥、文字正文、Cookie 或 CSRF。
5. Codux 的 iroh HTTPS/QUIC 健康和既有远程功能保持正常。

回滚只停止并禁用 `joi-remote-relay`、移除 8443 入口/安全组规则；桌面关闭远程访问。不要停止或修改 iroh-relay。轮换中继令牌后，需要在所有 joi 主机重新输入新令牌。

## 6. 当前外部门禁

2026-08-26 当前 Codux 环境没有保存的 SSH profile，因而尚未在 ECS 执行上述部署、证书和手机验收。代码与发布包可本地验证，但不能把真实公网部署标为完成。
