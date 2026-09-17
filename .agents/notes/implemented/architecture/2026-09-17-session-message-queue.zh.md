# Agent Note: 会话消息队列——持久 topic、强制归档与投递即唤醒的扇出

Status: implemented

[English](2026-09-17-session-message-queue.md) | 中文

- 日期: 2026-09-17
- 影响面: `@deepseek-ai/dsh-queue`(含 `/tool`)、`@deepseek-ai/dsh-client-ui-queue`、`dsh-client-ui-governor`(会话看板改名 + tab 环)
- PR: 6307ab410842837fa1c23a0f0f7adede0f45affc(特性 PR 合并后回填 SHA)

## Problem

会话之间需要一条 Kafka 语义的事件流缝:持久 append-only topic(每 topic 稠密 offset)、每消息生命周期(过期限时强制归档、归档数据永不投递给任何订阅者)、订阅关系在任一侧消失时静默解除、投递注入订阅会话的模型可见上下文——空闲会话被唤醒,运行中会话不被打扰。

## Decision

- **投递复用两条既有 agent 输入动词**:空闲会话 `agent.followup(信封)`(scheduler 已在用的唤醒),运行中会话 `agent.inject(信封)`(下一 step 边界认领,即阻塞命令之后)。信封是插件源 `user/message`(`plugin: 'queue'`,携带 `topic`/`offset`)——投影为上下文注入行、仅凭日志可重放、零 session 核心改动。一消息一注入,设计如此。
- **存储**:`queue` storage domain 四张表——topics(id 主键 + 唯一名索引,同名重建铸造全新 id)、messages(`topicId#offset` 键,live/archived 态)、订阅关系(`sessionId#topicId`)。所有写等待 domain 写链:同一串行任务内的读能看到先行写入。
- **offset 与边界**:串行发布链下每 topic 稠密 offset;载荷 ≤256KiB、每 topic live ≤10000(满额拒绝)、archived ≤10000(清扫器按最旧裁剪)。
- **会话三态**:已归档订阅者保留订阅但不生效——不投递、不唤醒、水位照常推进(错过即错过,恢复后也不补投);对已归档会话 `subscribe` 拒绝。会话删除在一个清扫周期内解除关系行(删除路径暂无宿主事件)。
- **工具**(`dsh-queue/tool`,standard preset 的 `tool-queue` 行):`queue-topic` list/inspect/delete(inspect 支持按 topic 或按 session 双向查关系,`current`=调用方)、`queue-history`(不动位点的过去时读取)、`queue-subscription`(仅限调用方会话)、`queue-publish`。
- **面板**:`ui-governor` 改名会话看板/Panel,页内 tab 环走新槽位 `governor.center.tab`(单贡献时隐藏);`ui-queue` 贡献"消息队列" tab(topic 表、单 topic 历史、带休眠徽标的订阅关系、受能力栅约束的控件),轮询 `queue` Remote 命名空间。

## Alternatives considered

- 新增 `queue/message` 会话事件类型:否决——目录再生与请求装配的改动买不到插件源 `user/message` 没有的东西,上下文注入投影免费渲染。
- 拉取(`consume`)动词与 agent 侧位点:规格否决——订阅即推送;翻历史是唯一的无位点读取。
- workspace 缝上的删除事件以实现即刻级联:暂缓——今日无此事件;清扫器在一个周期内收敛,本 note 记录上限。

## Consequences

- 投递 at-most-once:cursor 与注入同批推进;注入落账与 cursor 写入之间崩溃可能重复注入。
- 每宿主进程一个 broker:"分布式"是 N 个会话/面板消费一条持久日志,不是集群。
- 面板后续的底部 tab 一律走 `governor.center.tab` 槽位缝,不再新开 center view。

## Testing

- 服务套件(31 测试)per-file 100%:offset、唤醒/idle/inject 分支、归档休眠、双向级联、TTL 清扫与归档裁剪、上限、冷恢复投递、maintenance 重试。
- 工具套件(6)与面板套件(18 + governor 重构)per-file 100%;`test:gui` 4993 绿;e2e replay 绿。
