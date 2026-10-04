# Agent Note：客户端停止与审批按键、版本行、模型搜索与准备中工具行

Status: implemented

[English](2026-10-04-client-keys-version-model-search-preparing-rows.md) | 中文

范围：`packages/client/ui-conversation`（`src/client/stop-sequence.ts`、`src/client/stop-shortcut.ts`、`src/client/skeleton/ApprovalPanel.tsx`、`src/client/skeleton/ConversationRoot.tsx`）、`packages/client/ui-settings-general`（`src/client/CurrentVersionRow.tsx`）、`packages/client/ui-model-selection`（`ModelSelect` 搜索）、`packages/client/ui-primitives`（`src/rank-by-name.ts`、`src/MenuGroup.tsx`）、`packages/client/ui-tool`（`PreparingToolRow`、`tool-call-arguments-partial.ts`）、`packages/client/runtime`（快照 `phase`、assembler 降级为更新）、`scripts/client-build-environment.ts`、`apps/web/tests/preparing-tool-row.e2e.ts`

## 问题

官方同步蓝图行 R24/R34/R35（条目 X14）：上游客户端以双 Escape 序列停止运行中的轮次、用键盘回答审批、在通用设置中显示发布版本、在模型选择器中搜索，并在工具参数仍在流式输出时渲染准备中行。Harniverse 的 Web 客户端此前没有这些表面——停止按钮是唯一的停止入口，审批只能点选，「通用」分区没有版本表面，模型菜单没有过滤，工具调用在 `tool/call` 事件派发之前不可见。

## 决策

- **固定 500 ms 的 Esc-Esc 停止。** `StopSequence`（`stop-sequence.ts`）持有一次短命的首次按键，寻址到 freshly 解析的目标（会话、轮次、绑定代次、聚焦区域）；`installStopShortcut`（`stop-shortcut.ts`）在捕获阶段加入唯一的窗口 keydown 监听器，持有完整的资格链：裸的、非重复、非组合态（含 `keyCode 229` 的 IME 回退判定）且未被更早处理器消费的 Escape，没有打开的模态框或菜单，寻址到某个会话出现（occurrence）的元素——`ConversationRoot` 现在携带 `data-conversation-session`／`data-conversation-region`——且该会话正在运行一个未结束的轮次、没有待处理交互。审批接管（`data-approval-key`）、iframe、`.xterm` 与 inert 子树都不会武装该序列；轮次结束、接管、会话移除或绑定替换都会经会话订阅解除待定的首次按键。间隔按决策固定（上游从其 shortcuts 插件的已校验 Config 派生；本客户端没有可配置的快捷键注册表）。
- **带 IME 防护的审批键盘对等。** 焦点保持在 `ApprovalPanel` 内时，Enter 允许一次、Escape 拒绝；可编辑后代、按钮原生 Enter 点击与修饰键组合各归其主。IME 处理对组合开始／结束加锁存，并拒绝重复、组合进行中或组合结束后首次 keyup 的 Enter（`isComposing` 加 `keyCode 229` 回退），因此中日韩输入法确认绝不会替用户回答审批。
- **经 `DSH_CLIENT_VERSION` 的版本行。** `scripts/client-build-environment.ts` 把仓库版本注入为 `DSH_CLIENT_VERSION` 构建期定义；`CurrentVersionRow`（ui-settings-general）注册在 `settings.general.item` 上（`id: current-version`、`order: 100`）并渲染本地化标签。不含该定义的部分构建直接省略该行，而不是猜测版本。
- **带粘性提供方分组的模型搜索。** 超过四个条目的目录在模型面板显示搜索框；`rankByName`（移入 ui-primitives 作为共享菜单排序器）以不区分大小写的有序子序列匹配候选名称与可选的本地化 label——前缀命中优先，其次是最强对齐得分（边界与相邻匹配加权、跳跃扣分），再按来源顺序。提供方分组保持为 `MenuGroup` 区段，粘性标题由 `observeStickyMenuGroups` 驱动（异步 intersection 与 resize 观察；分组未跨越视口顶部前标题保持透明）。空组整体退出；目录缩减到阈值以下时查询与高亮随之清空，陈旧过滤不会清空小目录；下钻模型面板打开时搜索框获得焦点。
- **参数流式期间的准备中行。** 仅从流式命名 tool-call 增量可知的工具调用在运行时快照中物化为 `phase: 'preparing'` 调用；ui-tool 的准备分支渲染不可展开的 `PreparingToolRow`（`ToolRowState 'preparing'`），文件变更与 bash 变体通过 `tool` 命名空间词典把流式参数前缀显示为整 KB 进度（`useToolCallArgumentsPartial` 读取活跃 partial 块）。该行仅做呈现——不存在可冻结的已派发材料——提升的 `tool/call` 会以已派发行替换它；其轮次被中断的准备中行保持隐藏而非半显示。快照的 `phase` 是可选字段（缺席即 `start`），既有快照与契约消费方保持有效。assembler 以降级方式接受这种「前缀先到、权威事件后到」的顺序：某 Context 已持有 start 时，后来的 `'start'` Match 降级为更新；待处理新增中最早的 start 角色 Match 就是 THE start，其余降级为重放的更新，因此 Definition 可以在权威事件上提升流式前缀而不重排日志。

## 备选方案

**经快捷键注册表配置停止间隔。** 否决：本客户端没有快捷键注册表插件；照搬上游从 Config 派生的窗口会为一个常量引入整套配置表面。固定 500 ms 窗口就是决策。

**搜索结果的账户置顶。** 否决：把匹配的账户置顶到提供方分组之上会破坏菜单按提供方分组的身份；粘性分组标题在组内排序的同时保持分组可见。

**把准备中材料折叠进已派发行状态。** 否决：准备中调用没有可从中投影生命周期的冻结 call/result slice；以活跃 partial 块为键的专用呈现行才是诚实的形态。

**权威事件落地时丢弃流式前缀。** 否决：日志的追加顺序必须保持确定性；把重复的 start 降级为更新使重放与实时组装保持一致。

## 后果

仅用键盘的用户可以停止运行中的轮次并回答审批，而 IME 组合与原生按钮路径被有意排除在两者之外。打包构建显示其发布版本；不含定义的源码构建显示空缺而不是错误版本。大型模型目录可以过滤而不丢失提供方分组。工具参数流式从第一个增量起可见，代价是快照契约新增一个消费方必须视为可选的字段（`phase`）。准备中行的浏览器级证明交给 CI e2e 通道而非本地验证。

## 验证

- `packages/client/ui-conversation/tests/stop-sequence.client.spec.ts`：间隔内（含端点）两次独立按键、过期、首次按键的失效。
- `packages/client/ui-conversation/tests/stop-shortcut.client.spec.ts`：资格与解除的端到端覆盖——被消费的按键、非 Element 目标、离开会话、对话框／菜单、跨区域与跨轮次按键、审批出现／消失、终端／iframe／审批／inert 后代、生命周期变化、绑定替换、可继续与一次性 child。
- `chat-view.client.spec.tsx`／`conversation-node-definitions.client.spec.tsx`：会话表面中的审批键盘对等与准备中节点契约。
- `ui-settings-general` 的 `apply.client.spec.ts`／`components.client.spec.tsx`：版本行注册及其在定义缺席时的省略。
- `ui-model-selection` 的 `model-select.client.spec.tsx`：搜索阈值、跨分组排序、粘性标题、低于阈值时清空查询。
- `ui-primitives` 的 `rank-by-name.client.spec.ts`（空查询、子序列与前缀排序、边界／相邻／跳跃权重、label 作为第二键）与 `menu-group.client.spec.tsx`（唯一标题、哨兵不进可访问树、无同步布局读取、异步跨越与清除）。
- `ui-tool` 的 `preparing-rows.client.spec.tsx`／`tool-call-arguments-partial.client.spec.tsx` 及行／卡套件：准备中被已派发行替换、通用标题规则、前缀 Hook 只读自身调用。
- `packages/client/runtime` 的 `conversation-assembler.client.spec.ts`：前缀后随 start 组装顺序的降级为更新。
- `scripts/client-build-environment.client.spec.ts`：`DSH_CLIENT_VERSION` 定义注入及其失败形态。
- `apps/web/tests/preparing-tool-row.e2e.ts` 覆盖组装后的浏览器行为，仍归 CI web-e2e 通道（replay 模式；record 模式需要密钥）。
