# @deepseek-ai/dsh-model-policy-fallback

[English](README.md) | 中文

为 Session 当前选择的 Model Route 执行跨模型 fallback。已有的 `dsh-llm-retry` listener 继续负责同一个具体 provider/model 的 retry；本插件先委托给它，只有同模型恢复没有接管失败时才推进有序 Route。

每次切换都在下一次请求开始前写入 `model/fallback`。后续 `agent/request` waterfall 从 Session 日志恢复这次切换，因此 retry 或 resume 不依赖进程内 Route 状态。取消操作不会推进 Route。

## Model Experience

### 跨模型 fallback

#### 模型看到什么

下一次请求使用 Route 中下一个具体目标，同时保留相同的 Session history 和 tools。

##### Replacement request

```markdown
The same derived Session history and tools are sent to the next concrete model target in the configured Route.
```

#### Token 影响

不会增加额外 prompt。失败的请求可能已经消耗 provider token，之后才尝试下一个目标。

##### Token accounting

```markdown
A failed attempt may consume provider tokens before the next target is tried.
```

#### KV Cache 影响

切换 provider 或 model 通常会失去 provider 侧 KV cache 复用；Session transcript 保持不变，并为替代目标重新构建。

##### Cache continuity

```markdown
The Session transcript remains unchanged and is rebuilt for the replacement target.
```

## Known Limitations and Deferred Work

- 除取消以外的规范化 LLM failure 都会推进 Route；合适的有序链由 provider 策略和部署配置负责选择。
- 当前 step 到达最后一个具体目标后 Route 结束，Agent loop 随后报告原始终止失败。
