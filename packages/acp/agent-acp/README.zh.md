# @deepseek-ai/dsh-agent-acp

[English](README.md) | 中文

ACP 模式：其回合就是外部 Agent Client Protocol（ACP）agent 的回合的 agent。该行向作用域派生自其自身作用域的每个 agent 提供步骤驱动器，因此一个预设只需组合这一行就表达了 ACP 模式。此时 Harniverse 只是前端：外部 agent 自带模型、系统提示词、工具与技能，会话日志记录它产出的内容。协议、进程与回收属于 [`acp/acp-client`](../acp-client/README.md)。

## 预设模板

[`preset/acp/`](preset/acp/agent.cordis.yml) 是一个模板，不属于随发布提供的预设名册：外部 agent 需要你自己安装。把该目录复制到 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/acp/`，然后按你安装的 agent 设置 `command` 与 `args` —— Claude Code（`claude acp`）、Codex（`codex-acp`）、Gemini CLI（`gemini --experimental-acp`）、Antigravity（`agy acp`），或任何其他符合协议的 agent。agent 自身的登录，请在 harness 之外用它自己的程序完成一次。

该模板不带人设、工具、技能、MCP 服务器或模型路由：harness agent 会带来的一切，都由外部 agent 自己负责。

## 一个回合写入什么

[`dsh-agent`](../../core/agent/README.md) 的机器拥有回合及其步骤；本驱动器拥有步骤内部发生的事。一个步骤是外部 agent 回合的一个片段：流式回答成为 `assistant/chunk` 事件与一条 `assistant/message`，归属记为 `acp`。当外部 agent 报告一次工具调用时，该片段的消息携带这次调用，`tool/call` 记录它，`tool/result` 携带它报告的文本 —— 全部位于发起调用的那个步骤之内，因此每个结果都落在其调用旁边。工具调用之后的发言开启下一个步骤，并先等待每个未完成的调用报告完毕。`end_turn` 以 `completed` 关闭回合；`max_tokens` 以 `max-tokens` 关闭；拒绝、失败或 agent 一侧的取消以携带停止原因的错误关闭。

| 外部停止原因 | 回合结束方式 |
|---|---|
| `end_turn` | `completed` |
| `max_tokens` | `max-tokens` |
| `cancelled`，且回合在此处被取消 | `aborted` |
| `refusal`、`max_turn_requests`、`error`、未知 | `error`（`ACP_TURN`） |
| 连接中断或启动失败 | `error`（`ACP_TURN`）；下一个回合启动新进程 |

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `command` | 必填 | 通过 stdio 提供外部 agent 的可执行文件。 |
| `args` | `[]` | 传给 `command` 的参数。 |
| `env` | `{}` | 叠加在子进程接缝清洗后的父环境之上的环境变量。 |
| `cwd` | 每个会话的工作区 | 外部进程及其会话的工作目录。相对路径在加载时相对 harness 启动目录解析。 |
| `protocol` | `1` | 握手时请求的 ACP 版本：`1`，或带 v1 回退的 `2`。 |
| `permission` | `ask` | `ask` 把每个权限请求交给审批接缝，没有回答者时按拒绝处理；`allow` 选取 agent 的第一个允许选项；`reject` 拒绝每个请求。 |

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    command: claude
    args: [acp]
    env: {}
    permission: ask
```

## 进程生命周期

外部进程在第一个步骤启动，并为该 agent 之后的每个回合服务。agent 的作用域展开时它被回收；自行退出的进程会在下一个回合被新进程取代。它的 stderr 留在 harness 自己的 stderr 上。既没有工作区也没有配置 `cwd` 的会话，其第一个回合以 `ACP_NO_CWD` 失败，而不会把 agent 绑定到服务器的启动目录。

本包没有默认导出。否则 Cordis loader 的解包会隐藏具名的 `inject` 元数据；见[事后剖析 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)。

## Model Experience

### 外部 agent 的 prompt

#### 模型看到什么

只有人写下的文本，作为外部 agent 回合的 prompt。harness 插件注入会话日志的上下文不会被转发：外部 agent 拥有它自己的上下文。没有人工撰写文本的步骤发送占位符 `(no text content)`。

#### Token 影响

外部 agent 在它自己的账户下为它自己的上下文付费；本驱动器没有任何内容进入 harness 的模型请求。

#### KV 缓存影响

与每个 harness 请求缓存无关。复用取决于外部 agent 的提供方以及它收到的文本，而本驱动器原样传递该文本。

## Known Limitations and Deferred Work

- **外部会话不会在重启后延续** — 没有任何东西记录 agent 的会话 id，因此重启后的 harness 会打开一个新的外部会话，而 harness 的对话记录保留下来；持久化的恢复需要一种专属的会话事件。
- **只转发人工撰写的文本** — 附件与 harness 插件注入的上下文留在 harness 日志里，永远不会到达外部 agent。
- **工具结果只携带文本** — 一次调用的 `content` 条目只贡献其文本，别无其他；未报告任何内容的调用回退到其标题。
- **来自 agent 的图像与音频被丢弃** — 只写入文本与思考块；非文本输出需要本驱动器无法生成的附件引用。
- **计划、通知、用量与会话标题未被呈现** — 它们从客户端核心到达，被消费但不留持久记录。
- **每个预设一个外部 agent** — 在创建会话时从多个 agent 中选择，需要为每个 agent 复制一份预设。
