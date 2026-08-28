# Agent Note: 插件原生只读 Workspace 工作台

Status: implemented

[English](2026-08-28-workspace-workbench.md) | 中文

## Problem

Workspace 检查被拆在一个狭小的详情栏文件树和单独的会话视图之间。根目录等待用户执行展开手势，选择文件只会改变共享状态而不会导航到预览，Git 数据没有 Workspace 记账，重新挂载或切换 Session 后，可见文件树可能与所选文件失去联系。该呈现也没有安全的图片或 PDF 路径，外壳布局则没有适合较宽工作界面的顶层契约。

工作台必须保持为只读插件贡献。它不能绕过 slot 系统修改外壳 DOM 或 grid，不能暴露 Host 文件 URL、跟随符号链接、持久化检查内容，也不能让一个 Workspace 的迟到请求发布到另一个 Workspace 的视图。

## Decision

`dsh-client-ui-layout` 在现有 Session 作用域 `details` slot 旁声明根作用域 `workbench` slot。二者占用同一个物理右侧区域，并通过 `LayoutController` 互斥。布局 store 只按已解析的 Workspace id 持久化模式、打开状态以及彼此独立的 details／workbench 宽度；侧边栏与当前记账保持临时状态。Workspace 基线解析前发生的操作使用不持久化的 Session 临时记账，并在记账成为权威后迁移。关闭且宽度为零的占用项保持挂载，但进入 inert 状态并从可访问性树隐藏。面板在低于各模式断点，或让步求解无法保留最小停靠宽度时成为模态全框 drawer：被覆盖的外壳进入 inert 状态，CSS 隐藏控件不会进入焦点循环，焦点被约束并在关闭后恢复，Escape 会关闭当前占用项。其分隔条支持键盘操作，双击会重置当前模式的宽度。

`dsh-client-ui-workspace` 向该 slot 贡献一个 `WorkspaceWorkbench`，并贡献一个 Session 页头入口。工作台 store 位于根作用域，按 Workspace id 分隔目录、展开路径、标签、搜索、Git 状态和活动文档。因此记账到同一 Workspace 的 Session 共享一份查看状态。当前 Session 的显式 Workspace 成员关系优先；当 registry 记账尚未到达时，工作目录匹配会接住该 Session。只有 Workspace 基线就绪后才会裁剪已删除的 Workspace 记账。

工作台自动加载根目录并按需加载嵌套目录。每次 Workspace 转换都会中止活动请求集合并推进 generation fence；同一目录、标签、搜索或 Git 记账的后续请求也会中止前一个请求。回调在发布前同时检查请求 signal 与 generation。重新进入记账时会移除被中断的 loading 记录，使其能够再次请求。文件内容、base64 二进制数据、搜索结果与 Git 响应都只存在浏览器内存中，不会进入持久化投影。

## Authenticated inspection contract

现有 `workspace.files.*` 认证 RPC 族负责文件列表、递归文件名搜索、UTF-8 读取和二进制预览读取。搜索遍历普通目录且不跟随符号链接，并在扫描 20,000 个条目或得到 200 个结果时停止。候选文件使用 no-follow、非阻塞 descriptor，因此 FIFO 或其他特殊文件无法在普通文件检查前占满 Host 文件系统线程池。文本读取保留 1 MiB UTF-8 前缀契约。二进制读取只接受白名单图片与 PDF 扩展名，读取最大 8 MiB 的完整普通文件，并返回 base64 与媒体类型；超限和不支持的文件会失败，而不是产生损坏的部分预览。每个方法都要求 `harniverse.observe`，并分类为 read。

Git 状态、提交以及暂存区或工作区 diff 继续由 `workspace.git.*` 提供。浏览器不暴露修改操作。Host 在 POSIX 上把 Git 遍历绑定到已打开的目录 descriptor，禁用仓库配置的 fsmonitor 与外部 diff 执行，只向 Git 提供清理后的环境，并施加 10 秒操作 deadline。规范工作树根或 Git 元数据逃出已注册 Workspace 根的仓库会被拒绝。未跟踪的工作区条目通过普通文件预览打开，因为 Git 无法为索引外内容生成统一 diff。

## Preview boundary

文本分类按路径选择 Markdown、HTML、高亮代码、纯文本或有界 CSV 表格。HTML 使用空 sandbox 的 `srcDoc` frame。图片与 PDF 使用从认证 RPC 字节创建的 object URL；数据变化或标签关闭时浏览器会撤销相应 URL。PDF 使用 sandbox frame。统一 Git 输出作为带行角色颜色的文本渲染，不会被解释为 markup。

工作台通过具名 CSS container query 调整内部布局：狭窄面板和移动 drawer 宽度会把导航与活动文档显示为两个独立视图，较宽面板则同时保留活动栏、导航器和文档面板。

## Alternatives considered

**由 Workspace 插件修改外壳 DOM 或 grid。** 拒绝，因为这样的呈现会绕过 slot 声明、授权、HMR 生命周期和布局 store。外壳拥有物理轨道；Workspace 插件只拥有 `workbench` 占用项。

**把文件树留在 details，并把预览保留为会话标签。** 拒绝，因为一次交互仍会跨越两个独立导航的界面，选择文件后还需要第二次视图手势才能看到结果。

**把工作台 store 设为 Session 作用域。** 拒绝，因为 renderer 会为 Session 作用域 slot 的每个 Session 创建一个 store 实例。同一 Workspace 的两个 Session 会复制标签与目录状态，而不是共享一份 Workspace 记账。

**通过同源 HTTP 路由提供 Workspace 文件。** 拒绝，因为它会创建第二套授权与内容安全边界，赋予预览持久 URL，并扩大任意文件交付面。有界认证 RPC 值足以支持既定预览大小。

**返回截断的二进制前缀。** 拒绝，因为部分图片和 PDF payload 通常无效，并会让成功 RPC 无法与损坏文件区分。完整文件上限使拒绝语义保持明确。

## Consequences

Workspace 检查拥有一个可见、可调整宽度的界面，并具备共享的逐 Workspace 导航和独立的逐 Workspace 几何状态。API 增加两个只读方法和两个结构化文件预览失败；每个 carrier、确定性浏览器 fixture、schema、runtime facade 与测试替身都实现这些行。Base64 会增大二进制 wire 大小，但 8 MiB 源上限使成本保持有限，也避免了单独的文件服务平面。

工作台有意省略 Office 文档渲染与编辑。超过 1 MiB 的文本文件会显示截断提示，递归搜索可能在任一上限处报告不完整结果，超过 8 MiB 的二进制文件需要外部应用。聚焦的 Host、carrier、runtime、store、组件、slot 装配和布局检查固定了路径包含、边界、授权元数据、取消、Workspace 隔离、预览选择与 object URL 清理。真实 Grant 认证浏览器 E2E 固定了桌面与模态移动交互，并记录规范化 ARIA golden。
