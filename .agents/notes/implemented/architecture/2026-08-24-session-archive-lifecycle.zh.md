# Agent Note：会话归档生命周期与只读 Web 管理

状态：已实现

English | [English](2026-08-24-session-archive-lifecycle.md)

## 问题

Web 工作区归档集合会把 Session 从普通分组界面隐藏，但隐藏的身份仍可能保持附着、接受新的交互，而且缺少恢复和消息管理入口。永久删除已经拥有带 journal 的单会话事务，因此归档管理沿用这条生命周期，不引入第二套日志存储或删除路径。

## 决策

`workspace.archiveSession` 只接受没有运行、队列消息和待回答交互的空闲 Session。Host 先为 Session 身份加锁并重新检查活动状态，在 live 身份仍可确认时提交归档集合，然后通过 `closeIfIdle` 关闭空闲的工厂所有 Agent；关闭失败会回滚归档标记。Host 同时观察旧版本遗留的归档 Agent，并在其工作进入静止状态后关闭它们。

Host 在所有面向模型的修改边界把已归档 Session 视为只读。历史、状态、附件读取、删除和取消归档仍然可用；提示词、队列修改、取消、重命名、分叉、模型选择、命令执行及其他 Agent 修改使用现有 `agent-busy` 错误词汇拒绝，并携带 `SESSION_ARCHIVED` 原因。

`workspace.unarchiveSession` 只移除持久化归档标记，不恢复 Agent，也不改变当前选择。浏览器归档面板把 `workspace.archivedSessionIds` 与 Session 列表连接成归档行，通过客户端 Session 对象层打开不改变当前选择的只读预览，并沿用历史窗口加载更早页面。单个和多选删除都复用带 journal 的 `session.delete` RPC；多选时先删除选中的后代，再删除选中的父级，部分失败按行保留并展示。

## 失败与生命周期契约

运行中的 Session、包含队列工作的 Session、存在待审批或待回答交互的 Session 都在持久化归档前被拒绝。Session 级归档锁会阻止并发修改和取消归档。删除仍以 Host 为权威，并可继续拒绝 live 或非叶子 Session；浏览器逐项报告失败，不丢弃已经成功删除的结果。

归档列表是派生状态。Host 归档集合帧、Session 删除帧、重连基线和删除引用清理共同驱动它收敛，客户端不另外持久化归档状态。Session 删除后，内容寻址的共享附件仍保留给全局垃圾回收。

## 备选方案

**增加独立归档数据库或 Session 格式。** 现有 Workspace 归档集合已经持久化成员关系，Session 历史和删除 seam 已经提供所需读取与清理能力，不需要增加第二个权威来源。

**只在浏览器隐藏归档会话的修改控件。** 浏览器界面不能保护直接 RPC 调用方，因此只读状态由 Host 的修改边界强制执行。

**先增加批量删除 RPC。** 现有带 journal 的单会话删除已经处理 lineage、恢复和派生清理；客户端编排可以用更小的协议与迁移范围提供部分结果报告。

## 结果

已归档身份拥有统一且受约束的只读生命周期，不会通过普通 Web 导航意外恢复。实现增加一个 Workspace RPC 并扩展客户端 runtime 接口，同时保持现有 Session 格式、Workspace 域存储形状、历史分页和删除 journal 不变。
