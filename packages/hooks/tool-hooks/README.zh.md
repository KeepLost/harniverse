# @deepseek-ai/dsh-tool-hooks

[English](README.md) | 中文

面向模型的工作区 hook 管理:`hook_add`、`hook_remove`、`hook_list` 让智能体在会话中途安装、移除、列出会话 hook,无需知道 hook 文件的位置或其 Claude-Code 方言格式。

hook 是一条在生命周期节点(工具调用前后、每个提交的 prompt、会话启动、回合停止边界、子代理开启/关闭)自动运行的 shell 命令,可对智能体进行门控、增强或观察:拒绝或转人工审批一次调用、注入上下文,或仅做记录。这些工具写入的是 `@deepseek-ai/dsh-hooks-claude-code` 在**每个**事件都会重新读取的项目层方言文件,因此安装或移除自下一个匹配事件起生效——会话中途、无需重载——每次 hook 运行都以 `hook/invoked` + `hook/result` 落入会话日志。

模型面不暴露方言:平实的事件名(`pre_tool`、`prompt_submit` 等)、可选的正则匹配器、命令本身,以及一个简单的 stdout 契约(`{"action":"deny"|"ask"|"allow","reason":…}`、`{"context":"文本"}`)。内部实现上,每个受管条目把真实命令存放在 `run` 字段,并把桥可见的命令指向一个生成的适配器(`tool-hooks-adapter.mjs`,写在 hook 文件旁、按内容守护)——它把事件载荷管道给命令,再把简单契约翻译成方言的 `hookSpecificOutput` 信封。同文件中的手写条目原样运行,以位置名(`pre_tool#1`)列出;每次重写都保留外来根键,写入是原子的(临时文件 + 改名)。

## 配置

```ts
import type { Config } from '@deepseek-ai/dsh-tool-hooks'
const config: Config = {
  maxHooks: 256,
}
```

## 组合

- 需要 `ctx.tools`;每次调用都需要有工作区目录的 agent 支撑会话。
- `hook_add`/`hook_remove` 为独占(重写文件);`hook_list` 并发安全。
- 由 `standard`、`cordis`、`code` 三个 agent 预设挂载(与已挂载 Claude-Code 桥的预设相同)。`maxHooks` 限制单个工作区文件保留的 hook 组总数——受管加手写——默认 256。

## Model Experience

### Tool schemas

#### What the model sees

The model sees the [three generated workspace-hook schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-hooks): `hook_add`, `hook_remove`, and the read-only `hook_list` contract. An install carries a stable `name`, one of seven plain `event` values, an optional regex `matcher`, the `command`, and an optional `timeout_seconds`; no file paths or dialect terms appear anywhere.

#### Token effect

Three fixed schemas are sent on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each call returns one JSON document: the added or removed hook's view plus the effect note (`runs from the next matching event; an in-flight invocation is unaffected`), or the full hook list. Failures are plain-text reasons the model can act on, such as `a hook named "x" already exists; remove it first with hook_remove`.

#### Token effect

Results are small fixed-shape documents; `maxHooks` bounds how large a listing can grow.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- 受管条目经适配器为每次 hook 调用增加一个 `node` 进程;手写方言条目原样运行、零开销。
- 这些工具只管理项目层文件;用户层 hook 来源不进 `hook_list`,对其配置的事件继续生效。
- hook 命令经宿主 shell 服务的引号规则执行;内嵌双引号的路径仍是病态情形,手写 hook 本就如此。
