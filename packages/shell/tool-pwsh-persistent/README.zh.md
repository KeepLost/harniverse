# @deepseek-ai/dsh-tool-pwsh-persistent

[English](README.md) | 中文

模型侧 `pwsh(command)`，由一个 owner 作用域的 `ctx.terminals` shell 支撑。本包拥有工具契约与 shell 复用；部署方选择 terminal backend（配置 `shellDialect: pwsh` 的 `terminal-bash` 实例）与沙箱策略。它是 `tool-bash-persistent` 的 PowerShell 对应物：相同的持久状态契约，PowerShell 方言。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `backendType` | `shell` | 每个 Agent shell 使用的已注册 terminal backend。 |
| `timeoutMs` | `300000` | 单条命令的墙钟上限；超时关闭 shell。 |
| `maxOutputChars` | `16000` | 保留的命令输出字符上限；固定诊断文本在其后追加。 |
| `description` | 持久 shell 描述 | 模型可见的环境契约。 |

## 模型体验

### 工具 schema

#### 模型看到什么

生成的 [`pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-pwsh-persistent)，含配置的 `description`。本插件不贡献独立的 system-prompt 段落；persona 与环境指引由部署方负责。

#### Token 影响

`pwsh` 可见期间每个请求有固定的 schema 成本。

#### KV Cache 影响

配置的 description 与 schema 不变时前缀稳定。

### 工具结果

#### 模型看到什么

命令共享每个 Agent 的一个 shell，因此 cwd、`$env:` 变量、函数和后台任务跨调用保留。结果排除私有完成标记、shell 提示符与回显的输入行。非零包装命令追加 `[exit code: N]`：原生程序使用精确退出码，PowerShell 终止性错误使用 `1`。shell 在报告状态前退出时，结果追加 `[shell exited: code N]`、`[shell killed by signal: SIG]` 或 `[shell exited]`，随后重置并告知模型下一次调用从全新 shell 开始。长输出保留最早的前缀并附裁剪提示；若 terminal 已丢弃该前缀，结果会明确说明。超时返回有界的部分输出、关闭状态不确定的 shell 并报告重置。

#### Token 影响

数据相关。`maxOutputChars` 限制保留的命令输出；固定裁剪、前缀丢失、状态、超时与重置诊断可能扩展结果。

#### KV Cache 影响

追加式工具结果跟随可复用的请求前缀。

## 已知限制与延后工作

- 本工具为显式 opt-in，需要拥有 Agent，以及配置 PowerShell 的 terminal backend（`dsh-terminal-bash` 的 `shellDialect: pwsh`）。随发布提供的 base 与 Profile 组合继续使用非持久化 `dsh-tool-pwsh`。
- 在声明 Windows 平台验证之前，必须由原生 Windows CI 覆盖 ConPTY、Toolhelp32 进程所有权、Ctrl-C 投递与 taskkill 拆卸；非 Windows 测试使用模拟 native bridge。
- PowerShell 的 PSReadLine 会回显提交输入，且没有 `stty -echo` 对应物。marker 锚定提取会移除完整回显，但跨 terminal 宽度折行的回显可能在部分输出中留下有界片段。
- 模型命令中的裸 ESC 字符不受支持，因为 PSReadLine 会在执行前吞掉它们。
- 重定义 `prompt` 函数会移除就绪 marker；shell 随后通过静默档结算。
- 命令没有交互 stdin；读取输入的前台命令会阻塞到超时并重置 shell。
- SIGTSTP 与 SIGHUP 在 Windows 不可用；SIGINT 以控制台级 Ctrl-C 输入投递。
