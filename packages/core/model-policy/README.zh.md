# @deepseek-ai/dsh-model-policy

[English](README.md) | 中文

按 Session 管理的 Model Profile 与有序 Model Route。Profile 负责授权具体 provider/model 以及命名 Route；Route 是具体 provider/model 的有序 fallback 链。

服务注册独立的 `model-profiles` 和 `model-routes` Settings section。Session 把完整 Profile 快照写入 `model/profile`，后续设置修改不会悄悄扩大已有 Session 的权限。旧 Session 使用内置的 `unrestricted` Profile，允许当前注册的所有模型和 Route。

## Model Experience

### Profile 与 Route 策略

#### 模型看到什么

模型请求仍使用普通的具体模型。Route 遇到分类失败时可以切换具体 provider/model；该切换由 Session 策略和目标事件表示，不依赖隐藏进程状态。

##### Model request

```markdown
The normal Session history, system prompt, and tools are sent to the selected concrete model. Profile and Route control state is not added to the prompt.
```

#### Token 影响

不需要增加额外 prompt。Profile 和 Route 标识属于控制面状态，不进入模型可见的对话 transcript。

##### Token accounting

```markdown
Profile and Route identifiers are control-plane state and do not enter the model-visible transcript.
```

#### KV Cache 影响

Profile 或目标切换只影响后续请求，不重写已有 Session 历史和稳定 prompt 前缀。

##### Cache continuity

```markdown
Existing Session history and its stable prompt prefix are not rewritten.
```

## Known Limitations and Deferred Work

- provider 可用性和 adapter 专属模型校验仍由 Host LLM consumer 负责。
- 本服务负责持久化授权与 Route 解析；Agent loop 负责 retry 和分类后的跨模型 fallback 执行。
