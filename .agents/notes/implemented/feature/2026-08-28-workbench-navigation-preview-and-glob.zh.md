# Agent Note: Workspace 工作台导航、overlay 预览与 glob 筛选

Status: implemented

[English](2026-08-28-workbench-navigation-preview-and-glob.md) | 中文

## Problem

只读 Workspace 工作台把风格割裂的纵向活动栏、狭窄导航栏与占用右侧剩余区域的文档面板混在一起。打开文件后，对话和导航会同时被挤压，而不是让文件内容接管注意力。文件、变更和搜索不属于同一导航层级，文件搜索也只能执行不区分大小写的文件名子串匹配，无法把查询限制到 `*.py`、某个源码子树或明确的排除项。

工作台还消费了共享主题从未定义的 custom property 名称。浏览器会静默丢弃包含这些缺失值的声明，因此边框、hover 填充和标签颜色可能随 skin 分化，却不会产生构建错误。

## Decision

Session 页头入口采用 32px 胶囊，并与相邻 Session-log 操作使用相同的边框、字体、间距与 hover 语义。工作台内部把文件、变更和搜索作为顶部的三个同级页签。行几何遵循侧边栏的 34px 高度、8px 圆角和 22px 文件树缩进节奏。功能 CSS 只消费 `dsh-client-ui-theme` 定义的语义属性；`verify-client-css-tokens` 会拒绝主题外未定义的受管声明，以及主题未定义且不带 fallback 的 `--dsw-*` 或 `--ds-*` 引用。

打开文件会在按 Workspace 分区的工作台 store 中设置 `previewOpen`。第二个 `dsh-client-ui-workspace` 注册共享同一 store handle，并把预览渲染到 `shell.overlay`。`dsh-client-ui-layout` 将解析后的侧边栏与右侧轨道宽度发布为 `--dsh-frame-sidebar-width` 和 `--dsh-frame-right-width`，再向 overlay 条目传递通用的 `rightMode`、`rightOpen` 和 `rightDrawer` 占用事实。因此只有工作台是可见的停靠占用项时才会显示预览；其有界宽度保持在对话栏内，右边缘无需导入 layout store 或观察外壳 DOM 即可贴合工作台左边缘。预览从左侧进入并覆盖部分对话。关闭时它保持挂载、进入 inert 状态并离开可访问性树；打开时会把焦点移入非模态区域，仅在先前焦点目标仍可见且可操作时恢复焦点，并先于嵌套 drawer 消费 Escape，避免同时关闭整个工作台。关闭或切换工作台会立即撤回 overlay 并清除预览可见性，同时保留文档标签。

工作台成为全框 drawer 时，`shell.overlay` 按外壳契约进入 inert 状态。因此同一预览组件会改在工作台内部渲染，并以占满整个面板的切换替代导航 chrome。关闭预览会保留标签；关闭最后一个标签也会关闭预览。

`workspace.files.search` 接受可选 `include` 和 `exclude` 列表，每个方向最多 20 个非空模式，每个模式最多 200 个字符。模式不区分大小写：`*` 与 `?` 不跨路径分隔符，`**` 可以跨分隔符，`{a,b}` 表示备选，字符类支持范围和取反。不含 `/` 的模式匹配任意深度的 basename，包含 `/` 的模式匹配完整 Workspace 相对路径，尾斜杠覆盖目录子树；同时接受 `/` 和 `./` 根标记。排除列表缺失或为空时使用 Host 持有的依赖、缓存与构建输出默认项；非空列表会取代这些默认项，使调用方能够有意检查通常跳过的子树。搜索保留 200 个结果和 20,000 个扫描条目的边界，并在下降前裁剪已排除或不可能命中的目录。

## Plugin boundaries

布局包拥有占用模式、drawer 解析与唯一的 CSS 几何发布。Workspace 包拥有导航、预览状态与两个 slot 贡献；组件只接收 owner share、框架 hook、store action 和注入回调。Host API 契约拥有 wire 边界，以及由 Host 和确定性客户端 fixture 共用的 glob 编译器；Host inspector 拥有遍历，无 React 的客户端运行时只规范化可选列表并转发取消。组件不会导入其他插件的实现，也不会读取 Cordis context。

## Alternatives considered

**为缺失 CSS 属性定义兼容别名。** 拒绝，因为这会保留虚构词汇，并使未来功能 CSS 绕过仓库的语义 token 契约。迁移消费方并检查每个客户端样式表，才能移除静默失效。

**把搜索留在文件页签内，或保留纵向活动栏。** 拒绝，因为包含／排除字段与结果状态使搜索成为完整的同级工作流，而侧栏会占用稀缺的横向宽度并破坏工作台顶层信息层级。

**让预览继续停靠在导航旁。** 拒绝，因为用户明确打开文档后，它仍会让相互竞争的内容同时可见，并挤压对话，而不是由可关闭的内容 surface 覆盖对话。Overlay 会保留导航记账，但不强制同时呈现。

**由 Workspace 插件读取 layout store 或修改外壳 grid。** 拒绝，因为两条路径都会跨越插件所有权，使呈现依赖另一个包的内部状态或 DOM 写入。Owner prop 传递占用模式，一个 CSS custom property 负责对齐。

**加入通用 glob 依赖。** 拒绝，因为 wire 契约有意只支持固定的小型语法。本地编译器使接受的语法、边界、裁剪与测试继续由 Host 包持有，不会因依赖升级而静默扩张。

## Consequences

文件内容打开时会覆盖对话；这有意隐藏对话上下文，直到用户关闭预览。窄屏和宽屏保留同一种交互模型，不再维护 split-pane 变体。显式排除项会取代默认跳过项，因此用户输入较窄的排除范围后，需要自行承担默认情况下会被裁剪的依赖树和构建目录。

CSS 检查覆盖整个仓库，而非只覆盖工作台，因此其他客户端包中的既有失效别名也在同一变更中映射到当前语义 token。聚焦的布局、store、组件、runtime、schema、Host 遍历与 glob 编译器测试固定 owner-share 几何、焦点约束、Workspace 隔离、模式语法、默认排除、取消和 wire 边界。
