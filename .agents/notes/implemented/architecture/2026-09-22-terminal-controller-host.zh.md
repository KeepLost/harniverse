# Agent Note:W13 终端控制器 host 移植与 deque、RemoteError 前置项

Status: implemented

[English](2026-09-22-terminal-controller-host.md) | 中文

## 问题

经认证的 Web 终端 Remote(W13 host 半侧)需要本树尚未携带的三个前置项:用于跟随者队列的有界 deque、网关可以透传的结构化 `RemoteError` 词汇,以及终端拒绝类别的载体错误码。没有它们就移植控制器,将迫使客户端半侧日后拆除临时的队列与错误类型。

## 决策

`@deepseek-ai/dsh-deque` 逐字移植官方的循环 deque(摊还常数 push/pop、四分之一处收缩、容量下限)。`dsh-typert-protocol` 获得 `RemoteError`——携带结构化 `isDSHRemoteError` 标记与 `remoteErrorOf`,可不依赖载体包地指派到开放的 `RemoteFailure` 联合;apiproxy 的 `RpcErrorDetailsMap` 以 kebab 形式加入 `terminal-unavailable`、`terminal-control-unavailable`、`terminal-limit-reached`,网关 `rpcFailure()` 原样透传任何结构化远程错误。`@deepseek-ai/dsh-api-terminal-controller` 以 `ctx.terminalController` 之名扩展 `TypertRemoteService`,构建于 subprocess `spawnTerminal` 接缝之上:按 Session 幂等创建与有界注册表、经 lazy-require 接缝的 headless-xterm 屏幕重建、单控制者附着围栏、字节有界队列的跟随者流,以及通过前台观测回收无人值守终端的保持策略。

这些是用户自己的 system-user 终端(相对参考草稿的刻意分歧):它们以 `ambientEnv: 'full'` 加 `TERM=xterm-256color` 与 `DSH_SESSION_ID` 生成,默认启动登录+交互式 Shell(bash/zsh `-l -i`、fish `-i`、PowerShell `-NoLogo`、cmd 无参数——绝不使用 `--noprofile`/`--norc`/`-f`),从不施加沙箱约束,也不产生 session-log 事件,因此其流量对模型不可见。`retain`/`follow` 生成器保持为普通 host 方法,因为 harniverse Remote 派发是单参的;host apiproxy 将它们包装为 `events.terminal` / `events.hold` SSE 流(`harniverse.observe`),与单参 `terminal/*` Remote 端点并列,并施加每个 host 处理器都采用的 subagent 来源可见性围栏。web-app bundle 挂载该控制器,使经认证的面板能够经网关到达它。

## 备选方案

- 将 `retain`/`follow` 声明为 `@Remote` 流:否决——harniverse Remote 派发是单参的;EventsApi SSE 流承载增量帧。
- 通过专用活动 API 映射 subprocess 活动:否决——`inspectForeground()` 已报告输入等待与进程组身份;控制器在其边界将它们映射为 idle/busy/unknown 并记录其粗粒度。
- 复用 `defaultInteractiveShell()` 的参数:否决——那些是模型 PTY 的 no-rc 默认值;用户终端必须与用户自己的登录 Shell 完全一致地加载 profile。

## 后果

线上词汇(帧、info、shell、environment)与官方形状一致,客户端半侧无需重新协商即可移植。Shell 发现会跳过查找失败且无类型化未找到错误的候选,与 subprocess 接缝的普通错误契约一致。分配清理的保持天生处于关闭状态,其观测回调按构造即为死代码,并在覆盖率中以说明忽略。目录、接缝图、模块图与类型等价清单已再生;两个新包的模型体验均记录为无。

## 范围

deque 与 terminal-controller 包及其测试、typert-protocol remote-error 模块、apiproxy 载体错误码与网关透传及 terminal/hold SSE 传输与客户端 fake 覆盖、client/connection 契约再导出、web-app bundle 行、再生的目录与配对记录,以及本笔记。浏览器面板客户端半侧(右侧栏、基于 EventsApi 流的终端视图模型)是并行的 W13 客户端工作项。
