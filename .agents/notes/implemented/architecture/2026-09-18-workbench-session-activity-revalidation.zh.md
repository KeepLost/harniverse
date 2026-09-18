# Agent Note: 工作区工作台依据会话活动自动重验证已加载面

Status: implemented

[English](2026-09-18-workbench-session-activity-revalidation.md) | 中文

- 日期：2026-09-18
- 范围：`@deepseek-ai/dsh-client-ui-workspace`（工作台生命周期）、`@deepseek-ai/dsh-client-runtime`（列表活动水位）
- PR：pending（本笔记随修复一同提交）

## 问题

工作台的文件树、Git 变更列表与 Git 历史都是拉取式快照：目录缺失时加载、Changes 区首次打开时加载一次 Git，之后只靠两个手动刷新按钮才会再动。agent 在 turn 中改文件期间，所有已打开的工作台面全部变陈旧，直到用户手动点击刷新。

## 决策

两处配套改动让工作台跟随会话活动：

1. **列表活动水位改为随落定事件前进。** `SessionManager.handleMuxEnvelope` 此前只对用户发出的 `user/message` bump 摘要的 `updatedAt`；现在 `assistant/message`、`tool/result`、`turn/end` 也推进——步级落定，绝不按流式 chunk 触发。`applyMutation` 既有的 max 守卫保证回放或修复的旧事件不会让行倒退。工作区浏览器的 recency 排序因此在步级粒度上把正在流式的会话浮顶，与行"最近活动"的语义一致。
2. **工作台在其工作区水位前进时重验证已加载数据。** `WorkspaceWorkbench` 选取 cwd 等于工作区路径的全部会话（含 subagent——共享 cwd）的最大 `updatedAt`，并把已反映进数据的值记在账号的 `syncedActivity`。两者出现分歧时先去抖 500 ms，再静默重拉所有已加载目录与 Git 状态/历史——旧条目保持渲染直到新快照换入（stale-while-revalidate），没有加载闪烁打断阅读。面板关闭期间信号移动的，下次挂载时刷新（store 水位跨卸载存活）。手动刷新按钮保留其显式加载态。

## Consequences

- 会话的文件改动在 turn 落定（以及每个中间工具结果边界，经去抖）后自动出现在已打开的工作台里。
- 列表行随 turn 落定重排；没有按 chunk 的重排，侧栏渲染成本保持在原量级。
- cwd 不在本工作区的会话永远不会触发它的重验证。
- 会话之外的进程改动仍需手动按钮；触发源是会话事件，不是 fs watch。

## Alternatives considered

- **Host 侧 fs watcher + mux 失效帧：** 覆盖面严格更全（含外部改动），但需要新的推送契约、watcher 生命周期与去抖策略——作为文档化的升级路径推迟，已在重验证处留 `ponytail:` 注释。
- **把 workbench 槽扩为 session scope 以获得 `useSession`：** 为一个消费方改槽位契约架构；列表水位通过既有 `useSessions` 席位 delivers 同等信号。
- **按 chunk 的活动 bump：** 否决——会让列表 store 重建与侧栏在每个流式 chunk 上重渲染。
