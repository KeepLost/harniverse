# Agent Note：按需的 ACP 登录、持久化的外部会话绑定，以及 agent 报告的内容

状态：已实现

[English](2026-11-27-acp-sign-in-session-binding-and-agent-state.md) | 中文

## 问题

[ACP 模式](../architecture/2026-11-27-acp-client-core-and-acp-mode.md)交付时基于三个假设：agent 在 harness 连接前已经登录，harness 会话从不重新打开，agent 除文本与工具调用外不报告任何东西。拿人们实际使用的 agent 一跑，每个假设都不成立。

官方 registry 2026-11-26 的协议矩阵覆盖 42 个 agent：17 个只提供终端登录，27 个在人登录之前拒绝 `session/new`。客户端在握手时完成一种 agent 自驱方法，并拒绝所有其他 agent，于是它要么去问一个已经登录的 agent，要么拒绝一个尚未登录的 agent。Claude Code 适配器更进一步：它答复 `session/new`，却拒绝第一个 `session/prompt`，所以对它来说握手时的认证根本就是错误的时机。

没有任何东西记录外部 agent 的会话 id。因此 harness 一次重启之后，在仍保有整段对话的对话记录之下打开了一个全新的外部会话，而下一个问题 —— "那第二个呢？" —— 到达的是一个对第一个毫无记忆的 agent。并且 agent 的计划、标题、通知、提问、模式与选项从客户端核心到达后被丢弃：提问被答以 `Method not found`，计划从不出现，不离开 harness 就无法切换 agent 的模型。

## 决策

**登录等待 agent 提出要求。** [`@deepseek-ai/dsh-acp-client`](../../../../packages/acp/acp-client/README.md)在握手时不完成任何认证。当 agent 以 `Authentication required`（`-32000`）答复某个请求时，该请求 —— 打开或恢复会话，或一次 prompt —— 等待方法完成，然后再发送一次：agent 自驱的方法用 `authenticate`，由该人运行 agent 自己的程序一次来完成的终端方法用消费者的钩子。同一时刻被拒绝的请求共享同一次登录；失败或被取消的登录不被保留。agent 等待期间在 stderr 上打印的每个地址都到达消费者，每个一次。方法取 `authMethod` 指明者，否则取第一个 agent 自驱方法，再否则取第一个终端方法。

**绑定是一个会话事件。** [`@deepseek-ai/dsh-agent-acp`](../../../../packages/acp/agent-acp/README.md)在会话于 agent 上打开时追加 `acp/session`：agent 的会话 id、它的启动方式，以及工作目录。重新打开的会话通过 `session/resume` 或 `session/load` 重新接入，条件是它自己的日志持有绑定、agent 通告支持恢复，并且该行在同一目录启动同一个 agent；不再持有该会话的 agent 得到一个新会话，对话记录会说明这一点。"它自己的日志"是会话在 `header.seedLength` 之上的后缀，分叉（父会话事件的副本）正是由此与父会话的外部会话隔开。

**agent 报告的内容去往 harness 已有展示的地方。** 计划经 `todo/write` 成为会话的常驻待办列表；标题成为会话标题，直到该人自己为会话命名；通知成为对话记录中的一条通知消息；提问经 user-questions 接缝成为一个问题，并被记录为一次已完成的 `acp_question` 调用；模式、选项与命令为三个命令 —— `/acp`、`/acp-mode`、`/acp-option` —— 保留，由它们经 `session/set_mode` 与 `session/set_config_option` 切换。没有人撰写输入的步骤，在没有外部回合打开时，不启动外部回合：它被记入日志并随即完成，这也正是通知或登录地址不会变成 prompt 的原因。

**该行认识人们指名的 agent。** `KNOWN_AGENTS` 记载 registry 中四个 agent 各自如何启动、从哪里读取 API 密钥，以及如何登录；`agent: claude-acp` 补上该行未设置的命令。密钥经 `credentialEnv` —— 环境变量 → 凭据引用，每次启动时经凭据服务解析 —— 传递，绝不写进预设文件。

## 考虑过的替代方案

**像以前一样在握手时完成认证。** 它会去问一个已经登录的 agent；对 Claude Code 适配器而言它还是错误的时机：会话可以打开，被拒绝的是第一个 prompt。在第一次被拒绝时完成，对两类 agent 都适用，也使已登录的 agent 完全不会被问。

**只在 `session/new` 周围询问。** Codex 拒绝会话；Claude Code 适配器拒绝的却是 prompt。重试包住回合所依赖的每个请求。

**在出现能运行其程序的终端接缝之前，一律拒绝仅终端登录的 agent。** web 终端只运行发现的 shell，而附着进去以便键入的插件会把浏览器降为只读。harness 请该人运行方法所指明的程序，并说明何时完成，这在每个能显示问题的界面上都可行，且不需要新的接缝。

**在模型选择器中呈现模式与选项。** 选择器的目录由 LLM adapter 在宿主范围内构建，没有按会话贡献的入口，并且它以一个 ACP 模式并不使用的、已服务的默认模型为阻塞条件。三个命令到达同样的 agent 操作而不触碰选择器，并且只出现在该预设驱动的会话上。

**agent 无法恢复时，把 harness 的对话记录作为前言转发。** 这与该模式"只有人撰写的文本到达 agent"的规则相悖，而且这里探测过的每个 agent 都能恢复。取而代之的是打开一个新的外部会话并予以告知；前言仍留待 owner 决定。

**为计划列表组合 todo 工具。** 该工具注册一个 `todo_write` 工具，并在回合带着未完成的待办停止时排入一条续接消息，在 ACP 模式下这会变成一个 prompt。驱动器以自己的单元安装同一个 `todos` 折叠，键就是对话已经在读的那个。

## 后果

agent 恰好在它要求登录时被要求登录，经它自己的浏览器流程，或经该人运行的一个程序；重新打开的会话延续外部 agent 的上下文；agent 的计划、标题、通知、提问与切换在 harness 中可见且可切换。

`acp/session` 是只增策略下的一个只增会话事件：`SESSION_FORMAT_VERSION` 保持 `0`，持久化目录与会话契约摘要已为它重新生成。不认识该事件的读取者会拒绝该日志，一如它对待每个它不认识的必需事件。摘要基线的只增漂移就是这一个事件。

对真实适配器的运行发现了一个脚本化 agent 无法暴露的缺陷：agent 留下的流可能失败不止一次 —— 在它死后的每一次写入都是一个 `error` 事件 —— 只为第一次注册的监听器使第二次无人观察，而这会终止进程。传输层现在在其流的整个生命期内保留监听器。

保持原样、各自记在所属 README 中的有：附件不转发；agent 的图像与音频被丢弃；用量不呈现；重新打开之后 agent 报告的标题，在已应用过更早的标题时不再应用；每个预设一个外部 agent。内容缺口与单 agent 限制已在 [ACP 内容传递与一个预设中的多个 agent](2026-11-28-acp-content-passage-and-several-agents.md) 中闭合。

## 要求的验证

客户端核心针对内存中的脚本化 agent 逐分支覆盖 —— 会话与 prompt 的拒绝重试路径、固定的方法、终端钩子、地址监视、选项与模式的报告和切换、提问的解析与回答 —— 并以真实的 Claude Code 与 Codex 适配器所记录的握手与会话建立答复经真实绑定回放。驱动器经真实工厂针对真实子进程中的脚本化 agent 覆盖：绑定事件、经 JSONL 持久化重新打开并重新接入、新会话回退及其通知、`resume: false`、另一个 agent 的绑定、分叉、仅插件的步骤、计划列表、标题、通知、已回答与已谢绝的提问、三个命令、已解析与缺失的凭据，以及一个已知 agent 的启动。一次 Loader 冒烟端到端启动复制后的模板。

真实适配器于 2026-11-27 经该插件运行：Claude Code 适配器经一个中转站回答了一个回合，呈现了它发布的一条通知，并且 —— 在 harness 被销毁、会话重新打开之后 —— 回答了关于它自己先前答复的问题，这证明重新接入恢复了它的上下文。Codex 适配器经其 `api-key` 方法走了同一条路径并打开了会话；其中转站的 Responses 路由答复 502，因此没有得到它的模型答复。两者都可通过 `packages/acp/agent-acp/tests/real-agents.e2e.ts` 中的 `DSH_ACP_REAL=claude` 或 `codex` 按需运行，运行于一个临时 HOME 之下，否则保持跳过。
