# @deepseek-ai/dsh-compaction-settings

[English](README.md) | 中文

注册由根层持有的 `compaction` 设置命名空间。可选的 `thresholdRatio` 会在下一次压缩决策时覆盖所有 Agent Profile 的自动压力阈值。该值缺省时，每个 Profile 的压缩 Provider 继续使用其组合配置阈值。

精确的 Provider/Model 策略优先级高于此全局覆盖。支持范围为 `0.17` 到 `1`；下限高于默认的 `0.16` 保留比例。若某个 Profile 的比例保留值大于或等于全局阈值，该 Profile 会保留自身的有效阈值，而不是禁用压缩。

## 模型体验

### 全局压力阈值

#### 模型看到的内容

压缩 Provider 会根据 `compaction.thresholdRatio` 更早或更晚地总结旧对话历史。本插件本身不贡献提示词、工具、命令或模型请求。

#### Token 影响

此设置会改变后续请求保留的对话历史量，也会让辅助摘要请求的成本更早或更晚发生；它本身不会直接增加 token。

#### KV 缓存影响

阈值变化不会改变正在执行的决策。后续决策可能更早或更晚触发压缩；只有成功提交的压缩替换才会改变重放前缀，并使从第一个被替换历史 token 起的复用失效。

## 已知限制与延期工作

- 此设置仅控制压力阈值。Profile 持有的保留策略和精确模型策略仍由压缩 Provider 配置。
