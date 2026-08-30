# dsh-persona

[English](README.md) | 中文

把 agent（智能体）人设做成一个可组装的行：它通过作用域内动态上下文遮蔽部署级人设。

[`dsh-system-prompt`](../../core/system-prompt/README.md) 以自身配置持有部署级人设，并且无条件注册该上下文，因此每个作用域只有一个值。[agent preset](../agent-presets/README.md) 无法自行挂载提示词注册表——若没有属于自己的行，preset 能改变 agent 的工具，却永远改不了它的身份。本包就是那一行。

## 仅限 scope 内使用

在 agent scope 之外挂载本行，会与注册表自身的 `deployment:persona` 上下文注册相撞并明确报错。这不是需要绕开的限制：部署级人设已经有归属，而本行存在的意义正是为某一个 agent 遮蔽它。请把它挂在 preset 组装内部，由 preset 的挂载过程提供 agent scope。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `text` | 必填 | 作为 `deployment:persona` 动态上下文渲染的人设文本 |

`text` 与任何提示词上下文一样是模板：完整的 `{{…}}` 组在上下文**渲染**时（而非组装时）严格解析为已注册的提示词变量。空文本会以空的 runtime 贡献遮蔽部署级人设。该上下文会在每次符合条件的组装中求值，并与其他动态事实一起进入持久化 runtime 快照。

## 模型体验

### 人设上下文

#### What the model sees

位于 order 0 的 `deployment:persona` 动态上下文携带本行配置的 `text`，其中的提示词变量已解析。对于其 preset 挂载了本行的 agent，它会替换部署所配置的任何人设。它会进入持久化 runtime 快照，不会改变静态系统提示词中的身份或工具引导。

#### Token effect

只要值不变，该 agent 的每个 runtime 快照都会重复携带人设自身的 token。空文本不贡献 token。其他静态提示词段落保持独立。

#### KV Cache effect

静态请求前缀不包含这个作用域内的值。动态快照会作为 Session surface 的追加内容，遵循 runtime-context 的生命周期。

## 已知限制与暂缓事项

- **不支持全局挂载** —— 提示词注册表拥有未加 scope 的人设槽位，因此本行只能从带 scope 的组装中使用。要改变部署级人设，应在 `system-prompt` 行自身的配置中修改。
