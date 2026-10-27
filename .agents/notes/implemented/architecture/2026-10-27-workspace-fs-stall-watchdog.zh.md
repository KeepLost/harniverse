# Agent Note: 工作区文件系统卡死看门狗与熔断

Status: implemented

[English](2026-10-27-workspace-fs-stall-watchdog.md) | 中文

## 问题

一线反馈：从 Web 工作区面板打开某个特定的 Markdown 文件会弹出原始的 `signal timed out` 错误，此后**所有**到该实例的连接都劣化直到重启；重启并重新登录后，同一文件必定再次触发，而其它文件正常。代码诊断：

1. `"signal timed out"` 是 Chrome 对浏览器 RPC 客户端固定 30 秒单次调用窗口超时所抛 DOMException 的原生文案（`AbstractApiClient.postJson`）——即主机从未应答，超时发生在浏览器侧，不是文件系统 API。
2. 工作区检查器的四个文件系统操作（`list`、`search`、`read`、`readBinary`）**完全没有截止时间**：请求信号只在 await 之间检查，而 Node 的文件系统 promise 不接受信号。卡死的网络挂载（企业 SMB/NFS 抖动、杀毒/EDR 拦截、离线文件占位符实体化）因此把处理器永久挂起——主机永不结算，浏览器在 30 秒中止。
3. 每个挂起的操作永久钉死一个 libuv 线程池线程（默认仅四个，全进程共享）加一个文件描述符，而被放弃路径上的 `finally { await handle.close() }` 又会再钉一次。重试与其它客户端的操作各钉一个线程；线程池耗尽后**整个进程**所有文件系统类 RPC 全部排队挂死——这正是「所有连接出问题」。重启清空；再开同一文件再次钉死。
4. 一次读取要做约 9 次串行文件系统往返（每次包含性检查都重新解析规范化根），慢速挂载的延迟被逐级放大。

## 决策

四项互相独立的加固，各归拥有该失败的一层：

- **看门狗**（`WorkspaceStallGuard.run`）：每个文件系统操作与 10 秒上限竞速。正常结算的操作原样返回或抛错；卡死的操作被*放弃*而非取消——调用方的响应路径与熔断预算立即释放，孤儿文件系统 promise 等挂载应答后自行结算。句柄以不阻塞的方式关闭（`close().catch(...)`，永不阻塞调用方路径）。失败以结构化的 `workspace-entry-stalled`／`workspace-root-stalled` RPC 错误呈现，而非原始超时。
- **熔断**：卡死打击按工作区根累积（滚动 60 秒内 3 次）；集满后开启 30 秒冷却，期间该根上的所有操作快速失败、不触碰文件系统，使单个钉死的挂载无法通过重试抽干共享线程池。冷却后下一个健康操作重新开放该根；打击会滑出窗口。
- **往返减半**：每个操作只解析一次规范化工作区根，并贯穿包含性复验（`containedPath`／`openedPathInfo`），保留 TOCTOU 复查的同时删去冗余的 `realpath(root)`。
- **线程池下限**（`@deepseek-ai/dsh-app-boot (root entry first import)`，每个宿主进程 bin 的首位导入——CLI、remote-server、desktop host）：在任何文件系统调用确定池大小之前，把未设置或小于 16 的 `UV_THREADPOOL_SIZE` 提升到 16；运维显式设置的更大值优先。

浏览器侧把载体超时映射为可行动的信息（「workspace file read timed out: the host filesystem did not answer within the request window」），而不是透出 Chrome 的 DOMException 文案。

挂载侧的触发因（为什么恰是那个文件卡死公司文件系统）不在本仓库的控制范围内；这些改动把它的影响半径收敛为每次操作一个报错清晰的可读错误，而不是全进程卡死。

## 后果

- 卡死的操作是被放弃而非取消：悬死的线程池请求与其 fd 会一直占用到进程退出——看门狗限定的是调用方的等待、熔断器停止向卡死的根继续投喂，但真正让进程其余部分活下来的是 `UV_THREADPOOL_SIZE=16`；永久卡死的挂载在每个打击窗口内仍会泄漏一个槽位。
- 健康但缓慢的网络根上的工作区读取现在 10 秒后硬失败；冷却期错误会点名工作区以便用户重新挂载，浏览器也把 30 秒载体超时映射为同一条可操作信息。
- 线程池地板随 app-boot 根入口的首位导入生效（而非子路径导出）：tsx 的免构建源码启动器只把根导出重映射到 `src/`，专用 `lib/` 子路径会破坏 node 兼容冒烟向量。
- `workspace-entry-stalled`/`workspace-root-stalled` 加入 RPC 错误面，且规范根每操作只解析一次——遏制逻辑现在通过共享辅助函数传递可选的 `canonicalRoot`。

## 验证

`workspace-inspector-stall.spec.ts` 以注入时钟钉住看门狗（正常透传、卡死放弃、调用方中止）、熔断（不触碰文件系统的快速失败、根间独立、冷却重开、打击老化）与操作的结构化错误；faults 套件中的根故障用例钉住规范化根的错误映射；`threadpool-floor.spec.ts` 钉住三种环境分支。既有检查器套件在重构后的包含性路径上保持全绿。

## 考虑过的备选方案

**经信号实现真取消。** Node 的文件系统 promise 不接受 AbortSignal；`handle.read` 的 options 形参也无法中断已在途的线程池请求。与定时器竞速是唯一真正释放调用方的机制。

**按连接的 fs worker 隔离。** 把检查移入专职 worker 进程同样可以围堵卡死的挂载，但要在安全敏感的包含性栅栏上横跨一道进程边界；就观察到的失败类别而言，看门狗加熔断以不新增信任边界的方式提供同等保护。
