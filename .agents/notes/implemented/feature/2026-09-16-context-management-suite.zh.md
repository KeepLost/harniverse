# Agent Note：上下文管理套件——路由适配预检、压力提醒、显式跨度、审计清单

Status: implemented

[English](2026-09-16-context-management-suite.md) | 中文

范围:`packages/compaction/*`、`packages/context/context-nudge`、`packages/context/context-inspector`

## 问题

Owner 在异构模型间跑长会话。四个缺口,同一主题:

1. 把会话从大窗口模型切到小窗口模型(或重路由到**静默截断**的本地模型)会先发出注定失败的请求;唯一的自动恢复等 provider 认定的溢出错误——静默截断者永不报告——然后在做无意义的 `maxTokens` 减半后执行 `retain=0` 核弹式单发压缩。
2. 模型没有占用信号:`context_compact` 存在,但没有任何东西告诉模型*何时*值得行动。
3. `context_compact` 无法表达压*哪一段*——provider 策略永远选最老前缀。
4. 压缩行为不可审计:日志展示轨迹,但真实请求面(模型所见、检查点替换了什么)不可见。

## Decision

- **路由适配是预检且 provider 内部。** `agent/request` 监听器已解析容量并测量会话;fit 循环搭在压力块旁边。刻意*不*走 `context_compact` 工具通道(要求轮内模型主动),也*不是* `/compact`(人类触发、仅 idle、无目标窗口)。三个调用者、三种意图、一个缝。
- **分层折半,失败即反馈。** 每层按最老优先压缩,保留预算逐层折半。事务无法收缩的跨度(`UnhelpfulSummaryError`,从 `region.ts` 的普通 `Error` 提升为类型化导出)、重复跨度或无进展层都会折半预算而非中止;仅在 `retain = 0` 耗尽时放弃(警告一次,把失败留给 provider 路径)。这正是摘要套摘要合法且可终止的原因——溯源链经检查点 `sourceEventSeqs` 可传递组合。
- **提醒仅 token、非唤醒、工具门控。** 绝对阈值同时是模型级门槛(小窗口永远够不到,维持压力压缩 + `/compact`)。投递走既有 `agent.inject()` 缝:空闲驱动让提醒待定直到下一条用户提示;运行中驱动在下一 步边界领取。消费者注入前检查该 agent 组装的工具目录里有没有 `context_compact`(Code preset 不挂该工具;在那里的提醒是误导噪声)。迟滞在落回上次触发的下限后重新武装。策略与压力阈值同住 `compaction` 设置命名空间,同样的"组合默认、运行时覆盖、非法警告一次"形态。
- **跨度用位置,不用 id。** `from`/`to` 是从最老保留消息数起的 1 起算位置——模型可从自身上下文数出,零请求渲染改动,零全量会话金样翻搅。(seq 派生 `#N` id 注解已被考虑并推迟:它会改写每个模型可见请求,而序数已交付其收益;仅当位置漂移在实践中造成困扰再重访。)边界吸附保持工具调用/结果配对完整;跨度必须止于当前轮之前;解析后的跨度走编程式 `compactRegion()` 路径。结果报告遮蔽条目、token、吸附位置数与保留上下文规模——闭合模型的反馈回路。
- **检查器是投影,永不重组。** `ctx.contextInspector.manifest()` 复用 `systemPrompt.assemble` + `renderPrompt`、逐节点 `deriveEventMessage` 折叠与共享 meter。伴随测试在同一步内同时捕获 manifest 与真实请求,钉住 manifest ≡ 请求。展示面消费者(Web 审计抽屉、CLI 导出)是后续工作;服务与其等价性保证先行。

## 后果

- 小窗口(≤ 1,024 token fit 预留)只在已溢出时才 fit 恢复;生产窗口不受该预留边界影响。
- `docs/tool-catalog.md` 与 shipped-composition 目录期望随 `context_compact` schema 变更。
- base 组合挂载 `context-nudge` 与 `context-inspector`;preset 不动(nudge 的工具门处理 Code preset 的缺席)。

## Alternatives considered

- 基于 manifest 服务的 Web 审计抽屉 + CLI `dsh context`。
- 若位置漂移在实践中困扰模型,重访 seq 派生消息 id。
- 考虑在 UI 压缩卡时间线里呈现 fit 恢复结果。
