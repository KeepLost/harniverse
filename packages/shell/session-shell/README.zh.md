# @deepseek-ai/dsh-session-shell

[English](README.md) | 中文

路由化 [`ctx.shell`](../shell/) 缝之上的会话级 shell 家族指针：`sessionShell` 服务持有会话下一个模型请求在哪个 shell 家族（bash | pwsh）下运行。与 [`dsh-shell-router`](../shell-router/)（同时挂载两家族的基座）一起组合——`dsh-tool-bash` 与 `dsh-tool-pwsh` 都保持注册，指针为该会话退役非活跃家族的工具。

包根导出 `SessionShellService`、`session-shell/change` 事件类型、`sessionShell` projection、`SESSION_SHELL_CONTEXT` 节与钉死的 `CONTEXT_TEXT`。

## 行为

- **纪元语义。** `switch(agent, family)` 校验存活、路由器可用性与目标家族，然后追加一条 durable `session-shell/change` 事件并折叠 `sessionShell` projection（last-wins）。切换在下一个模型请求生效：运行时上下文快照宣布新家族（该上下文节取代 environment 节不再陈述的 shell 事实），退役家族的工具离开该请求的目录。在途 shell 调用照常完成；两家族的后台终端与持久 shell 继续运行；什么都不拆。
- **按 agent 的工具限制。** 在 `agent/created` 与每次切换时，服务在该 agent 的作用域上下文上施行 `tools.restrict({ deny: [另一家族工具] })`——与呈现、查找、分发共用的同一可见性解析器——退役工具对该 agent 从 schema、查找、执行原子消失。上下文不带作用域的 agent（结构性桩）跳过限制而不抛错。
- **串行化变更。** 同一 agent 上的并发切换串行；最后者按序胜出，被拒绝的操作也会把队列排空。
- **能力读取。** `describe()` 返回 `{ switchable, families }`——路由宿主报告路由器的可用性；单执行器宿主报告其启动默认值且 `switchable: false`。路由器探测是结构化的（看 `availability()` 是否存在），绝不 `instanceof`。
- 无记录覆盖时的**默认解析**：路由器的生效家族，否则平台分裂。

```yaml
- id: shell
  name: '@deepseek-ai/dsh-shell-router'
- id: session-shell
  name: '@deepseek-ai/dsh-session-shell'
```

HTTP 面是 sessions API 上的 `session.shell`（observe）与 `session.switchShell`（operate）；无此服务的宿主答 `shell-unavailable`。

## Model Experience

### 运行时上下文节

#### 模型看到什么

运行时上下文快照里一行钉死的文本，陈述会话的 shell 家族（如 `Shell: bash`）——不在被缓存的 environment 节里。切换后，下一请求的 partial 上下文快照携带新行。

#### Token 影响

每次请求在运行时上下文节内一行。

#### KV Cache 影响

家族切换追加一份 partial 上下文快照（按请求事实的常设机制）；system prompt 与保留历史前缀逐字节不变，既有 KV-cache 条目仍然可用。

### 家族工具可见性

#### 模型看到什么

请求的工具目录里只出现活跃家族的工具（`bash` 或 `pwsh`）；切换落定的同一口气里调用退役家族的工具得到 `UNKNOWN_TOOL`，运行时以标准未知工具指引作答。

#### Token 影响

一份工具 schema 而非两份。

#### KV Cache 影响

工具目录变化骑在同一请求边界快照上；对历史是 append-only。

## Known Limitations 与遗留工作

- **切换需要路由器**——单执行器宿主上 `switch` 拒绝、`describe()` 报 `switchable: false`；对只组合一个家族的宿主没有执行器迁移故事。
- **限制是 agent 作用域而非会话作用域**——在注册工具不同的组合下恢复的会话，其初始限制仍会在 `agent/created` 重算；但两家族工具都不注册的组合无物可退役。
- **projection 在分发时折叠**——committed 映射桥接 append 到分发的窗口，使背靠背切换不会读到陈旧家族；只读 durable 日志的读者按序看到事件。
