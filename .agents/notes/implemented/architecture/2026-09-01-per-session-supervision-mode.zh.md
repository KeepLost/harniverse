# Agent Note：按 Session 独立的人机监督模式

状态：已实现

English | [English](2026-09-01-per-session-supervision-mode.md)

## 问题

权限 preset、沙箱和审批策略描述 Agent 可以做什么，却没有描述依赖人类的操作是否可以等待。因此无人值守运行仍可能进入用户提问或审批接缝并停住；即使独立工作已经明确，计划审阅也可能阻塞完成。

## 决策

Harniverse 通过独立的 `supervision/mode` Session 事件拥有两种值：`supervised` 和 `unsupervised`。`dsh-supervision` Service 负责 fold、运行时上下文指导、命令和 Session 投影。`unsupervised` 下新的用户提问和审批请求会在调用 Provider 之前拒绝；已经进行中的请求不会被追溯取消。面向模型的指导要求不要重试被阻止的交互，继续独立工作，并在最终报告中列出尚需用户决定的事项。

Agent Profile 元数据可以为新建的普通 Session 设置 `supervisionMode`。Web composer 在 Access Mode 旁提供同一个当前 Session 切换器。新建 Child Profile 时可以设置固定模式；未设置时，子级在委派边界捕获父级模式。`unsupervised` 父级不能定义 `supervised` 子级。

Plan Mode 遵循独立的边界规则：unsupervised Session 不能进入 Plan Mode，但已经处于 Plan Mode 的 Session 可以不经用户审阅直接退出，并在下一步继续执行。

## 考虑过的替代方案

**复用 approval policy `never`。** 不采用，因为审批策略是更窄的动作决策契约，无法表达用户提问、计划审阅或 UI 中独立的人机监督选择。

**切换模式时取消全部 pending 交互。** 不采用，因为模式切换是面向未来的策略事件；已启动操作的所有权仍归该操作及其取消信号。

**从模型目录中隐藏依赖人类的工具。** 不采用，因为能力接缝必须继续对 supervised Session 可用，且决策应在实际操作边界执行，而不是依赖提示词或工具目录过滤。

## 后果

每个新 Session 都有持久化、可回放的监督模式；支持投影的客户端可以渲染当前选择，而不需要第二份可变镜像。持久化的子级日志保留委派时的模式，因此冷恢复不会重新读取父级后来的状态。`unsupervised` 不回答外部 Provider 特有的对话框；这些适配器继续拥有各自的无人值守契约。

## 验证

聚焦的 Service、用户提问、审批、Plan Mode、子级继承、Profile 元数据和 Web composer 测试覆盖快速失败、直接退出计划、持久化委派快照和独立 UI 选择器。交付过程中还会运行 persistence event catalog、Host/Client 类型聚合、GUI 套件和构建后的 Web replay 套件。
