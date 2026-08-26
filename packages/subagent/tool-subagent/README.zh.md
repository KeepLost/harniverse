# @deepseek-ai/dsh-tool-subagent

[English](README.md) | 中文

基于一个已配置 `ctx.subagents` 提供方、面向模型的委派工具。更换提供方只会改变传输，不会改变执行约定。

## 提供方选择与生命周期

每个插件实例把一个 `provider` 绑定到一个 `toolName`；模型不会收到提供方选择器。如需公开另一种传输，请加载另一个名称不同的实例。工具只在其提供方存在时注册，从而避免对同级加载顺序和提供方重新加载的依赖。工具描述遵循 `provider.inheritsParentContext`：新建子 agent（智能体）需要独立提示词，而 fork 子 agent 已能看到父级已完成轮次。

同步调用会让执行信号贯穿启动和执行，等待 `run.result`，并且在返回前总会等待 `run.dispose()`。只有 `completed` 会返回规范值 `{ mode: 'sync', invocationId, sessionId, output: JsonValue[] }`；中止、拒绝、token 上限和其他失败都会变成出错的工具结果。其消息会把可选的提供方撰写 `SubagentResult.diagnostic` 放在单独的 `Diagnostic:` 行下，再于另一标题后附加保留下来的部分 assistant 文本，因此两类文本都不会成为成功的 assistant 输出，被截断的回答也绝不会被悄悄丢弃。如果结果收集与 dispose（资源释放）都 reject，出错的结果会保留两项失败。

`backgroundMode` 仍是部署级默认策略。面向模型的 schema 使用 `mode: sync|async`：`sync` 等待终态的一次性结果，`async` 在接受持久化可继续 child 轮次后返回。可继续的异步工作要求提供方具备 `prepareContinuable`，通过统一 Invocation 服务启动，并保持 child 可接受后续消息。两种模式都会渲染持久化 child Session id；`session_inspect` 可以读取两类 Session，`session_message` 只继续异步 child。每当该 child 的 Activation 结束，继续执行服务会投递一条结算通知。

`toolFilter` 会改变子 agent 的全局工具层，但不是从父级派生的权限上限。见 [agent 作用域的安全非目标](../../../.agents/notes/implemented/architecture/2026-07-08-agent-scope-contexts.md#security-and-authority-are-non-goals)。

启用可选的 Profile 管理面后，`child_profile_define` 和 `child_profile_list` 只操作调用方 Agent 的私有内存命名空间。`child_profile_list` 会在已有 revision 旁返回可用 grant；省略能力数组表示继承该 grant，显式空数组表示不授予该类能力。委派工具接受 `child_profile_id`；Host 会在启动前解析其 immutable snapshot、模型路由、深度/token 上限、工作区和工具边界。Profile 缺失或未授权时直接报错，不会回退到父级默认路由；父级注册表消失后，每个已启动 child 仍持久保留其 resolved snapshot。

## 配置

| 键 | 含义 |
|---|---|
| `provider`（必填） | 提供方名称（`spawn`、`fork`、`acp` 等）。 |
| `toolName` | 面向模型的名称，默认 `subagent`；每个已加载实例必须不同。 |
| `enableRunInBackground` | 允许 `mode: async`，默认 `true`；禁用时拒绝异步调用。 |
| `backgroundMode` | 内部默认策略，默认 `one-shot`；它决定省略 `mode` 时默认采用 `sync` 还是 `async`。面向模型的约定始终是 `mode: sync|async`。 |
| `agentOptions` | 传给具体提供方的子 agent `provider`、`model` 和正整数 `maxTokens`；进程内提供方会用显式值覆盖继承的父级选项。 |
| `persona` | 每个子 agent 独立的 persona；要求提供方具备 `persona` 能力。 |
| `toolFilter` | 每个子 agent 独立的全局工具限制；要求提供方具备 `toolFilter` 能力。 |
| `maxDepth` | 绝对委派深度上限，默认 `3`（`0` 禁止委派）；数值上限要求 `depthLimit` 能力，缺失时挂载失败。对于预算由子 harness 拥有的进程外提供方，`'provider-managed'` 不发送上限。工具在达到上限时仍然可见；每次尝试启动都会检查调用 agent 的当前深度，被拒绝时返回出错的工具结果。 |
| `enableChildProfileDefine` | 公开 `child_profile_define`，默认 `false`；Host 必须先绑定父级 grant 和模型路由，模型才能定义可用 Profile。 |
| `enableChildProfileList` | 公开 `child_profile_list`，默认 `false`；列表会投影当前父级的精确 grant 与私有修订。 |

## 并发

前台调用和后台调用均并发安全：同一条 assistant 消息中的同级委派会在循环的滚动池（`maxParallelToolCalls`）下重叠执行，结果仍按模型顺序提交。子 agent 在各自的会话中工作，一次运行绝不变更父会话；一次性后台形态对父级拥有状态的唯一写入是注册一个 Task——这是一次同步、可交换、能容忍并发分发的插入，因此重叠的后台调用按分发竞态顺序获得各自的 job id。协调同级工作区效果由模型负责，正如模型已经对后台和可继续子 agent 所承担的那样。见 [并行 subagent Agent Note](../../../.agents/notes/implemented/feature/2026-08-09-parallel-subagent-delegations.md) 和 [并行工具调用 Agent Note](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)。

## 模型体验

### 工具 schema

#### 模型看到的内容

当提供方存在时，以当前实例配置的名称公开已生成的交付版 [`subagent` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-subagent)。schema 公开 `mode: sync|async` 和可选的 `child_profile_id`，但不会接受原始命令、endpoint、凭据或 Profile 路径。启用 Profile 管理后，模型还会看到父级私有的 define/list 工具及可用 grant。当工具在本次组装的作用域中可见时，一个 `tool:<toolName>` 系统提示词 section 会说明配置的异步默认策略，把 `session_message` 与 `session_inspect` 指定为继续和读取入口，并要求仅在下一步动作依赖结果时选择 `mode: sync`。

#### Token 影响

每个父级请求都会产生固定的 schema token 开销；每个提供方实例增加一个 schema，每个可继续实例还会增加一个简短的系统提示词 section。

#### KV Cache 影响

只要提供方实例、名称、描述和 schema 不变，前缀就保持稳定。提供方注册生命周期可能从首个变化的工具定义开始，使父级复用失效。

### 前台结果

#### 模型看到的内容

调用会保留描述和提示词。成功时会标识持久化的一次性 child Session 与 Invocation，说明 `session_inspect` 接受该 Session id 而后续轮次不接受，然后包含子 agent 的最终文本。其他结果变为 `Error: <message>`，可选的安全提供方详情会放在单独的 `Diagnostic:` 行中，并位于任何部分 assistant 输出之前。子 agent 中间步骤不会进入父级。

#### Token 影响

提示词和结果会留在父级历史中，直到上下文压缩（context compaction）；子 agent 工作上下文留在子 agent 中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 后台结果

#### 模型看到的内容

异步调用会在 child 完成前同时渲染持久化 child Session id 与 Invocation id；同步调用会随最终结果渲染相同的身份。异步 child 的结算会以[服务负责的通知](../subagent/README.md#settlement-notice)到达父级。已交付的 `session_message` 工具负责直属 child 的后续消息，`session_inspect` 则按 Session id 读取 child transcript。

#### Token 影响

确认消息会被保留；一次性最终输出只在收集或注入时进入父级历史，而可继续子 agent 的输出绝不会通过本工具返回——其结算通知独立于任何工具结果到达。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **后台运行不通过本工具公开结果**：一次性任务的最终输出通过通用 Task 接口收集，可继续子 agent 的输出留在其自身会话中，按其 subagent id 读取。结算通知会说明该子 agent 如何结束，并携带可能存在的最终 assistant 消息，但它不是本次调用的返回值，也无法在此等待。
- **等待中的一次性实例较晚才发现重复名称**（`TODO(subagent-dup-toolname)`）：可继续实例会在插件应用期间预留提示词 section 名称，但若要阻止等待中的一次性实例回滚提供方注册，仍需要一份预期名称注册表。
- **每个实例的子 agent 策略固定**：其他模型、persona、工具过滤器或深度上限都需要另一个名称不同的工具。
- **Skill/MCP member 和 route fallback 仍由 Host 负责**：Profile 当前已执行主模型路由、工作区、工具和深度/token 边界；原生 Skill/MCP 投影以及多路由 fallback/scheduler 尚未由此 Consumer 暴露。
