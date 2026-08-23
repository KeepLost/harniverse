# Agent Note：冷会话辅助 RPC

Status: implemented

[English](2026-08-23-cold-session-auxiliary-rpcs.md) | 中文

## 问题

打开冷会话时，展示历史页会与 `commands/list`、`session.models` 同时发出。两个辅助响应都只有约 1 KiB，但在真实日志上各自耗时 0.6-1.1 秒，因为其 lookup 路径会恢复 Agent。Resume 通过与历史页相同的 per-session 持久化链读取完整日志，因此小请求排在与其并发的大型页面之后。

事件循环并非瓶颈：辅助调用等待约一秒时，实测事件循环 p99 延迟仍为 5-20 ms。单独调用冷 `commands/list` 约耗时 0.27 秒，因为它触发自己的 resume；Agent live 后只需约 0.01 秒。

## 决策

命令发现以 `SessionId` 而非 `Agent` 寻址。Agent 已 live 时，其 scope chain 仍会贡献命令 shadow。冷会话不可能拥有 Agent-scoped 注册，因此发现操作直接读取全局命令层，绝不只为取得 scope key 而恢复会话。命令执行仍以 Agent 寻址，因为它会针对接收 Session 变更和记录日志。

模型目录观察保留 live 路径，包括尚未由后续 request header 表示的进程内选择。对于 detached 会话，它先读取不可变会话 header 完成 ownership 准入，再让持久化读取最后一条 request header。`SessionPersistence.readRequestHeader()` 观察一个有效已存储前缀。第一方协调器直接通过后端运行它，而不加入 per-id 变更链，因此它可以与 detached 历史页并行，且不会发布、修复或 prepare Session。第三方直接实现继承 `inspect` 回退。

顺序 JSONL 仍需解析物理产物，因为目标 header 可能只在日志开头记录过一次。这是刻意的取舍：实测解析约 0.1 秒，而排在展示页之后约需一秒。SQLite 在相同观察契约下读取其稳定已存储前缀。

## 考虑过的替代方案

**保留 Agent lookup 并优化 resume。** 已拒绝，因为命令发现只把 Agent 用作 scope key，模型观察也不需要运行中的 Agent。即使把不必要的 ownership 变便宜，仍会创建生命周期工作，并将只读 UI 元数据耦合到 resume。

**从有界历史尾部读取模型选择。** 回归测试否决了该方案：`request/header` 只在 header 变化时发出，从未切换模型的会话可能只在 seq 0 保存选择。尾读会悄悄返回错误的 host default。

**串行化所有持久化读取。** Detached 展示页和有状态 preparation 仍保留串行化，但这一狭窄观察拒绝串行化。`loadStored` 已返回有效连续前缀；append 期间的并发观察者可以看到较早前缀，而不违反 selection 契约。

## 后果

冷命令发现不再通过取得 Agent 来证明会话存在；没有 live Agent 时，它只公开全局组合的描述符。Web 客户端只对会话目录提供的会话调用它，并在调用前过滤 addressed subagent。Live Agent-scoped shadow 保持不变。

模型观察会在顺序存储上执行物理解析和事件校验，但避开 Session 构造、合成 recovery 和 per-id 队列。返回选择是该次读取观察到的稳定前缀中的最后一个 header。每次 detached await 后都会重新检查并发发布；只要 live Agent 存在，就仍以 Agent 为权威，而新发布的 child 仍会触发 subagent fence。

## 验证

持久化套件证明 `readRequestHeader` 在所有后端返回最后一个 header，并能在同 id 历史页被刻意阻塞时完成。Host 模型测试固定 detached selection、host-default 回退、live 进程内选择优先级、subagent ownership、不存在、无 resume 和无完整 `inspect`。命令测试固定无 Agent 时的全局发现和 live scoped shadow；生成的 Typert 元数据现在携带 JSON `sessionId`，而非 `agent` lookup。

通过真实 Grant 注册、owner 批准、签名 challenge exchange 和读者真实 JSONL/Zstd 日志，并发 `commands/list` 从 646-1,033 ms 降至 20-271 ms，`session.models` 从 646-1,033 ms 降至 113-533 ms。在最大的实测会话上，两者分别从 1,033 ms 降至 34 ms 和 144 ms，而独立历史页仍约为一秒。
