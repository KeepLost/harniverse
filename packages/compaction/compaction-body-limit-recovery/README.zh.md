# @deepseek-ai/dsh-compaction-body-limit-recovery

[English](README.md) | 中文

针对被提供方在传输层请求体上限拒绝的请求（`413 Failed to buffer the request body: length limit exceeded`，及其它提供方的等价体积封顶信号）的恢复：把所有仍活跃的图片出现落账、压缩文本表面、然后重试请求，而不是把失败抛到表面。由 base bundle 紧随 [`dsh-compaction-image-offload`](../compaction-image-offload/) 之后组合。

## 它做什么

插件挂 `agent/request-error` waterfall。当失败被分类为请求体超限（[`REQUEST_BODY_TOO_LARGE_CODE`](../../llm/llm/README.md)，由 pi-ai stream 分类器与两个 DeepSeek 协议适配器映射）时，处理器：

1. 以 `{ setting: 'unlimited', pressureCount: Infinity }` 向 [`dsh-image-offload-policy`](../image-offload-policy/) 请求全历史的落账决策——每个仍活跃的出现，从旧到新——并追加一条携带它们的 `image/offload` 事件；
2. 在组合了 [`ctx.compaction`](../compaction/) 引擎时调用 `compactIfNeeded(agent, 'context-overflow', signal)`；压缩失败不致命（图片落账已经 durable）；
3. 任一确定性缩减落定即重试：落账决策、压缩返回结果、或 `replaceGeneration` 前进（中途抛错的压缩可能已追加事件）。恢复期间取消则保留原始失败。

预算为每会话三次恢复，`assistant/message` 时重置；耗尽后抛出原始错误。非请求体失败原样放行。

ponytail：这是被动循环——上限是只有撞上才发现的传输封顶。升级路径是主动请求体预算（发送前估算序列化体积并预裁/预压）；在提供方专属体积信号值得那个设计之前，有界被动循环就是安全网。

```yaml
- id: compaction-body-limit-recovery
  name: '@deepseek-ai/dsh-compaction-body-limit-recovery'
```

## Model Experience

### 静默重试的请求

#### 模型看到什么

恢复本身不可见：失败的那次尝试不进入会话表面。重试的请求在图片原位携带 `image/offload` stub，压缩若已运行则携带压缩后的表面——两者都是常设机制的普通产物。

#### Token 影响

重试的请求更小：落账图片变为 stub，被遮蔽范围被摘要。

#### KV Cache 影响

缩减按 offload/压缩机制各自的契约追加或替换；恢复不在其上添加任何额外表面。

## Known Limitations 与遗留工作

- **被动而非主动**——第一个超限请求仍会被发出并被拒绝一次；预发送预算是延后的升级。
- **两次 assistant 消息之间每会话三次恢复**——真正不可缩减的请求体（图片词汇之外的一个超大活跃附件）会耗尽预算并抛出原始错误。
- **此路径上的压缩是尽力而为**——无引擎的组合仍会落账图片并仅凭该缩减重试。
