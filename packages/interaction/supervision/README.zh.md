# @deepseek-ai/dsh-supervision

[English](README.md) | 中文

独立的会话级策略，用于决定依赖人类的操作是否可以等待用户。`supervised` 保持现有审批和提问行为；`unsupervised` 会立即失败新的用户提问和审批，使 agent 可以完成不依赖用户决定的工作而不会等待。

## 模式

- `supervised`：用户提问、计划审阅和审批请求使用已配置的提供方。
- `unsupervised`：新的依赖人类的请求快速失败。面向模型的上下文会要求 agent 不要重试，继续独立工作，并在最终报告中同时列出已完成事项和未决事项。

模式以 `supervision/mode` 事件保存到会话日志。当前会话可以通过 `/supervision <mode>` 切换；切换影响后续模型步骤和能力调用，不会取消或重新计算已经运行的操作和 pending 交互。

Agent Profile 可以与 `permissionPreset` 并列声明 `supervisionMode`。模型只能通过 Profile 选择新建普通会话或 Child Profile 的模式，创建工具不接受原始模式值。

## 模型体验

### 监督策略

#### 模型看到的内容

模型会在运行时上下文快照中收到当前模式。`supervised` 下审批和提问工具保留正常的 Provider 行为；`unsupervised` 下这些操作会在进入 Provider 前确定性失败，模型会被要求继续独立工作，并报告尚未解决的决定。

#### Token 影响

当前监督模式及其指导会为每次模型请求增加一小段动态运行时上下文。

#### KV Cache 影响

模式通过动态运行时上下文传递，因此切换模式只会改变下一次请求的动态上下文，不会重写稳定的 system prompt 前缀。

## 已知限制与暂缓事项

- `unsupervised` 会抑制 Harniverse 的人类交互 seam（`ctx.userQuestions` 和 `ctx.approval`）；外部 Provider 自己的对话仍由其适配器负责。
- 切换模式时已经等待用户决定的会话仍保持 pending；需要时应单独取消或中断。
