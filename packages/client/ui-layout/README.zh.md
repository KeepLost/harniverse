# @deepseek-ai/dsh-client-ui-layout

[English](README.md) | 中文

外壳插件：三轨 AppFrame（拖动手柄与让步链）加 `ctx.layout` 面板几何服务；它注册到运行时拥有的 `root` slot，并声明 `sidebar`、`conversation`、Session 作用域 `details`、根作用域 `workbench` 和 `shell.overlay`。Details 与 workbench 是同一个物理右侧区域中彼此互斥的占用项，拥有独立的宽度范围、中心让步、drawer 断点和双击宽度重置。关闭的侧边栏仍保留 56px 控制栏，右侧区域则关闭到零宽度。该包还提供主题呈现器：它消费解析后的 `ctx.theme` 快照，并将其投影到 document（用 `html { color-scheme }` 驱动原生 UA 控件，依据当前配色方案设置 `body[data-ds-dark-theme]`，并将主题的别名 token 设为 body 上的内联变量，同时拥有一个 `<meta name="theme-color">`，其内容随计算后的 body 背景色更新）。在应用调色板和 token 后进行测量，可确保渲染后的背景成为唯一的颜色依据；呈现器在 dispose（资源释放）时会移除其自有的元数据节点，并一并清除其写入的其他全局状态。

AppFrame 始终挂载会话栏和物理右侧栏；非 blank 当前 Session 可以显示任一右侧占用项。关闭且宽度为零的右侧占用项进入 inert 状态，并从可访问性树隐藏。侧边栏与窄屏覆盖状态是临时的。投影后的 `localStorage` 记录只持久化每个当前 Workspace 的右侧模式、打开状态以及 details／workbench 宽度；活动记账保持临时，Workspace 基线就绪后会裁剪已删除的 Workspace 记账，未入账 Session 则使用浏览器本地记账。该基线解析前，面板操作使用不持久化的 Session 临时记账，并在解析后迁移到对应 Workspace 或浏览器本地记账。显式成员关系优先解析，cwd 匹配负责接住尚未到达的记账帧。低于当前模式断点，或让步求解器无法保留该模式的最小停靠宽度时，右侧占用项会成为模态全框 drawer，但不会重写其偏好宽度；它会让被覆盖的外壳进入 inert 状态，约束并恢复焦点，并在按下 Escape 时关闭。会话与 details owner share 为空；侧边栏接收 `collapsed` 和 `width`，工作台接收 `drawer`，每个 `shell.overlay` 条目接收通用的 `rightMode`、`rightOpen` 和 `rightDrawer` 占用事实。AppFrame 把实际渲染的轨道宽度发布为 `--dsh-frame-sidebar-width` 和 `--dsh-frame-right-width`，使全框 surface 无需读取布局状态或接收呈现几何组件数据即可留在对话栏内并与右侧占用项对齐。注册方通过标准钩子获取业务数据，并从各自的 inject 接口获取操作。

`/client` 导出表层包含插件主体（`apply`／`inject`）、`LayoutController`、`ILayout` 和 owner-share 接口。AppFrame、面板 store 与让步求解器仍属于包内部。

## 模型体验

无。布局外壳管理浏览器查看状态；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **侧边栏几何信息是瞬时状态**：重新加载会恢复其默认值；只有逐 Workspace 的右侧区域偏好会持久化。
- **让步与 drawer 模式通过推导零轨道实现，不会改动偏好宽度**：空间恢复后面板会自行恢复；消费方禁止把 store 中的右侧宽度当作实际渲染状态。
- **挤压重排期间不提供滚动锚定**：布局变化可能移动读者的 viewport。
