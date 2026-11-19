---
name: verify
description: 在隔离的 Joi Electron 窗口验证界面、HTTP 与 Pi 提问回答闭环，并截图记录观察。
---

## 启动

1. 先执行 `npm run build:renderer` 和 `npm run build:electron`，确保运行当前源码。
2. 用 `@playwright/test` 的 `_electron.launch({ args: ['.'], cwd: <仓库根目录>, env: { ...process.env, JOI_TEST: '1' } })` 启动；Windows 冷启动可用 `firstWindow({ timeout: 60000 })`。检查 Electron 的 `app.getPath('userData')` 为本次临时 `joi-e2e-*`，不能使用真实用户目录。
3. 在真实窗口完成管理密码、本机访问及跳过模型配置。操作步骤可查仓库 `tests/e2e/conversations.spec.ts`，但验证应驱动窗口，不是运行测试文件。

## 对话提问闭环

- 使用本次临时 loopback 合成模型端点与非空合成 key，通过实际模型来源 HTTP 接口创建并验证。当前 generic-openai 使用 OpenAI Responses `/responses` SSE，只有 chat/completions 替身不足。
- 通过实际工作台接口绑定本次临时目录；原生目录选择器可用返回该目录的替身。HTTP、持久化、SDK、回答接口和界面保持真实。
- 浏览器 bootstrap 会旋转 session/CSRF。脚本完成设置接口后 reload，让 renderer 接管其会话；后续点击期间不再 bootstrap。
- 从普通对话输入框发送任务，合成模型先返回 `ask_user`，等待真实卡片出现。截图标题、选项、默认答案和期限。
- 点击选项／填写文字，再点击提交。观察回答 POST、卡片回执、原 turn 完成，并在合成模型下一请求中确认原 call_id 的工具结果。仅卡片消失不是闭环证据。
- 探针选择刷新保留、双击只提交一次、旧版本拒绝。超时可只推进该临时数据库问题的 deadline，观察真实宿主扫描和模型继续；报告必须注明未实际等待30分钟。

## 证据与收尾

将截图和不含凭据的合成观察结果放在本次 `test-results/` 下并用图像读取工具查看。记录正常路径、至少一个边界探针及真实观察；模型品质、实体Android和公网行为未驱动就保持未验证。结束调用 `app.close()`，关闭自己的合成端点，保留截图，不清理他人的任务目录。
