# Agent Note: 与版本无关的 ACP 客户端核心与 ACP 模式背后的步骤驱动器接缝

Status: implemented

[English](2026-11-27-acp-client-core-and-acp-mode.md) | 中文

> 同日由[按需的 ACP 登录、持久化的外部会话绑定，以及 agent 报告的内容](../feature/2026-11-27-acp-sign-in-session-binding-and-agent-state.md)修订：客户端在 agent 首次要求时完成登录，ACP 模式记录外部会话并在重新打开时重新接入。本 note 中与此相悖之处，描述的是首个版本。

## Problem

Harniverse 过去只能以两种方式使用 Agent Client Protocol：作为供自动化客户端驱动的服务器，以及作为一次性 subagent 后端——后者的协议代码与 subagent 契约融合在一起。两者都停留在 SDK 0.25.1。没有任何办法让人打开一个由外部 agent（Claude Code、Codex、Gemini CLI、Antigravity）担任主 agent 的会话并由 Harniverse 充当前端，而那个 subagent 后端也无法为此复用：它的进程、握手、权限策略与回收，都和 `SubagentResult` 的映射一起待在同一个模块里。

agent 工厂让情况更糟：它构造唯一一个具体驱动器类，该类的生命周期外壳与它的模型回合是同一个对象，因此第二种运行回合的方式没有可以挂靠的接缝，除非再复制一份外壳，或在工厂里写一个特例。

## Decision

协议迁入一个库，"步骤内部发生什么"成为一种可注册的贡献。

[`@deepseek-ai/dsh-acp-client`](../../../../packages/acp/acp-client/README.md) 为所有消费者拥有 ACP 的客户端一侧：agent 定义、基于子进程接缝的 stdio 传输、握手、认证、会话、回合路由、权限回答与回收阶梯。它的 API 与版本无关。一套 `AcpUpdate` 词汇同时覆盖协议 v1 与 v2，两者的差别只在于一个很小的 `ProtocolShape`；v1 通过 prompt 响应报告回合完成，因此它的 `running` 与 `idle` 状态是合成的，消费者无法区分版本。消费者提供启动函数、权限 answerer 与工作目录，并拥有它派生出的每一个持久事件。[`@deepseek-ai/dsh-subagent-acp`](../../../../packages/subagent/subagent-acp/README.md) 现在是它的一个薄消费者，行为与测试保持不变。

该库在 SDK 的 ndJSON 分帧之上自行讲 JSON-RPC。SDK 自带的客户端 app 会按照它的 schema 校验每个 `session/update`，并丢弃它不认识的变体，这会悄无声息地丢掉更新的 agent 所报告的内容；核心改为用自己的前向兼容解析器读取每个更新，因此未知变体以 `other` 透传，绝不抛错。

驱动器接缝把 agent 机器与步骤分开。[`@deepseek-ai/dsh-agent`](../../../../packages/core/agent/README.md) 的 `AgentMachine` 拥有每个驱动器共享的部分——收件箱、阶段状态机、取消、维护，以及领取输入、询问 `agent/pre-step`、追加进入的消息并关闭每个步骤与回合的回合脚手架。`StepDriver` 拥有一个步骤：在领取与 pre-step 决策之间的 `prepare`，以及针对获准步骤的 `run`。工厂构造机器，并在发布之前一次性封存其作用域链所贡献的驱动器；`ctx.agents.registerDriver()` 以 effect 为作用域并按作用域分层，因此预设行贡献驱动器的方式与它贡献工具的方式相同。[`@deepseek-ai/dsh-agent-loop`](../../../../packages/core/agent-loop/README.md) 保留生命周期拥有者的角色，并提供默认驱动器——模型循环，其步骤代码原样迁移。其他包的行为均未改变。

[`@deepseek-ai/dsh-agent-acp`](../../../../packages/acp/agent-acp/README.md) 是第二个驱动器：一个步骤是外部 agent 回合的一个片段。片段规则来自会话日志自身的约定与对话视图：每个步骤一条 `assistant/message`，每个 `tool/result` 都位于其 `tool/call` 所在的步骤。工具调用之后的发言开启下一个步骤，并等待未完成的调用报告完毕。该预设是一个供人复制的模板，而不是随发布提供的名册条目：外部 agent 需要人自己安装，而随发布提供的名册正是设置页与选择器快照所枚举的内容。

## Alternatives considered

**把协议留在 `subagent-acp` 里，让 ACP 驱动器去导入它。** 这样 subagent 契约（`SubagentRun`、停止原因的扁平化、`onError` 汇）就会成为会话驱动器所依赖的 API，而驱动器还要拥有它所需回合的第二份副本。独立成库让 subagent 包保持为消费者，并让进程、握手与回收只有一份实现。

**让驱动器通过 `llm/stream` 或 `agent/request` 替换模型流。** 这样模型循环仍会执行外部 agent 已经执行过的工具调用，而且是通过它从未注册的工具；权限请求则在回合中途从工具流水线之外到达。接缝应位于回合之下，而不是它的请求之内。

**为 ACP 模式再写一个 `Agent` 实现。** 模型循环所运行的外壳——唤醒锁存、取消收敛、维护、处置静默——精细且经过大量测试；第二份副本会漂移。机器只抽取一次，两个驱动器都跑在它上面。

**通过 `TurnDriver` 组合整个回合，保持模型循环的回合不动。** 这样 ACP 驱动器就要把回合脚手架（领取、pre-step、进入的消息、未完成工具结果的恢复）复制成一份克隆。在步骤处切分，让脚手架只存在于一处。

**在线路上使用 SDK 的客户端 app。** 它会丢弃 schema 之外的更新变体，因此更新的 agent 的输出会被悄无声息地丢失；它也没有提供读取原始 `session/update` 的途径。这个 JSON-RPC peer 很小，且完全处于本仓库的测试之下。

**把 ACP 预设随名册发布。** 这会向每一个没有安装外部 agent 的人宣传一个会失败的模式，并且会改变设置页与选择器的快照。模板让该模式保持为明确的自主选择。

## Consequences

任何符合协议的 ACP agent 都只差一条定义，v1 或 v2 皆可，且只有一套回收与一条权限路径；协议的新消费者无需编写协议代码。步骤接缝是通用的：另一种引擎就是一个已注册的驱动器加一行预设，而不是工厂的改动。

代价是 `dsh-agent` 的接口面变宽（机器与注册表），以及 SDK 版本的分化：自动化服务器及其快照套件停留在 0.25.1，直到它们被移植到 SDK 的 2.x agent app，那是一项独立的改动。ACP 模式只转发人工撰写的文本，丢弃 agent 的非文本输出，且不在重启后恢复外部会话；每一项都列在所属的 README 中。

所需验证：客户端核心的测试针对脚本化的内存 agent 与真实进程的回收阶梯覆盖了每一个分支；机器与注册表由 `dsh-agent` 的测试套件以及保持不变的 `dsh-agent-loop` 测试套件覆盖；ACP 驱动器通过真实工厂、针对真实子进程中的脚本化 agent 进行覆盖；另有一个 Loader smoke 端到端地启动一份复制来的预设模板。
