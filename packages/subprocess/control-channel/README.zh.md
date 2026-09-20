# @deepseek-ai/dsh-control-channel

[English](README.md) | 中文

PTC 与 SSH 执行共享的有界控制通道契约。唯一的生命周期 owner——新进程 PTC provider 或 SSH 执行 provider——消费本接口；普通 shell、LSP 和子代理启动保持其更简单的路径，不获得自己的控制协议。

契约分三部分。帧编解码器承载长度前缀 JSON `call`/`reply`/`log`/`limit`/`done` 帧，带单帧字节上限（超限帧被拒绝、从不拆分）、增量解码会在对端声明超限或畸形帧时让通道失败，并配套正交的失败词汇表（`exception`、`timeout`、`abort`、`process-exit`、`invalid-output`、`output-limit`、`protocol`、`io`、`sandbox-unavailable`），使恰好一种 kind 命名第一个终态结果。背压施加在决策发生处：发送队列拒绝超过排队字节上限的写入，未决调用门拒绝超过回复上限的调用。生命周期状态机区分结果、取消、超时和通道关闭——终态类别从不互渡——随后是受管进程组安静下来的 quiescent，最后是清理；清理总是完成并独立报告。

本包只提供契约加上可选传输。可选传输 `ControlChannelTransport` 把该契约接入一条双工流对：它在未决调用门下配对调用与回复，在写入处施加发送背压（传输接受字节后释放排队额度），恰好记录一个终态结果——`done` 帧的值、调用方信号或显式取消带来的 `abort`、调用方期限到期带来的 `timeout`、对端不发终态帧即关闭带来的 `process-exit`、契约违规带来的 `protocol`、流故障带来的 `io`——并驱动生命周期：结果之后结束可写端、等待可读端安静，关闭宽限期一到即升级到 provider 的 `forceTerminate` 钩子。`dispose()` 是强制收尾：取消仍在运行的通道、不等敌意对端即走到 `cleaned-up`，并返回全部清理备注（第二个终态帧、崩溃的帧处理器、失败的强制终止）。provider 提供流与进程组击杀；本包从不自行 spawn 或杀死任何进程。

## Model Experience

### 控制通道帧

#### 模型看到什么

不直接看到任何内容：帧在宿主与一个受控执行之间传递工具调用、回复和进度。`log` 帧的文本可能经 provider 拥有的进度通道呈现；该措辞属于 provider。

#### Token 效应

无——本契约不贡献模型请求。

#### KV Cache 效应

无——通道从不接触请求历史。

## Known Limitations and Deferred Work

- 流接线（stdio 控制 fd、SSH 通道）、进程 spawn 和进程组监督属于 PTC 与 SSH provider；传输接受任意 Node 双工流对加一个 `forceTerminate` 钩子。
- 帧压缩以及在一条通道上复用多个执行，在 provider 需要之前不在范围内。
