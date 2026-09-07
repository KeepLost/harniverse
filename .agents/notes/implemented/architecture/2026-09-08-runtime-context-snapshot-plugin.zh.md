# Agent Note: 运行时上下文快照移出智能体循环

Status: implemented

中文 | [English](2026-09-08-runtime-context-snapshot-plugin.md)

## Problem

智能体循环（agent loop）持有运行时上下文的发布职责：每个 pre-step 组装 system-prompt 上下文平面，并在组装文本与保留快照不同、或压缩（compaction）移除了保留快照时，向进入批次 prepend 一份完整快照。这留下三个缺陷。在请求瀑布内完成的压缩（请求边界或溢出重试路径）或没有后续轮次的手动 `/compact`，会让模型直到某个稍后的步骤碰巧运行前都得不到当前运行时上下文。任何单一策略变化都会重新发布所有章节，重复花费未变化部分的成本。而发布逻辑内嵌在 `dsh-agent-loop` 中，迫使所有组合接受同一种发布策略，没有可替换的接缝。

文本归属同样发生了漂移：`harness:source` 上下文在第二段中携带 DSH 关系与第三方声明，在一个主题是路径的上下文里重复身份材料，而 `dsh-app-boot` 持有组装它的辅助函数。

## Decision

[`@deepseek-ai/dsh-context-snapshot`](../../../../packages/context/context-snapshot/README.md) 持有发布职责；`dsh-base` bundle 在 `system-prompt` 之后直接挂载它，因此所有 profile 都继承。`dsh-agent-loop` 不再计算或追加快照：其 pre-step 默认决策就是未修改的已领取消息，`runtime-context.ts` 已删除且无兼容路径。

### 快照语义

保留状态是对本插件自身持久 `user/message` 记录按事件顺序的折叠（fold）——complete 替换、partial 覆盖、cleared 清空——每次决策时重新推导，绝不在内存中缓存。发布将当前组装的章节与该折叠比较：会话开始以及章节名称集合变化时发布**完整**快照；名称集合稳定而文本原地变化时发布仅携带变化章节的**部分**快照；平面清空时发布**清除**标记；未变化时不发布。部分快照的来源持久携带 `form: 'snapshot', partial: true`：`dsh-llm` 的 `ContextFormed` snapshot 变体新增 `partial?: true`，Web UI 为其渲染专用的部分更新文案（`运行时上下文有部分更新。`）而非完整取代说明。

### 时机路径

- **`agent/pre-step`，在 `next()` 之后** —— 到期快照 prepend 到进入批次、置于已领取输入之前，使模型先读到当前运行时上下文，再读它必须处理的材料。在瀑布之后（而非循环过去的之前）计算，关闭了步骤压力缺口：串行 pre-step 监听器期间发生的压缩已反映在此决策读取的折叠中。
- **`agent/request`，在 `next()` 之后** —— 压缩在请求瀑布内完成并遮蔽保留快照时，恢复消息在此持久追加；请求历史从会话 surface 重建，因此重试的请求无需新的用户输入即可携带它。失败只记录日志且请求继续：上下文记账绝不中断它所观察的请求。
- **智能体空闲时的 `compaction/end`** —— 手动 `/compact` 不运行任何步骤或轮次，因此由一个受控的异步恢复直接追加到期消息；进行中的轮次和请求通过上面两条路径持有自己的恢复。

### 身份与 checkout 重组

`dsh-system-prompt` 导出 `HARNESS_IDENTITY`：顺序 −100 的身份开场白现在说明 Harniverse/DSH 派生关系以及第三方、无隶属、许可证保留声明。`includeHarnessIdentity: false` 移除整个开场白，含声明。新的 [`@deepseek-ai/dsh-harness-source`](../../../../packages/context/harness-source/README.md) 持有 `harness:source`（顺序 −99，紧邻 `app:web-surface`（−98）之前）：单个段落给出 `HARNESS_SOURCE_ROOT`（从包自身入口向上四跳推导，导出供测试与快照归一化使用）以及逐字保留既有措辞的 pwd/cwd 分离句。`dsh-app-boot` 的 `addHarnessSourceContext`/`HARNESS_SOURCE_CONTEXT` 已删除且无兼容路径。`dsh-web-app` 通过 bundle 行无条件挂载 `dsh-harness-source`——命名实现 checkout 与表层无关——因此 `surfaceContext` 现在只门控 `app:web-surface` 上下文及其变量，且 `dsh-web-app` 不再依赖 `dsh-app-boot`。

## Supersession

本 Note 取代 [Web agents receive explicit runtime context](../bug-fix/2026-07-28-web-agent-runtime-context.md) 中快照发布的部分：发布归插件所有，并具备循环从未有过的部分快照语义与三条压缩恢复路径。它取代 [Source checkout paths do not define working directories](../bug-fix/2026-07-30-source-checkout-workdir-distinction.md) 的文本决策：checkout 事实改由 `dsh-harness-source` 持有，workdir 分离句逐字保留，DSH 关系条款移入 `HARNESS_IDENTITY`。[统一动态提示词默认值](2026-08-30-unified-dynamic-prompt-and-runtime-defaults.md)保持组装路径不变；本 Note 移动的是组装结果的发布位置。

## Testing

包内快照与 invariant 规格（23 个用例）固定了日志派生折叠、不可读种子容忍、complete/partial/cleared 决策表以及全部三条时机路径，包括请求瀑布与空闲压缩恢复。agent-loop 套件中的运行时上下文部分随行为迁移；`agent-loop-testkit` 与 `agent-spine-demo` 组合挂载该插件，使组装测试保留快照发布。`dsh-client-ui-conversation` 测试对真实部分记录固定部分更新文案，`dsh-system-prompt` 测试逐字固定 `HARNESS_IDENTITY`。

## Alternatives considered

**在 `dsh-agent-loop` 内修复压缩缺口。** 拒绝：这会加深归属问题——循环要长出自己的日志折叠，并继续迫使所有组合接受同一种发布策略，正是插件架构要避免的耦合。

**通过 `agent.inject()` 恢复。** 拒绝：注入的上下文会留在 inbox 中直到另一条消息唤醒驱动器，而恢复必须落在制造缺口的请求或压缩边界之内，持久且无需轮次。

**只保留完整快照。** 拒绝：单章节策略变化将不断重新发布所有未变化章节；按章节的 diff 由日志派生且廉价，持久 `partial: true` 标记让线缆消费方如实了解范围。

**原地改写或合并早期快照消息。** 拒绝：历史是 append-only；改写破坏前缀缓存复用与回放，而模型通过阅读快照序列重建当前状态。

**把 DSH 声明留在 `harness:source`。** 拒绝：身份归身份开场白所有；checkout 上下文命名的是路径。在那里携带声明会在每个同时挂载两者的组合中重复身份材料。

## Consequences

策略变化现在只需花费与变化章节成比例的部分消息，而非完整重新发布；压缩也无法再在步骤、请求或手动压缩边界让模型持有过期的运行时上下文。`dsh-agent-loop` 更薄，且可以在没有快照行为的情况下测试。代价：部分快照的身份判定基于逐章节文本，重排章节或文本不变的含义漂移不会发布更新（已记录的限制）；请求边界恢复在瀑布内重新组装一次；省略该插件——或抑制运行时上下文——的组合不发布快照，testkit 与 demo 组合通过挂载它来覆盖。
