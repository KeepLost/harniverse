# @deepseek-ai/dsh-api-terminal-controller

[English](README.md) | 中文

Host 侧浏览器终端 Remote。`ctx.terminalController` 拥有构建于 subprocess provider [`spawnTerminal`](../../subprocess/subprocess/README.md) PTY 接缝之上的按 Agent 交互式 Shell 会话,并通过 headless xterm 终端渲染的先快照后输出屏幕帧将其提供给浏览器面板。[子系统页面](../../../docs/subsystems/terminal-controller.md) 拥有线上形状以及保持、控制与 Shell 发现语义。

## 服务:`TerminalController`(ctx 键:`terminalController`)

该服务以 `terminal` 命名空间扩展 `TypertRemoteService`。创建在一个 Agent 的会话注册表中对开放身份是幂等的;已关闭的身份无法重建,且每个 Agent 的终端数量受 `maxTerminals` 约束。每个 Agent 的终端随其 fiber 销毁,Host 销毁会在 `disposeGraceMs` 内排空其拥有的每个终端。

屏幕重建经由 lazy-require 接缝使用 `@xterm/headless` 与 `@xterm/addon-serialize`,因此 headless 渲染器仅在存在终端时加载。同一时刻只有一个附着持有输入控制权;来自其他附着的写入、调整尺寸与重命名会以只读方式失败。无人值守的终端——没有窗口持有、控制者或观测到的活动——会在 `unattendedTimeoutMs` 后关闭。

Shell 发现解析配置的 `shell` 或来自 `dsh-shell` 的平台交互默认项,通过 subprocess provider 的可执行查找逐个验证候选,并连同交互参数报告选定项(POSIX 登录式 Shell 为 `-i`,PowerShell 为 `-NoLogo`,cmd 无参数)。

在本移植中,`retain` 与 `follow` 生成器是普通的 host 方法:harniverse Remote 派发是单参的,增量屏幕帧的流传输推迟到将拥有它的浏览器面板客户端集成。

## 模型体验

无。该包面向浏览器面板,不注册任何提示词、工具或会话事件。

#### KV 缓存影响

无直接影响;终端输出仅通过记录它的消费者到达模型。

## 已知限制与延后工作

- `follow` 与 `retain` 流在 harniverse 中尚无 Remote 流传输;在浏览器面板集成加入其载体之前,调用者直接使用 host 方法。
- 前台活动观测将 subprocess 接缝的 `inspectForeground()` 按输入等待状态与进程组映射为 idle/busy,比专用活动 API 更粗粒度。
- Shell 发现会跳过可执行查找失败的候选而不产生类型化的未找到错误,与 subprocess 接缝的普通错误契约一致。
