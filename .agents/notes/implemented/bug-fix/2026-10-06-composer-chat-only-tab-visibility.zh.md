# Agent Note: 常驻 composer 仅在 Chat 绘制；全高全宽视图不再预留底部让位

Status: implemented

[English](2026-10-06-composer-chat-only-tab-visibility.md) | 中文

- Date: 2026-10-06
- Scope: `@deepseek-ai/dsh-client-ui-conversation`（composer seat 可见性）、`@deepseek-ai/dsh-client-ui-trajectory`（full-bleed 标记、让位删除）
- PR: #TBD (merge)

## 问题

常驻 composer seat 此前在每个会话视图标签页都渲染。轨迹（Trajectory）页在 [2026-07-27 账本决策](../feature/2026-07-27-trajectory-inspection-ledger.md)中选择浮动 composer：seat 以绝对定位浮在视图底部，而所有纵向滚动容器都把 `--dsh-trajectory-bottom-clearance`（composer 实时高度＋16px）预留为永久 padding，使最后几行仍可滚到——代价是记录表、检查器的 Summary/Source 面板和上下文方块条下方各有一条永久空白带。能力（Capabilities）页则是同一个 seat 以 sticky 常规流贴在列表下方。用户判定两者都不对：输入面应只属于 Chat，预留带吃掉了检查器的下半屏。

## 决策

会话主体现在把解析后的当前视图标记（`data-active-view`）写在 `.viewArea` 上；composer seat 在有待处理审批载具进入 composer 链时携带 `data-composer-takeover`。ConversationRoot 的样式表在当前视图非 `chat` 且无接管钉住时以 `display: none` 隐藏 seat——以 display 隐藏而非移除，因此切换视图标签期间 seat 保留其 DOM（textarea identity、草稿、焦点机制），跨会话过渡的常驻设计不受影响；该标记只存在于已打开的非空白会话中，hero 保留其 composer。旧 overlay 标记驱动的全高几何改名为语义诚实的 `data-conversation-view-fullbleed` 契约（视图填满整列并自带滚动容器）；Trajectory 声明该标记，被钉住的 seat（接管情形）在全高全宽视图上仍以绝对定位浮动并保留宽度补偿。Trajectory 完全删除 `--dsh-trajectory-bottom-clearance`：记录表面板、检查器主体与上下文方块条使用整列高度。

## 备选方案

- 在 Chat 之外卸载 seat 而非隐藏：否决——常驻 seat 是无会话/会话与 hero 过渡的承重设计；`display: none` 在移除输入面的同时保留它，且隐藏后的高度经 seat 观察器发布为 0，供任何消费者使用。
- 让每个视图在 `conversation.view` 注册项上声明 composer 姿态（`docked`/`overlay`/`hidden`）：暂缓——恰只有一个已交付视图（chat）需要 composer，壳侧规则只是一对选择器；若将来出现第二个需要 composer 的视图，注册字段是升级路径。
- 保留 Trajectory 的浮动 composer、仅删除让位 padding：否决——这会重新引入让位原本要修复的缺陷（输入条遮住最后几行），且用户首先要求的就是输入面仅属于 Chat。

## 后果

- 输入面只存在于 Chat（与 hero）；要输入就切换标签页。接管交互（待审批）在任何标签页都可回答——seat 钉在当前视图上，在全高全宽视图上浮动。
- Trajectory 上被钉住的接管会暂时遮住上下文方块条与记录表下部；这与旧浮动 composer 的瞬态姿态相同，只是现在仅限于交互存续期间。
- `--dsh-composer-height` 发布机制不变（Chat 的浮动控件消费它）；Trajectory 不再从它派生任何几何。
- 2026-07-27 账本决策的 composer-overlay 段落与 2026-09-16 上下文方块条 note 的让位机制被本 note 取代；其历史记录保持原样。

## 验证

- `packages/client/ui-conversation/tests/skeleton.client.spec.tsx`：active-view 标记跟随标签选择与失效 id 的 Chat 回退；takeover 标记恰在存在待处理交互时出现并在 Chat 之外钉住 seat；textarea 节点跨切换保持常驻。
- `packages/client/ui-trajectory/tests/views.client.spec.tsx`：视图声明 `data-conversation-view-fullbleed`。
- `apps/web/tests/composer-tab-geometry.e2e.ts`（重写）：真实引擎下 Trajectory 页 seat 为 `display: none` 且无暴露的文本框、同一 seat 与 textarea 节点跨标签往返存活、Chat 的滚动条槽预留不变、全高全宽滚动容器事实不变；已刷新提交的可见性金证。
- `apps/web/tests/trajectory-virtualization.e2e.ts`：流式发送改经 Chat 标签页（composer 不再可从 Trajectory 触达），Trajectory 仍是流的观察面。
- `pnpm run test:gui` 绿；聚焦套件绿；web replay 场景（composer-tab-geometry、trajectory-virtualization、navigation-panes、startup-auto-selection）本地绿。
