# Agent Note:Wave-6 批次 D —— client-ui-stats 逐步事实视图

Status: implemented

[English](2026-11-12-wave6-client-ui-stats.md) | 中文

## Problem

官方 `dsh-experimental-client-ui-stats`(wave-6 调查 row 8)在会话旁渲染按轮次/步的上下文用量、计时、缓存命中与工具事实。Harniverse 此前没有这样的表面:wave-2 默认禁止本地模型计量/计费,因此没有任何逐步测量被展示。owner 的 row 8 裁定将该事实视图放行到默认之外,同时维持计费禁令,并列入 wave-6 执行队列的批次 D。

## Decision

以纯消费型客户端插件 `packages/client/ui-stats`(`@deepseek-ai/dsh-client-ui-stats`)吸收:折叠共享会话窗口 —— 无宿主侧服务、无新会话事件、无计量:

- **四个 `ConversationNodeDefinition` 拥有一个 `stats` 视图目标**:`stats-step`(每个 `step/start`;折叠流块得 TTFT、装配消息得不相交 usage/中断/答案预览、按 callId 配对的 `tool/call`→`tool/result`(区间取并的墙时)、`llm/retry` 计数),`stats-prompt`(每个 `user/message`;触发事实 —— 来源种类、生产者、声明形式、通知摘要、预览、文件/图片计数 —— 轮次归属取自引擎解析的 Location),`stats-turn-end`(关闭标记,使中断尾部与结局可渲染),`stats-compaction`(一次事务的提供者/模型/usage/折叠规模/耗时/错误;编号压缩归入所属轮次,独立压缩位于轮次之间)。
- **视图注册一个 `conversation.view` 页签**(`ctx.slots.inject`,排在 Trajectory 之后),经会话绑定提供 `loadOlder`;合计栏汇总已加载窗口;表格把轮次展开为步,展示上下文 tokens(input + cacheRead + cacheWrite)、缓存读·写与命中率(cacheRead ÷ (cacheRead + input))、TTFT、模型/解码耗时、t/s、工具 pill、重试与错误。
- **触发词汇本地化**:仅用户提示与插件注入 —— 官方的团队消息发送者列无对应物(Agent Teams 维持拒绝)。费用/计费数字按裁定缺席。

## Alternatives considered

**宿主侧整日志投影(官方 `dsh-session-stats` 模式)。** 本批次拒绝:已加载窗口合计是 Trajectory 已确立的诚实口径,而宿主折叠会为一个页眉新增持久化投影包;已作为后续工作记入 README。

**逐调用折叠详情行。** 拒绝:逐调用检查已在 Trajectory 检查器中;步行携带按名称 pill 与未完成计数,不复制该表面。

**PTC 内层派发的单独归因。** 拒绝:`tool/code-dispatch` 子调用并入父 `tool/call` 配对 —— 其时间位于父区间内,输出计入父结果规模;记为已知限制。

## Consequences

统计页签补完了 wave-6 执行队列(A/B/C 经 PR #286/#287 合入、#288 晋升)。`ConversationViewSnapshotMap` 合并加宽了会话存储暴露的泛型;Trajectory 的规格夹具随之收窄(增量调和,无行为变化)。挂载面遵循新包清单(tsconfig paths + client 聚合、`cordis.patch.yml` 行、web-app 依赖、slot 目录、中英模块图、README 对)。视图滚动由会话壳的滚动器承担 —— ui-theme 抬升面规则捕获到缺失的滚动条 rebind 后修正。包证据:42/42 测试、定向覆盖率 100%(v8 ignore 仅用于引擎保证臂并附理由)、`test:gui` 全绿、翻译配对一致。
