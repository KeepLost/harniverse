# @deepseek-ai/dsh-queue

[English](README.md) | 中文

会话消息队列(`ctx.queue`):Kafka 语义的持久 topic——每 topic 稠密单调 offset;基于时间的强制归档(过期或已归档的消息永不投递,滞后订阅者同样拿不到);订阅关系为双向静默级联的独立关系模型(任一侧被删,关系立刻解除、不通知);投递即唤醒的扇出——空闲的订阅会话自动转为活跃并处理消息,运行中的会话在阻塞命令之后、下一次推理请求时一并看到。单一宿主进程即 broker;"分布式"指任意多会话与面板消费同一持久日志。

## Remote 面

`queue` Typert Remote 命名空间经 `dsh-api-remotes` 暴露:`topicList`/`messages`/`subscriptions`/`stats` 挂 `harniverse.observe`;`topicCreate`/`topicDelete`/`publish`/`subscribe`/`unsubscribe` 挂 `harniverse.operate`。

## 服务契约

- **Topic**:名字唯一;publish 隐式建题并取部署默认 TTL。同名重建即全新 topic(新 id、offset 归零、旧订阅不复活)。
- **消息**:每 topic 稠密 offset;载荷有界(默认 256 KiB);每 topic live 上限(默认 10 000,满额拒绝发布);`expiresAt = 发布时刻 + (消息 TTL ?? topic TTL ?? 默认 24h)`。
- **投递**:publish 落盘后扇出,给每个订阅者追加一条插件源 `user/message`(`plugin: 'queue'`,携带 `topic`/`offset`)——空闲会话经 `agent.followup` 唤醒,运行中会话作为注入上下文在下一 step 边界接收。at-most-once:订阅 cursor 与投递同批推进。投递时刻已过Deadline的消息永不投递,但水位照常推进(错过即错过)。
- **会话三态**:活跃、空闲未归档正常投递(空闲即唤醒);已归档保留订阅但不生效——不投递、不唤醒、水位照常推进;恢复未归档后仅新消息恢复投递。对已归档会话 `subscribe` 拒绝。
- **关系模型**:删除 topic 或会话,其订阅行静默解除(会话侧在一个清扫周期内完成——删除路径暂无宿主事件可挂)。
- **工具**(`dsh-queue/tool`,按 preset 装配):`queue-topic`(list / 按 topic 或按 session 双向 inspect / delete)、`queue-history`(过去时、不动位点)、`queue-subscription`(订阅/退订——仅限调用方会话)、`queue-publish`。

## Model Experience

### 队列投递

#### 模型看到什么

投递以 `queue` 标注的用户角色上下文注入到达:一行信封(topic、offset、发布者、过期时刻)+ 载荷原文。

#### Token 影响

一条投递 = 信封(约 30 token)+ 载荷。没有轮询动词——需要历史的 agent 显式调用 `queue-history`。

#### KV Cache 影响

投递在日志尾部追加,缓存复用与普通追加轮次一致;运行中会话的批量发布在下一 step 边界合并,只多一次前缀扩展。

## Known Limitations and Deferred Work
- 投递语义为 at-most-once(cursor 与投递同批推进):事件落账与 cursor 写入之间崩溃可能重复注入,写入前崩溃可能丢一条。
- 一条消息一次注入;高频 topic 不合并为批量摘要。升级触发器:某订阅会话持续多消息/秒。
- 会话删除级联在一个清扫周期内生效(今日删除路径无宿主事件可挂)。
- 无跨进程 broker:队列的持久性等同宿主 storage domain。
