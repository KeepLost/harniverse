# Agent Note: 逐条消息的 provider/model 溯源行

Status: implemented

[English](2026-10-31-assistant-provenance-meta-seat.md) | 中文

## 问题

会话转录里看不出每条 assistant 回复由哪条 provider 路由与哪个模型生成，于是中途切换过模型（或以另一路由 resume）的会话没有任何可见的逐条痕迹。事实本身早已持久化——每条 `assistant/message` 事件都携带 `message.source`（`ModelMessageSource`：provider、model），加载时校验非空——runtime 的 `AssistantMessageNode` 也早有可选 `provenance` 槽位，但会话折叠器从未填充（只有轨迹折叠器为其请求检查面板填过），逐条消息的元信息行也没有任何呈现接缝。

## 决策

先填充，再设席位：

- 会话 assistant 折叠器事件支撑的 `finalNode()` 现在从 `event.data.message.source` 填 `provenance: { provider, model }`，与轨迹折叠器完全一致。合成中断节点（没有定稿消息事件）不携带。
- `conversation.chat.assistant.meta` —— 由 `assistant-step` chat-node 条目声明的 single/session 席位（声明即认领），owner share 为 `AssistantMetaOwnerProps = { provenance }`（纯数据）。内置占用者以 priority 100 把 `provider · model` 渲染为消息体下方一行安静的 11px 三级归属文字；更低优先级的注册可以按自己的方式呈现同一身份，dispose 恢复内置标签。
- 摆放归渲染点（AssistantMarkdown 在 `.meta` 尾行渲染席位输出），文案归占用者——与兄弟席位相同的渲染点/占用者分工。未接线席位时直接渲染裸 id（画廊/正文的回退模式）。
- 身份未知时渲染点保持静默：流式行（尚无 final node）与合成中断不打标签。Host、协议、会话格式零改动——v0 事件已携带数据，contract digest 不受影响。

## 备选方案

**不设席位的固定行内标签。** 差异最小，但不可替换，且违背 row-7 席位批次恰好为这些域确立的呈现席位模式。

**回合尾 chrome 标签。** 回合粒度会错标多步回合与回合中途的模型切换；需求是逐条消息。

**Host 侧改动（新投影或事件字段）。** 不必要：身份已按消息持久化；新增承载面信息增益为零（contextPressure 投影丢弃 provider/model 正是警示镜像）。

**会话级显示（stats dock 或模型席位）。** 只表达当前/下一次路由；多模型会话的历史无法在会话级归因。

## 后果

- 每条定稿 assistant 消息——含事件支撑的中断——都获得可见归属行，因此装配浏览器的金标发生变化；全部受影响金标文件已在同一变更中刷新（唯一的文本形状变化：每条定稿行新增一条 `text: provider · model`，中断时与停止标记相邻）。
- 第三方以低于 100 的优先级注册即可隐藏或改样式该标签；dispose 恢复。客户端 slot catalog 随新席位再生。
- 验证：折叠器 provenance 断言（以可区分 source 填充定稿；合成中断保持 undefined）；presentation-seats 套件中的占用者、桥接、未知即静默与 registry 台架（priority 100、dispose 恢复、fiber 拆除）；`pnpm run gen-client-catalog`；受影响文件 oxlint 零发现；`pnpm run typecheck`；`pnpm run test:gui`；`pnpm run test:snapshot` replay；web e2e 金标经 `DSH_SNAPSHOT=refresh` 刷新并抽查 replay 绿。
- 关系：扩展 row-7 席位家族（[2026-10-30 row-7 seats](2026-10-30-row7-presentation-seats.md)）；轨迹请求检查显示（[2026-09-16 trajectory request context](2026-09-16-trajectory-request-context.md)）仍是请求级视图，本 Note 拥有逐条消息的会话行。
