# Agent Note: 显式启用的持久 PowerShell

Status: implemented

[English](2026-08-25-opt-in-persistent-powershell.md) | 中文

## 问题

随发布提供的 `dsh-tool-pwsh` 每次调用都会启动新进程，因此 PowerShell 的 cwd、环境、变量、函数与 job 无法跨模型轮次保留。复用持久 Bash 包装器会用 Bash quoting 与 prompt 设置破坏 PowerShell 输入。Windows PTY 拆卸也不能依赖 POSIX 进程组、纯数字 PID 或 node-pty 退出事件。

## 决策

`@deepseek-ai/dsh-tool-pwsh-persistent` 是独立的 `ctx.terminals` function plugin。它注册与一次性工具相同的面向模型名称 `pwsh(command)`，为每个确切 Agent 保留一个 PTY，并串行化该 owner 的调用。部署必须选择一个 `pwsh` Consumer；Agent Profile 组合把两个包都记录为 `pwsh` 的 owner，因此已选择的冲突会被拒绝。

本包使用 PowerShell 原生 bootstrap 与命令包装器。PowerShell `prompt` 函数发出 terminal 就绪 marker；命令使用反引号转义、随机 start/end marker、`Invoke-Expression`、`$?` 与 `$LASTEXITCODE`。超时、取消、初始化失败、发送失败和 shell 退出都会先关闭 owner 会话，再允许后续调用，以免复用状态不确定的会话。输出裁剪遵循持久 shell 约定；固定的重置与状态诊断可以超出配置的命令输出上限。

本地子进程提供方在可注入模块边界后增加 Windows 检查器。Koffi 3.1 从 `kernel32.dll` 解析 Toolhelp32 与 `GetProcessTimes`；进程身份为 `{ pid, started }`，存活判断和每次定向终止都会重新检查精确创建时间。进程树按子进程优先顺序遍历，能处理环，并忽略不可读或已经消失的成员。Ctrl-C 通过 terminal 输入写入投递；TERM 与 KILL 使用 taskkill 进程树。根身份不匹配后停止收养后代，且只有验证根已消失后，才会补全未到达的 node-pty 退出事件。

Koffi 已在工作区其他位置解析为 3.1.1，因此 subprocess-local 声明维护中的 `^3.1.0` 范围，不引入另一个 lockfile 版本。现有 node-pty `^1.1.0` API 足以支撑实现，保持不变。

CLI 分发包含该插件以供显式组合，ACP 与包级 Loader fixture 会把它与 PowerShell 方言的 `dsh-terminal-bash` 一起挂载。base bundle、随发布提供的 Profile 与 preset 都不挂载它；随发布提供的一次性 `dsh-tool-pwsh` 默认值保持不变。

## 考虑过的替代方案

**替换随发布提供的一次性 pwsh 行。** 不采用，因为持久可变状态会改变执行、超时、取消和清理语义。部署必须显式 opt-in。

**改造持久 Bash 包装器。** 不采用，因为 `PS1`、`PROMPT_COMMAND`、`stty`、Bash ANSI-C quoting 与 `$?` 都不能实现 PowerShell 输入或状态语义。

**信任数字 PID，或在没有身份围栏时运行 taskkill。** 不采用，因为 PID 复用可能把拆卸所有权转移给无关进程树。

**编写项目自有 native addon 或升级 node-pty。** 不采用，因为维护中的 koffi binding 已提供所需 Win32 调用，而当前 node-pty API 已提供本层所需的全部 terminal 操作。

## 后果

无需改变随发布提供的默认值即可使用持久 PowerShell 状态。该插件有意与一次性 pwsh 使用同一个工具名，因此组合必须二选一。Windows 进程检查首次解析 `kernel32.dll` 时会直接暴露 native bridge 失败；非 Windows 导入不会加载该库。模拟测试提供确定性的跨宿主逻辑覆盖，但在 Harniverse 声明 Windows 平台验证之前，原生 Windows CI 必须覆盖真实 ConPTY、Koffi ABI 布局、Ctrl-C 投递、taskkill 升级、进程消失竞态与 node-pty 退出事件缺失。
