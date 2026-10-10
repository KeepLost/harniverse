# `@deepseek-ai/dsh-client-ui-settings-im`

[English](README.md) | 中文

「IM 机器人」设置页：用户在这里把 Telegram、飞书机器人接入 Harniverse，查看它们的健康状况，调整每个机器人的会话起点，并为允许与机器人对话的账号配对。它是纯浏览器插件，建立在 [`@deepseek-ai/dsh-chat-manager`](../../chat/chat-manager/README.md) 的 `chatBots` Remote（`ctx.remote.chatBots`）之上；节点半不注册宿主行为。该分区以分区 id `im` 把自己的导航图标注册到带键的 `settings.nav.icon` slot。

## Composition

```yaml
# host rows (the service this section manages) are owned by the web-app bundle
# browser row
- id: ui-settings-im
  name: '@deepseek-ai/dsh-client-ui-settings-im'
```

插件注入 `chatBots` 命名空间服务，因此未挂载 chat manager 的宿主永远不会激活它，该设置页随之不存在。它向 `settings.section` 注册，id 为 `im`、order 为 `21`，位于 Agent presets（20）与 Voice input（25）之间。导航图标按 section id 在 `ui-settings-general` 中选择。

## Behavior

- **渠道即数据。** 左列列出宿主快照中的 `platforms`，每个平台描述符一项；接入表单由描述符的 `fields` 渲染（凭据为带显示/隐藏开关的密码输入，`options` 为下拉，`hint` 置于输入框下方）。宿主新增平台无需改客户端：它会得到首字母徽标与通用空状态文案。Telegram 与飞书有各自的徽标与“如何创建机器人”文案。
- **每个渠道一个面板。** 头部是主操作“接入机器人”与“N / M 在线”统计。其下每个机器人一张卡片，显示平台徽标、可就地编辑的别名、遮罩后的平台身份、以圆点加文字呈现的状态（运行正常 / 连接中 / 重连中 / 异常 / 已停用，异常时附宿主消息）以及最近检查时间。展开的卡片包含工作区、模型与思考强度、Agent Preset，以及操作行：检查连接、重试连接（机器人既非在线也非停用时显示）、停用/启用，以及带内联确认的移除接入。
- **覆盖项跟随默认。** 工作区、模型、preset 都提供“跟随默认”，选择即清除覆盖。可选的思考强度来自所选模型，换模型会丢弃旧的强度。工作区选择器提供已登记的工作区、手输绝对路径，以及运行时具备时的原生目录选择器（`ctx.workspaces.pickDirectory`）；模型与 preset 列表来自 `llm.models` 与 `agentPresets.list`。
- **配对。** “已绑定的账号”列出该渠道已配对的所有者并提供解除绑定。“生成配对码”请求一次性配对码，并显示到期倒计时、复制按钮和在与机器人私聊中发送 `/pair <代码>` 的说明。配对码是全局的（不区分平台），倒计时结束后给出失效提示。
- **轮询。** 页面挂载期间（设置壳只挂载当前激活的 section）立即读取快照并每 3 秒读取一次；页面隐藏时跳过，重新可见时立即读取。每次变更落定后重新拉取快照，被更新读取超越的读取结果会被丢弃。
- **失败。** 接入失败留在表单内联显示：`invalid-credentials`、`unreachable`、`duplicate-bot` 各有中文句子，其余错误码显示宿主原话。宿主把所有 `chatBots` 失败都归在线上错误码 `chat-bot-failed` 下，业务原因放在 `details.reason`；控制器读取该原因，缺失时退回线上错误码。首次读取失败显示错误与重试；之后的读取失败保留最近一次快照并给出警告。聊天桥处于启动中、失败或（已有机器人时）停止状态会显示横幅；没有机器人时桥处于停止是空闲状态，因为宿主随第一个机器人启动它。
- **无障碍。** 控件均为带标签的原生按钮、输入与下拉；接入表单是带 `aria-busy` 的命名 `form`；状态为 `role="status"`、失败为 `role="alert"`；状态始终以文字表达（圆点仅为装饰）；卡片开关是 `aria-expanded` 按钮；移除确认把焦点放在安全选项上；别名编辑器内按 Escape 仅取消重命名，不会关闭设置面板。

## State and wiring

`createImStore()` 声明本设置页的共享查看状态（最新快照与读取阶段、选中渠道、展开的卡片、接入表单、进行中的操作、每个机器人的结果提示、已签发的配对码，以及模型/preset 目录）；组件经 `useStore` 读取、仅经声明的 actions 写入。操作层（`controller.ts`）驱动 Remote 与目录线路，并经这些 actions 发布结果；它通过唯一的绑定点 `ctx.get('remote.chatBots')` 访问 Remote，类型来自宿主生成的命名空间。`/client` 入口仅导出 `apply`、`inject` 与类型。

## Model Experience

None, as this package is a browser-side management surface over the `chatBots` Remote; the chat bridge owns every model-visible effect of a bot conversation.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- 快照按 3 秒轮询；转发事件推送（Remote 事件白名单）是既定的升级路径，可去掉固定节奏。
- 配对码是全局的：宿主为任意平台只签发一种码，因此说明里不指明具体机器人，且该区块在每个渠道下重复出现。
- 目录选择器接受已登记的工作区、手输路径或原生选择器；没有应用内目录浏览器，因此没有原生选择器的运行时需要手输路径。
- preset 名称取自名册中的文件名；内置 preset 的本地化名称位于 Agent presets 设置页，不跨插件共享。
