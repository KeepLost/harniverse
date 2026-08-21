# @deepseek-ai/dsh-tool-compaction

[English](README.md) | 中文

`ctx.compaction` 的 model-facing Consumer。它注册 direct `context_compact` 工具，让模型能在继续新阶段前压缩一段安全的较早会话前缀。

base 与 standalone headless 组合会在选定的 compaction Provider 旁加载它。Web 将它移入 standard 和 Cordis Agent preset；Code preset 会省略它，因为 Code Mode 只能通过 nested dispatch 访问原生工具。

## 约定

工具接受一个必填且非空的 `reason`。该理由记录为何不再需要较早上下文的细节，但不能选择范围或提供摘要文本。Provider 从受保护的执行身份取得调用方 Agent，应用已路由模型的保留策略，保持工具调用／结果配对，并将取消转发给摘要流程。

缺少活动 Agent 的调用和嵌套在另一工具内的调用会在后端运行前失败。该工具为 exclusive，因此不会与可能改变同一 Session surface 的同级调用重叠。

## 组合

在该 Consumer 前挂载一个 compaction Provider：

```yaml
- name: '@deepseek-ai/dsh-compaction-lossless'
- name: '@deepseek-ai/dsh-tool-compaction'
```

## Model Experience

### `context_compact`

#### What the model sees

[生成的 schema](../../../docs/tool-catalog.md#context_compact)只暴露 `reason`。成功调用会报告被替换历史条目数及其估算 token 数，不会重复私有摘要。历史过短时返回 `No compactable older history is available yet.`，且不会开启压缩事务。

#### Token effect

schema 增加固定 request token。调用会追加其理由和简短结果；后端成功执行时，会用一个摘要检查点替换更大的较早前缀，并保留近期尾部。

#### KV Cache effect

只要组合不变，工具发现就保持稳定。no-op 只追加普通调用／结果尾部。成功替换会使从第一个已遮蔽历史 token 起的复用失效，而该范围之前未改变的前缀仍可复用。

## Known Limitations and Deferred Work

- **仅 direct 调用**：nested 与 Code Mode sub-dispatch 会失败；Code preset 会省略该 Consumer。
- **无范围控制**：模型不能选择事件边界或提供摘要文本；选择与摘要都由 Provider policy 负责。
- **需要已路由容量**：保留尾部策略需要最新持久 provider/model route 的 context metadata。
