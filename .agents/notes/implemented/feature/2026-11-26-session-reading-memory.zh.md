# Agent Note: 会话行未读标记背后的按会话阅读记忆

Status: implemented

[English](2026-11-26-session-reading-memory.md) | 中文

## 问题

侧边栏里“某个会话在无人查看时完成了”的提醒，是客户端本地状态。运行时观察每个会话在未被选中时运行位落下，就在其列表行上设置一个 `completed` 位；选中该会话便清除它。这使提醒成了某个浏览器标签页的属性，而不是阅读者的属性：在同一宿主上打开的另一个浏览器或设备从不显示它，一次刷新就会忘记它，而且只要行被选中它就立刻清除，哪怕转录尚未加载，于是快速点进又离开的阅读者什么都没看到就丢掉了标记。它还只记录了一轮已经结束——不记录是否失败——也没有任何手动标记会话的途径。

## 决策

阅读状态属于宿主。[`@deepseek-ai/dsh-client-session-reading`](../../../../packages/client/session-reading/README.md) 在一个包里以两个 face 拥有它。

宿主 face `SessionReadingService`（`ctx.sessionReading`）在宿主内存中为每个会话保存一条记录：`{ sessionId, completedTurn, failed, readTurn, manualUnread }`。持久的 `turn/end` 事件通过 `session/event` 流推进它——不新增任何会话事件或线帧——一条记录为未读，当且仅当 `manualUnread || completedTurn > readTurn`。宿主的每个浏览器与主体读到的都是同一批记录。Remote 是一元的：`sessionReading.list()` 以 `harniverse.observe` 提供记录，`sessionReading.mark(sessionId, 'read' | 'unread')` 以 `harniverse.operate` 应用一次阅读动作，每次已存储的变更都发出无载荷的 `sessionReading/changed`，由 [`api-remotes`](../../../../packages/api/remotes/README.md) 经其名单转发，使消费方重新读取 `list()`。

浏览器 face 在一个不依赖 React 的控制器中镜像该账本，并通过 `ctx.slots.provideRoot` 把它发布为可选的 `useSessionReading` 根 hook。该 hook 是全局标准 props 的可选成员：没有本插件的组合会原样渲染会话列表，消费方必须容忍它缺席。[ui-workspace](../../../../packages/client/ui-workspace/README.md) 是消费方：它为状态点读取未读行，提供行菜单标记，并报告自己当前是否渲染了所选会话的行。

仅当四项事实同时成立时，控制器才自行确认一个已完成的轮次，每一项都回应旧提醒出错的一种方式。文档可见且持有焦点：隐藏在后台标签页或窗口之后的完成不算看到。该会话被选中。其行被会话列表报告为已渲染：侧边栏折叠为窄栏、或搜索替换了列表时，阅读者并没有在看这一行。转录展示了账本所记的那一轮——该会话的对话快照持有对应的 `turn/end`；对于宿主启动以来没有任何完成的会话，则要求其窗口已加载完毕——因此历史尚未到达的选中项保持未读。任一事实变动都会重新判定，每个会话同一时刻只有一次确认在途，被拒绝的确认会在下一次关注变化时重试。

手动未读是被保持，而不是被确认：在会话持续被选中期间到达的、带 `manualUnread` 的记录永远不会被自动清除，无论该标记来自本页的菜单还是另一个浏览器。离开该会话会解除保持，回到它时就像阅读任何其他完成一样把它读掉。

行的呈现跟随账本：未读行显示标注“未读”的 `done` 点，所记轮次失败的未读行显示标注“运行失败”的 `error` 点，实时活动仍然优先于该标记，行菜单负责切换标记。运行时客户端本地的 `completed` 位连同推导它的代码一并移除。

本包是 `packages/client/` 下的一个拆分项目：其宿主 leaf 加入宿主聚合，使 Typert 得以生成 Remote 契约；其客户端 leaf 加入客户端聚合。[`packages/client/connection`](../../../../packages/client/connection/README.md) 是带宿主半边的客户端包的先例。由于客户端 leaf 消费 `api-remotes` 的客户端 face，而 `api-remotes` 又挂载生成的 `/remote` 贡献，后者只把本包声明为 devDependency；peer 依赖边会在生成模块图据以排序的 peer 图中闭合成环。

账本只存在于宿主内存。宿主重启会丢弃全部记录，因此在新进程上、下一次完成之前，没有任何会话显示为未读；这一点已被接受。升级路径是在某个存储域中按会话 id 持久化每会话记录，[`dsh-message-feedback`](../../../../packages/feedback/message-feedback/README.md) 的边车是它的范式。

## 考虑过的替代方案

**保留客户端本地位，并在浏览器之间同步它。** 否决：阅读状态是关于阅读者的事实，而不是关于会话的事实，没有任何持久内容可供同步；客户端也无法告知其他浏览器本浏览器看到了什么。把它移到宿主正是整个决策本身。

**现在就持久化账本。** 暂缓：它要付出一份数据域规格、一份 schema，以及每次确认的一道持久化屏障，而所对付的失效模式——重启遗忘未读标记——是有界且自愈的。记录的形状已经是可持久化的形状，升级只需增加后端而不改动 Remote。

**为账本提供流式 Remote `follow`。** 上游的 session-status 插件按会话流式推送状态；Harniverse 的 Typert 只支持一元调用，那将需要一套新的流式传输。一元的 `list()` 加上转发的空 `sessionReading/changed` 复用了既有的转发事件帧，并让 `list()` 保持唯一权威读取。

**把根 hook 设为必需，并由运行时发布。** 否决：运行时将依赖该 Remote 与宿主行，而所有没有阅读插件的组合——包括组装式 jsdom 快照——都将无法渲染会话列表。可选 hook 使这道接缝保持插件原生。

**仅凭选中即确认**，即旧位的做法。否决：它会在转录到达之前清除，而这正是快速点进就会丢标记的原因。四项事实每次变化只花费一次快照读取，并且只清除确实展示过的内容。

**把任何已挂载的对话都视为正在阅读。** 否决：控制器看不到 DOM，而“该轮次位于已加载的窗口中”是对话快照本来就携带的证据。看得到自己行的会话列表则提供证据中关于行的那一半。

**从不自动确认手动标记。** 否决，改为保持：阅读者一旦离开该会话再回来，那就是在阅读它。在阅读者停留期间，保持依然保护着该标记。

**在 `packages/host/` 下放提供方包、在 `packages/client/` 下放消费方包**，即上游拆分 Remote 提供方与其浏览器消费方的方式。被已批准的单包设计否决；其代价是上文所述的仅 devDependency 依赖边。

## 后果

- 在同一宿主上打开的浏览器与设备对哪些会话未读保持一致，失败的完成与成功的完成在行上可区分。
- 记录从不清理；已删除会话的记录会惰性地留存到宿主退出。
- 行被挂载即算已读，而非滚动进入视口才算；转录检查读取的是对话快照而不是 DOM。
- 被拒绝的手动标记会让该行保持不变，且只在控制台报告原因。
- `SessionSummary.completed` 与 `SessionListEntry.completed` 退出运行时的公开契约；渲染旧提醒的消费方改为读取 `useSessionReading`。
- 治理配额页签曾通过可选的 `completed` 映射旧提醒，现已失去其 `done` 圆点；其行只显示交互与运行中两种状态。
- 阅读插件是 `packages/client/` 下第二个拆分的宿主／客户端项目，`sessionReading/changed` 加入转发事件名单。
- 在已挂载的会话列表之下加载或卸载阅读插件，只会重新挂载一个无状态的桥接组件；列表主体及其本地状态（包括进行中的搜索查询）保持挂载。

## 测试

`packages/client/session-reading/tests/ledger.host.spec.ts` 在真实会话存储上驱动宿主服务：每次持久结算、最新结算的失败位、复用会话 id 时的重新开始、每种标记结果、冻结的线缆副本，以及变更信号计数。`loader-composition.host.spec.ts` 通过仅用于测试的 `cordis.yml`，以真实 Loader 组合启动该服务。

`controller.client.spec.ts` 在伪造的宿主账本之上覆盖浏览器对象层：未读镜像及其稳定快照、单飞重取、被拒绝与中断的读取、每一项缺失的关注事实、实时完成、选中跟随、在途与重试的确认、来自本页与来自其他阅读者的手动保持，以及释放。`apply.client.spec.ts` 在真实 Context 上挂载插件，断言根 hook、转发信号、`connection/reset`、窗口焦点与文档可见性，以及随 fiber 撤回。

ui-workspace 的 tree、row 与 browser 规格断言未读点与失败点及其标签、行菜单标记、折叠、溢出、搜索、平铺与窄栏各状态下的行可见性报告，以及一道出现又消失时浏览器依然健在。运行时规格保留了被移除的位昔日所依附的列表刷新与选中行为。新包的每个文件、`tree.ts` 与 `Rows.tsx` 都在逐文件 100% 覆盖率门禁之下；运行时与 `WorkspaceBrowser.tsx` 处于已记录的客户端 GUI 欠账豁免中，新增行均已被覆盖。
