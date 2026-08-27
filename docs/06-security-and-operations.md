# 安全与运维

## 0. JOI-01 新信任边界

- Pi provider secret 只进入 Electron `safeStorage` 支持的 CredentialStore；SQLite 只保存 credential reference/version。renderer、HTTP/SSE、日志、诊断、备份、会话正文和安装包不得包含密钥。
- 唯一全局 joi 只获得工作台、Partner、Work、Memory、Schedule 与 User 工具；不注册任意 read/bash/edit/write/grep/find/ls。
- 通用模型源仅允许公网 HTTPS，以及明确的 localhost/127.0.0.1 本机服务；拒绝其他 private/LAN、link-local、metadata、URL 内嵌凭据和跨 origin redirect。
- URL 创建、DNS 解析、redirect 和实际连接阶段都重新校验目标，防止 DNS rebinding 与 SSRF；HTTP 仅对明确本机目标开放。
- 自动模型 fallback 只处理 timeout、连接失败、429 与 5xx；鉴权、余额、配置和安全/内容拒绝不得通过换源绕过。
- 所有外部副作用在 outbox 后执行并使用稳定 action id；跨 provider 恢复只能在安全 Turn 边界发生，不能重复本机命令、A2A message 或正式表达。

Life 相关规则继续保护旧事实，但安全检查的新主体使用 `workbenchId`、source revision 和 partner revision。

## 1. 安全定位

核心 MVP 是个人可信局域网产品，不是公网 SaaS。ADR 0013 增加一个用户主动启用的受限 Android 原生传输例外；它不暴露 LAN API，只承载首页任务卡读取与文字提交。安全目标是以最少操作防止同网段或中继侧的随意控制、Token 泄露、跨 Life 数据混用和重复执行，不引入企业级账号或审批系统。

已接受的风险：

- LAN Web 和 AI Mana A2A 默认使用明文 HTTP。
- 管理员口令、会话 Cookie 和 A2A Bearer 在可信局域网传输，不能抵御网段内主动窃听者。
- 产品不适合机场 Wi-Fi、访客网络、公共云主机或端口映射公网。

上述明文风险只适用于 LAN listener。Android 远程由 iroh 加密传输，并在 App 与 joi 主进程之间对业务帧再次执行 AES-256-GCM 端到端加密。

开启 LAN Listener 前必须展示一次风险说明；不同意仍可只使用桌面窗口。

## 2. 威胁边界

### 2.1 保护对象

- Agent Bearer Token 和 Token 关联信息。
- 管理员口令派生值与 Web 会话。
- 人格、消息、记忆、事务、Artifact 和活动记录。
- 生命运行权限、预算、Agent allowlist 和 action 完整性。
- A2A messageId/taskId/contextId 的恢复事实。

### 2.2 主要威胁

- 未登录的局域网设备操作生命。
- 恶意 Card URL、DNS rebinding、redirect 或跨 Origin Bearer 泄露。
- Agent 输出伪造生命动作、越权引用其他 Life/Agent/interaction。
- prompt/记忆/Artifact 中的数据覆盖受信任运行规则。
- 崩溃后盲目重发造成外部副作用重复。
- renderer、日志、诊断或备份泄露凭据和业务正文。
- symlink、路径穿越、危险 MIME 或超大 Artifact。

MVP 不承诺防御已经控制本机 OS 账户、读取进程内存或修改应用二进制的攻击者。

## 3. 管理员与会话

### 3.1 首次设置

- 只能从 Electron 桌面窗口设置第一个管理员口令。
- 最低 6 个字符，不要求复杂字符组合，避免额外规则。
- 使用 Node `crypto.scrypt`、每个安装独立随机 salt 和恒时比较。
- 数据库只保存算法版本、参数、salt 和派生值。
- 不提供邮箱找回；忘记口令只能在本机桌面重置并撤销全部 LAN 会话。

### 3.2 桌面会话

- preload 生成一次性、60 秒有效、仅 loopback 可兑换的 bootstrap nonce。
- renderer 使用 nonce 换取 HttpOnly 会话；nonce 不进入 URL、localStorage 或日志。
- LAN 请求不能使用桌面 bootstrap endpoint。

### 3.3 LAN 会话

- 登录成功设置 HttpOnly、SameSite=Strict Cookie。
- 会话空闲 24 小时过期，绝对有效期 7 天。
- 每次修改管理员口令撤销全部 LAN 会话。
- 登录失败按源 IP 与全局双维度限速：连续 10 次失败暂停 5 分钟。
- 所有写请求检查已确认 Origin 与每会话 CSRF token。
- UI 不保存口令，不提供“永久记住密码”。

### 3.4 Android 远程设备

- 桌面每次只维护一个待绑定票据；票据十分钟过期，首次成功握手即销毁，生成新票据使旧票据失效。
- 票据只编码进 `joi://pair` 二维码，不经过 HTTP、反向代理 access log 或 Referer；首次成功握手后立即失效。
- Android 将设备密钥保存在系统安全存储中以支持重启恢复。手机系统账户被接管不在保护范围内，用户可在桌面逐设备撤销。
- 桌面把 iroh 节点私钥和设备密钥通过 `safeStorage` 加密后保存；GET 状态只返回连接状态和设备安全元数据。
- 握手使用 HMAC-SHA-256 双向证明，HKDF-SHA-256 派生每连接会话密钥；业务帧使用 AES-256-GCM、连接 ID AAD 和严格递增序号拒绝重放。

## 4. Agent 凭据

- Bearer 在 renderer 提交后立即交给主进程；表单离开即清空。
- 使用 Electron `safeStorage` 加密，SQLite 只保存 blob、凭据 id、状态和更新时间。
- `safeStorage.isEncryptionAvailable()` 为 false 时禁止保存 Token，不做明文兜底。
- Token 不允许通过 GET、SSE、错误 details、诊断、备份或剪贴板再次读取。
- 轮换 Token 原子替换凭据；旧 Token 不保留可恢复副本。

脚本型 Partner Skill 使用宿主环境凭据时采用独立的默认拒绝边界。bash 子进程始终只继承维持命令正常工作的精确非敏感基线（例如 PATH、HOME/USERPROFILE、临时目录、locale、终端和 OS 信息），不使用通配符复制宿主环境。其他变量必须同时满足三项条件才会注入：值已被 Joi 进程继承、变量名被进程级 `JOI_PARTNER_ENV_PASSTHROUGH` 显式授权、当前精确选中的 Skill 在合法 frontmatter `metadata.joi_required_env` 中声明了该名称。进程级授权不是对所有 bash Partner 的全局暴露；未选中声明该变量的 Skill 时值保持不可见。非法声明在模型或工具启动前 fail closed。诊断、结果和日志只允许记录变量名与固定处理建议，不得记录值。新增或修改用户环境后必须完整重启 Joi，运行中的进程不会自动刷新环境快照。
- Card Origin/认证变化时不自动转发既有 Bearer。

## 5. 网络控制

### 5.1 Hub Listener

- loopback 固定绑定 `127.0.0.1`；IPv6 支持作为后续项。
- LAN 只允许用户选定的 RFC1918 IPv4，不监听 `0.0.0.0`。
- 默认端口 `43130`，冲突时显示错误，不静默换端口。
- MVP 不自动修改 Windows/macOS/Linux 防火墙。
- LAN Listener 失败、地址消失或端口占用不能停止 Runtime 内核。

### 5.2 A2A 出站

- URL 规范化、DNS 解析、每次 redirect 和最终连接地址都执行 network policy。
- HTTP 仅允许 loopback、本机和 RFC1918；禁止 link-local、云元数据、多播与保留地址。
- Bearer 只发送给用户确认的 scheme/host/port Origin。
- 禁止 userinfo、query/hash 凭据和忽略 TLS 证书错误的全局开关。
- 所有请求设置连接、首包、空闲和总时长上限。

### 5.3 Connection breaker

远端返回 429 或明确可重试的 503 时，Hub 按 `Card Origin + Agent Connection id + credentialVersion` 的不可逆 hash 打开共享 breaker：

- 同一连接被多个 Life 使用时共享冷却，防止每个 Life 继续撞击同一 Endpoint。
- 支持数字秒和 HTTP-date 两种 `Retry-After`；冷却夹在 10 秒至 1 小时。
- 已存在的较长冷却不能被后到的较短响应覆盖，到期自动关闭。
- breaker key 不包含明文 Bearer，也不把完整 Origin 写入诊断。
- breaker 只阻止新的远端 Invocation；用户消息、Agent 结果和闹钟仍正常持久化。
- 用户触发事件可以绕过“自主唤醒额度”，但不能绕过 Endpoint 容量或 breaker。

breaker 与每 Life 预算分别计数、分别展示。数据库不可用时 Runtime 已进入恢复模式，不通过额外远端调用“探测”恢复。

### 5.4 Android iroh 传输

- joi 和 Android 都使用 iroh endpoint；同网可打洞时直接传输，否则通过配置的标准 iroh relay。无需开放 Joi 本机 TCP 监听或公网管理 API。
- 默认 relay 是 `https://remote.joilab.top`，设置页可改为其他 HTTPS relay。默认服务不把共享 Bearer 打包进桌面或 APK；ECS 采用公开 relay 模式，并以连接速率、单客户端带宽和突发配额限制资源滥用。
- `remote.joilab.top` 与兼容保留的 `cudex.joilab.top` 共用 iroh 多域名证书和数据面。中继指标只监听 loopback，TLS 私钥、ACME 缓存和任何历史访问令牌不得进入仓库、诊断或部署输出。
- sidecar 只允许有界 NDJSON 控制帧，节点私钥只经 stdin 传入；不得在参数、日志或诊断中记录节点私钥、device id、二维码、正文或密文。
- iroh TLS 身份之后仍必须完成 Joi 应用层双向证明；中继不能伪造已绑定设备或解密业务帧。
- 主机侧命令 allowlist 固定为 `feed.get` 和 `message.send`。文字提交沿既有 inbox 和稳定 idempotency key；未知、超长或畸形命令立即断开。

## 6. 运行时授权

- Hub 只接受 schema 注册的 joi action。
- 每个 action 校验当前 wakeId、Life、Affair、Agent allowlist 和资源所有权。
- 整个 ActionEnvelope 原子校验；不得执行“合法的一半”。
- 协作者结果永远先成为事件，不能直接控制生命。
- auth-required 始终由用户解决；Hub 不把 Token、管理员口令或系统凭据交给 Agent。
- 不增加通用“每个动作都确认”的审批层；Agent 自身 permission 与 auth-required 是执行权限事实源。
- 全局紧急停止优先于调度，且必须能从托盘和桌面窗口触发。

## 7. 数据与文件

### 7.1 SQLite

- 启用 foreign keys、WAL 和 busy timeout。
- 数据库仅由主进程打开；renderer 与 LAN 请求不获得 SQL 能力。
- schema migration 在 Runtime 调度前完成，失败则进入只读恢复模式。
- 关键写入使用事务：事件 + outbox、动作 + 事件消费、凭据引用 + Agent 连接。
- Alarm 到期必须以 `(lifeId, alarmId, occurrenceAt)` 幂等地写入 event/outbox，成功后才标记 FIRED；锁冲突或投递失败保持 SCHEDULED 并退避重试。

MVP 不提供数据库正文加密。依赖 OS 账户和磁盘加密保护本地人格、消息与记忆；设置页应说明这一点。

### 7.2 Artifact

- 文件名消毒，禁止 `..`、绝对路径、设备名、symlink/junction 逃逸。
- 下载前后都验证 realpath、父目录、大小、MIME 和 hash。
- 不自动打开、执行或解压未知文件。
- Markdown 禁止 raw HTML、script、iframe；外部链接用系统浏览器打开。
- 临时预览副本有 TTL，过期后清理；原 Artifact 不被隐式删除。

## 8. 日志、SSE 与诊断

### 8.1 允许记录

- requestId、lifeId 的不可逆短 hash、wake/invocation/action id。
- 状态、耗时、重试次数、队列长度、错误码、版本和资源计数。
- Endpoint 的连接 id 与 Origin hash，不记录完整 URL/IP。
- breaker 打开/关闭时间、原因码和脱敏 connection hash。

### 8.2 禁止记录

- 管理员口令、CSRF token、Cookie、A2A Bearer。
- 人格、用户消息、生命表达、记忆正文、任务 prompt。
- thinking、原始 tool payload、完整 A2A message/task、文件正文和绝对路径。

诊断导出默认只含允许记录项。用户主动选择“包含内容样本”属于后续能力，MVP 不提供。

SSE 只发送 renderer DTO；不得复用数据库对象或 A2A SDK 原对象直接序列化。

## 9. 日常运行

### 9.1 启动

1. 取得 Electron 单实例锁。
2. 初始化安全日志与 crash marker。
3. 打开 SQLite、验证完整性、执行迁移。
4. 初始化 safeStorage 和凭据状态。
5. 用 in-process marker、持久 Turn `lastActivityAt` 和 startup grace 恢复 leases、outbox、Wakes、Invocations、interactions 和 scheduler。
6. 启动 loopback API；加载桌面窗口。
7. 尝试 LAN listener；失败只降级 LAN。
8. 恢复 A2A 远端状态后再启动新调度。

### 9.2 关闭

- 关闭窗口：隐藏到托盘，不停止 Runtime。
- 暂停全部：停止新 Wake，保留 Listener、阅读和设置功能。
- 显式退出：停止新调度，排空已提交本地事务，记录活动远端 Task，优雅关闭 Listener 与 SQLite。
- 强制更新重启：使用与显式退出相同的 Runtime drain 语义，再启动新版本恢复。

### 9.3 健康检查

本地诊断状态包括：

- database：open/migration/integrity/WAL。
- runtime：arbiter/outbox/scheduler/lease、Wake liveness 证据与 stale 数量。
- web：loopback/LAN/session/SSE。
- agents：Card/health/readiness/active invocations/breaker；不显示凭据原文。
- storage：数据库、Artifact、备份大小和可用磁盘。

健康状态不枚举消息内容、Token 或完整 Agent URL。

## 10. 备份与恢复

### 10.1 备份内容

- SQLite 一致性快照。
- 受控 Artifact 和附件。
- 版本 manifest、hash 和应用/schema 版本。
- 不包含可在其他机器解密的明文 Agent Token。

创建备份时使用 SQLite online backup API 或等价一致性机制，不直接复制活动 WAL 组合。备份先写临时目录，验证 hash 后原子发布。

### 10.2 恢复流程

1. 只允许在 Runtime 暂停且无活动本地事务时开始。
2. 检查 manifest、版本、hash 和磁盘空间。
3. 把当前数据移入 quarantine，不直接覆盖。
4. 恢复数据库/Artifact，运行 migration 与完整性检查。
5. 成功后保留一次可回滚 quarantine；失败立即回滚。
6. 撤销 Web 会话，Agent 连接进入 `TOKEN_REQUIRED`，由用户重新输入 Token。
7. 对备份中的非终态远端 Invocation 标为 `UNKNOWN_REQUIRES_REVIEW`，不自动重发。

## 11. 更新与迁移

- 更新前自动创建轻量数据库备份。
- migration 只前进，不在失败后半提交版本号。
- Renderer 与 API 版本不匹配时显示升级页，不继续写入。
- Agent 扩展版本按 capability 协商；Hub 新版本不得把未知 action 发给旧 Agent。
- 回滚应用前必须检查 schema 是否仍兼容；不兼容时要求从备份恢复。

## 12. 故障处理手册

| 故障                  | 自动行为                         | 用户操作                     |
| --------------------- | -------------------------------- | ---------------------------- |
| LAN 端口占用          | 停止 LAN listener，保留 loopback | 修改端口或释放占用后重试     |
| 数据库 migration 失败 | 进入只读恢复模式                 | 导出诊断、从备份恢复         |
| safeStorage 不可用    | 禁止 Agent 新调用                | 修复 OS 密钥存储后重试       |
| 主 Agent离线          | Life 保持 QUEUED，退避探测       | 检查 Agent、Token 或重新绑定 |
| Agent 返回 429/503    | 打开共享 breaker，保留事件       | 等待 Retry-After 或检查服务  |
| Card 发生敏感漂移     | 停止新调用                       | 查看变化并重新确认           |
| 远端 Task 状态未知    | 禁止自动重发                     | 查询 Agent 或选择人工重试    |
| action 连续三次无效   | Life 进入 DEGRADED               | 修复/升级主 Agent扩展        |
| 磁盘空间不足          | 停止 Artifact 下载和新 Wake      | 清理空间或导出后删除数据     |
| SSE 中断              | 客户端按 Last-Event-ID 重连      | 超出窗口时刷新快照           |

## 13. 最低运维门禁

- 每次发布必须通过 migration 前进/失败回滚、备份恢复和强更重启测试。
- Windows 与 macOS 必须验证托盘、开机启动、窗口关闭和显式退出语义。
- 至少一台第二局域网设备验证登录、SSE、消息、暂停和 interaction。
- 至少一个真实 AI Mana 主 Agent 与两个协作者完成端到端恢复场景。
- 安全测试必须覆盖 SSRF、Origin 漂移、Token 不出主进程、action 越权和 Artifact 路径逃逸。
- 可靠性测试必须覆盖多 Alarm 同时到期、event 投递失败、运行中插话崩溃和跨 Life 共享 breaker。
