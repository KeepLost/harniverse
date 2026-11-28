# Agent Note: 步骤未开启时放回 inbox 领取的输入

Status: implemented

[English](2026-11-29-inbox-claims-return-before-step-start.md) | 中文

## 问题

`AgentMachine.preStep` 在步骤还不存在时就从 inbox 领取输入：它先把提议的那批消息从队列移除，然后准备步骤（`driver.prepare` 组装提示词），再询问 `agent/pre-step`，最后才追加 `step/start`。这个窗口内的任何失败——准备过程抛错、某个 `pre-step` 监听器抛错、一次停止——都会让这一批消息随轮次结束而消失。持久化的 splice 只记录了移除，没有任何记录保存它移除了什么，于是这段输入丢失；`foldConsumedWork` 只能在事后把它记账。

官方的报告（#5655）是用户可见的情形：第二条提示触发压缩，用户在压缩期间按下停止，那条提示就没了。进程在这个窗口内退出时同样会丢掉这一批，而且恢复 Session 也找不回来，因为日志里除了一次移除之外没有领取的痕迹。

## 决策

- **Inbox 在队列之外保存一份领取记录**，与队列从同一批事件折叠而来（`core/agent/src/inbox.ts`）。不带 `outcome` 的移除是一次领取，追加到 `pending`；一次取消会把它的身份从两个领取列表中删掉，除非同一个 splice 又把它们插回。`settle(event)` 折叠机器追加的两个持久边界：`step/start` 清空 `pending`；`turn/end` 清空 `pending`，仅当轮次以 `interrupted` 结束时把这批消息留在 `interrupted` 里。构造函数像重放 splice 一样重放这些事件，所以恢复的 agent 读到的是在线时写入的内容；带种子的 Session 只重放 `seedLength` 之后自己的事件。
- **步骤开启之前就失败的轮次会放回这一批**（`core/agent/src/machine.ts`）。轮次的 `catch` 先确定结束原因，再在 `turn/end` 之前调用 `inbox.returnClaims()`：尚未落定的那批消息回到 `next-turn` 队首，队列面板会显示它，除非 `clear()` 已经丢弃了它。机器在追加 `step/start` 与 `turn/end` 时结算这份记录。
- **恢复的 agent 会拿回被中断的轮次领取的输入。** `AgentLoop` 在 `sessions.announce(session)` 打开 Session 的写入之后、`agents.announce(agent)` 之前调用 `inbox.restoreInterrupted()`。放回会追加 splice，因此是持久化的；新建的 Session 没有被中断的领取，这次调用什么也不做。
- **放回不会唤醒驱动。** 它在下一次唤醒时运行，排在之后入队的输入之前。

## 考虑过的替代方案

- **`pre-step` 拒绝时也放回** —— 否决：拒绝是准入对那段输入的裁定，和此前一样；轮次仍以 `blocked` 关闭，这批消息保持丢弃。
- **把每条消息放回它原来离开的队列** —— 否决：放回 `next-step` 的 steer 在队列面板里看不见，而它要插入的那一步已经结束；`next-turn` 是拥有者看得见、可以编辑或移除的地方。
- **在准备之前写 `user/message`，或增加一个错误钩子** —— 否决：钩子无法在进程退出后恢复领取；在准备之前记录提示，会在用户于准备期间停止时留下一条没有回答的提示。
- **放回之后唤醒驱动** —— 否决：每次准备都失败的那批消息会陷入循环。它留在队首，直到原因被修复或拥有者移除它。
- **由各投递方自己放回** —— 否决：每个投递方都得保留一份副本，而 inbox 本来就能看到 `clear()` 和 `claim()`；由 inbox 默认放回。

## 影响

- 带 `keepInbox` 的停止现在会放回唤醒投放在步骤开启前领取的那批消息。`cancel.spec.ts` 此前钉住了丢失；该测试现在钉住放回。
- 每次唤醒都在准备阶段失败的那批消息会留在 `next-turn` 队首，之后每次唤醒都会把它和更新的输入一起领取并一起放回。原因修复后，拥有者从队列面板移除它即可；官方记录带有同样的后果。
- 某个 `pre-step` 监听器对一次提议抛错时，不再消耗掉那次提议。`loop.spec.ts`、`interception.spec.ts` 和 `context-snapshot.spec.ts` 此前钉住了消耗；每个测试现在都在下一次唤醒时运行被放回的提议，排在之后发送的提示之前。
- 下游 `pre-step` 钩子抛错的目标回合会回到队列，同时目标解除武装；下一次唤醒时驱动器的预约检查会拒绝这个回合，因为它的预约已经不在了。`goal-round-driver.spec.ts` 钉住的是放回的回合，取代原来的空队列。
- 用 `inject()` 注入的上下文若在准备阶段失败，同样会被放回，并成为下一次唤醒所开轮次的输入。
- 与官方改动（`da3ba0f245`，#9145）的差异：没有继承的 `session/end-seed` 规则，因为我们的 `session/end-seed` 不携带数据，而 Inbox 本来就从 `seedLength` 开始重放；压缩监听器没有改动，因为我们的 `compaction-basic` 在请求路径里没有模型切换检查；和官方改动一样，没有改动任何投递方。

## 测试

- `core/agent/tests/machine.spec.ts`：准备抛错时把这一批放回 `next-turn` 并只报告一次错误；被放回的一批在下一次唤醒时先于更新的提示运行；`step/start` 之后的失败让这一批保持落定；准备期间的停止在带 `keepInbox` 时放回、不带时丢弃。
- `core/agent/tests/agent.spec.ts`：一次领取按领取顺序回到 `next-turn` 队首，除非步骤已开启或已执行 `clear()`；轮次被中断的日志会重建一份领取，`restoreInterrupted()` 放回它一次，重复恢复不会重复入队，取消被放回的领取会把它删掉；步骤已开启或轮次失败的日志没有可恢复的内容。
- `core/agent-loop/tests/resume.spec.ts`：恢复一个轮次仍打开且已领取提示的持久化 Session，会在 `agent/created` 之前放回它，不写入任何合成轮次，并让它在下一条提示之前运行。
- 改动前，机器用例看到的是空的 `next-turn`，恢复用例在 `agent/created` 时看到的是空队列。
- `core/agent` 与 `core/agent-loop`：26 个文件，456 个测试。共用这个循环的投递方——acp、goal、schedule、queue、sdk、headless、plan、todo、peer、subagent、interaction、session-query、hooks、monitor、context——全部通过，只有三个权限测试以 root 运行时失败，在未改动的代码上同样如此。

## 相关

- 官方记录 `architecture/2026-11-24-inbox-returns-claims-for-an-unopened-step`（dsh 0.2.3-alpha.3）。
- [显式轮次取消](../architecture/2026-07-16-explicit-turn-cancellation.md)拥有信号生命周期；放回依托轮次自身的失败边界。
