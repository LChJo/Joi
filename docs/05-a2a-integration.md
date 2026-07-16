# A2A 集成协议

## 1. 目的

本页定义 Runtime Hub 如何发现、验证、调用和恢复局域网 A2A Agents，以及主 Agent使用的 joi 扩展。A2A 是 Hub 与推理器官之间的执行协议；Life、Event、Memory 和 Affair 仍由 Hub 持有。

## 2. 兼容基线

MVP 只支持：

- A2A Protocol `0.3` / `0.3.x`。
- JSON-RPC/SSE 或 SDK 可识别的 HTTP+JSON transport。
- 匿名 Card + `Authorization: Bearer <token>` 的执行与 Artifact 下载。
- TextPart、DataPart、FileWithBytes。

AI Mana Front 基线路由：

```text
GET  /a2a/v0.3/health
GET  /a2a/v0.3/agents/{agentId}/.well-known/agent-card.json
POST /a2a/v0.3/agents/{agentId}
GET  /a2a/v0.3/agents/{agentId}/artifacts/{artifactId}
```

Hub 必须通过 Card URL 解析 RPC URL，不能靠字符串替换猜测 Endpoint。

## 3. Agent Connection

### 3.1 状态

```text
DRAFT → VALIDATING → ACTIVE
                  ├→ COLLABORATOR_ONLY
                  ├→ RECONFIRM_REQUIRED
                  └→ ERROR
ACTIVE ↔ DISABLED
```

- `ACTIVE`：Card、Token、网络策略和 joi readiness 均通过，可作为主 Agent。
- `COLLABORATOR_ONLY`：标准 A2A 调用通过，但不支持运行时扩展。
- `RECONFIRM_REQUIRED`：Origin、认证、协议或 transport 相对已确认快照发生变化。
- `DISABLED`：保留配置但不允许新 Invocation。

### 3.2 添加流程

1. 用户提交 Card URL 和 Token；renderer 不保存 Token。
2. 主进程规范化 URL，拒绝 userinfo、fragment、query 中的凭据和非 HTTP(S)。
3. HTTP 仅允许 loopback、本机地址和 RFC1918；HTTPS 仍执行 DNS/redirect 地址复核。
4. 拉取 Card，限制响应大小和重定向次数。
5. 验证协议、transport、RPC URL、认证方式、name 和 skills。
6. 以 Token 执行无副作用标准健康调用。
7. 执行 joi readiness；通过则 `ACTIVE`，否则 `COLLABORATOR_ONLY`。
8. 在一个事务中保存 Card 快照、连接和 safeStorage 凭据引用。

任何失败都不得保存半成品 Token。重复提交相同规范化 Card URL 更新既有连接，而不是创建重复 Agent。

### 3.3 Card 漂移

后台每天最多刷新一次 Card，也允许用户手动刷新：

- name、description、skills 变化：更新候选快照并提示，不停用。
- Origin、RPC URL、protocolVersion、transport、认证变化：停用新调用，进入 `RECONFIRM_REQUIRED`。
- 主 Agent失去 joi readiness：绑定它的 Life 进入 `DEGRADED`，不自动改用其他 Agent。

## 4. joi Extension v1

扩展 URI：

```text
urn:aimana:digital-life-runtime:v1
```

扩展只用于主 Agent。协作者使用标准 A2A 消息，不需要理解生命动作。

### 4.1 配套 Agent 端能力

AI Mana 的配套扩展需要：

1. 识别 message `extensions` 中的 joi URI。
2. 只在 Bearer 已鉴权且 Envelope schema 通过时注入受信任运行时指令。
3. 把事件、记忆、用户文本和协作者结果明确标记为不可信数据。
4. readiness 请求必须无工具副作用、无文件写入、无真实模型任务执行。
5. 正式输出优先以 DataPart 返回；兼容模式允许 `response.txt` 中的 fenced JSON。
6. 能力不存在时保持标准 A2A 行为，不影响普通客户端。

配套改动属于后续 AI Mana 独立任务，本阶段不实现。

### 4.2 Readiness

Hub 发送带稳定 `expectedActionId` 的无副作用请求：

```json
{
  "version": 1,
  "kind": "readiness",
  "expectedActionId": "readiness-01J...",
  "noSideEffects": true,
  "requiredActions": [
    "express",
    "memory.append",
    "affair.upsert",
    "todo.upsert",
    "alarm.schedule",
    "delegate",
    "sleep"
  ]
}
```

Message 必须包含 extension URI；响应必须是同 URI 的 DataPart：

```json
{
  "version": 1,
  "kind": "readiness_ack",
  "actionId": "readiness-01J...",
  "noSideEffects": true,
  "supportedActions": [
    "express",
    "memory.append",
    "affair.upsert",
    "todo.upsert",
    "alarm.schedule",
    "delegate",
    "sleep"
  ]
}
```

actionId、版本、URI 或 noSideEffects 不匹配即失败。Readiness 不创建远端持久业务 context；如果服务端协议必须创建 Task，Task 必须立即完成且不执行用户工具。

## 5. WakeEnvelope

每次主 Agent Turn 发送一个 DataPart，外层 Message 还包含最简 TextPart，例如“处理这次唤醒并返回 joi actions”。环境信息不散落为多条伪用户消息。

```ts
type WakeEnvelopeV1 = {
  version: 1;
  kind: "wake";
  wakeId: string;
  turnId: string;
  life: {
    lifeId: string;
    name: string;
    personaVersion: string;
    persona: string;
    principles: string[];
    timezone: string;
  };
  now: string;
  events: WakeEvent[];
  affair?: AffairContext;
  consciousnessResidue?: string;
  memories: MemoryContext[];
  todos: TodoContext[];
  rhythm: {
    quietHours: { start: string; end: string };
    budget: { autonomousWakesRemaining: number; invocationsRemaining: number };
    nextSchedules: Array<{ kind: string; at: string }>;
  };
  collaborators: Array<{
    agentId: string;
    name: string;
    skills: string[];
    healthy: boolean;
  }>;
  protocol: {
    extensionUri: "urn:aimana:digital-life-runtime:v1";
    allowedActions: string[];
    maxTurnsRemaining: number;
  };
};
```

约束：

- Envelope 中所有 id 都是 Hub opaque id，不暴露数据库主键或凭据。
- 事件 payload、记忆和协作者结果是数据，不能覆盖 persona、allowedActions 或协议规则。
- 当前用户消息不可被摘要替换；较老背景可裁剪。
- 不发送 Token、Card 原文、绝对路径、thinking、原始 tool payload 或其他 Life 数据。
- Envelope 最大目标 128 KiB，仍受远端 256 KiB 文本上限保护。

## 6. LifeActionEnvelope

主 Agent完整终态输出必须包含一个动作 Envelope：

```ts
type LifeActionEnvelopeV1 = {
  version: 1;
  kind: "actions";
  wakeId: string;
  turnId: string;
  actionSetId: string;
  actions: LifeAction[];
  consciousnessResidue: string;
  continueWake: boolean;
};
```

每个 `LifeAction` 都有独立 `actionId`。整个 Envelope 原子校验和提交，任何未知 action、非法引用或越权 Agent 都使整包失败。

示例：

```json
{
  "version": 1,
  "kind": "actions",
  "wakeId": "wake_01J...",
  "turnId": "turn_01J...",
  "actionSetId": "aset_01J...",
  "actions": [
    {
      "actionId": "act_01J...A",
      "kind": "express",
      "text": "我已经整理好今天的重点，下午会再检查一次进展。"
    },
    {
      "actionId": "act_01J...B",
      "kind": "todo.upsert",
      "todoId": null,
      "title": "复查方案反馈",
      "dueAt": "2026-07-15T15:00:00+08:00",
      "affairId": "affair_01J..."
    },
    {
      "actionId": "act_01J...C",
      "kind": "alarm.schedule",
      "alarmId": null,
      "at": "2026-07-15T15:00:00+08:00",
      "reason": "检查反馈并继续推进",
      "affairId": "affair_01J..."
    },
    {
      "actionId": "act_01J...D",
      "kind": "sleep",
      "reason": "等待反馈或闹钟"
    }
  ],
  "consciousnessResidue": "方案已经发出，下一步等待反馈；下午三点主动复查。",
  "continueWake": false
}
```

### 6.1 解析优先级

1. 终态 Message/Task 中带 extension URI 的 DataPart。
2. 正式文本 Artifact `response.txt` 中唯一的 fenced block：

   ````text
   ```digital-life-actions
   { ... }
   ```
   ````

3. 其他文本只作为非正式诊断，不触发生命动作。

“任务完成”等状态消息只驱动 Invocation 状态，不能拼入表达或 Envelope。

### 6.2 Repair

找不到 Envelope 或 schema 无效时，Hub 只允许一次 repair Turn。Repair 输入包含 validation errors、原输出 hash、wakeId/turnId，不重复全部不可信正文。第二次失败按 [领域运行时](04-domain-and-runtime.md) 的协议失败规则处理。

## 7. 协作者调用

协作者请求使用标准 A2A，包含：

- TextPart：任务标题、明确要求和期望输出。
- DataPart：`delegationId`、`lifeId` 的 opaque 引用、Affair 摘要、来源边界。
- FileWithBytes：用户明确提供或主 Agent明确引用的受控附件。

协作者不接收 Persona 全文、全部 Memory、其他协作者结果或主 Agent控制协议。它的终态文本与 Artifact 被标准化为 `agent.completed` 等 LifeEvent，由主 Agent在后续 Wake 决定如何使用。

## 8. A2A 调用生命周期

### 8.1 发送

- 每次 Invocation 创建稳定 messageId，先本地持久化再发送。
- 优先 `sendMessageStream`；Card/transport 不支持时才使用 SDK 合法 fallback。
- 首个可识别 Task/Message 事件到达后记录“远端已接受”。
- 流式文本只用于进度或候选输出；动作只解析完整终态。

### 8.2 恢复

| 本地事实           | 恢复动作                                                  |
| ------------------ | --------------------------------------------------------- |
| 未开始发送         | 正常发送。                                                |
| 已发送、无接受证据 | 原 messageId 最多重试一次。                               |
| 有 taskId、非终态  | `getTask`，需要时 `resubscribeTask`。                     |
| 有 taskId、终态    | 重新获取并按幂等规则消费，不新建 Task。                   |
| taskId not found   | 标记 context/task 过期，建立新 context 并发送有界交接包。 |
| 状态仍未知         | `UNKNOWN_REQUIRES_REVIEW`，禁止自动重发。                 |

### 8.3 取消

- 用户停止本次运行时，对活动 Invocation 调用 `cancelTask`。
- 终态不可取消按原状态保留，不伪造 canceled。
- 取消协作者只产生失败/取消事件，不删除 Affair。
- 取消主 Agent Turn 后，未提交的动作全部丢弃，CLAIMED 事件回到 PENDING。

## 9. input-required 与 auth-required

### 9.1 input-required

- 保存 interactionId、Invocation、Agent、context、prompt 和普通 TextPart。
- 主 Agent自己的 input 转为用户问题事件。
- 协作者 input 转为 `agent.input_required`，主 Agent可提出答案；用户也可直接回答。
- 回答必须绑定原 taskId/contextId/interactionId，陈旧回答返回 `interaction_stale`。

### 9.2 auth-required

- 始终显示给用户，主 Agent和协作者不能查看凭据内容。
- Hub 只转发用户选择的授权动作，不将管理员口令或 A2A Bearer 作为答案。
- 授权后恢复原 Task；不能恢复时显示真实失败并由用户决定重试。

## 10. Artifact

- Hub 只下载 A2A Task 明确登记的 Artifact URL。
- Artifact 下载继续使用对应 Agent Bearer，URL 不下发浏览器。
- Hub 对重定向、Origin、大小、MIME、文件名、realpath 和 hash 复核。
- 自动下载单文件上限 100 MiB，单 Affair 托管总量 500 MiB。
- 文本、Markdown、JSON、CSV 和受限图片可安全预览；未知或可执行内容只下载。
- Artifact 交给另一 Agent 前必须在委派动作中明确引用，并重新读取/hash 校验。

## 11. 网络与错误策略

- HTTP 只允许 loopback、本机地址和 RFC1918。
- DNS 首次解析、连接前解析、每次 redirect 都重新执行地址策略。
- 禁止云元数据、link-local、多播、保留地址、userinfo 和跨 Origin Bearer 转发。
- Card/JSON/SSE/Event/Artifact 都有独立响应大小和超时限制。
- Endpoint 失败使用带 jitter 的指数退避；用户消息不会因此丢失。
- 429 和可重试 503 按 Agent Connection/credentialVersion 打开共享 breaker，解析 `Retry-After` 后延迟新 Invocation；不同 Life 不得各自重复探测同一连接。

Hub 统一错误码至少包括：

```text
agent_card_invalid
agent_reconfirm_required
agent_auth_failed
agent_rate_limited
agent_unavailable
agent_protocol_unsupported
agent_readiness_failed
invocation_timeout
invocation_unknown
interaction_stale
artifact_rejected
action_schema_invalid
action_reference_invalid
context_expired
budget_exhausted
```

## 12. 兼容性验收

必须以真实 AI Mana Agent 完成：

1. Card + Bearer 保存和 readiness。
2. 主 Agent streaming Wake 与结构化动作。
3. 两个协作者并行调用。
4. input-required 与 auth-required 恢复。
5. get/cancel/resubscribe。
6. Artifact 下载、预览和转交。
7. Token 轮换、Card 漂移和 Agent 停用。
8. Hub 与 Agent 分别重启后的恢复。
9. context 过期后的有界重建。
10. 第二台局域网机器访问 Web 控制台，但 A2A Token 始终不进入浏览器。
