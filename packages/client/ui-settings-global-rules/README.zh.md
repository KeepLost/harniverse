# `@deepseek-ai/dsh-client-ui-settings-global-rules`

中文 | [English](README.md)

“全局规则”设置分区：基于 `globalRules` Remote、以等宽编辑器修改 harness 主目录下的 `AGENTS.md`（用户级指令作用域）。保存带版本校验 —— 分区回传最近一次读取的令牌，加载与保存之间的外部修改会以冲突提示呈现并提供显式重新加载，而不是被静默覆盖。

## 组合

```yaml
# browser row (the web-app bundle owns it)
- id: ui-settings-global-rules
  name: '@deepseek-ai/dsh-client-ui-settings-global-rules'
```

插件注入 `slots`、`locale`、`connection`。向 `settings.section` 列表槽位贡献一个条目（id `global-rules`，order 12 —— 位于模型分区之后、Plugins 之前：规则文件影响每一次模型交互），并向 `settings.nav.icon` 贡献导航图标（key `global-rules`）。节点半是标准的外观空操作；宿主侧文件服务为 `@deepseek-ai/dsh-global-rules`。

## 分区行为

- 挂载时加载一次，展示内容、符号路径，以及文件缺失时的“保存将创建”提示；读取失败（包括部署缺少该缝时的本地化文案）提供重试。
- 编辑按宿主上报的上限做字节计数：计数器使用二进制单位，超限草稿（多字节安全）会禁用保存并内联告警。
- 仅在草稿有改动时启用保存；保存成功后说明生效语义 —— 新会话在第一步读取新内容，当前会话在下一次文件操作后感知（指令加载器自身的 reconcile）。
- 冲突时保留草稿并提供重新加载（重新读取文件）；被拒绝或失败的保存展示服务端消息。“放弃更改”恢复为已加载内容。

## Model Experience

间接发生：分区只经 globalRules Remote 搬运字节，被编辑的 `AGENTS.md` 由 `dsh-agent-instructions` 基线链渲染为持久的用户全局指令消息；分区本身不发出任何模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **未保存草稿不持久化** —— 草稿保存在组件状态中，离开分区即丢弃；持久化推迟到确有用户反馈丢失过长草稿再做。
- **无 diff 与 Markdown 预览** —— 编辑器是令牌化等宽字体的纯文本；渲染或与已加载内容比对随草稿持久化决策一并推迟。
- **冲突恢复是手动的** —— 重新加载以磁盘内容替换草稿基底并丢弃未保存编辑；设置面板不适合引入三方合并。
