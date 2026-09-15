# @deepseek-ai/dsh-context-nudge

[English](README.md) | 中文

基于非唤醒 [`agent.inject()`](../../core/agent/README.md) 收件箱的阈值门控上下文压力提醒。当会话保留历史跨越绝对 token 阈值时,插件排入一条面向模型的提醒,建议调用 `context_compact`;增长超过可配置增量后再投递下一条。空闲驱动让提醒保持待定,直到下一条用户提示或 steering 到来;运行中的驱动在最近的步边界领取——提醒永不唤醒已停止的 agent。

触发刻意只用 token 数:巨大窗口的模型获得主动回收引导;小窗口模型永远够不到阈值,维持自动压力压缩与人类 `/compact` 命令。工具目录中没有 `context_compact` 的 agent(例如 Code preset)不会收到提醒。

## 契约

- **首次提醒**在测量保留占用达到 `thresholdTokens` 时触发。
- **间隔**要求距上次投递至少增长 `refireDeltaTokens`。
- **迟滞**在占用落回 `lastFireTokens − refireDeltaTokens` 及以下(通常因压缩)时重新武装首次规则。
- 测量在持久 surface 边界(`user/message`、`assistant/message`、`tool/result`、已提交的 `compaction/end`)搭乘共享 token meter;插件自身待定提醒被排除,投递不会自我再触发。
- 每条提醒在其消息 source 上记录 `measuredTokens` 与 `thresholdTokens`;包不变量拒绝任何记录测量低于阈值的自有提醒。

配置来自插件组合 config,运行时覆盖走 `compaction` 设置命名空间(`nudgeEnabled`、`nudgeThresholdTokens`、`nudgeRefireDeltaTokens`,在 Web 设置压缩卡上暴露)。非法覆盖——增量不小于阈值或非正数值——上报一次后被忽略,回退组合默认值。

## 组合

```yaml
- name: '@deepseek-ai/dsh-context-nudge'
  config:
    thresholdTokens: 120000
    refireDeltaTokens: 20000
```

与注册了 `context_compact` 的组合挂载在一起(base 组合已如此)。

## 模型体验

### 上下文压力提醒

#### 模型所见

一条指明当前占用并指向 `context_compact` 的 user 角色 system 注入。它随其后自然到来的请求进入——空闲会话在用户下一条提示之后,运行中会话在下一 步边界。

#### Token 效应

每条提醒花费其自身短文本。提醒按构造稀少:每次阈值跨越一条,加上每次配置增量一条。

#### KV 缓存效应

被领取的提醒追加在对话尾部;其前缀保持可复用。

## 已知限制与后续工作

- **无 provider 认定用量**——占用是共享 meter 的估算,非 provider 账目;两者可能随分词器漂移。
- **仅绝对阈值**——窗口相对阈值已被设计否决:绝对阈值同时充当模型级门槛(见上游 Agent Note)。
- **无按 agent 覆盖**——策略全局;按 profile 调优保留为组合事务,直到出现消费者需要。
