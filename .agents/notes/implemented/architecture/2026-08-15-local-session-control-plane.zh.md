# Agent Note: 本地 Session 控制面

Status: implemented

[English](2026-08-15-local-session-control-plane.md) | 中文

## 问题

Web API Proxy 已经服务本地浏览器 Session，但控制观测并不完整：mux 游标被忽略，导致每次重连都重建所有已打开历史窗口；流队列可以无界增长；prompt 准入不返回持久身份；无法查询单条消息的生命周期；实时 teardown 没有按 id 操作；持久数据没有协调删除路径；进程本地状态也没有 Host incarnation 隔离标识。

这些缺口相互影响。Prompt 回执只有在后续状态能够对账时才有用；回放只有在慢消费者显式失败并可续传时才可靠；close 只有到达 Agent owner 的完全停稳边界才安全；delete 只有在 close 之后且日志外引用已经清理时才安全；进程本地快照也只能在 Host 启动身份一致时复用。

## 决策

`packages/host/apiproxy` 是本地 Session 控制面。它保持为 loopback/trusted-host 浏览器 BFF，而不是独立版本化的公共 API。SDK JSON-RPC 与 ACP 保持更窄的自动化约定；它们不替代 Web BFF 对 Session、队列、交互、workspace 和 Host 状态的职责。

### 持久同步

`session.history` 有两种互斥模式。后向模式按追加来源消息边界分页。前向模式要求 `afterSeq` 加正整数 `maxEvents`，把 `afterSeq` 视为排他游标，并返回不含投影的连续事件区间。

`events.mux.since` 将每个 Session id 映射为该客户端已应用的最后一个连续持久 seq。Host 会在采样回放切点前安装实时观察，发送 `session/subscribed`，回放至切点，随后排空实时缓冲并丢弃重叠项。问题、审批、队列、任务和投影仍是临时快照／实时值，不会被虚构成持久事件。

每条 Host 流队列受 `streamQueueMaxFrames` 限制。溢出时保留并排空已接纳帧，随后使流失败；禁止静默丢帧。重连会采样新的 Client 游标，因此可以跨 generation 有界推进回放。浏览器保留权威的已打开窗口，用前向 history 修复普通缺口，并在 Host 宣告的尾部低于本地游标时重新建基。

### Prompt 回执与工作生命周期

`session.prompt` 返回确切获准的 `MessageId`；斜杠命令继续走独立的 command API。`session.workStatus` 从持久日志折叠出 `unknown`、`queued`、`claimed`、`discarded` 或 `settled`；claim 将消息与轮次关联，settlement 记录该轮次的持久结束原因。

这种关联描述生命周期，不代表输出因果所有权。多条 queued 或 steering 消息可以共用一个轮次，注入上下文或工具续行也可能影响其输出。控制面绝不会把某条 assistant 消息选作一个已获准 `MessageId` 的响应；[follow-up 所有权决策](2026-07-30-followup-enqueue-and-owned-runs.md)仍是权威。

### Close 与 delete

`session.close` 属于 Agent 生命周期 teardown。它会阻止新的控制面准入、等待同 Session 的 admission chain、排空可续行后代，并调用 `AgentRegistry` 保留的工厂自有记忆化 disposer。AgentLoop 关闭准入、取消并排空、dispose Agent scope、flush 仍附加的确切 Session，随后 detach Agent 与 Session。Close 发送 `running: false`，并保留持久 Session 行。[Agent 生命周期决策](2026-06-18-agent-lifecycle-and-ownership-contracts.md)规定该顺序。

`session.delete` 是独立的跨存储变更，只接受冷的持久叶子 Session。它拒绝实时／closing 身份和存在子级的 Session；按 parent 串行化会把进行中的 fork 排在叶子检查之前。Workspace 域中的持久标记用于区分恢复与从未存在的 id。该操作先记录标记并拦截延迟投影写回，再通过 `SessionPersistence.delete` 删除权威日志，最后幂等移除 workspace/archive 引用并清除标记，使 cleanup 失败或重启后的重试能够收敛。JSONL 只 unlink 已验证 transcript，并在 POSIX 上同步其所在目录；SQLite 在一个事务中级联删除事件行。共享附件会被保留，响应会明确报告这一事实。[持久化决策](2026-06-14-session-persistence.md)规定存储仲裁。

### 快照与启动隔离

`host.describe.bootId` 标识一个 API Proxy 进程生命周期。`session.status` 返回该值与一个 Session 快照：attached/running/closing 状态、最后持久 seq、队列、任务和可回答的待处理交互。附加状态从实时 owner 同步采样；冷状态通过检查获得而不恢复 Agent，并带空的进程本地集合。

重连到相同 `bootId` 时，可以按各自 generation 规则复用进程本地观察。即使 Session id 和持久 seq 不变，`bootId` 改变也会使这些观察失效。

## 考虑过的替代方案

**把 SDK JSON-RPC 或 ACP 扩展为通用控制协议。** 两者都是有用的自动化适配器，但都不拥有完整本地浏览器状态，也不拥有 Web BFF 的交互、队列、workspace 与双流约定。扩展任一方都会复制或泄漏这些职责。

**保持 mux 仅实时，并在每次重连后重建历史。** 该方式能收敛，但会重新读取并构建每个已打开窗口，无界生产方队列还可能在恢复开始前耗尽内存。游标回放加显式失败的队列上限让进度可观察。

**把 `MessageId`→轮次视为 prompt 输出归因。** 该映射能准确记录准入和结算，但共享轮次没有排他的 assistant 响应。API 暴露生命周期事实，并省略虚假结果。

**通过 detach SessionStore 状态来 close，或直接 unlink 存储来 delete。** 直接 detach 会留下 Agent 工作与 scope；直接 unlink 会与 write-behind、retirement 或未发布 preparation 竞争，并留下跨存储引用。两者都绕过权威 owner。

**向子级和附件级联删除。** 子级谱系不可变，内容寻址附件还可能被共享。在存在显式级联与垃圾回收政策前，拒绝非叶子删除并保留附件，可以避免隐式数据损失。

## 验证

Host 与载体测试固定前向 history 校验、回放／实时重叠、队列溢出先排空后失败、SSE/WebSocket 游标传输、prompt 回执、持久工作状态折叠、状态快照、启动身份、close 顺序和仅叶子删除。核心生命周期测试固定准入截止、并发 close 加入、scope 结算、实时 Session flush 和 detach 顺序。共享持久化约定在 JSONL 与 SQLite 上运行，并固定删除仲裁、重建身份、缓存写回隔离和 workspace/archive 清理。Client connection 与 runtime 测试固定动态游标采样、保留窗口、前向缺口修复、重复抑制和 Host 回滚重新建基。

## 后果

本地控制方可以增量重连、识别已获准工作、检查一致的当前状态、卸载实时 Session，并删除符合条件的持久 Session，而无需公开暴露服务或虚构 prompt 级输出所有权。新增状态机与既有 owner 放在一起，不引入第二个编排服务。

删除不是安全擦除：共享附件会保留，派生查询索引中的字节也可能持续存在，直到下一次对账。游标表通过 mux URL 传输，并限制为常驻的权威 Session；超大游标表需要未来的流协商消息。Host 队列按帧而不是字节限制，浏览器 WebSocket inbox 也没有独立字节上限。
