# @deepseek-ai/dsh-agent-acp

[English](README.md) | 中文

ACP 模式：其回合就是外部 Agent Client Protocol（ACP）agent 的回合的 agent。该行向作用域派生自其自身作用域的每个 agent 提供步骤驱动器，因此一个预设只需组合这一行就表达了 ACP 模式。此时 Harniverse 只是前端：外部 agent 自带模型、系统提示词、工具与技能，会话日志记录它产出的内容。协议、进程、登录与回收属于 [`acp/acp-client`](../acp-client/README.md)。

## 预设模板

[`preset/acp/`](preset/acp/agent.cordis.yml) 是一个模板，不属于随发布提供的预设名册：外部 agent 需要你自己安装。把该目录复制到 `${DSH_HOME:-$HOME/.dsh}/.agent-presets/acp/`，用 `agent` 指明你安装的 agent —— `claude-acp`（Claude Code）、`codex-acp`（Codex）、`gemini`（Gemini CLI）或 `antigravity-acp`（Google Antigravity）—— 对于任何其他符合协议的 agent，则用 `command` 与 `args`。已知 agent 会补上该行未设置的命令。

该模板不带人设、工具、技能、MCP 服务器或模型路由：harness agent 会带来的一切，都由外部 agent 自己负责。

## 一个回合写入什么

[`dsh-agent`](../../core/agent/README.md) 的机器拥有回合及其步骤；本驱动器拥有步骤内部发生的事。一个步骤是外部 agent 回合的一个片段：流式回答成为 `assistant/chunk` 事件与一条 `assistant/message`，归属记为 `acp`。当外部 agent 报告一次工具调用时，该片段的消息携带这次调用，`tool/call` 记录它，`tool/result` 携带它报告的内容 —— 全部位于发起调用的那个步骤之内，因此每个结果都落在其调用旁边。工具调用之后的发言开启下一个步骤，并先等待每个未完成的调用报告完毕。`end_turn` 以 `completed` 关闭回合；`max_tokens` 以 `max-tokens` 关闭；拒绝、失败或 agent 一侧的取消以携带停止原因的错误关闭。

没有人撰写的步骤 —— 在没有外部回合打开时由 harness 插件注入的上下文 —— 不启动外部回合：它被记入日志，该步骤随即完成。

| 失败情形 | 回合结束方式 |
|---|---|
| 连接中断或启动失败 | `error`（`ACP_TURN`）；下一个回合启动新进程 |
| 无人完成的登录 | `error`（`ACP_TURN`），指明登录方法或要运行的程序 |
| 无人存储的凭据引用 | `error`（`ACP_CREDENTIAL`），指明该引用 |
| 既没有工作区也没有配置 `cwd` 的会话 | `error`（`ACP_NO_CWD`），而不会把 agent 绑定到服务器的启动目录 |

## 图像

该人的图像随其文本一同传递，并保持他们撰写的顺序：每张图像从附件存储读回，作为一个图像块发送；只有当 agent 的握手允诺了图像 prompt 时，它才会接收图像块。agent 无法接收、没有存储持有，或存储无法读回的图像留在原处；回合继续进行，对话记录中的一条通知指明该图像与原因。该人附加的通用文件，经由其句柄文本的只读路径到达 agent，由 agent 自己的工具读取。

agent 发来的图像以附件形式进入日志：它流式发来的图像被存储并写在其文本之后，工具调用报告的图像则落在该调用结果中的位置上，因此对话会展示这两者。存储无法保存的图像 —— 它不存储的类型、无法解码的字节 —— 成为一段说明此事的文本注释。在其回合结束前被中断的消息保留其文本，不保留任何图像。

这需要组合中有附件存储（[`attachment/attachment-local`](../../attachment/attachment-local/README.md)）；没有它时，每张图像都留在原处或成为一条注释。

## 登录

只有当 agent 以此为由拒绝请求时，才会要求它登录，因此已经登录的 agent 永远不会被要求。完成的方法是 `authMethod` 指明的那一个，否则是 agent 通告的第一个 agent 自驱方法，再否则是第一个终端方法。agent 自己驱动的浏览器登录在需要它的那个回合内进行；它等待期间打印的每个地址都以通知的形式落入对话记录。终端登录变成一个问题，指明要在终端里运行一次的程序，并等待该人说明已完成；没有 user-questions 接缝时，回合失败并指明该程序。

## 外部会话

第一个回合在 agent 上打开一个会话，并把它以 `acp/session` 记入会话日志：agent 的会话 id、它的启动方式，以及工作目录。harness 重新打开该会话时，只要 agent 仍持有那个会话并通告支持恢复，下一个回合就会重新接入那个外部会话；无论哪种情况，harness 的对话记录都保留。不再持有该会话的 agent 会得到一个新会话，对话记录会说明这一点。分叉继承其父会话的事件，但没有属于它自己的事件，因此它打开自己的外部会话。`resume: false` 在每次 harness 启动时打开一个新的外部会话。

## 一个预设中的多个 agent

该行可以在 `agents` 下指明多个 agent；会话随后运行 `default`，否则运行第一个条目，直到该人用 `/acp-agent` 另作选择。切换会回收正在运行的 agent 的进程；所选 agent 的下一条消息，会在它仍持有本会话早先打开的外部会话时继续该会话，否则打开一个新会话。重新打开的会话继续使用它上次交谈的 agent。该人的选择在 harness 进程的生命周期内保留；在会话最后一条消息之后作出的切换，不会在重启后被记住。

## agent 报告什么

| 报告 | 去向 |
|---|---|
| 计划 | 会话的常驻待办列表（`todo/write`），即对话中展示的列表；每次报告整体替换它。 |
| 以文档形式保存的计划 | 对话记录中的一条通知，携带该文档的全文，以及 agent 指明时它所在的文件；内容未变的文档只展示一次。 |
| 标题 | 会话标题，直到该人自己为会话命名为止；已应用的标题记录为 `acp/title`，因此会话重新打开后，agent 之后的标题仍然生效。 |
| 通知 | 对话记录中的一条通知；它不启动外部回合。 |
| 提问 | 通过 user-questions 接缝向该人提出的一个问题，逐字段作答；提问与回答被记录为一次已完成的 `acp_question` 调用，位于该 agent 的工具调用旁边。没有该接缝时，问题被谢绝。 |
| 模式、选项、命令 | 为 `acp` 命令保留，并被之后的每次报告替换。 |
| 上下文与费用 | [`dsh-agent`](../../core/agent/README.md) 词表中只记入日志的 `agent/context` 记录：agent 在上下文中持有的 token 数、它据此预算的窗口，以及迄今的会话费用。token 计量器的占用环读取它，`/acp` 打印它。重复现有记录的报告不写入任何内容。 |

## acp 命令

该行为它驱动的会话注册四个命令。`/acp` 显示外部 agent、它的会话、可供选择的 agent、它的模式、它的选项、它在 prompt 内提供的命令，以及它报告过的上下文与费用。`/acp-agent` 列出可供选择的 agent 并标出当前生效的那一个；`/acp-agent <name>` 选择接下来各条消息运行的 agent，回合运行期间该切换被拒绝。`/acp-mode <mode>` 切换会话的模式。`/acp-option <option> <value>` 按 id 或名称设置一个选项 —— 模型、推理力度、速度 —— 布尔选项用 `true`/`false`；不带值时显示该选项的现状。切换通过 `session/set_mode` 或 `session/set_config_option` 到达 agent，agent 不提供时被拒绝。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `agent` | 无 | 已知 agent —— `claude-acp`、`codex-acp`、`gemini` 或 `antigravity-acp` —— 其命令与参数补上该行未设置的部分。 |
| `command` | 已知 agent 的 | 通过 stdio 提供外部 agent 的可执行文件。除非 `agent` 指明知 agent，否则必填。 |
| `args` | 已知 agent 的，否则 `[]` | 传给 `command` 的参数。 |
| `env` | `{}` | 叠加在子进程接缝清洗后的父环境之上的环境变量。 |
| `credentialEnv` | `{}` | 环境变量 → 凭据引用。每个引用在每次启动时经凭据服务解析，并作为该变量交给 agent，因此预设里不写入任何密钥。 |
| `agents` | 无 | 该行可驱动的具名 agent，每个是一个带上文七个键的对象。会话用 `/acp-agent` 选取其一。不与顶层的 `agent` 或 `command` 同时使用。 |
| `default` | `agents` 的第一个条目 | 会话运行的 agent，直到该人另作选择。 |
| `cwd` | 每个会话的工作区 | 外部进程及其会话的工作目录。相对路径在加载时相对 harness 启动目录解析。 |
| `protocol` | `1` | 握手时请求的 ACP 版本：`1`，或带 v1 回退的 `2`。 |
| `authMethod` | agent 的第一个 | agent 要求登录时该行完成的登录方法的 id。 |
| `resume` | `true` | harness 重新打开会话时，是否重新接入其日志记录的外部会话。 |
| `permission` | `ask` | `ask` 把每个权限请求交给审批接缝，没有回答者时按拒绝处理；`allow` 选取 agent 的第一个允许选项；`reject` 拒绝每个请求。 |

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    agent: claude-acp
    env: {}
    permission: ask
```

```yaml
- id: agent-acp
  name: '@deepseek-ai/dsh-agent-acp'
  config:
    agents:
      claude:
        agent: claude-acp
      codex:
        agent: codex-acp
        credentialEnv:
          OPENAI_API_KEY: OPENAI_API_KEY
    default: claude
    permission: ask
```

## 进程生命周期

外部进程在第一个步骤启动，并为该 agent 之后的每个回合服务。agent 的作用域展开时、该人切换到另一个 agent 时，它被回收；自行退出的进程会在下一个回合被新进程取代。它的 stderr 留在 harness 自己的 stderr 上；它在登录期间打印的地址在途中从中读取。

本包没有默认导出。否则 Cordis loader 的解包会隐藏具名的 `inject` 元数据；见[事后剖析 0001](../../../docs/postmortem/0001-acp-default-export-drops-inject.md)。

## Model Experience

### 外部 agent 的 prompt

#### 模型看到什么

该人撰写的文本与图像，保持他们的顺序，作为外部 agent 回合的 prompt。harness 插件注入会话日志的上下文不会被转发：外部 agent 拥有它自己的上下文。既没有文本也没有被转发的图像的人工消息发送占位符 `(no text content)`。

#### Token 影响

外部 agent 在它自己的账户下为它自己的上下文付费；本驱动器没有任何内容进入 harness 的模型请求。

#### KV 缓存影响

与每个 harness 请求缓存无关。复用取决于外部 agent 的提供方以及它收到的内容，而本驱动器原样传递这些内容。

## Known Limitations and Deferred Work

- **agent 流式发来的图像排在其文本之后** — 一个片段的文本是一个块，它流式发来的图像排在该块之后，与到达顺序无关；工具调用报告的图像保持在该调用结果中的位置。
- **音频在两个方向上都不传递** — harness 不存储音频附件，客户端也不发送音频块。
- **文档计划以其文本展示** — 通知原样携带该文档；它不按 Markdown 渲染，其中的复选框也不进入待办列表。
- **agent 的选择只为 harness 进程保留** — 最后一条消息之后作出的切换不会在重启后被记住，创建会话的对话框也不提供 agent 选择器；`/acp-agent` 就是那个切换。
- **`todos` 列表只有一个单元** — 挂载 todo 工具的组合必须去掉该行的列表，反过来也一样。
- **没有附件、文件系统、终端或 MCP 透传** — 客户端不通告这些能力，因此 agent 读写它自己进程的文件。
