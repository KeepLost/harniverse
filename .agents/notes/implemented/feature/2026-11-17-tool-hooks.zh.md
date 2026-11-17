# Agent Note:tool-hooks——面向模型的工作区 hook 管理器

Status: implemented

[English](2026-11-17-tool-hooks.md) | 中文

## 问题

会话中途自定义 hook 在用户层早已可行:写入 Claude-Code 方言的项目文件(`.dsh/hooks/claude-code.json`)会自下一个匹配事件起生效,因为 `dsh-hooks-claude-code` 在每个挂点都重新读取其来源。但模型侧的唯一路径是"知道这个约定"——文件路径、方言事件名、matcher 组结构,以及 `hookSpecificOutput` 输出信封,全是模型没有正规渠道习得的内部词汇;而手写信封(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask",…}}`)恰恰是不该指望模型每次都写对的序列化细节。

## 决策

- **由工具包持有方言**(`@deepseek-ai/dsh-tool-hooks`,挂载于 `standard`、`cordis`、`code` 预设——与已挂载 Claude-Code 桥的预设相同;`minimal` 两者皆无)。`hook_add` / `hook_remove` / `hook_list` 以命名 hook 管理,使用平实事件名(`pre_tool` … `subagent_stop`)、可选正则匹配器(写入时校验,坏模式永远不会毒化桥的逐事件解析)、命令与超时。模型永远看不到路径或方言词。
- **由生成的适配器持有输出信封。** 受管条目把模型的命令存于 `run` 字段;桥可见的命令调用 `tool-hooks-adapter.mjs`(写在 hook 文件旁、按内容守护、绝对带引号路径,子代理工作区也能解析)。适配器把事件载荷管道给命令,并把简单 stdout 契约——`{"action":"deny"|"ask"|"allow","reason"}`、`{"context":"…"}`——翻译成方言的 `hookSpecificOutput` 信封,并从刚读到的载荷打上 `hookEventName`。纯文本、非 JSON stdout 与非零退出原样透传,退出码语义与仅观察型 hook 照旧可用。
- **文件保持权威且共享。** 工具原地重写方言文件(原子临时文件 + 改名),保留外来根键、外来事件与手写组;手写组以位置名(`pre_tool#1`)列出,亦可移除。每个受管组嵌入的 `name` 字段被桥解析器忽略(未知字段被跳过),但正是工具赖以工作的稳定标识。因为执行者始终是桥而非工具,"中途生效"性质被完整继承:下一个匹配事件读到新文件,无需重载,`hook/invoked` + `hook/result` 审计每次运行,`ask` 决策走既有审批缝。
- **边界**:`maxHooks`(默认 256)限制单文件总组数;超时上限取方言默认(600 秒);无匹配主体的事件组合(`prompt_submit`、`stop`)传入 matcher 会被拒绝而非静默丢弃。

## 备选方案

- **在提示节里教约定**(不加工具):方言信封仍留在模型手里,只随提示发布而存在,变更仍需文件写工具。被否决——在有类型化表面的成本低廉时这太脆弱。
- **直接注册内存监听器**(按名字订阅 `tools/pre-execute` 的工具):绕过桥,方言的每个特性(matcher、超时、stderr 摘要、分离式生命周期挂点、审计事件对、审批 ask 路径)都要重新实现,且 hook 随进程消亡而非持久化在桥已拥有的文件里。被否决——那会成为第二台更弱的 hook 引擎。
- **用 `tool-cordis` 动态插件当 hook 面**:能力更强,但 JS 插件体比一条 shell 命令重得多,且 `cordis` 预设并非处处存在。保留为需要真实 `ctx` 的 hook 的逃生通道;`tool-hooks` 服务 shell 命令形态。

## 后果

- 三个主流预设上的任意智能体都能会话中途装 hook("每次 bash 前先问"是一次工具调用的事),用户可在会话日志审计;移除对称。
- 适配器为每次受管 hook 调用增加一个 `node` 进程;手写 hook 与桥的全部行为不变。
- Windows 注意:hook 命令经 shell 服务的引号规则执行;内嵌双引号的路径仍是病态情形(手写 hook 本就如此)。
- `name`/`run` 字段是方言文件中一个稳定的附加约定;未来若桥长出自己的原生命名,应将二者视为保留字段。
