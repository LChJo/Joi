# ADR 0028：本地任务按需申请工作区写租约

- 状态：Accepted
- 日期：2026-10-13
- 验收：AC-14、AC-33、AC-46、AC-53、AC-54、AC-62、AC-67；AC-WR-01..06

本地 Pi、Claude、Codex 的工具权限是能力上限。新策略先取得 READ，允许同物理目录的分析并发；WRITE 独占执行及验收。已启动旧 run 保留旧策略，A2A 不参与该协议。

阶段持久化为 READ_QUEUED、READ_RUNNING、WRITE_QUEUED、WRITE_RUNNING，按请求序号调度写者。存在有效写者时拒绝新读者。升级只能在没有其他读者和更早写者时原子完成；否则工具停止、检查点保存后，原子登记请求并释放 READ，不能持读等写。

暂停是内部资源等待，不产生用户问题、验收或完成事件。SUSPENDED 实例保留任务归属，释放执行容量但计入常驻配额。恢复使用原 Work/run/attempt/instance 和 run+代次稳定键的 continuation outbox。恢复核对取消、门禁、需求版本及检查点；旧代次不得发布结果或释放新租约。

Pi 执行前门禁覆盖写、编辑、Shell，未知工具拒绝。Claude 使用 PreToolUse hook 覆盖自动放行，禁用未验证的间接入口。Codex 使用真实 read-only sandbox 和 COMPLETED/WRITE_REQUIRED 结构化协议，最多纠正一次；原线程恢复仍遵守配置上限。不兼容 CLI 安全失败。

恢复 WRITE 后重新读取相关文件并建立产物基线，不重放被拦截的编辑。分析阶段不以共享目录差异认领产物。附件与辅助文件写到任务独立目录。原生会话、消息检查点及协议 JSON 保持私有。
