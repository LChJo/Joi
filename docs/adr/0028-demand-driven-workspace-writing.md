# ADR 0028：本地任务按需申请工作区写租约

- 状态：Accepted
- 日期：2026-10-13
- 验收：AC-14、AC-33、AC-46、AC-53、AC-54、AC-62、AC-67；AC-WR-01..06

本地 Pi、Claude、Codex 的工具权限是能力上限。新策略先取得 READ，允许同物理目录的分析并发；WRITE 独占执行及验收。已启动旧 run 保留旧策略，A2A 不参与该协议。

阶段持久化为 READ_QUEUED、READ_RUNNING、WRITE_QUEUED、WRITE_RUNNING，按请求序号调度写者。存在有效写者时拒绝新读者。升级只能在没有其他读者和更早写者时原子完成；否则工具停止、检查点保存后，原子登记请求并释放 READ，不能持读等写。

暂停是内部资源等待，不产生用户问题、验收或完成事件。SUSPENDED 实例保留任务归属，释放执行容量但计入常驻配额。恢复使用原 Work/run/attempt/instance 和 run+代次稳定键的 continuation outbox。恢复核对取消、门禁、需求版本及检查点；旧代次不得发布结果或释放新租约。

Pi 执行前门禁覆盖写、编辑、Shell，未知工具拒绝。Claude 使用 PreToolUse hook 覆盖自动放行，禁用未验证的间接入口。Codex 使用真实 read-only sandbox 和 COMPLETED/WRITE_REQUIRED 结构化协议，最多纠正一次；原线程恢复仍遵守配置上限。不兼容 CLI 安全失败。

恢复 WRITE 后重新读取相关文件并建立产物基线，不重放被拦截的编辑。分析阶段不以共享目录差异认领产物。附件与辅助文件写到任务独立目录。原生会话、消息检查点及协议 JSON 保持私有。


## 权限与执行需求一致性（AC-WR-07）
新 Work 的 executionNeeds 声明 SHELL/FILE_WRITE；空数组表示使用内置读取工具或返回文本。Pi/Claude 的普通 Shell 与文件写入都需要 WRITE 上限，Codex 的只读命令沿用原 sandbox。WRITE 是按需升级上限，READ 是不可写权限边界，不能将分析阶段误当作权限声明。旧 brief 缺失声明时视为未知，执行门禁仍有效，不通过自然语言关键词推断权限。

派发在 Work/outbox 提交前拒绝冲突，Joi 同轮最多纠正一次。Pi/Claude 工具集合按 Work 上限和固定搭档配置求交集，常驻实例每次执行重新投影；越权调用终止该轮并保留安全原因，不能循环探测或变成用户许可请求。

恢复、改派和未启动 brief 更新核对需求而不扩大原 READ。已失败任务只通过补充 Work 满足已获用户授权的缺失交付，继承验收、不重放已完成外部操作。补充提交事务检查同轮或活跃恢复、来源状态及两轮限额，重复请求复用持久计划；历史失败记录与旧运行事实保留。
