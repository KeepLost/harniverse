# Agent Note: 工作台固定头部与 Git 历史分页

Status: implemented

[English](2026-10-15-workbench-sticky-headers-and-history-paging.md) | 中文

## Problem

日常使用中工作台导航暴露出三个缺陷。各视图的操作行（文件区的新建文件/新建文件夹/刷新/折叠；变更区的分支头、侧切换与刷新；搜索区的查询框与过滤器）都位于导航主体的滚动容器内，滚动长树或长历史时恰好在最需要的时候被划出屏幕；纯图标操作除 `aria-label` 外没有悬停提示；变更历史只是宿主上限 100 之下的固定 50 条窗口，末尾是死板的"结果已达到显示上限"提示，无法继续翻页。

## Decision

**把每个分区的头部钉在滚动视口，历史窗口按整体重取分页。** 三个面板把各自控件渲染进粘性头部（`filesToolbar`、`searchHeader`、`changesHeader`）：`position: sticky` 配 `top: -6px` 与负 `6px/8px` margin 收回滚动主体的内边距，铺不透明 `--dsw-alias-bg-layer-2` 底色加发丝线底边，`z-index: 1` 压过行——与预览区 CSV 表头在同一列的钉法一致，负 top 模式沿用调度中心粘性表头的先例。五个纯图标按钮补上与 `aria-label` 一致的原生 `title` 提示，与本文件其他操作的原生 title 惯例一致。

历史分页沿用现有单一请求形状（从 HEAD 取 `workspaceGit.commits({ limit })`）：加载更多控件调用 `loadGit(false, 已加载 + 50)`，处理器按更深 limit 整体重取窗口并替换 store 切片。否决追加游标：topo 序泳道让"比 X 更早"在并行泳道间无定义——整体替换的更宽窗口使 `layoutCommitGraph` 始终是可见提交的纯函数，旧窗口底部的悬空泳道自然接续。宿主上限从 100 提到 500（`WORKSPACE_GIT_COMMIT_LIMIT`），客户端以 `GIT_HISTORY_MAX` 镜像，控件在触顶后让位于既有上限提示；刷新与文件监视触发的重校验改为按已加载深度重取而非回落 50，加载态保留旧行而不是清空面板。store 新增 `historyTruncated` 标志，状态条目截断（历史标题上方的提示）与历史窗口截断（图形下方的分页控件）独立上报，不再 OR 成一个含混提示。

## Alternatives considered

**把头部移出滚动容器。** 否决：导航主体由三个分区与插件槽共享，每个分区都要自己的滚动包装，为同样视觉结果引入三倍布局结构。

**样式化 tooltip 组件。** 暂缓：客户端没有共享 tooltip 原语，原生 `title` 以零成本符合本文件惯例；自定义原语以后可整体替换。

**基于游标的追加（`before <sha>`）。** 如上否决；≤500 条提交的整窗重取负载极小，并彻底消除重复与乱序风险。

## Consequences

三个面板滚动时操作始终可达；每个图标按钮悬停自解释；历史深度按 50 条一页增长至 500 并在刷新后保持。store 的 `truncated` 标志现在只表示状态条目截断，`historyTruncated` 承载历史窗口状态——读取旧 OR 语义的插件消费方看到的是更精确的一对标志。浅色主题下提交者名与搜索占位符的可读性由独立的 dimmed 标签校准 note 处理。

验证：`workspace-workbench.client.spec.tsx` 覆盖控件契约（每次点击翻一页、加载中禁用、500 触顶让位上限提示、完整时不渲染）与工作台流程（初始 50、加载更多到 100、刷新保持深度 100）；客户端全套与宿主 inspector 套件保持绿色；`verify-client-css-tokens` 解析全部新引用。

PR: #190 (merge)
