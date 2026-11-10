# Agent Note：PTC 线整体吸纳

Status: implemented

[English](2026-11-08-ptc-line-absorption.md) | 中文

## 问题

Wave-6 的两项 PTC 升级——带可选保留的 Script 求值、保留态运行的协作式中断——建立在上游一次 harniverse 从未吸纳的重构之上：`Ptc*` 词汇的 seam 与 `resolve`/`run` 拆分、带三种求值器的托管持久进程 Node 提供方，以及它们依赖的基座面。把它们补到 fresh-process 提供方上不可能：保留与协作停止在那里没有基座。

## 决策

按钉定版本 `fcc0ad4621` 吸纳官方 PTC 线：

- **Seam**（`dsh-ptc-runtime`）：官方 Service Definition——`PtcRunRequest`/`PtcRunSpec` 与提供方自有的 `resolve` 步骤、`programFormat`（`function-body`/`repl`/`script`）、`retainsState`、`release(owner)`，以及 `sandbox`/`timeout` 提供方描述符。Python 提供方适配新 seam，固定以进程根为 cwd、以配置的 wall 预算为准。
- **Node 提供方**（`dsh-ptc-runtime-node`）：官方实现——per-call 异步函数体跑在全新进程；可选 `persistent-in-memory` REPL；`vm-script` 配 `scriptPersistence`（每个保留 owner 一个独立 realm，顶层 await 经 Node v26.6.0 REPL 变换（基于 Acorn）降级）。保留态中断遵循官方决策：吊销执行权、请求协作停止、以 `stopGraceMs` 约束确认时限、超时回落到托管进程组终止；确认只吊销托管执行权，不取消全部 Node 活动。
- **基座**：`SandboxExecutionPolicy.additionalWritableRoots` 与共享的 `workspaceWritableRoots` 推导及各 runner 的执行（Windows ACL 拒绝额外根）、`FileSystem.processPathFromHostPath`、`dsh-subprocess/control` 的 fd-7 通道与 seam 上的 `stdio.control`，以及原先重复放在 bash/pwsh sandbox 助手里的共享 runner 失败诊断。
- **消费者**（`dsh-tools`）：`run_code` 先 resolve 出 spec 再运行；提供方保留状态时以调用方 agent 为 `stateOwner`，并按 agent-提供方对注册一次 release 效果（解包 Cordis 服务原始对象）；schema 文案与 SDK 节按运行时的 `programFormat` 推导。TypeScript function-body 文案保持字节不变；script 与 REPL 形态各有自己的文案。
- **Session**：store 生命周期结束的 session 拒绝追加（`attachments` null 标记），并允许之后挂到新的 store——与上游守卫一致，持久策略观察者测试依赖它。

上游的 `dsh-util-values`（`assertNever`/`snapshotJsonValue` 的家）不移植：harniverse 的这两个助手仍在 `dsh-llm`/`dsh-session`，移植来的提供方从那里导入。

## 备选方案

**只把两篇 Note 补到 fresh-process 提供方上。** 两个行为在那里都没有基座：没有可保留 Script 上下文的持久进程，也没有承载协作停止的控制通道。

**移植上游 `tool-executor-ptc` 包。** 它建立在上游 `dsh-tools` 的 pipeline API 上，harniverse 未吸纳该 API。`run_code` 传输仍由注册表持有并适配新 seam；上游的按调用 `timeoutMs`/沙箱升级工具参数不移植（harniverse 部署在运行时插件上配置预算；记入 node 提供方 README 的 Known Limitations）。

**移植上游实验性 Python 提供方。** harniverse 保留自己的 fresh-process Python 后端在产品组；适配到 seam 保留其 fd-3 协议与测试。

## 后果

提供方配置面变形（per-call 预算变为 `timeoutMs`/`maxTimeoutMs`；`executionMode` 与 `scriptPersistence` 是新键）；bundles 不带配置挂载插件，部署配置无需变更。保留态是尽力而为的进程内存，经 agent 作用域释放；未确认的停止会终止托管进程组并丢失该状态。owner 批准的语义放宽就是上游契约：确认的停止吊销的是托管执行权，不取消计时器、用户 Promise、I/O 回调或用户创建的 worker，被超时的运行其保留状态可以存活。额外可写根在 `read-only`/`danger-full-access` 下不授予任何东西，并在推导期拒绝符号链接、缺失与非目录项。上游各 Note（[Script 求值与保留]、[保留态中断]、[沙箱化 Node 提供方]、[尽力而为的持久 PTC]、[持久 PTC 沙箱]）仍是这些机制的正典决策记录。

[Script 求值与保留]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-10-20-ptc-script-evaluation-and-retention.md
[保留态中断]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-10-29-retained-ptc-interruption.md
[沙箱化 Node 提供方]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-11-sandboxed-node-ptc-runtime.md
[尽力而为的持久 PTC]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-09-23-best-effort-persistent-ptc.md
[持久 PTC 沙箱]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-10-08-persistent-ptc-sandbox.md
