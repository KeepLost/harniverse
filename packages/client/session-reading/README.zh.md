# @deepseek-ai/dsh-client-session-reading

[English](README.md) | 中文

会话行未读标记背后的按会话阅读记忆。某个会话在无人查看时完成一轮，就会显示为未读；一旦阅读者确实看到了完成的这一轮，标记即清除，行菜单也可以手动设置或清除它。每个会话的记录保存在宿主内存中，由该宿主的每个浏览器、设备与主体共享，因此在同一宿主上打开的两个浏览器对哪些会话未读保持一致。本包有两个 face：宿主半边保管账本并通过 `sessionReading` Remote 提供它，浏览器半边把它发布为可选的 `useSessionReading` 根 hook。[ui-workspace](../ui-workspace/README.md) 渲染该标记，并报告会话列表正在显示什么。

## 宿主账本

`SessionReadingService`（`ctx.sessionReading`，本包的默认导出）为每个会话保存一条记录：`{ sessionId, completedTurn, failed, readTurn, manualUnread }`。持久的 `turn/end` 事件推进它：`session/event` 流上的每次结算都把 `completedTurn` 设为该轮次，并把 `failed` 设为原因种类是否为 `error`。恢复与种子历史不会经过这条流，因此打开一个旧会话不会触发任何标记。轮次编号在同一份日志内递增；若某次结算不高于已记录的轮次，说明该 id 如今承载的是另一份日志，记录从该轮次重新开始。

一条记录为未读，当且仅当 `manualUnread || completedTurn > readTurn`。记录从不清理：会话已被删除的记录会留存到宿主退出，其间它是惰性的，因为没有任何行指名它。

## Remote

- `sessionReading.list()`（能力 `harniverse.observe`）返回每条记录的冻结副本。
- `sessionReading.mark(sessionId, 'read' | 'unread')`（能力 `harniverse.operate`）应用一次阅读动作。`read` 把 `readTurn` 设为 `completedTurn` 并解除手动标记；`unread` 升起手动标记，会话尚无记录时创建记录。已处于所请求状态的会话返回其已存记录且不发出通告；对没有记录的会话执行 `read` 返回 `{ record: null }` 且不存储任何内容。Remote 以 id 为键保存记录，不检查会话是否存在。

每次已存储的变更之后，服务都会发出空载荷的 `sessionReading/changed`。[api-remotes](../../api/remotes/README.md) 转发该事件，消费方重新读取 `list()`，它始终是权威账本。

## 浏览器半边

插件注入 `slots`、`sessions`、`remote` 与 `remote.sessionReading`。它的 `SessionReadingController` 是不依赖 React 的对象层：读取一次账本，在转发的 `sessionReading/changed` 事件和 `connection/reset` 时重新读取，把抓取期间到达的调用合并为一次尾随抓取，并在读取被拒绝或出错时保留上一份镜像（在控制台给出警告）。`apply` 通过 `ctx.slots.provideRoot({ hooks: { sessionReading } })` 发布该控制器，渲染器把它绑定为 `useSessionReading` 根 hook。该 hook 是全局标准 props 的可选成员：没有本插件的组合——组装式 jsdom 快照、不挂载阅读行的宿主——会原样渲染会话列表，因此消费方必须容忍它缺席。

`useSessionReading(selector)` 在 `{ unread, mark, report }` 上做选择。`unread` 以 id 为键，为每个未读会话保存一项，每项只携带 `failed` 位；键缺席即视为已读。`mark(sessionId, action)` 从行菜单发送一次阅读动作。`report(sessionId, rowVisible)` 是会话列表声明自己当前是否渲染了某个会话的行的方式。

### 确认已读

仅当以下每一项关注事实同时成立时，控制器才自行发送 `mark(sessionId, 'read')`：

- 文档可见且持有窗口焦点（`document.visibilityState === 'visible' && document.hasFocus()`）；
- 该会话是当前选中项（`ctx.sessions.list`）；
- 列表报告其行已渲染，且此后未报告它隐藏；
- 转录展示了账本所记的那一轮：该会话的对话快照持有对应的 `turn/end`；对于宿主启动以来未完成任何轮次的会话，则要求其窗口已加载完毕。

任一事实变动都会重新判定，因此阅读者正在查看时落地的完成，会在新一轮渲染出来的那一刻被确认；而历史尚未到达的选中项保持未读。每个会话同一时刻只有一次确认在途；被拒绝或失败的确认会在下一次关注变化时重试，每次成功的标记都会重新读取账本。

手动未读会被保持：在会话持续被选中期间到达的、带 `manualUnread` 的记录永远不会被自动确认，无论该标记来自本页的行菜单还是另一个浏览器。离开该会话会解除保持，回到它时就像阅读任何其他完成一样把它读掉。

## 模型体验

无。阅读账本是宿主的查看状态，其 Remote 从不进入提示词、工具 schema 或会话事件。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **记录只存在于宿主内存** —— 宿主重启会丢弃全部记录，因此在新进程上、下一次完成之前，没有任何会话显示为未读。升级路径是在某个存储域中按会话 id 持久化每会话记录。
- **行被挂载即算已读，而非滚动进入视口才算** —— 会话列表报告的是它是否渲染了选中的行；已挂载但位于滚动视口之外的行仍然计入。
- **被拒绝的手动标记只记录日志，不作提示** —— 该行保留其标记，原因留在控制台。
- **转录检查读取的是对话快照，而不是 DOM** —— 挂载了选中会话却隐藏其转录的对话视图，仍会被视为正在阅读它。
- **确认按会话而非按轮次** —— 在一次 `mark('read')` 调用进行期间结算的轮次，会与读者已看到的那一轮一起被确认。
