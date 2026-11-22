# Agent Note：请求图片预检预算——body-limit 短期措施的升级落地

Status: implemented

[English](2026-11-23-request-image-budget-preflight.md) | 中文

## 问题

`compaction-body-limit-recovery`（见 [413 请求体恢复](2026-11-03-body-limit-recovery.md)）是被动兜底：撞上传输上限才发现它，沉降全部图片、压缩、重试。它自己的 ponytail 注明了这个天花板——"主动的请求体预算……发送前预沉降"——因为一次 413 往返是白费的一次尝试，而且全历史沉降会丢掉本可以保留的图片。pi-ai 路径此前完全没有聚合上限：`toPiContextWithImages` 把每个保留出现都内联为 base64，任何网关上的图片密集会话都可能每次尝试都超体。

## 决策

- **`dsh-llm` 持有共享选择器。** `packages/llm/llm/src/request-images.ts` 从 `dsh-llm-deepseek`（它们原本服务 DeepSeek 提供方限制）抽出 `limitRequestImages`（字节与数量预算下最老先行、带移除 quantum 的选择）与 `projectImageOmissions`（把被丢弃的 wire 坐标经 `GenerateOptions.onImagesOmitted` 提交，无钩子时用本地省略占位符）。`ImageWireLocation` 成为两个适配器共享的 `dsh-llm` 类型。
- **pi-ai profile 增加路由预算** `maxRequestImageBytes`（默认 20 MiB）、`maxRequestImages`（默认 50，即 Azure OpenAI 文档记载的 GPT-4o/4.1 上限）、`imageOffloadByteQuantum`（默认 10 MiB）与 `imageOffloadCountQuantum`（默认 10），在 profile 解析处校验为正安全整数。`toPiContextWithImages` 按唯一附件读取一次请求版本，在消息遍历前应用选择并投影被丢弃出现——超预算的请求**发出前**就收缩：组合了 compaction 属主时走其持久化 `image/offload` 路径（`compaction-image-offload` 接线 `onImagesOmitted`），否则用本地占位符。重复引用只读一次。
- **`compaction-body-limit-recovery` 按其自身升级路径注记删除**：预检预算消除了它所针对的图片驱动 413 类别，age/modality/budget 沉降现在都在派发前运行。`REQUEST_BODY_TOO_LARGE_CODE` 及其分类器留在 `dsh-llm`——对真正超大的非图片信封，该分类仍是诚实的信号。

这与官方 0.2.3 的做法（`IMAGE_OFFLOAD_REQUIRED` 失败 + agent/request-error 重试环）有意分叉：harniverse 已在组装时内联结算提供方图片压力（`onImagesOmitted` → 持久化 `image/offload` → 新投影），因此同样的持久化决策以零浪费尝试落地，无需新增重试路径。

## 备选方案

- **采用官方"失败再重试"形态**——否决：它要在一次失败往返之后才复用我们既有的沉降 seam；内联选择在请求发出前落地同样的持久化决策。
- **保留被动包与预算并存**——否决：一个失败类别两个属主；该 note 自身的移除条件（"落地后删除本包"）已满足。
- **整请求体（文本 + 图片）预检预算**——推迟：图片聚合覆盖了观测到的 413 类别（按恢复 note，纯文本历史几乎不会撞体上限；工具结果由 `tool-result-artifacts` 封顶）。文本侧估算器需要提供方特定的尺寸信号，值得单独设计。

## 后果

- pi-ai 图片密集会话不再支付 413 往返；最老出现按新图片 quantum 一次沉降，后续视觉请求经既有离线 stub 重读保留的原图。
- 网关更紧的部署按路由调低 `maxRequestImageBytes`；DeepSeek 线自己的连接级限制不变。
- 恢复包的文本侧兜底随之消失：单个超大的非图片信封现在呈现其原始传输错误而非被压缩一次。工具结果由 `tool-result-artifacts` 封顶（可见 5 万字符，spill + `artifact_read` 分页），上下文溢出压缩仍在自己的触发器上运行。
- 证据：`llm-pi-ai/tests/request-image-budget.spec.ts`（字节与数量预算、钩子沉降、本地占位、每附件单次读取，4 测试）；`llm-deepseek` 套件行为不变（485+ 测试）；llm/compaction 组合 catalog 与模块图已再生。
