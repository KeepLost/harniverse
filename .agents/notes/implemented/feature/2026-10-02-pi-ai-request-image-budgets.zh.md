# Agent Note: pi-ai 请求图像按模型预算投影

Status: implemented

[English](2026-10-02-pi-ai-request-image-budgets.md) | 中文

## 问题

pi-ai 适配器此前把每张请求图像按存储原件发送：`context.ts` 用 `AttachmentStore.readImage` 解析图像块，于是准入门接受过的字节（单张至多 5 MiB、40 MP）原样上线。`llm-deepseek` 已改用 `readImageRequest` 在按模型预算下投影（默认 2048² 像素 / 1 MiB，`'low'` 低细节为 512²）；pi-ai 路由——包括经 pi-ai 接入的 OpenAI、Anthropic 与 DeepSeek 网关——仍在为各家服务商本就会在服务端缩小的内容支付全尺寸 token。

## 决策

把 `llm-deepseek` 的模式以相同默认值移植进 `llm-pi-ai`：

- `models` 条目新增两个可选字段：`imageMaxBytes`（单张投影后请求图像可占用的编码字节，base64 展开之前）与 `imagePixelBudget`（请求图像投影所受的总像素预算，保持纵横比，`'low'` 即 512² 低细节预算）。两者随路由解析进入 `ResolvedPiAiProviderProfile` 的 `configuredImageBudgets`，与 `configuredMaxTokens` 并列——catalog 条目自身不声明预算，缺席即干净地表示"适配器默认值"。
- 适配器按请求从所路由模型的条目计算 `ImageRequestPolicy`（`'low'` → 512²，显式数字胜出，缺席 → 2048² 像素与 1 MiB），交给 `toPiContext`，再穿入 `userContent`，同时覆盖用户图像与嵌套的工具结果图像。分派改为 `attachments.readImageRequest(ref, policy)`；`readImage` 不再位于请求路径上。
- 重载集合保留旧的 `(options, attachments, onReplayDegrade?)` 形状并新增 `(options, attachments, policy, onReplayDegrade?)`；用显式重载（而非联合参数）保住 replay-degrade 回调的上下文类型。
- 不能投影的挂载式附件提供方（基类 `readImageRequest` 以 `ATTACHMENT_PROJECTION_UNSUPPORTED` 拒绝）如今会在含图请求上失败，而原先读存储原件会成功——这与 `llm-deepseek` 已有的契约一致。默认附件 store 实现了投影，默认组合不受影响。

## 备选方案（Alternatives considered）

**继续发送原件。** 否决：各家服务商都在服务端缩小图像，全尺寸意味着 token 与线缆成本；`llm-deepseek` 已把"投影后请求"确立为本仓库模式。

**从 pi-ai 模型 catalog（例如 `inputLimits`）推导预算。** 否决：已安装 catalog 声明的是服务商能力而非部署策略；两个新字段沿用 `maxTokens` 的先例——显式配置、由解析按模型 id 记录。

## 后果

pi-ai 路由的请求图像由配置约束而非准入门限制；准入门（5 MiB / 40 MP / 每消息 20 张）仍是持久 store 的上限，保持不变。只覆写 `readImage` 的自定义附件提供方必须同时实现 `readImageRequest` 才能服务含图的 pi-ai 请求。`adapter.spec.ts`、`context.spec.ts` 与 `convert.spec.ts` 的测试桩统一经 `readImageRequest` 投影，适配器层的 store 桩抽出共享的 `ProjectingStubStore` 基类。

## 测试

`pnpm exec vitest run packages/llm/llm-pi-ai/tests` —— 300 项测试，含新增的 `projects request images through readImageRequest with per-model budgets` 适配器测试（断言到达 store 的策略来自 `imagePixelBudget: 'low'` + `imageMaxBytes: 2048` 条目，为 `{maxPixels: 512 * 512, maxBytes: 2048}`；投影后字节而非原件上线；`readImage` 从未被调用），以及迁移后的桩断言嵌套工具结果图像与无观察者路径照常解析。`pnpm exec tsc -p packages/llm/llm-pi-ai --noEmit` 与对触及文件运行 `scripts/run-oxlint.ts` 均干净。
