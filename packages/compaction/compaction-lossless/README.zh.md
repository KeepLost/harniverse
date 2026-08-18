# @deepseek-ai/dsh-compaction-lossless

中文 | [English](README.md)

面向 Harniverse 的 Lossless 风格自动压缩插件。插件复用现有 `CompactionEngine` 事务，把每个已提交的 summary checkpoint 投影为当前 Session 的 summary DAG。原始 Session event log 仍是唯一事实源，summary 节点只是可有界展开的派生索引。[summary DAG Agent Note](../../../.agents/notes/implemented/feature/2026-08-18-summary-dag-compaction-history.md)记录了该设计。

## 组合

插件组合两个 Host 侧角色：

- `CompactionHistory` 注册 `ctx.compactionHistory`，从当前 Session event log 重建 summary 节点。
- `LosslessCompactionEngine` 注册 `ctx.compaction`，继承 Basic provider 的 token pressure、overflow recovery、tool-pairing 检查、取消、durable bracket 和 surface replacement。

该 provider 应替代 `@deepseek-ai/dsh-compaction-basic` 加载。两个 provider 都注册 `ctx.compaction`，不能在同一个 context 中同时启用。

随附的 base、standard、code、Cordis 和 standalone headless 组合选择该 provider，并加载 `@deepseek-ai/dsh-tool-compaction-history`。自定义组合可以改选 `compaction-basic`，也可以省略历史工具。

```yaml
- name: '@deepseek-ai/dsh-compaction-lossless'
  config:
    thresholdRatio: 0.8
    retainRatio: 0.16
    maxSearchResults: 20
    maxExpansionDepth: 3
    maxExpansionTokens: 4000
```

`auto` 默认是 `true`，符合条件的 step pressure 和标准 context overflow 会自动触发压缩。继承的 `thresholdRatio`、`retainRatio`/`retainTokens`、摘要目标、重试、overflow 以及精确 `modelPolicies` 配置仍然可用。

## Summary DAG

每个 `compaction/summary` 只有在匹配的 replacement checkpoint 提交后才会进入索引。替换原始 surface 消息时节点是 `leaf`；被替换的 surface 中包含旧 summary checkpoint 时节点是 `condensed`。父节点关系从被引用的 checkpoint event 推导；每个节点还单独保留该轮替换新增的 raw message seq，因此展开能同时恢复父级历史和较新的消息。

索引在 resume 或 HMR 后从 `Session.events` 重建，因此依赖 canonical Session persistence 后端即可保持 durable，不需要第二份 raw transcript 数据库。

## 配置

| 键 | 默认值 | 含义 |
|---|---:|---|
| `thresholdRatio` | `0.8` | 触发自动压缩的 routed model context window 比例。 |
| `retainRatio` | `0.16` | 原样保留的 recent surface 预算；与 `retainTokens` 互斥。 |
| `retainTokens` | 未设置 | 原样保留的绝对 recent surface 预算。 |
| `summarizationProvider` / `summarizationModel` | 空 | 可选 summary route；否则使用 routed conversation target。 |
| `maxTokens` | `8192` | summary generation cap。 |
| `compactionRetries` | `1` | 额外压力压缩尝试次数。 |
| `maxOverflowRetries` | `1` | context-overflow recovery retry cap。 |
| `modelPolicies` | `[]` | 精确 provider/model policy override。 |
| `auto` | `true` | 启用自动压力与 overflow 压缩。 |
| `maxSearchResults` | `20` | history Consumer 可返回的最大 summary hit 数。 |
| `maxExpansionDepth` | `3` | expansion 可返回的最大 DAG level 数。 |
| `maxExpansionTokens` | `4000` | 最大 expansion 估算 token 数。 |

## Model Experience

### 自动会话压缩

#### What the model sees

模型看到一个 `compaction/summary` checkpoint 和保留的 fresh surface。DAG metadata 与原始消息不会进入 prompt，直到 Consumer 主动读取。

#### Token effect

自动压缩把旧 surface 节点替换为一个更短的 checkpoint。DAG projection 本身不增加 request token。

#### KV Cache effect

surface replacement 会从第一个被替换的 history node 起使 provider cache reuse 失效。重建或查询内存 DAG 不会修改 request prefix。

## Known Limitations and Deferred Work

- **Provider 选择是互斥的**：该插件不能与 `compaction-basic` 共存，因为两者都实现 `ctx.compaction`；组合必须选择一个 provider。
- **当前索引按 live Session 工作**：持久化 Session 在加载进 `ctx.sessions` 后建立索引；跨 Session 搜索仍由 `dsh-session-query` 负责。
- **summary 由模型生成**：raw event log 和 source event seq 引用仍然无损，但 summary 可能省略细节；需要加载历史 Consumer 才能有界恢复 source。
- **搜索是内存 term scan**：第一版保持依赖少且简单，后续可以用持久化 FTS projection 替换而不改变 service contract。
