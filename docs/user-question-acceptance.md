# 提问队列与回答闭环

日期：2026-11-19。实施范围：本地 Pi 普通对话／子搭档、Joi 目标提问、桌面／LAN／已协商能力的远程及 Android。未扩展 Claude/Codex 原生提问和任意 A2A 提问桥。

## 行为与验收

| ID | 验收 |
| --- | --- |
| ASK-01 | 每个目标／普通会话独立 FIFO，最多一张可回答的 ACTIVE 卡。其余 QUEUED 只预览、不计时。中断卡保留在原回合，退出活动队列和超时扫描；子搭档按持久 parentTurnId 归入父会话。 |
| ASK-02 | 当前卡激活后 30 分钟采用明确展示的推荐答案，缺推荐的普通问题使用现有权限内的继续指令。TIMEOUT_DEFAULT 与人工答案区分，未提交草稿不作为默认答案。 |
| ASK-03 | 回答携带 scope、questionId、version。人工回答须在截止前提交，超时默认须在截止时或之后提交，事务按持久状态、版本和宿主时间裁定。排队卡、中断卡、旧版本及其他会话的卡不接受这一入口的回答。 |
| ASK-04 | 取消、替代不自动恢复；授权／凭据／付费／发布等独立确认优先，后续普通问题冻结排队。官方 confirm 超时默认否定，不把推荐答案当额外授权。 |
| ASK-05 | Pi 普通对话使用公开 extension tool、sequential ask 与 UI binding，答案返回原 toolCallId，由 SDK 自己继续同一轮；不另发用户轮次，不覆写底层 Agent 回调。 |
| ASK-06 | ask_user 以 canonical 成功工具结果确认交付。基本 UI 在持久执行结果后确认。显式恢复将请求、原回合和已选默认一起落库，只有恢复回合成功持久化时才确认源答案；失败仍可重试。 |
| ASK-07 | 模型提交提问时先校验选项和推荐。目标暂停结果、问题、门禁同事务提交。单 Work 取消时撤销其未交付问题，推进下一张卡或版本化恢复评审；撤销不生成用户回答。多个 Work 分别关联 action/run，goal_resume 重验门禁版本。 |
| ASK-08 | 提问保留原正文和工具历史。普通对话用 waitingForUser 独立投影等待并保持 RUNNING。SSE 和持久游标覆盖状态变化；恢复完成更新原回合的回执；回答后的旧 GET 不覆盖更新的 SSE 或轮询结果。 |
| ASK-09 | 草稿按 scope/id/version 隔离；推荐单／多选、自定义回答、默认操作、人工／自动回执可读。卡片为内嵌节点，不弹强制模态，问题出现时不将标题滚出视口。普通对话和首页的待回答卡紧凑呈现，手动输入框默认两行，保留倒计时和回答操作。普通对话的已回答卡默认以一行显示问题和答案。目标首页只显示待回答和排队问题，已结束问题在任务详情和结果页的“问答记录”下默认收起。旧版配对网页在任务卡内提供同样的折叠入口。展开可查看提问来源、完整问答、回答时间及交付状态。 |
| ASK-10 | 进程崩溃后以新运行身份显式续接，保留完整私有上下文、原请求和保存的答案，要求先核验未知副作用。每次恢复尝试有稳定身份，重复请求共用该尝试；失败后可另起一次显式恢复。 |
| ASK-11 | 无保存答案的中断卡明确展示默认内容与“采用默认答案并恢复”，不得假称已有人工答案；有答案时显示“从已保存答案继续”。 |
| ASK-12 | 远程协商 questions.v1；旧主机明确提示不支持。回答与恢复沿用鉴权、CSRF/origin 与远程 allowlist，Android 使用相同身份及状态规则。 |

## 官方机制与 Joi 职责

固定 `@earendil-works/pi-coding-agent@1.5.2`。官方 `examples/extensions/question.ts` 使用 sequential 工具，等待 UI 后返回结果；`AgentSession.bindExtensions({uiContext,mode:"rpc"})` 为宿主基本交互提供公开接入。这里保留进程内 SDK，不新增 RPC 子进程。TUI `custom()` 不用于 React。

官方 `ctx.ui.select/input/confirm` 的 timeout 返回空值／false，不是推荐同意。Joi 的持久 FIFO、30 分钟默认策略、回执、数据库/原生会话对账是宿主实现。显式扩展 dialog timeout 与业务 ACTIVE 30 分钟区分：前者可撤销自身卡片，但不能连带取消同 owner 的其他问题。

来源：锁定包 `docs/extensions.md`、`docs/rpc-extension-ui.md`、`examples/extensions/question.ts` 和 [Pi 官方仓库](https://github.com/earendil-works/pi)。遵守 [ADR 0035](adr/0035-sdk-owned-pi-sessions.md) 的会话所有权。

## 验证接缝

- `user-question-queue.test.ts`：FIFO、计时、取消、默认、CAS。
- `sqlite-goal-question-queue.test.ts`：同事务暂停、多个 Work、独立确认、默认来源、幂等恢复。
- `question-event-recovery.test.ts`：子问题归属、游标、分页、私有无截断恢复上下文。
- `joi-orchestration-migration.test.ts`：正式 Ask 迁移使用 107–108。旧开发库按原文件名识别 104–105 的 Ask 迁移记录，保留历史卡和恢复关联，并正常应用父分支的历史数据迁移。
- `pi-user-question-runtime.test.ts` / `pi-user-question-ui.test.ts`：真实 SDK＋合成 provider，原 call 答复、默认来源、单卡取消、canonical ACK。
- `pi-question-http.test.ts`：真实 HTTP/Auth/SQLite/ConversationService/SDK，人工回答和 Clock 推进 30 分钟的同轮继续。
- React／Flutter 卡片和远程协议测试覆盖显示、操作、错误与能力协商。

真实供应商回答质量、Android 实体设备、公网连接与安装包发布不是上述合成验证的结论。
