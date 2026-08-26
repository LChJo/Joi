# 来源、事实基线与术语

## 0. JOI-01 术语优先级

本文件以唯一全局 joi、Pi、工作台、Partner 和 Work 为目标术语。后文既有 Life/Wake/主 Agent 术语只描述兼容存储和历史协议；发生冲突时，本节与 ADR 0002/0003 优先。

| 术语 | 目标定义 |
|------|----------|
| **唯一全局 joi** | 用户唯一入口、唯一 system policy 与唯一调度权威；通过 Pi 选择工作台、规划、派发、并发、等待和改派。 |
| **Pi** | joi 的唯一主推理基座；SDK 只由 infrastructure adapter 使用，不直接拥有数据库、shell 或任意文件工具。 |
| **工作台（Workbench）** | 一个人格/工程领域的持久上下文投影；其 workspace binding 是该工作台的 cwd 权威，多个工作台可共享同一物理目录，路径由基础设施私有映射保存。 |
| **Partner / 搭档** | 全局、版本化的执行能力模板，只保存引擎、模型、提示词、技能、工具和知识库，不拥有 cwd。 |
| **PartnerInstance** | 绑定恰好一个 `workbenchId` 的搭档运行会话；默认临时，续话可常驻，但永不跨工作台复用。 |
| **Work** | 绑定恰好一个 `workbenchId` 的工作项，可形成 DAG；`NONE` 无文件权限，`READ/WRITE` 自动使用该工作台工作区和 lease。 |
| **WorkResult** | 不可变、工作台范围内 的运行结果事实；正文受限存储，通知与管理 DTO 只携带有界摘要和元数据。 |
| **Model Source** | Pi 的版本化模型连接；每个 Turn 固定 source/model revision，一个主源加用户排序备用源。 |
| **目标地图 / harness** | goal 的持久化推进索引（ADR 0010）：destination（最终目标）、path（每层路径，只引用 work）、decision（Decisions-so-far）、fog（待晋升的雾区）；经遍历与复盘推进，不是第二条调度链。 |
| **harness review** | 一层结果走完后投入 inbox 的复盘系统输入；由 joi 推理 turn 经唯一串行槽位决定下一层路径、记录决策或 `MAP_CLEARED`。 |

工作台不是 Agent，不保存执行状态机，也不产生独立 scheduler。唯一 joi 选择工作台、创建 Work 并派发 PartnerInstance。产品文案统一使用“工作台”；代码、API、DTO、事件和工具使用 `Workbench/workbenchId/workbench.*`。`Life/lifeId/life.*` 仅允许存在于旧表、迁移、旧只读 API mapper 和历史 fixture。

## 1. 文档目的

本页记录 joi 文档包依赖的来源、已经验证的 A2A 能力和统一术语。后续产品、架构、协议和验收文档都以本页为词义事实源。

## 2. 来源

### 2.1 产品理念来源

外部原始材料 `README (1).md`（未纳入仓库）描述了 joi 的基本立论：

- 超长期任务的核心障碍是回合制与缺乏中断/恢复机制，而不只是上下文窗口。
- 生命主体是整个运行时；LLM 是推理与语言器官，不是全部主体。
- 人类消息、作息、闹钟、精力和待办应当作为平等事件进入仲裁系统。
- 主体连续性来自持久记忆、意识残留、待办和自我唤醒，而不是一段永不结束的模型上下文。
- 多 Agent 协作应以稳定角色、持续记忆和产出物交接为基础，而不是一次性 SubAgent 调用。

本项目继承这些工程目标，但不对“意识”或“生命”的哲学命题作技术证明。产品文档中的“生命”是指具有持久身份、事件驱动、自主唤醒和跨会话连续性的数字运行实例。

### 2.2 A2A 实现来源

兼容基线来自 AI Mana Front：

| 项目         | 基线                                       |
| ------------ | ------------------------------------------ |
| 仓库分支     | `featur/agents_a2a`                        |
| 提交         | `b93e2330bb6c9e88323255f41fe509b4da3a9f6b` |
| 应用版本     | `1.5.0`                                    |
| A2A Protocol | `0.3`                                      |
| SDK          | `@a2a-js/sdk@0.3.14`                       |

已经从规格与实现核实的服务能力：

- 通过 Agent Card 描述 Agent、skills、transport 与 streaming 能力。
- 使用 A2A JSON-RPC/SSE 发送消息和接收状态、文本与 Artifact。
- 支持 TextPart、DataPart 和内联 FileWithBytes。
- 支持 Bearer Token、独立 Agent context、Task、messageId 幂等、取消、查询和续订。
- 支持 `input-required`、`auth-required`、受保护 Artifact 下载和进程重启后的明确失败/恢复语义。
- AI Mana 的 LAN Server 默认使用端口 `43120`，仅绑定用户选择的 RFC1918 地址。

已经确认的兼容差距：

- 当前 AI Mana 只把既有 Workspace 编排扩展识别为受信任系统指令。
- 普通 DataPart 会被序列化进 Agent prompt，但不会自动获得 joi 运行时语义。
- 同一 A2A context 的新任务采用 FIFO；运行中事件默认不能无损注入正在进行的模型回合。
- Token/usage 上报不是标准保证，Hub 不能只依赖 token 数量实施预算。

因此，完整自治的主 Agent 需要配套的 `urn:aimana:digital-life-runtime:v1` 扩展；普通 A2A Agent 仍可作为协作者。

### 2.3 独立后端参考来源

另行审阅了 `LChJo/digital-life` 的本地调研副本。它是完全不同的 Python 3.11 项目，不是本项目的前身，也不是 A2A 兼容基线：

| 项目     | 快照                                                        |
| -------- | ----------------------------------------------------------- |
| 上游     | `git@github.com:LChJo/digital-life.git`                     |
| 分支     | `main`                                                      |
| 提交     | `8afe89bbfb8d5d510974d7dd53c72817c2e20052`                  |
| 版本     | `0.1.0`                                                     |
| 技术栈   | Python、SQLite、直接 LLM Runtime、飞书/微信、Vue 员工控制台 |
| 许可证   | Apache License 2.0，Copyright 2026 zhp                      |
| 调研日期 | 2026-07-15                                                  |

该仓库只作为运行时可靠性案例。值得吸收的是事件持久化、运行中插话、唤醒存活判定、审计、熔断和实例隔离等经过源码或回归测试说明的设计；其直接模型调用、Python 进程模型、渠道接入、Vue UI 和文件式人格/记忆不进入本项目技术基线。

调研以当前提交的源码和测试为准，而不是把该仓库设计文档当作无条件事实源。审阅时发现其 `AGENTS.md`/`CLAUDE.md` 指向的部分架构文档已经缺失，测试也明确记录了多闹钟写锁限制；这说明整模块复制会把既有耦合与缺陷一起带入。详细采用矩阵、指定源码路径和许可证处理见[参考后端调研与吸收清单](08-reference-backend-assessment.md)。

## 3. 术语

| 术语                                 | 定义                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------- |
| **Runtime Hub / Hub**                | 常驻桌面主进程。持有生命状态、事件、记忆、调度、A2A Client 和 Web 服务。  |
| **joi / Life**              | 一份独立的身份、人格、记忆、事件队列、事务、作息与 Agent 绑定。           |
| **Primary Agent / 主 Agent**         | 数字生命的主要推理器官。解释事件并返回结构化生命动作。                    |
| **Collaborator / 协作者**            | 按能力承接委派的 A2A Agent，不直接修改生命状态。                          |
| **Agent Connection**                 | Hub 保存的 Agent Card、Endpoint、凭据引用、能力快照和健康状态。           |
| **Event / 事件**                     | 对生命有意义的持久刺激，例如消息、闹钟、待办到期或 Agent 结果。           |
| **Wake / 唤醒**                      | Hub 选择事件批次、组装上下文并调用主 Agent 的一次运行周期。               |
| **Wake Turn**                        | 一次具体 A2A 主 Agent 调用。一个 Wake 可包含有限个连续 Turn。             |
| **Affair / 事务**                    | 跨多个 Wake 推进的工作主线，可等待输入、Agent 结果或未来时间。            |
| **Todo / 待办**                      | 事务中的可执行承诺，具有状态、截止时间和负责人。                          |
| **Alarm / 闹钟**                     | 由用户或主 Agent 创建、在未来生成事件的持久计划。                         |
| **Schedule / 作息**                  | 周期性生成计划、复盘、记忆整理等事件的规则。                              |
| **Consciousness Residue / 意识残留** | 上一个 Wake 留给下一个 Wake 的简短当前关注、未决问题和下一步。            |
| **Episodic Memory / 情景记忆**       | 与时间、事件和事务关联的经历片段。                                        |
| **Semantic Memory / 语义记忆**       | 经整理形成的稳定事实、关系、偏好、规则和教训。                            |
| **Memory Metabolism / 记忆代谢**     | 将活动记录提炼、合并、降权或晋升为长期记忆的过程。                        |
| **Action Envelope / 动作信封**       | 主 Agent 返回的结构化、可校验动作集合。                                   |
| **Expression / 表达**                | Agent 主动向用户输出的一条消息，是动作而不是结束整个生命循环的标志。      |
| **A2A contextId**                    | A2A Agent 内的一段远端会话连续性。它不是 joi 的长期身份。        |
| **A2A taskId**                       | 一次远端执行任务的标识，用于查询、取消和续订。                            |
| **Artifact**                         | Agent 产生并通过 A2A 登记的文本或文件产物。                               |
| **Runtime Injection / 运行时注入**   | Wake 运行期间追加的上下文事实；与用户消息、Agent 正式输出和动作分开审计。 |
| **Flow Event / 流程事件**            | 描述一次运行跨层状态转换的只读审计事实，不代替领域实体。                  |

## 4. 命名与写作规则

- 数据库和 API 字段使用英文；产品界面默认使用中文。
- “事件”专指已经持久化且可消费的 `LifeEvent`，临时 UI 状态不称为事件。
- “唤醒”专指主 Agent 决策周期，协作者调用称为 Invocation。
- “消息”只有在被写入事件表后才能触发运行。
- “已恢复”必须有远端 Task 查询/续订或本地幂等证据，不能仅表示重新发送成功。
- 文档中的 MUST、SHOULD、MAY 分别表示必须、推荐和可选要求。

## 5. 版本规则

- Hub API 首版为 `/api/v1`。
- joi A2A 扩展首版为 `urn:aimana:digital-life-runtime:v1`。
- A2A `0.3.x` 作为 MVP 唯一兼容协议族。
- Card 的协议、transport、认证或 Origin 变化时，连接进入 `RECONFIRM_REQUIRED`，不得静默继续发送 Bearer。

## 6. 文档边界

文档包描述目标产品，不承诺已有实现。原始理念文档用于产品立意，AI Mana Front 用于兼容事实，独立 Python 后端用于架构反证和可靠性经验；新工程不会复制任一现有项目的 UI、数据库或运行时模块，只实现本文档明确采纳的协议与领域约束。
