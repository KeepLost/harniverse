# @deepseek-ai/dsh-client-ui-settings-plugin-inventory

[English](README.md) | 中文

Web 设置中的只读**插件列表**标签页。浏览器插件注册一个 id 为 `all` 的本地化 `settings.plugins.tab` 贡献；“插件”分区拥有导航入口与标签栏。插件激活期间不会读取 Remote；首次选择该标签页时才挂载组件，并通过 [`api-remotes`](../../api/remotes/README.md) 懒调用 `ctx.remote.pluginInventory.list()` 和 `ctx.remote.pluginInventory.diagnose()`。

该标签页在可搜索的双列清单前展示诊断摘要。它渲染发现项的严重程度、稳定代码、消息、可选路径和可选文本处理建议；标签页不提供修复、重启或配置操作。紧凑折叠卡片继续显示模块短名称、有效启停标签、已启用条目的根 fiber 状态圆点、Loader 条目 id 和 Cordis 阶段。加载、空结果、无匹配结果与通用失败状态只属于已挂载组件；重试会同时刷新两个快照，且不会暴露传输或诊断异常。注册使用 `ctx.slots.inject()`，因此能跟随标签 slot 的延迟声明、重新声明、本地化变化与 teardown，而无需 import 分区拥有方。

## 模型体验

无，因为本包只在浏览器设置中展示 Host 拥有的部署快照，不注册任何模型接口。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **每次 Settings 挂载或重试只读取一对报告** —— 标签页不订阅生命周期变化，也不会在重连后自动重新读取；切换标签页会保留当前数据，重新打开 Settings 则会取得新的清单和诊断快照。
- **只读 Host 视图** —— 本地搜索不会额外引入来源、按来源分组、当前浏览器激活诊断或插件修改控件。
