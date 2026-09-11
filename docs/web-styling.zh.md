# Web UI 样式参考

[English](web-styling.md) | 中文

本文规定浏览器客户端包的样式职责归属与组件规则。当前 token 值位于 [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/)；本文不重复这份由源码生成的清单。

## 职责归属

[`ui-theme`](../packages/client/ui-theme/README.md) 负责 `--dsw-*` 静态色阶、语义别名、排版、动效、渐变、阴影、滚动条样式以及明暗主题偏好。[`ui-layout`](../packages/client/ui-layout/README.md) 将解析后的主题快照应用到文档。功能包使用语义别名，不得另行定义全局主题。

全局样式表归 `ui-theme/src/styles/` 所有。组件样式以 CSS Modules 形式放在组件旁。当某个值属于该组件的布局或呈现约定时，组件可以定义局部自定义属性；共享颜色、排版、层级和动效属于主题包。

## 组件规则

- 使用 CSS Modules 和 `clsx`；不得添加组件库或 Tailwind。
- 功能组件使用 `--dsw-alias-*` 语义 token。不得复制静态色板值或在其中写入颜色字面量。
- 功能组件 CSS 不得包含主题选择器。明暗主题覆盖属于主题所有方。
- 字体大小必须与行高配对；已有角色匹配时使用主题排版变量。
- 当组件约定要求保留列结构时，源码文本、终端输出和 diff 行不得换行；使用共享滚动条样式，不得定义组件专用滚动条选择器。
- 呈现规则写在 CSS 中。React 内联样式可以传递组件局部自定义属性值，但不得编码主题分支。
- 添加过渡动画或仅悬停可见的控件时，保留清晰可见的键盘焦点和减少动态效果行为。

## 适配宽度

客户端只有一套断点刻度，由 [`ui-layout`](../packages/client/ui-layout/README.md) 拥有：AppFrame 把自身宽度归类为一种形态，并作为 `data-viewport` 发布在框架元素上——小于 600px 为 `phone`，小于 1024px 为 `compact`，以上为 `regular`。phone 形态是单列 surface：侧边栏覆盖会话栏，而不是在其旁边占据轨道。

- 依据框架属性选择，而不是声明媒体查询：`:global([data-viewport='phone']) .row`。功能组件不引入第四种宽度类别，且该属性可在组件测试中断言，媒体查询做不到。
- 当约束来自组件自身的盒子而非设备时，优先使用容器查询。会话栏宽度独立于 viewport 变化（侧边栏收起、右侧区域打开），因此必须适配自身卡片的控件行应测量该卡片：在所属盒子上声明 `container-type: inline-size` 并匿名查询，与输入栏控件行一致。
- 媒体查询留给框架之外的 surface。外壳在插件加载前渲染的认证页面没有框架祖先，使用自己的媒体查询。
- phone 布局是形态变化，而不是等比缩小的桌面布局：横向控件行改为堆叠或滚动条，表格改为卡片列表，固定宽度面板改为全屏 sheet。触摸 surface 上不得依赖仅悬停可见的方式承载信息——`@media (hover: hover)` 和 `(pointer: coarse)` 用于表达该意图。

## 变更系统

在所属 `ui-theme` 样式表中添加或修改共享 token，然后在功能包中使用其语义别名。公共样式约定发生变化时，更新所属包的参考文档。视觉行为遵循[测试策略](testing.md)；[样式系统 Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.md) 记录框架依据。
