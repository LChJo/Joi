# ADR 0024：pi 搭档的写入边界由工具强制，而不是提示词

- 状态：accepted
- 日期：2026-09-27
- 相关：ADR 0014（原生 Agent SDK 适配）、ADR 0006（工作台私有搭档实例）、ADR 0023（长任务异常的错误兼容）

## 背景

三种 partner 引擎对「授权写」的实际含义不同，而 pi 是最宽的那个：

| 引擎 | 授权写之后的边界 |
|---|---|
| `codex` | OS 级 `sandboxMode: workspace-write`，越界写被沙箱拒绝 |
| `claude-code` | 交给 CLI 自己的 permission 层与路径边界 |
| `pi-core` | **没有**。`write` / `edit` 工具不做任何路径检查 |

更具体地说，joi 的系统提示词此前**主动邀请**越过工作区：

> 「The assigned workspace is your home base: create work files there by default. When the task requires it, **you may also read and write paths outside the workspace**（for example user directories, installed skill folders, or configuration files）。List every write outside the workspace (path and change) in your final reply.」
> —— `pi-partner-engine-runtime.ts`（改前）

唯一的约束是提示词本身，外加要求模型事后申报。`pi-coding-tool-factory.ts` 的注释当时也直说了这一点：「Tools carry no path sandbox: the workspace scope is prompt governance, not tool enforcement.」

这不是「零授权即可写」——revision 层已经授权了写工具。问题在于**同一条授权在不同引擎上意味着不同的风险**，而 pi 是唯一一个「一旦授权即无限制」的，并且它正是本次事故里无人看护连续运行十小时的那条路径（见 ADR 0022 / 0023）。

## 决策

### 1. 只拒绝写，不拒绝读

`write` 与 `edit` 落盘前校验目标路径是否在工作区内，越界则拒绝。**读保持不受限**：这一步保护的是写入，而 task 合法地需要读工作区之外的东西——已安装的 skill、用户配置、参考仓库——拒绝读会直接破坏工作，且不换来任何保护。

### 2. 校验放在工具的文件操作层，不放在参数检查里

pi 的 `createWriteTool` / `createEditTool` 接受 `operations` 注入，而操作函数收到的是 **pi 自己已经解析好的绝对路径**（`resolveToCwd` 处理过 `~`、绝对路径与相对 cwd）。在参数层自己再解析一遍意味着复刻它的规则，而两份实现之间任何一处不一致——某个写法 pi 解析到外面、joi 解析到里面——都是一个洞，不是一次误拒。放在解析层之下就没有可分叉的东西。

### 3. 包含判定在符号链接解析之后做

把字符串当路径比对是这类边界最典型的漏法：`<workspace>/link/new.txt` 作为字符串在工作区内，落到磁盘上却取决于 `link` 指向哪里。因此先把**最深的已存在祖先**做 realpath，再判断包含关系——写入目标通常还不存在，所以只能对存在的部分求值，而这恰好也是符号链接逃逸真正发生的位置。

### 4. 提示词随之改写，不再承诺做不到的事

原句改成：工作区是唯一会写入的地方；读取仍可越界；越界写会被工具拒绝；**并且明说 shell 命令不受这条边界约束**。最后一句是刻意的——见下。

### 5. `bash` 不在边界内，并且明说

`bash` 能写什么取决于它执行什么，没有任何参数检查能判定。这不是可以绕开的技术细节，而是这条边界的**诚实上限**：配了 `bash` 的 partner 仍可越界写。因此提示词明说这一点，并明确要求不要用 shell 绕开文件工具的拒绝——**与其给一个看起来完备、实际有洞的边界，不如给一个说明了自己边界在哪里的边界**。

## 后果

- **pi 与其他两个引擎在「授权写」上的语义差距被缩小**：文件工具的越界写在三个引擎上都会被拒（codex 靠沙箱、claude 靠 CLI、pi 靠这里），差异只剩 `bash`。
- **越界写不再是静默的**：工具抛出，pi 把它变成模型读到的一条错误结果，错误信息里写明边界与「读不受限」。模型从边界本身学到边界，而不是从指令里的一句承诺。
- **一条已知的兼容代价**：此前提示词允许写 `{baseDir}`（skill 自己的目录）等外部位置，这类写现在会被拒。如果确有 skill 依赖它，需要显式开一个允许根，而不是恢复「全部允许」。这一点尚未观察到实际影响，先按「只拒绝越界写」的最小面落地。
- 契约测试 `tests/unit/pi-coding-tool-factory.test.ts` 新增三条：越界写被拒（绝对路径与 `..` 两种写法）、符号链接逃逸被拒、越界读仍然可行。原先那条「不强制路径边界」的用例改名为「仍然可以读工作区外」，因为读的那一半没有变。

## 追记（2026-10-03）：提示词的禁令密度造成读的自我设限

落地后被观察到一次反面效果：搭档在交付报告里写下「不在工作区；按约束未去区外寻找」——工具本可读，但它把「the only place your file tools will write … do not plan work that depends on it …」这一段四句禁令泛化成了「区外不能动」的全局限令（"do not plan work that depends on it" 的宾语没有把写和读分开）。修正：读权限改为独立成句的**肯定式**表述（`workspaceReadScopeLine`，三个引擎共用，置于段落或边界块的首句），写限制压缩为一句并明确主语是 write/edit。教训：一条「只拦 X」的边界，提示词里必须先把「不拦其余」说成许可，再描述 X 的拒绝；禁令密度高于许可密度时，中等模型会用最保守的方式解读。
