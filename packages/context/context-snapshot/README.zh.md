# @deepseek-ai/dsh-context-snapshot

[English](README.md) | 中文

将由 system-prompt 上下文平面组装的内容发布为持久的 user 角色运行时上下文快照。`dsh-system-prompt` 中注册为动态上下文的内容（部署 persona、沙箱或计划模式策略、任何贡献插件）只有经过本插件的消息才能进入模型历史，因此每一次模型可见的更新都可以从 Session 日志重建。

依赖 `ctx.agents` 与 `ctx.systemPrompt`（`inject: ['agents', 'systemPrompt']`）。默认的 `dsh-base` 组合将其紧随 `system-prompt` 挂载。

## 快照生命周期

保留状态每次决策都从 Session 日志推导——绝不缓存在内存中。归属消息是 source 为 `{ kind: 'plugin', plugin: '@deepseek-ai/dsh-context-snapshot' }` 的 `user/message`。按事件顺序折叠可见的归属消息得到有效状态：清除标记将其清空，完整快照将其整体替换，部分快照只覆盖它携带的名称。`sections` 无法读取为 `{ name, text }` 对的记录（恢复、分叉或外部写入的种子）不贡献任何内容——既不贡献状态，也不贡献已发布标志。

发布逻辑将当前组装的 sections（`renderContextSections`）与该状态比较：

| 条件 | 消息 |
|---|---|
| 从未存在可读的归属记录且 sections 为空 | 无 |
| 名称集合变化（新增或移除 section） | **完整**——全部 sections |
| 仅部分 section 文本变化 | **部分**——仅变化的 sections |
| sections 为空但曾发布过快照 | **清除**标记 |
| 无变化 | 无 |

## 时机

三条路径共享发布规则：

- **`agent/pre-step`** —— 瀑布决策之后，待发布消息被前置进入批次，排在被认领的用户输入之前，使模型先读到当前运行时上下文再处理要执行的内容。
- **`agent/request`** —— 当压缩在请求瀑布内完成并遮蔽了保留快照时，一条新的完整（或清除）消息被持久追加；请求历史从表面重建，重试的请求无需新用户输入即可携带它。失败仅记录日志，请求继续。
- **代理空闲时的 `compaction/end`**（无 `error`）—— 手动 `/compact` 不产生步骤，因此由一个受控的异步恢复持久追加待发布消息。进行中的轮次与请求通过上述路径自行恢复。

## 模型体验

### 完整快照

#### 模型看到什么

一条 user 角色消息以取代性框架行开头，随后按组装顺序渲染每个贡献上下文。

##### 完整消息

```markdown
Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

<one block per contributing context, in assembly order>
```

#### Token 影响

每次发布一条保留消息；运行时上下文不变的会话只支付一次。重新发布的完整快照会重复全部 sections。

#### KV Cache 影响

纯追加历史：每次发布都位于可复用前缀之后，既有 token 保持不变，新快照与其后的轮次构成新的后缀。

### 部分快照

#### 模型看到什么

部分更新框架行宣布有更新，其后只跟随文本发生变化的章节；持久 source 携带 `partial: true`，未携带的 sections 保持此前可见运行时上下文快照的最后发布值。

##### 部分消息

```markdown
Current runtime context has some updates.

<only the sections whose text changed>
```

#### Token 影响

一条与变化 sections 成比例的保留消息，而非整个上下文——未变化部分越大，相比完整重发布节省越多。

#### KV Cache 影响

与完整快照相同，纯追加。

### 清除标记

#### 模型看到什么

一行短句说明当前没有适用的运行时上下文，且先前的快照不再生效。

##### 清除消息

```markdown
Current runtime context: none. Earlier runtime-context snapshots no longer apply.
```

#### Token 影响

一条简短的保留消息，仅在最后发布的状态清空（最后一个上下文被销毁或运行时上下文被抑制）时发布一次。

#### KV Cache 影响

与完整快照相同，纯追加。

## 已知限制与延后工作

- **部分快照的判别依据是逐 section 文本** —— 名称集合与文本都相同的重排不会产生更新；同名上下文在文本未变的情况下语义漂移对比较不可见。
- **线上不做跨消息合并** —— 模型通过阅读快照序列重建当前状态；本插件不重写或压缩自己的早期消息。
- **空闲后的压缩恢复是尽力而为** —— 落在空闲检查之间的 `compaction/end` 会在下一个步骤或请求边界恢复；没有持久标记跟踪遗漏的恢复。
- **请求边界恢复会重新组装一次** —— 恢复在请求瀑布内对提示平面组装一次；上下文贡献昂贵的提供者要在压缩重试上再次支付该成本。
