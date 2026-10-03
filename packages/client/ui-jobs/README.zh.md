# @deepseek-ai/dsh-client-ui-jobs

[English](README.md) | 中文

Web 后台任务特性的归属方：向 `conversation.session.header.actions` 贡献一个条目，列出当前会话可见的 `ctx.jobs` 记录。列表状态来自 [`dsh-client-runtime`](../runtime/README.md) 从 `session/jobs` 帧折叠出的 `jobsBySession` 镜像；展开行的输出查看器与两步停止通过共享的 connection api client 写入（`jobs.follow` / `jobs.kill`），因此除弹层与行视口状态外，本包不持有任何状态。

只有当会话至少有一个任务时才渲染触发器，普通对话不会因为一项未被使用的能力而长出控件。角标计数为 `running` 加 `stopping`，为零时省略，这样只剩已完成任务的会话保留一个安静的历史入口，而不是宣告一个「零」。弹层是一个扁平列表：活跃行在前按 `startedAt` 升序，随后终态行按 `finishedAt` 降序；毫秒相同的并列按启动顺序打破，宿主的 map 迭代顺序永远不参与决定。一行显示生产者 kind、label、状态标记、生产者一旦给出 `detail` 就取代通用状态词的那段文字，以及已耗时。该耗时在活跃时每秒推进，并在 `finishedAt` 冻结；只有当打开的列表里确实有会动的东西时时钟才运行。缺少 `finishedAt` 的终态行读作零而不是负数，超过一小时的耗时停留在小时单位，不会长出任何生产者目前都到不了的「天」词汇。

每个活跃行带一个展开控件，打开只读输出查看器；查看器跨终态保持挂载，被保留的输出环在收起或行消失之前始终可读。查看器每 500 ms 从 offset 0 起轮询 `jobs.follow`，用自持游标追加每个返回窗口；除非人类手动滚离底部，它始终钉在底部，并在行进入终态后停止轮询（最后一次 follow 收走尾部）。读取失败就地渲染，轮询在行活跃期间持续重试，重连因此自愈。停止控件是两步的：第一次点击只进入 2.5 秒后自行还原的确认态；第二次点击调用 `jobs.kill`——一次人类停止，不认领 owner 的常规完成通知（注册表推送随即将该行翻转为 `stopping` 及其终态）。被拒绝或失败的停止就地渲染。两个动词都要求 `harniverse.operate` 能力，并在线路侧失败关闭，而不是靠隐藏控件。

终态行保持可见并弱化，直到注册表在 owner 销毁时把它们丢掉。它们本就在快照里，失败任务的 `detail` 是其失败唯一可读之处，在这里过滤掉它们是输出与中断两期要推翻的工作。因此一个运行中的一次性后台 subagent 会同时出现在这里和 [subagent 目录](../ui-subagent/README.md)里：目录负责进入子会话的 transcript，而这个列表是将来中断能力唯一可能附着的句柄。

Escape 关闭列表并把焦点交还触发器，在其外部按下指针同理。最后一个任务消失时先关闭列表再卸载控件，焦点因此不会从一个被移除的节点上凭空消失。样式只用 token；文案走本包自己的 `job` locale 命名空间。行为由 [Web 后台任务展示 Agent Note](../../../.agents/notes/implemented/feature/2026-08-08-web-background-job-display.md) 规定。

## 模型体验

无，因为本包为人类渲染宿主计算出的注册表状态，不触及 prompt、消息、schema、流或工具结果。模型对同一批任务的视角仍属于 [`dsh-tool-jobs`](../../jobs/tool-jobs/README.md)；人类 `jobs.kill` 特意不认领终态报告，模型仍会收到它的完成通知。

#### KV Cache effect

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **查看器是纯文本，不是终端模拟器** —— `client/ui-terminal` 没有导出只读渲染入口，而跨包导入符号被禁止，因此输出环以等宽文本面呈现，发射 ANSI 序列的生产者会将其原样显示。升级意味着要么从 `ui-terminal` 导出只读组件（公共 API 新增，需要审批），要么第二次 vendored xterm 基础样式。
- **列表不等于注册表自己的集合** —— 它展示的是「一个会话通过线路视图能看到什么」，所以别的会话拥有的任务在这里永远不出现；而进程重启会清空列表，transcript 里启动这些任务的 `run_in_background` 卡片却还在。无主任务（在没有活体 `Agent` 时启动的）是反过来的情形：它会进入每一个会话的列表，与 `list(caller)` 对每个调用方的报告一致。
