# Agent Note：分支标题递增改读常驻标题投影，而非投影后的列表存储

Status: implemented

中文 | [English](2026-09-17-fork-title-resident-projection.md)

- 日期：2026-09-17
- 范围：`@deepseek-ai/dsh-client-runtime`（会话分支标题策略）
- PR：待补（本笔记与修复同船提交）

## 问题

在重连后约一秒内触发的分支手势会产生一个标题永远得不到 ` (1)` 递增的子会话。e2e 场景 `chat-long-interactions` 在 CI 负载下命中了它：为分支子会话录制的续跑脚本从未被消费，面包屑轮询超时，一直显示未加后缀的标题。

`SessionService.fork({ increaseTitle: true })` 从投影后的会话列表存储（`list.getSnapshot().byId[id].title`）读取源标题。该存储距离标题的真正归属地差一次 flush：标题存放在 manager 的按会话常驻投影存储里，列表存储只有在投影的 `markDirty` flush 级联触发 `projectList()` 之后才能看到。重连会用不含标题的基线重建列表，并异步地逐个重新落盘标题，因此与重落盘竞速的分支会读到 `undefined`，并把它当作"没有持久源标题"——静默跳过重命名，却仍然打开子会话。期间 UI 一直显示正确标题，因为面包屑读的是会话自身的投影 face，掩盖了这层滞后。

## 决策

`fork` 现在通过 `SessionManager.titleOf(sessionId)` 读取源标题——对常驻 `'title'` 投影的一次同步读取，正是 `buildListSnapshot` 构建列表行时读取的同一来源。快照构建器复用同一访问器，两处读取不会漂移。投影后的列表存储保留其渲染职责；它不再是分支标题策略的输入。

## 考虑过的替代方案

- **读取标题前重试或等待列表 flush**：否决——那只是为读错来源打补丁，给用户手势加等待；权威值本就可同步读取。
- **把递增移到宿主侧（fork RPC 带上重命名语义）**：与缺陷不成比例的线上契约变更；标题策略（`increaseTitle`）本就是客户端职责。
- **把缺失标题当作分支失败**：会让尚无标题的会话（仅有 cwd 的空白会话）无法分支。

## 后果

- 在列表存储滞后于标题重落盘期间发起的分支，现在仍会产出带递增后缀的子标题；"静默无后缀子会话"状态消失。
- 来自子代理会话的分支现在也会递增：它们的列表行从不携带 `title`（目录路径只设置 `displayTitle`），因此旧的读存储实现总是跳过其重命名。`subagent-conversation` 的分支 golden 已刷新为带后缀的行，与普通分支 golden 的约定一致。
- `titleOf` 成为策略代码唯一认可的同步标题读取；列表行与策略共享同一事实来源。
- 既有的无标题行为保持不变：没有持久标题就不重命名，这是设计使然。

## 验证

- `sessions-service.client.spec.ts` 新增回归测试：在 `session/projection` 标题帧的同一同步 tick 内发起分支——早于任何 flush 把标题落进列表存储——仍会发出 `session.rename` 递增。该测试对旧的读存储实现失败。
- 既有的"无标题策略或无持久源标题时不重命名"分支仍然通过：完全没有标题投影时 `titleOf` 为 `undefined`，不触发重命名。
- `pnpm run test:gui` 336 个文件全绿；`chat-long-interactions` e2e 在 `DSH_SNAPSHOT=replay` 下通过。
