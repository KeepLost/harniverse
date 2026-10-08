# Agent Note: 在认领边界前撤回待处理插话

Status: implemented

[English](2026-10-06-recall-pending-steering.md) | 中文

## 问题

Host 早已能通过 `session.updateQueue` 移除或编辑待处理的 `next-step` 单次入队项，但 Web 没有入口：待处理插话气泡只有「复制」，QueueDock 只能撤回 `next-turn` 行。由此产生两个缺口。Stop（`keepInbox`）停泊的插话会与新输入同批混入下一次发送，却无处收回。而一次被拒绝的 `queue-item-not-found` 混杂三种含义——循环已认领该批次、另一客户端已撤回、会话是冷的——UI 只能笼统提示「可能已经开始发送」。该操作还能改删没有任何用户动作拥有的注入上下文行（审批通知、任务完成）。

## 备选方案

- **后移提交点，让撤回窗口延伸到请求发出（准入水位）。** 本次否决：它改写 agent-loop 的提交顺序，迫使十余个消费方接受新的 durable 事件，并与既定的上游 0.2 吸收计划耦合。认领边界已覆盖常见场景（工具等待、提问等待、停泊插话）。
- **在客户端过滤非用户行，而非由 host 拒绝。** 否决：任何其他客户端或脚本都能绕过；该决策属于做出它的操作本身。
- **带时间窗的撤回与发送后反悔。** 否决：边界是因果性的（认领），不是时间性的；时间窗既不能保证未读，也帮不了空闲时的同步发送。
- **批量撤回（「全部撤回」）。** 否决：逐条、非原子的移除需要显式产品决策（批量清除已由停止承担）。

## 决策

- **撤回窗口止于认领**（D1a、D3a）：按钮只在单次入队项仍待处理时收回它。认领之后 UI 报告「模型已读取」并引导使用停止（D5a）；不设时间窗、不做请求后撤销、不做批量动作（D6a）。
- **Host 收紧 `session.updateQueue`**（D7a）：`next-step` 单次入队项除非 `source.kind === 'user'`，其 edit/remove/steer 一律以新错误码 `queue-item-not-user` 拒绝；`next-turn` 保持接纳插件 follow-up 不变。`queue-item-not-found` 的 details 现在携带该单次入队项的持久 `status`——`claimed`/`settled`（模型已读）、`discarded`（已被撤回）、或冷会话的 `{ state: 'unknown' }`（操作绝不复活冷会话）——客户端据此按事实路由文案，而不是猜测。
- **待处理插话气泡可撤回**，经新的 `ChatViewInjected.recallSteering(itemId, content)` 在 `apply.ts` 组装：先执行 Host 移除，只在成功裁决后用 `splitFileHandleText` 剥离句柄的纯文本回填输入框（D2b）。草稿非空时保留草稿、文本进剪贴板并提示；带图片/文件附件仍可撤回但提示附件未恢复；任何失败绝不回填，输掉竞态的文本不会在输入框复活。该操作在 Stop 停泊后仍可用，对已寻址 subagent 隐藏（QueueDock 的可变性规则），chat 域依旧不导入 input 域。
- **同一语义只用一套文案**（D8a）：QueueDock 的删除动作统一称为「撤回」，且每一次被拒的撤回——条带行或气泡——都报告持久生命周期，而非笼统的「可能已开始发送」。
- **范围之外，记为已知限制**（D9a、D10a）：continuable-subagent 与冷会话的待处理残留仍不可撤回；移除不回收附件；撤回不抹除准入 splice 中的正文，导出与附件授权仍可引用。

本笔记取代[steer-action 笔记](2026-07-30-web-queue-steer-action.md)中「只有复制、没有 Fork/编辑/删除操作」这一待处理插话呈现条款；该笔记对严格 steering 决策本身仍然有效。

## 后果

- 撤回对认领竞态的安全由既有同步临界区保证：先移除产生 `canceled` splice，先认领产生携带生命周期的拒绝。空闲唤醒仍是零宽窗口（`prompt` 返回前已同步认领）。
- 被撤回的消息在转录中不留痕（`canceled` splice 是唯一记录），但正文仍在日志的插入 splice 中可读：撤回的含义是「不再发给模型」，不是抹除。
- QueueDock 的撤回失败文案读取 `QueueMutationError.status`；调用抛错版 `ConversationController.updateQueue` 的调用方看到同样的结构化拒绝，撤回编排则使用不抛错的 `removeQueueItem`。

## 验证

- `packages/host/apiproxy/tests/api-proxy-status.spec.ts`——next-step 用户消息撤回返回 `discarded`；非用户 next-step 行对全部操作返回 `queue-item-not-user`，而插件 `next-turn` 行仍可变更；输掉的竞态在 details 中返回 `claimed`、`discarded` 与冷会话 `unknown` 生命周期。
- `packages/client/ui-conversation/tests/`——`queue-dock.client.spec.tsx`（撤回文案、按状态区分的通知）、`chat-view.client.spec.tsx`（运行与停泊时可见、subagent 隐藏、忙态门控、以单次入队项身份与内容发起调用）、`chat-apply.client.spec.tsx`（仅成功回填、句柄剥离与附件提示、草稿非空走剪贴板、模型已读拒绝不回填）、`service-orchestration.client.spec.ts`（新错误形态下 steering 竞态收敛行为不变）。
- `apps/web/tests/steering.e2e.ts`——keyless 回放在气泡上撤回被提问停泊的插话（下一次请求不含它；输入框回填），并在下一次发送前撤回 Stop 停泊的插话；待处理插话的 ARIA 金样钉住新的撤回动作。
