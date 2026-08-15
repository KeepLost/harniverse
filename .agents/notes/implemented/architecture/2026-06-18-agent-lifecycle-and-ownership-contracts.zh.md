# Agent Note: Agent 生命周期与所有权约定

Status: implemented

[English](2026-06-18-agent-lifecycle-and-ownership-contracts.md) | 中文

## 问题

ACP（Agent Client Protocol）与 tool-bash 的若干限制是同一个所有权约定缺失的症状：插件可以通过 `ctx.agents` 创建或恢复 agent（智能体），但无法独立拥有和 dispose（资源释放）单个 agent，而长时间运行的 bash 任务在执行器中也没有稳定的所有者。ACP 在断连时中止并等待 agent，却无法仅注销该会话的 agent；`session/cancel` 无法取消已入队但尚未开始的工作；`tool-bash` 将任务所有权保存在插件本地的 `Map` 中，因此一次 HMR（热模块替换）重载就可能让旧任务看起来无主。

## 决策

三项约定变更：队列感知的取消、`AgentHandle` 释放器，以及 bash 所有者令牌。

### 1. 队列感知的 `Agent.cancel(cause?)`

`Agent` 接口新增 `cancel()` 动词——唯一的公开停止原语。（它最初与范围更窄、仅作用于步骤的 `abort()` 一同交付；后者后来因无人使用而移除，使 `cancel()` 成为唯一公开的停止工作方式。）它清空 inbox 的 queued + steering FIFO，在存在活跃轮次时中止它，并保留一个不带 cause 的 pre-run 标记，使在被领取前被取消的提示词永不运行，而后来的提示词仍保持独立。有效调用会在清空或中止前发出 `agent/cancel-requested`，携带类型化的 `user | parent` cause；空闲取消不发出任何事件，也不会使下一条提示词搁浅。`whenIdle()` 会在取消后达到完全停稳，ACP 的 `session/cancel` 映射到 `user`。[显式轮次取消决策](2026-07-16-explicit-turn-cancellation.md)规定了当前的 cause、signal 生命周期与协作式结算约定。

### 2. `AgentHandle` 异步释放器

`ctx.agents.create`/`resume`（以及 `AgentFactory` 接口）返回 `AgentHandle = { agent: Agent; dispose(): Promise<void> }`。释放器是一种**消费方能力**——仅持有裸 `Agent` 的注册表观察者无法自行合成 teardown。调用方 fiber 和已注册 factory 提供方是结构上的共同所有者。工厂发布 Agent 时，`AgentRegistry.enter` 会把该确切的记忆化 disposer 保留为注册表按 id 关闭能力；`ctx.agents.close(id)` 调用它，并发调用方加入同一个操作，而没有该能力的直接注册 Agent 会被拒绝。每个所有者都进入同一个 teardown：停止新准入、取消并等待循环、撤销其 scope、flush 仍附加的确切 Session，随后 detach Agent 和 Session。公开 ID 在其精确注册表条目 detach 时可复用。ACP 在 `SessionRecord` 中保存每个新会话的 disposer；配置创建的 Agent 由 `AgentLoop` fiber 拥有，Host 控制面则通过注册表保留的能力关闭它们。

**拆除顺序对持久性至关重要**，实现将会话生命周期折叠进 Agent 的单个复合 Cordis effect。fiber 卸载会并发释放兄弟 effect（`Promise.all`），这会让 Session append 发布钩子的移除与循环关闭记录竞争。Disposer 先关闭准入，再取消并等待 driver 真正 idle，dispose 作用域世界，并在确切 Session 仍存活时调用 `SessionStore.flush`；随后才 detach Agent 与 Session。Scope 和 flush 失败会在两个 detach 操作之后汇总；受隔离的生命周期通知无法拒绝该链或跳过后续 teardown。

### 3. Service Definition 中的 Bash 所有者令牌

后台任务所有权从 `tool-bash` 插件本地的 `Map<string, Agent>` 移入执行器。`ShellExecRequest` 新增可选的 `owner?: string`；解析后的 `ShellExecSpec` 将其作为必需但可空的 `owner: string | undefined` 携带（被遗忘的 owner 是可见的 `undefined`，而非静默缺失的属性）。执行器把 token 存在任务上，并通过新的 `ShellExecutor.ownerOf(id): string | undefined` 方法暴露它（不放在公开的 `BashTask` 上——只有一条读取路径，没有冗余 API）。`tool-bash` 完全删除其 `Map`：它在 `start` 时将 `exec.agent?.id`（共享的注册表/会话 id）盖章为 owner，`bash_output`/`bash_kill` 则以 `!== undefined` 语义把 `ctx.shell.ownerOf(id)` 与调用方 token 比较（空字符串 token 仍是真实 owner）。完成通知通过扫描 `ctx.get('agents')?.list()` 查找 `agent.id === ownerToken` 的存活 agent（经 `ctx.get` 读取——`onJobDone` 运行在 bash fiber 这一外部 fiber 上，直接使用 `ctx.agents` proxy 会抛异常）。由于所有权现在保存在执行器的任务上（随 `dsh-shell` fiber dispose），它能跨越 `tool-bash` HMR 重载，关闭旧的 `XXX(tool-bash-owner-hmr)` 缺口。（`onJobDone` 监听器仍受 `tool-bash` 的 `apply` effect 约束，因此落在重载间隙的完成仍会丢失一条通知——既有的重载间隙丢失——但所有权隔离本身已经不受 HMR 影响。）

## 验证

以下不变式已经成立，并由测试固定：

- ACP 断连或插件拆除后，任何由桥接层拥有的会话都不留下已注册 agent 或会话存储条目，包括与连接关闭竞争的创建流程。
- 已入队的提示词启动前执行 `session/cancel`，能阻止该提示词运行；后来接受的提示词仍是独立的已入队轮次。
- `tool-bash` HMR 重载不会使另一个会话能够读取或终止已有的后台任务（所有权保留在执行器上）。
- 既有的非 ACP 演示无需显式管理 handle 仍能工作；由配置创建的 agent 仍归 `AgentLoop` 插件 fiber 所有。
- 按 id 关闭会加入并发调用方、拒绝新的 prompt 与 maintenance 准入、经过最终实时 Session flush 达到完全停稳，且绝不会在 Agent scope 结算前 detach Session。

## 会话所有者令牌在存活 agent 中唯一

bash 所有者 token 比较依赖共享的 `Agent.id`/`SessionId` 在存活 agent 中唯一。并发的同 ID 操作可以都私下准备，但发布时会依次登记会话和 agent；`SessionStore.enter()` 拒绝重复的存活会话 id，每个失败事务都回滚自己的私有状态。因此程序化调用方无法发布两个共享同一会话 token 的存活 agent。访问*策略*（token 比较）留在 Consumer `tool-bash`；bash 能力只存储不透明的 `owner` 字符串且从不解释它——这是正确的 Service Definition / Service Provider / Consumer 拆分。

## 曾考虑的替代方案

- **公开的 `BashTask.owner` 字段**而非 `ShellExecutor.ownerOf(id)` Service Definition 方法：否决。一条读取路径即可，无需冗余 API。
- **为 agent 的会话生命周期使用兄弟 Cordis effect**：否决。fiber 卸载时并发释放兄弟 effect（`Promise.all`），store 拥有的 append 发布钩子的移除与循环的关闭 `session/flush` 产生竞争；单一复合 effect 的有序 LIFO 链才能在两条释放路径上都捕获关闭的 `turn/end`。
- **在 `cancel()` 之外另设一个仅中止步骤的 `abort()`**：最初发布过，后因无人使用而移除；`cancel()` 是唯一的公开停止原语（见[公开停止接口 Agent Note](../simplification/2026-06-20-public-agent-stop-api.md)）。
- **Host 关闭请求直接 detach Session**：否决。SessionStore detach 是确切存储能力，不是 Agent teardown；直接调用会在移除 driver 的发布与持久性 owner 时，让 driver 和作用域依赖仍然存活。

## 后果

本决策有意触及公开接口（`Agent`、`AgentFactory`、`AgentRegistry` 与 bash seam），而非实现协议局部 teardown。同步 Agent 观察仍不携带能力；异步 close 只能经自有 handle 或注册表保留的工厂能力执行。
