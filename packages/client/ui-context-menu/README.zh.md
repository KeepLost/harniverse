# @deepseek-ai/dsh-client-ui-context-menu

[English](README.md) | 中文

带捕获目标的类型化、可插件扩展的右键菜单与单一共享 Web 弹层。业务插件按目标族注册 `MenuContribution`（`ContextMenuTargetMap` 与 `SlotMap` 一样走声明合并）；`contextMenus` 服务负责解析、排序与取消，`useContextMenu`（全局标准 seat）把手势处理器绑定到任意元素。Harniverse 预置 `session`／`file`／`directory`／`url`／`image` 五个目标族；其余族随其所属特性落地。

一个贡献可以拒绝、同步作答，或在准备预算内异步解析（`resolutionTimeoutMs`，默认 1000ms；迟到或失败的应答会丢弃该提供者的动作并给出本地化通知）。`observe` source 会对同一捕获目标做响应式再解析；每个出现位置都拥有自己的 AbortController 链——关闭弹层、插件卸载或更新的准备动作都会取消在途元数据查询。捕获目标不可变：改变应用选中项绝不会改变已打开菜单的作用对象。同一目标（按规范化 JSON 身份）4 CSS 像素内的重复手势会切换弹层；工厂渲染的省略号按钮（`contextMenu.button`，其目标族没有已注册贡献时隐藏）按自身实例切换。弹层注册进 `shell.overlay`，图标行经 `contextMenu.icon` 按键分发，React 行经 `contextMenu.content` 提供——纯数据贡献不需要渲染器。

上游的两个依赖被有意省略（Wave-6 批 D 计划中记录的缝）：没有 shortcuts 注册表，`MenuActionView.commandId` 是休眠的字符串身份（无实时快捷键字形）；dockkit 的 `tab` 目标族未声明。两者随其所属线落地。

## 模型体验

无。该包属于浏览器侧弹层接线；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **没有 shortcuts 目录** —— `commandId` 为实时快捷键显示而保留，但在 shortcuts 线被吸收前不解析任何内容；菜单行永不显示按键字形。
- **没有 `tab` 目标族** —— 上游 dockkit 的 tab 目标随 dockkit 依赖一并省略；pane 形态的目标（若终被采纳）随 pane 系统落地。
