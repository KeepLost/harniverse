# @deepseek-ai/dsh-acp-client

[English](README.md) | 中文

与协议版本无关的 Agent Client Protocol（ACP）客户端核心。任何符合协议的 agent 都是一条 `AcpAgentDefinition`；`connectAcpAgent` 通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 接缝启动它，协商协议版本，并返回一个连接，其会话以归一化更新的形式流出。登录在 agent 首次要求时完成。该库负责协议与进程；从收到的事实中派生什么，由消费者自己负责：[`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) 收集一条回答，[`acp/agent-acp`](../agent-acp/README.md) 写入会话日志。

## 连接

```text
const connection = await connectAcpAgent({
  definition: { command: 'agent', args: ['acp'], env: {}, protocol: 1 },
  cwd: '/absolute/workspace',
  spawn: spec => ctx.subprocess.spawn(spec),
  permission: policyAnswerer('reject'),
  signal,
})
```

`connectAcpAgent` 启动 agent，发送 `initialize`，然后以活动连接兑现。任何失败（包括被取消的建立过程）都会在清理掉已启动的进程之后以 `AcpError` 拒绝；`AcpError.kind` 指出失败的来源（`spawn`、`handshake`、`auth`、`unsupported`、`protocol` 或 `transport`）。

| `AcpConnectOptions` | 默认值 | 含义 |
|---|---|---|
| `definition` | 必填 | 该 agent：`command`、`args`、显式 `env`、请求的 `protocol`、可选的固定 `profile`，以及登录时完成的可选 `authMethod`。 |
| `cwd` | 必填 | 进程及其每个会话的绝对工作目录。 |
| `spawn` | 必填 | 子进程接缝的启动函数；agent 沿用接缝的凭据清洗与整棵进程树的回收。 |
| `permission` | 拒绝每个请求 | 回答 agent 权限请求的 answerer。 |
| `questions` | 谢绝每个问题 | 回答 agent 提问的 answerer。 |
| `signIn` | 无 | agent 等待登录期间为该人做的事：显示它打印的地址，或请求一次终端登录。 |
| `profiles` | 无 | agent 画像，按优先级排列。 |
| `clientInfo` | `harniverse` 1.0.0 | 握手时本客户端报告的身份。 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、回收升级之前的窗口。 |
| `disposeGraceMs` | `3000` | POSIX 上 SIGTERM 与 SIGKILL 之间的宽限；Windows 直接强制终止。 |
| `signal` | 无 | 取消握手或 v2 到 v1 的回退。 |

只有当消费者提供某项可选客户端能力时，客户端才通告它：提供 `questions` 即表单 elicitation，提供 `signIn.terminal` 即终端登录。它不向 agent 提供文件系统或终端，agent 在它自己的进程里自理；对此类能力的请求以 `Method not found` 回答。

## 协议版本

`definition.protocol` 选择握手请求的版本。默认的 `1` 说稳定版协议。`2` 请求预览版协议，并在 agent 回答它只说 v1 时启动一个新的 v1 子进程。两个版本都不说的 agent 使握手失败。两个版本映射到同一组更新；v1 通过 `session/prompt` 的响应报告回合结束，因此 v1 绑定会合成 v2 agent 自己报告的 `running` 与 `idle` 状态。

## 会话与回合

一个连接承载任意数量的会话。`newSession()` 在连接的工作目录打开一个会话；`resumeSession()`、`listSessions()` 与 `closeSession()` 仅在 agent 通告了它们时可用，否则以 `unsupported` 类的 `AcpError` 拒绝。v2 agent 无需通告即须提供这三者。

`session.prompt(blocks, { signal })` 启动一个回合，并返回它的 `updates` 与 `end`。一个会话同时只跑一个回合：回合进行中再发 prompt 会拒绝。中止 `signal` 会立即在本客户端一侧以 `cancelled` 结束该回合，并发送 `session/cancel`；下一个 prompt 会等到 agent 安静下来，因此被取消回合的迟到更新永远不会进入其后的回合。agent 进程退出时，进行中的回合以传输错误拒绝，此后的操作一律拒绝。

会话还携带 agent 为它提供的东西：`modes`、`configOptions` 与 `commands`，取最后一次报告。`setMode(modeId)` 切换模式，`setConfigOption(configId, value)` 设置一个选项；两者都到达 agent，替换会话所报告的内容，并在 agent 拒绝时拒绝。什么都没报告的会话无处可切。

## 更新

每个 `session/update` 以一条 `AcpUpdate` 到达，按到达顺序排列。本客户端不解释的变体，或字段不符合其契约的已知变体，以 `other` 到达，绝不抛出。

| `kind` | 携带 |
|---|---|
| `message-chunk`、`thought-chunk` | 一个流式内容块。 |
| `message`、`thought` | 一次整消息 upsert（v2）。 |
| `tool-call` | 对一次工具调用的补丁：缺省的字段保持不变，`null` 清除它。 |
| `plan` | agent 的计划条目，整体一份；agent 保留多份计划时带上计划的 id。 |
| `plan-removed` | agent 撤下的计划的 id。 |
| `usage` | agent 报告的上下文窗口计量。 |
| `session-info` | agent 报告的会话标题与更新时间。 |
| `notice` | 给该人的一条通知。 |
| `mode` | 现在生效的模式。 |
| `config` | 一次变更之后每个配置选项的现状。 |
| `commands` | agent 在 prompt 内提供的每个命令。 |
| `state` | 前台工作 `running`、`idle`、`requires_action` 或 `unknown`，空闲时带停止原因。 |
| `other` | 任何其他变体，原样透传。 |

## 权限请求

agent 的 `session/request_permission` 以一条 `AcpPermissionRequest` 到达连接的 answerer，带上 agent 的选项；回答选中一个选项，或不给同意。抛出的 answerer 不给同意。`policyAnswerer('allow' | 'reject')` 提供两种固定策略；未指定 answerer 的连接拒绝每个请求。

## 提问

agent 的 `elicitation/create` 以一条 `AcpQuestionRequest` 到达连接的 `questions` answerer：agent 的消息，以及每个被请求属性一个字段 —— 自由文本、数字、是或否，或从有名称的值中选择，agent 允许时可多选。回答按名称携带各字段，或谢绝；本客户端无法表达的字段会在不提问的情况下谢绝整个请求。抛出的 answerer 取消该请求。要求该人打开某个地址的请求改去 `signIn.url`，有人展示时被接受，无人展示时被取消。

## 登录

已连接的 agent 永远不会被要求登录，直到它以 `Authentication required` 拒绝某个请求为止。被拒绝的请求 —— 打开会话、恢复会话或一次 prompt —— 随后等待方法完成，再被发送一次：agent 自驱的方法用 `authenticate`，由该人运行 agent 自己的程序一次来完成的方法用 `signIn.terminal`。同一时刻被拒绝的每个请求都加入正在进行的这一次登录；失败或被取消的登录不会被保留，下一次拒绝会重新开始。`connection.agent.authMethods` 列出 agent 提供的方法，终端方法带其参数与环境。agent 自驱的登录等待期间，它在 stderr 上打印的每个地址都到达 `signIn.url`，每个一次。没有针对 agent 所提供方法的钩子时，该请求以 `auth` 类的 `AcpError` 拒绝，并指明要运行的程序。

## agent 画像

agent 特定的行为是一个画像：一个 id、它适用的 `agentInfo.name` 值，以及至多一次请求改写。`connectAcpAgent` 在握手前固定 `definition.profile` 指明的画像，或选择 `agents` 列出了 agent 所报告名称的第一个已提供画像。没有画像时，协议路径不查阅任何画像。

## 已知 agent

`KNOWN_AGENTS` 是关于官方 ACP registry 所列、本客户端运行或探测过的 agent 的数据：每个如何通过 stdio 启动（`command`、`args`），从哪里读取 API 密钥（`credentialEnv`），如何登录，以及它报告的名称。`knownAgent(id)` 查找其中一个。协议路径不使用其中任何内容；消费者指明一个来补全定义。

## 回收

`dispose()` 以传输错误结束每个进行中的回合，关闭连接，并基于接缝的公开动词运行回收阶梯：stdin EOF、EOF 宽限，然后是 `terminate()`（SIGTERM、启动宽限、SIGKILL）以及子进程所有者的整棵进程树退出证明。它幂等。`disposeAcpChild(child, eofGraceMs)` 是同一阶梯，用于消费者自己启动的句柄。

## Model Experience

间接地，通过从归一化更新中派生模型可见事实的消费者：[`acp/agent-acp`](../agent-acp/README.md) 把外部 agent 的输出写成会话事件，[`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) 把一条回答返回给工具结果。

#### KV 缓存影响

本库不注册任何 harness 模型上下文。它只决定什么经由线路到达外部 agent；构建 prompt 的消费者拥有每个 token 及其复用。

## Known Limitations and Deferred Work

- **prompt 只有文本** — `AcpPromptBlock` 只携带 `text`；图像、音频与嵌入上下文的 prompt 需要本客户端未构建的、按能力门控的形状。
- **没有外部会话记忆** — 这里没有任何东西跨连接记录 agent 的会话 id；需要重新接入的消费者自己存储该 id 并调用 `resumeSession`。
- **不读取文档形式的计划** — 内容为 Markdown 的 `plan_update` 以 `other` 到达。
- **只有 stdio** — Streamable HTTP 与 WebSocket 传输在协议中仍是草案，这里没有对应绑定。
- **没有注册任何画像** — 四个已知 agent 在运行时都不需要请求改写；需要改写的 agent，画像就是它的去处。
