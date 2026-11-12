# Wave-6 批次 D:client-ui-stats 逐步事实视图

[English](2026-11-12-wave6-client-ui-stats.md) | 中文

日期:2026-11-12
状态:已实现(wave-6 row 8 定论"吸收";计费仍被禁止)

## 做了什么

新增客户端插件 `packages/client/ui-stats`(`@deepseek-ai/dsh-client-ui-stats`),向 `conversation.view` 环贡献"统计"页签,与 Chat、Capabilities、Trajectory 并列。它基于共享会话窗口展示按轮次/步的测量事实:上下文 tokens(input + cacheRead + cacheWrite,不相交的提供方 usage 契约)、缓存读·写与命中率、首字延迟、模型与解码墙时、解码速度(t/s)、工具记账(按名称 pill、按区间取并的配对墙时、未完成调用、错误)、重试计数、关闭原因,以及压缩事务(编号压缩归入所属轮次,独立压缩位于轮次之间)。合计栏汇总已加载窗口。费用/计费数字刻意缺席——row 8 裁定保持"禁计费"默认,只放行事实。

## 为什么

官方 `dsh-experimental-client-ui-stats`(wave-6 调查 row 8)被裁定可吸收:逐步事实视图(上下文用量、计时、缓存命中、工具成本)在 wave-2"永不本地模型计量/计费"默认之外;默认本身不变。这是 wave-6 执行队列的最后一项(批次 A/B/C 经 PR #286/#287 合入并由 #288 晋升)。

## 决策

- **本地折叠,不做宿主投影**:合计覆盖已加载事件窗口,非整日志。官方 sessionStats 整日志投影(宿主侧包)作为后续工作记录在 README;Trajectory 已确立"已加载窗口合计"这一诚实口径。
- **触发词汇本地化**:用户提示(按 `source.files` 媒体类型计文件/图片数)与插件注入(生产者、声明形式、通知摘要)。官方的团队消息发送者列无对应物——Agent Teams 维持拒绝。
- **PTC 内层派发并入父调用**:`tool/code-dispatch` 子调用不单独归因;其时间位于父 `tool/call` 配对区间内,输出计入父结果规模。记为已知限制。
- **无逐调用折叠面板**:按名称 pill 加未完成计数;逐调用细节留在 Trajectory 检查器(不复制表面)。
- **壳层滚动**:ui-theme 滚动条规范捕获到"抬升面上滚动未 rebind"后,视图移除了自己的 `overflow-y`——由会话壳的滚动器负责翻页。

## 形态

四个 `ConversationNodeDefinition`(`stats-step`、`stats-prompt`、`stats-turn-end`、`stats-compaction`)为一个 `stats` 视图目标折叠事件窗口;`stats-aggregate.ts` 分组行与合计;`StatsView.tsx` 渲染。注册:`ctx.slots.inject('conversation.view', ...)`,经会话绑定提供 `loadOlder`,在真实框架栈上验证可销毁。挂载面:`tsconfig.base.json` paths、`tsconfig.client.json` 引用、`cordis.patch.yml` 行、web-app 依赖、slot 目录再生、模块图(中英)更新。

## 验证

- 包套件:42 测试全绿(真实 ConversationNodeAssembler 折叠、聚合/构建器、格式化、jsdom 视图行为、真实栈注册+销毁、构建产物交接/CSS)。
- 定向覆盖率:包内语句/分支/函数/行 100%(v8 ignore 仅用于引擎保证的防御臂,均附理由)。
- `pnpm run test:gui` 全绿(581 文件);定向 oxlint 干净;typecheck 干净;翻译配对 1328/1328。
