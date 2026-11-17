# @deepseek-ai/dsh-tool-hooks

[English](README.md) | 中文

面向模型的三作用域 hook 管理:`hook_add`、`hook_remove`、`hook_list` 负责安装、移除、列出位于 `session`(仅本会话,保存在会话日志并被子代理继承)、`workspace`(此工作区目录下所有会话)或 `global`(此用户所有会话)作用域的 hook——模型全程看不到文件路径或 Claude-Code 方言。

hook 是一条在生命周期节点(工具调用前后、每个提交的 prompt、会话启动、回合停止边界、子代理开启/关闭)自动运行的 shell 命令,可对智能体进行门控、增强或观察:拒绝或转人工审批一次调用、注入上下文,或仅做记录。任何作用域都自下一个匹配事件起生效——会话中途、无需重载——每次 hook 运行都以 `hook/invoked` + `hook/result` 落入会话日志。

会话级 hook 是与会话及沙箱模式完全同类的持久会话状态:`hook_add`/`hook_remove` 追加一条 `hook/config` 快照事件(末事件胜),Claude-Code 桥在每个挂点把它折出来并排在一切文件源之前(特异性序 `session → user → project → plugin → policy`),因此同工作区的两个会话绝不会看到彼此的会话 hook,重启即免费重放。子代理在启动时通过 `source: 'delegation'` 下种一次性继承委派父级的会话 hook。修改会话级 hook 需要处于 supervised 模式;unsupervised 会话会被拒绝(失败即关闭),使会话无法悄悄重新武装自己——文件作用域则一如既往保持开放。

模型面不暴露方言:平实的事件名(`pre_tool`、`prompt_submit` 等)、可选的正则匹配器、命令本身,以及一个简单的 stdout 契约(`{"action":"deny"|"ask"|"allow","reason":…}`、`{"context":"文本"}`)。内部实现上,每个受管条目把真实命令存放在 `run` 字段(会话条目经适配器 argv 内联传递),并经由唯一一个生成的适配器(`$DSH_HOME/hooks/tool-hooks-adapter.mjs`,按内容守护)执行——它把简单契约翻译成方言的 `hookSpecificOutput` 信封。同文件中的手写条目原样运行,以位置名(`pre_tool#1`)列出;每次重写都保留外来根键,写入是原子的(临时文件 + 改名)。

## 配置

```ts
import type { Config } from '@deepseek-ai/dsh-tool-hooks'
const config: Config = {
  maxHooks: 256,
}
```

## 组合

- 需要 `ctx.tools`;每次调用都需要 agent 支撑会话,workspace 作用域还需要会话工作区目录。
- `hook_add`/`hook_remove` 为独占(重写一个存储);`hook_list` 并发安全。
- 由 `standard`、`cordis`、`code` 三个 agent 预设挂载(与已挂载 Claude-Code 桥的预设相同)。`maxHooks` 分别限制每个作用域存储保留的 hook 组总数——受管加手写——默认 256:会话折叠、工作区文件、全局文件各自计数。

## Model Experience

### Tool schemas

#### What the model sees

The model sees the [three generated hook schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-hooks): `hook_add`, `hook_remove`, and the read-only `hook_list` contract. An install carries a stable `name`, one of seven plain `event` values, a `scope` of `session` (the default; the schema text states it requires supervised mode), `workspace`, or `global`, an optional regex `matcher`, the `command`, and an optional `timeout_seconds`; no file paths or dialect terms appear anywhere.

#### Token effect

Three fixed schemas are sent on each request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while tool visibility and definitions are unchanged.

### Tool results

#### What the model sees

Each call returns one JSON document: the scope plus the added or removed hook's view and the effect note (`runs from the next matching event; an in-flight invocation is unaffected`), or the full listing grouped as `session` (with a `changeable` gate state), `workspace`, and `global`. Failures are plain-text reasons the model can act on, such as `a hook named "x" already exists in this scope; remove it first with hook_remove` or the supervised-mode refusal naming the workspace and global alternatives.

#### Token effect

Results are small fixed-shape documents; `maxHooks` bounds how large each scope's listing can grow.

#### KV Cache effect

Append-only result text follows the reusable request prefix and does not invalidate earlier cache entries.

## Known Limitations and Deferred Work

- 受管条目经适配器为每次 hook 调用增加一个 `node` 进程;手写方言条目原样运行、零开销。
- 会话级改动按设计仅限 supervised;unsupervised 会话只能请用户切换监督或改用文件作用域,拒绝信息是唯一的带内救济。
- 子代理继承在启动时下种一次;父级后续变更不会传播到运行中的子级,且已携带任意 `hook/config` 事件的子级永不再下种。
- hook 命令经宿主 shell 服务的引号规则执行;内嵌双引号的路径仍是病态情形,手写 hook 本就如此。
