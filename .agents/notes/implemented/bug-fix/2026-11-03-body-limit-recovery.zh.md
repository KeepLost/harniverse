# Agent Note: 413 请求体恢复 —— 裁图、压缩、重试

Status: implemented

[English](2026-11-03-body-limit-recovery.md) | 中文

## 问题

被提供方以体积过大拒绝的请求——`413 Failed to buffer the request body: length limit exceeded`（DeepSeek），或其它提供方任何传输层请求体上限——会杀死会话的这一轮：waterfall 把失败抛到表面，没有任何东西收缩载荷，每次重试都撞同一堵墙。表面里已存在的图片是通常的肇事者；实践中几乎只有带图的会话会触到请求体上限。

根因：`agent/request-error` 处理器覆盖了 `CONTEXT_WINDOW_EXCEEDED`（compaction-basic）与限流，但不存在"请求体体积"的分类，这条路径上也不跑任何缩减器——本可恢复的场景（图片可用现行 `image/offload` 策略落账，文本可压缩）被当成致命错误。

## 决策

- `dsh-llm` 新增 `REQUEST_BODY_TOO_LARGE_CODE` 与 `isRequestBodyTooLargeError()`；pi-ai stream 分类器和两个 DeepSeek 协议适配器（chat-completions 的 `httpErrorCode`、messages 的 `providerError`）把各自传输层信号映射到该分类上，所有提供方路径说同一个谓词。
- **`@deepseek-ai/dsh-compaction-body-limit-recovery`**（base bundle 行，排在 `compaction-image-offload` 之后）挂 `agent/request-error`：遇请求体超限失败时 (1) 运行 `resolveImageOffloadDecisions(events, { setting: 'unlimited', pressureCount: Infinity })`——把每个仍活跃的图片出现按从旧到新全部落账——追加 `image/offload` 事件，(2) 在组合了压缩引擎时调用 `compaction.compactIfNeeded(agent, 'context-overflow', signal)`，(3) 任一确定性缩减落定（`decisions.length > 0`、压缩返回结果、或表面 `replaceGeneration` 前进——中途抛错的压缩可能已追加了事件）即重试。
- 重试预算为每会话三次，`assistant/message` 时重置；耗尽后抛出原始错误。恢复中取消则保留原始失败（`next()`）；非请求体失败原样放行。
- 可选压缩腿失败不致命：图片落账已经 durable，重试决策读的是每个已落定的缩减，而非该调用的返回。

ponytail：这是被动式请求体恢复——上限是只有撞上才发现的传输层封顶。升级路径是主动请求体预算（发送前估算序列化体积并预裁/预压），那需要按提供方的体积信号，值得独立设计；在此之前，有界的被动循环就是安全网。

## 备选方案

- **当作 context-overflow 处理**（`CONTEXT_WINDOW_EXCEEDED`）——否决：失败不同（传输封顶 vs 模型窗口），缩减经济学不同；混用编码会触发为另一量级调好的 maxTokens 减半与重试策略。
- **只裁图、不压缩**——对长文本无图场景否决：这类会话同样触顶；压缩本就是已组合、按策略驱动的缩减器。
- **无限重试**——否决：真正不可缩减的请求体（单个超大附件）会死循环；三次有界尝试加成功即重置覆盖了瞬态场景。

## 后果

- 任何经分类适配器抛出体积信号的提供方，现在都能优雅降级而不是杀死这一轮；无分类的提供方原样穿过。
- `image/offload` 决策为 unlimited 档：恢复后表面不再持有图片（保留为 durable 落账引用）；后续 context-overflow 仍可压缩文本。
- 证据：`compaction-body-limit-recovery` 套件——分类穿透、全历史落账重试、压缩协同、预算耗尽与重置、取消时序（13 测试，`src/index.ts` 按文件 100%）；分类分支由 llm-pi-ai / llm-deepseek 套件钉死。
