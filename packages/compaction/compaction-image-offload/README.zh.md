# @deepseek-ai/dsh-compaction-image-offload

[English](README.md) | 中文

面向模型请求投影的持久化按龄图片卸载。在会话存储上挂载 `image/offload` 消息投影,并在每个 agent 请求边界结算一次决策:当保留的请求图片达到配置的 `imageOffloadAfterUserTurns` 后续用户轮数时,追加一个 `image/offload` 事件,此后的每个模型请求在原图位置渲染规范的卸载占位文本。

## 功能

插件通过 `ctx.sessions.registerMessageProjection` 注册 `imageOffloadProjection` —— 作用于持久 `image/offload` 事件的会话消息投影 —— 并监听 `agent/request` 瀑布流。在每个边界,它解析生效设置(挂载设置 Provider 时为 [`compaction.imageOffloadAfterUserTurns`](../compaction-settings/README.md),否则为 `'unlimited'`),让 [`@deepseek-ai/dsh-image-offload-policy`](../image-offload-policy/README.md) 针对活跃日志给出待结算决策;每个决策通过追加一个 `image/offload` 事件结算,其 `targets` 为 `{ messageSeq, imageIndex }` 对。投影用策略的占位文本块逐个替换目标图片块 —— 每张图一个文本块、原位替换 —— 因此块位置永不漂移,连续决策可组合。日志中的原件不受影响:重放、持久化,以及直接读取事件的展示面继续显示真实图片。

## 设置语义

`'unlimited'`(默认值;未挂载设置服务时亦然)不做按龄卸载;Provider 侧压力处理保持逐请求。正整数 `n` 表示:请求边界处每张图片存在 `n` 个后续用户消息轮即卸载。既非 `'unlimited'` 也非正整数的存储值会在边界处响亮失败 —— 该轮报错,而不是猜测龄限。

## 模型体验

### 历史中的卸载占位

#### 模型看到的内容

决策结算后,后续请求在原图位置显示占位文本块。占位是真实的 —— 它指明图片已卸载 —— 周围的文本块、工具结果与块顺序均不变。

#### Token 影响

每张已结算图片的 token 成本被占位的短文本成本取代;其余不变。

#### KV 缓存影响

占位原位替换图片且不移动任何其他块,因此直到第一个被结算图片之前的请求前缀保持可复用;复用仅从第一个被替换位置起失效,与任何已提交的历史编辑一致。

## 已知限制与延期工作

- **无持久化 Provider 压力路径** —— 决策仅基于龄。Provider 侧预算压力(例如 DeepSeek 请求图片上限)保持在 LLM 适配器内逐请求处理;目前没有 Provider 失败携带可结算的持久压力码。
- **未挂载本插件的组合派生原图** —— 投影随注册作用域;会话迁移到未挂载插件的组合后会重新派生未打占位的图片(`image/offload` 事件保持持久且惰性)。
- **`0` 不是 `'unlimited'`** —— 非法存储值使该轮响亮报错,而不是退化为 unlimited。
- **窗口化恢复容忍窗口外目标** —— 源事件落在恢复窗口之外的目标不产生条目(无占位),这是设计行为。
- **展示面不受影响** —— 直接折叠事件的 UI 仍渲染原图;只有模型请求投影发生变化。
