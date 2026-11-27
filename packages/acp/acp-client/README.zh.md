# @deepseek-ai/dsh-acp-client

[English](README.md) | 中文

与协议版本无关的 Agent Client Protocol（ACP）客户端核心。任何符合协议的 agent 都是一条 `AcpAgentDefinition`；`connectAcpAgent` 通过 [`dsh-subprocess`](../../subprocess/subprocess/README.md) 接缝启动它，协商协议版本，完成认证，并返回一个连接，其会话以归一化更新的形式流出。该库负责协议与进程；从收到的事实中派生什么，由消费者自己负责：[`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) 收集一条回答，[`acp/agent-acp`](../agent-acp/README.md) 写入会话日志。

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

`connectAcpAgent` 启动 agent，发送 `initialize`，完成 agent 仍需要的认证，然后以活动连接兑现。任何失败（包括被取消的建立过程）都会在清理掉已启动的进程之后以 `AcpError` 拒绝；`AcpError.kind` 指出失败的来源（`spawn`、`handshake`、`auth`、`unsupported`、`protocol` 或 `transport`）。

| `AcpConnectOptions` | 默认值 | 含义 |
|---|---|---|
| `definition` | 必填 | 该 agent：`command`、`args`、显式 `env`、请求的 `protocol`，以及可选的固定 `profile`。 |
| `cwd` | 必填 | 进程及其每个会话的绝对工作目录。 |
| `spawn` | 必填 | 子进程接缝的启动函数；agent 沿用接缝的凭据清洗与整棵进程树的回收。 |
| `permission` | 拒绝每个请求 | 回答 agent 权限请求的 answerer。 |
| `profiles` | 无 | agent 画像，按优先级排列。 |
| `clientInfo` | `harniverse` 1.0.0 | 握手时本客户端报告的身份。 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、回收升级之前的窗口。 |
| `disposeGraceMs` | `3000` | POSIX 上 SIGTERM 与 SIGKILL 之间的宽限；Windows 直接强制终止。 |
| `signal` | 无 | 取消握手、认证或 v2 到 v1 的回退。 |

本客户端不声明任何可选的客户端能力：它不向 agent 提供文件系统、终端或 elicitation，agent 在自己的进程里自给自足。对这类能力的请求会得到 `Method not found`。

## 协议版本

`definition.protocol` 选择握手请求的版本。默认的 `1` 使用稳定协议。`2` 请求 Preview 协议；当 agent 回答它只会说 v1 时，另起一个 v1 子进程。两种版本都不会说的 agent 会导致握手失败。两个版本映射到同一套更新；v1 通过 `session/prompt` 的响应报告回合结束，因此 v1 绑定会合成 v2 agent 自己报告的 `running` 与 `idle` 状态。

## 会话与回合

一个连接可以承载任意多个会话。`newSession()` 在连接的工作目录中打开一个会话；`resumeSession()`、`listSessions()` 与 `closeSession()` 仅在 agent 声明了对应能力时可用，否则以 `unsupported` 类的 `AcpError` 拒绝。v2 agent 无需声明即提供这三者。

`session.prompt(blocks, { signal })` 启动一个回合，并返回它的 `updates` 与 `end`。一个会话同一时间只运行一个回合：回合进行中再发 prompt 会被拒绝。中止 `signal` 会立即在客户端这一侧以 `cancelled` 结束该回合，并发送 `session/cancel`；下一个 prompt 会等到 agent 安静下来才开始，因此被取消回合的迟到更新永远不会混入后继回合。agent 进程退出时，进行中的回合以传输错误拒绝，后续操作也被拒绝。

## 更新

每个 `session/update` 都按到达顺序以一条 `AcpUpdate` 到达。本客户端不解读的变体，或字段不符合约定的已知变体，以 `other` 到达，绝不抛错。

| `kind` | 携带内容 |
|---|---|
| `message-chunk`、`thought-chunk` | 一个流式内容块。 |
| `message`、`thought` | 整条消息的更新插入（v2）。 |
| `tool-call` | 对一次工具调用的补丁：缺省的字段保持不变，`null` 表示清除。 |
| `plan` | agent 的计划条目。 |
| `usage` | agent 报告的上下文窗口用量。 |
| `session-info` | agent 报告的会话标题与更新时间。 |
| `notice` | 给人看的通知。 |
| `state` | 前台工作状态 `running`、`idle`、`requires_action` 或 `unknown`，空闲时附带停止原因。 |
| `other` | 其他任何变体，原样透传。 |

## 权限请求

agent 的 `session/request_permission` 以一条 `AcpPermissionRequest` 到达连接的 answerer，其中带有 agent 给出的选项；回答选择其中一个选项，或不给予同意。抛错的 answerer 等同于不给予同意。`policyAnswerer('allow' | 'reject')` 提供这两种固定策略；未指定 answerer 的连接拒绝每个请求。

## agent 画像

某个 agent 特有的行为是一个画像：一个 id、它适用的 `agentInfo.name` 取值，以及至多一个请求改写。`connectAcpAgent` 在握手前固定 `definition.profile` 指名的画像，或者选择第一个 `agents` 列出了 agent 所报告名称的已提供画像。没有画像时，协议路径不参照任何画像。

## 回收

`dispose()` 以传输错误结束每个进行中的回合，关闭连接，并通过接缝的公开动作运行回收阶梯：stdin EOF、EOF 宽限，然后是 `terminate()`（SIGTERM、启动宽限、SIGKILL）以及子进程拥有者的整棵进程树退出证明。它是幂等的。`disposeAcpChild(child, eofGraceMs)` 是同一个阶梯，供消费者对自己启动的句柄使用。

## Model Experience

Indirectly, through the consumers that derive model-visible facts from normalized updates: [`acp/agent-acp`](../agent-acp/README.md) writes an external agent's output as session events, and [`subagent/subagent-acp`](../../subagent/subagent-acp/README.md) returns one answer to a tool result.

#### KV Cache effect

本库不注册任何 harness 模型上下文。它只决定哪些内容经线路发往外部 agent；构建 prompt 的消费者拥有每一个 token 及其复用。

## Known Limitations and Deferred Work

- **Prompt 只有文本** — `AcpPromptBlock` 只携带 `text`；图像、音频与嵌入上下文的 prompt 需要本客户端尚不构建的、按能力门控的结构。
- **只有一种认证流程** — 本客户端完成 agent 声明的第一个 agent 驱动的认证方法，并拒绝只提供终端登录的 agent；在交互式终端中复现 agent 的调用方式尚属后续工作。
- **没有外部会话记忆** — 没有任何东西跨连接记录 agent 的会话 id；需要重新接入的消费者自行保存该 id 并调用 `resumeSession`。
- **只有 stdio** — Streamable HTTP 与 WebSocket 传输在协议中仍是草案，这里没有对应绑定。
