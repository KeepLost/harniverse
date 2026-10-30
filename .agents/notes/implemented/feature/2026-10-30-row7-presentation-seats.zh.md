# Agent Note: 可替换呈现席位与独占会话匹配

Status: implemented

[English](2026-10-30-row7-presentation-seats.md) | 中文

## Problem

官方 row-7 的客户端 UI 增量之下，下游仍有五个呈现面是硬接的：新建会话行没有面向单会话选项的增量席位（官方的 worktree 入口正是其动机消费者），每处对话图片图库与推理正文都经直接导入渲染、第三方插件无法按域替换，且会话装配器对每个 Definition 独立匹配——在同一目标上呈现某个通用 Definition 事件族子集的业务 Definition 会重复渲染，没有办法认领事件。

## Decision

五个席位加一条分发规则，全部落在既有的 slot 与装配器缝上（所有者 2026-10-30 的 row-7 处置）：

- `conversation.hero.options` —— hero Workspace 行右端的根作用域列表席位，位于 workspace、agent 预设与模型档案胶囊之后。根作用域与其余 hero 席位一致（尚无会话，选择为下一个会话暂存），与官方的会话作用域有意分歧，理由同预设胶囊。选项区为空时整块收起。官方的 worktree 消费者需要的 Host API 下游尚不存在（`WorktreeService.create` 需要宿主 Agent；`connectWorkspace` 不透传 `cwd`），因此席位空载发布——官方同样如此，其后才由其 worktree 插件填充。
- `conversation.chat.user.images` 与 `conversation.chat.assistant.images` —— 两个独立可替换的 single/session 图库席位，分别由 `user` 与 `assistant-step` 聊天节点条目声明（声明即认领），各由内置共享 `ui-attachment` 图库以优先级 100 占用。更低优先级的注册只替换其中一个域；注销后恢复内置图库。steering 气泡与待定投影保持直接图库（每个席位唯一声明者；`steering` 键不能共同声明）。席位从条目组件以绑定的渲染回调转发给纯渲染器——正是官方自己的转发模式（"域调用者必须把框架 Slot 席位转发给自己的纯 React 后代"）。
- `conversation.details.tool.images` —— 详情面板的结果图片席位，由 ui-tool 的详情条目声明，同样以优先级 100 由模型侧视图占用。keyed toolview 条目内部的聊天行图库刻意不做席位：它渲染在其他条目自己的布局内，且响应式读取纪律禁止 ReactNode 值的 owner 属性。
- `conversation.chat.reasoning.body` —— 展开后的 Think 正文，由 `assistant-step` 条目声明；内置纯 pre-wrap 正文以优先级 100 占用，替换者获得同一段文本与流式状态而不触碰折叠行外壳。官方独立的 Content Factory 不移植：共享原子包（`ui-attachment`）就是下游的可复用实现缝，默认正文只是纯文本。
- `ConversationMatchResult.exclusive?: true` —— Definition 可为其唯一视图目标认领一个事件。分发先评估所有 Definition 的 match 再接受任何命中，随后把被认领的事件从同目标的其他 Definition 处扣下，并抑制该目标的未匹配事件 fallback；其他目标与无目标 Definition 照常收到。同目标两个认领、或无目标 Definition 认领，都在分发时报错并点名事件。当前没有已发布 Definition 使用认领（answered-question 节点走 sent-user-text 规则缝，从未冲突）；能力开放，装配器覆盖钉定顺序无关性、扣留、fallback 抑制与两种失败模式。

## Alternatives considered

**为所有图片域做一个共享图库席位。** 官方首先否掉了它——为一个域准备的替换会波及其他域；下游同理。

**在 `user` 与 `steering` 两个键上都声明用户图片席位。** 每席位唯一声明者是 SlotCore 不变量（第二个声明即抛错）；steering 保持直接图库而不是复制席位。

**在 ToolRow 内渲染 `tool.call.images` 席位。** ToolRow 渲染在 keyed toolview 条目自己的组件树内；触达它需要经 owner 属性转发渲染回调，为响应式读取纪律所禁止（"ReactNode 内容走 slot"）。主体自持的详情面板才是诚实的席位位置。

**用 Definition 优先级（`specific`/`default`）代替认领。** 官方评估后同样否决：优先级把分发变成排序而不是所有权声明，两个认领响亮失败而不是悄悄排序。

**随席位移植折叠动画或聊天分组机制。** 两者都骑在 B1/R33 对官方 turn-fold 家族的既有拒绝上；它们保持为 R33 自有设计的参考。

## Consequences

- 每个席位的内置占用者以优先级 100 注册，享有 slot 系统的遮蔽-恢复语义；无第三方注册时视觉上毫无变化，浏览器金标逐字节不变（replay 验证）。
- hero 行在有消费者之前携带一个空的、收起的选项区；worktree/建会话时选 cwd 的入口等待评审文件中记录的 Host API 拓宽。
- 独占认领逐事件由事件数据裁决；每个至少有一个命中的事件多分配一个 match 数组，分发保持注册顺序无关。
- 模型标签席位已被覆盖：`conversation.input.model` 存在、由 `ui-model-selection` 占用，其渲染点可替换性由既有 input-bar 测试钉定——记为碰撞，无新代码。
- 验证：装配器独占套件（两种注册顺序的扣留、跨目标与无目标投递、fallback 抑制、两种抛错模式）；ui-conversation 与 ui-tool 的占用者/桥接/线程/注册台架（默认优先级、单域遮蔽、注销恢复、fiber 拆卸）；skeleton hero 行摆放；`test:gui` 全绿。
