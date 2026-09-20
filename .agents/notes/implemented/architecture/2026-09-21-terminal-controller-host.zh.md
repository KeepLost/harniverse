# Agent Note:终端控制器 host 移植与 deque、RemoteError 前置项

Status: implemented

[English](2026-09-21-terminal-controller-host.md) | 中文

## 问题

浏览器终端 Remote 需要三个 harniverse 此前不具备的前置项:用于 follower 队列的有界双端队列、网关可以透传的结构化 `RemoteError` 词汇,以及终端拒绝类的载体错误码。没有它们就移植控制器,将迫使后续客户端工作去拆除临时的队列与错误类型。

## 决策

`@deepseek-ai/dsh-deque` 逐字移植官方环形双端队列(摊还常数 push/pop、四分之一收缩、容量下限)。`dsh-typert-protocol` 获得 `RemoteError`,带结构化 `isDSHRemoteError` 标记与 `remoteErrorOf`,无需载体依赖即可赋给开放的 `RemoteFailure` 联合;apiproxy 的 `RpcErrorDetailsMap` 以 kebab 形式新增 `terminal-unavailable`、`terminal-control-unavailable`、`terminal-limit-reached`,网关 `rpcFailure()` 原样透传任何结构化远端错误。`@deepseek-ai/dsh-api-terminal-controller` 以 `ctx.terminalController` 扩展 `TypertRemoteService`,构建于 subprocess `spawnTerminal` 接缝之上:按 Agent 幂等创建与有界注册表、经 lazy-require 接缝的 headless-xterm 屏幕重建、单控制者附着围栏、字节有界的 follower 流,以及通过前台观测回收无人值守终端的保持策略。subprocess 终端句柄新增 `resize(cols, rows)`,本地由 node-pty 实现,SSH 经专用 `terminal.resize` 辅助 RPC。

## 备选方案

- 将 `retain`/`follow` 声明为 `@Remote` 流:否决——harniverse Remote 派发是单参的;在浏览器面板客户端集成选定增量帧载体之前,生成器保持为普通 host 方法。
- 通过专用活动 API 映射 subprocess 活动:否决——`inspectForeground()` 已经报告输入等待与进程组身份;控制器在其边界将它们映射为 idle/busy/unknown 并记录其粗粒度。
- 复刻官方 `terminalEnvironment()` 默认 Shell 查找:否决——`dsh-shell` 的 `defaultInteractiveShell()` 是 terminal-bash 后端已在使用的平台默认权威。

## 后果

线上词汇(帧、信息、Shell、环境)与官方形状一致,未来的客户端一半可以不经重新协商直接移植。Shell 发现会跳过查找失败的候选而不产生类型化未找到错误,与 subprocess 接缝的普通错误契约一致。分配清理的保持机制生而处于 closing,其观测回调按构造即不可达,覆盖检查在说明理由后将其忽略。目录、接缝图、模块图与类型等价清单已再生成;两个新包的模型体验均记录为无。

## 范围

deque 与 terminal-controller 包及其测试、typert-protocol 远端错误模块、apiproxy 载体错误码与网关透传、跨本地与 SSH 提供方的终端句柄 `resize` 接缝、再生成的目录与配对记录,以及本笔记。浏览器面板客户端一半(右侧边栏、终端视图模型、真实载体上的窗口持有)延后至其独立工作项。
