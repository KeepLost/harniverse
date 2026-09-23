# @deepseek-ai/dsh-api-terminal-controller

[English](README.md) | 中文

Host 侧浏览器终端 Remote。`ctx.terminalController` 拥有构建于 subprocess provider [`spawnTerminal`](../../subprocess/subprocess/README.md) PTY 接缝之上的按 Session 交互式 Shell 会话,并通过 headless xterm 终端渲染的先快照后输出屏幕帧将其提供给浏览器面板。[子系统页面](../../../docs/subsystems/terminal-controller.md) 拥有线上形状以及保持、控制与 Shell 发现语义。

这些是用户自己的 system-user 终端,而非模型 PTY:每个终端以完整 harness 环境生成(`ambientEnv: 'full'`,并叠加 `DSH_SESSION_ID`),并向 PTY 接缝请求 `xterm-256color` 终端类型(`term`,并镜像到 `TERM`),使 `clear`、颜色与全屏程序可用,以常规登录+交互会话方式启动 Shell(bash/zsh `-l -i`、fish `-i`、PowerShell `-NoLogo`、cmd 无参数),从不施加沙箱约束,其流量对模型不可见——控制器是由认证 API 把关的 Host Remote,终端内容不产生任何 session-log 事件。

## 服务:`TerminalController`(ctx 键:`terminalController`)

该服务以 `terminal` 命名空间扩展 `TypertRemoteService`。创建在一个 Session 的注册表中对开放身份是幂等的;已关闭的身份无法重建,且每个 Session 的终端数量受 `maxTerminals` 约束。每个 Session 的终端随其 fiber 销毁,Host 销毁会在 `disposeGraceMs` 内排空其拥有的每个终端。

屏幕重建经由 lazy-require 接缝使用 `@xterm/headless` 与 `@xterm/addon-serialize`,因此 headless 渲染器仅在存在终端时加载。同一时刻只有一个附着持有输入控制权;来自其他附着的写入、调整尺寸与重命名会以只读方式失败。无人值守的终端——没有窗口持有、控制者或观测到的活动——会在 `unattendedTimeoutMs` 后关闭。

Shell 发现解析配置的 `shell` 或来自 `dsh-shell` 的平台默认项,通过 subprocess provider 的可执行查找逐个验证候选,并连同用户启动参数报告选定项(bash/zsh 为 `-l -i`,fish 为 `-i`,PowerShell 为 `-NoLogo`,cmd 无参数)。显式配置的 shell 路径与参数覆盖发现结果。

`retain` 与 `follow` 生成器是普通 host 方法而非 `@Remote` 声明:harniverse 的 Gateway 派发是单参的,因此 host `apiproxy` 将它们包装为 EventsApi surface 上的 `events.terminal` / `events.hold` SSE 流。

## 模型体验

无。该包面向浏览器面板,不注册任何提示词、工具或会话事件。

#### KV 缓存影响

无直接影响;终端输出永不进入模型请求或 Session 日志。

## 已知限制与延后工作

- 前台活动观测将 subprocess 接缝的 `inspectForeground()` 按输入等待状态与进程组映射为 idle/busy,比专用活动 API 更粗粒度。
- Shell 发现会跳过可执行查找失败的候选而不产生类型化的未找到错误,与 subprocess 接缝的普通错误契约一致。
