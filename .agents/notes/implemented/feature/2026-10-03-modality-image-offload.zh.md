# Agent Note: 模态图片卸载——纯文本路由在请求边界结算

Status: implemented

[English](2026-10-03-modality-image-offload.md) | 中文

Scope: `packages/compaction/image-offload-policy`、`packages/compaction/compaction-image-offload`、`packages/attachment/attachment`、`packages/host/apiproxy`

## Problem

把会话切换到纯文本模型——或路由回退落到纯文本模型——会卡死之后的每一轮：只要请求中还残留任何图片出现，两个适配器都会抛 `UNSUPPORTED_CONTENT`，而 apiproxy 更是在会话曾持有图片时直接拒绝切换本身。wave-3 的图片卸载机制只认识 `'age'` 与提供方 `'pressure'`，其桩文本不带路径，视觉模型回到会话后也没有重新查看已卸载图片的文档化途径。

## Decision

- 在 `'age'` 与 `'pressure'` 之外新增 **`'modality'` 原因**（`image-offload-policy/src/types.ts`）。`resolveImageOffloadDecisions` 新增 `routeAcceptsImages: false`，绕过按龄与压力规则，一次性结算**全部**有效出现——包括工具结果图片——最旧优先。
- **派发前在请求边界结算**（`compaction-image-offload/src/index.ts`）。`agent/request` 监听器改为 `{ prepend: true }` 注册从而包在最外层：按龄决策在 `next()` 前结算，随后 `await next()` 观察到**最终**配置——包括任何回退监听器替换过的模型——当 `resolveModelInfo` 报告输入模态不含 `image` 时，追加一条覆盖全部出现的 `image/offload` 决策。模态未知、缺少 llm 或附件服务、或解析失败时静默跳过；适配器自身的 `UNSUPPORTED_CONTENT` 守卫仍是响亮的安全网。同一会话稍后产生的图片在下一个边界结算。
- **通过 A5 硬链接机制铸造带路径的桩。** 每个被结算出现得到一段按 `fileHandleText` 格式书写的桩（`dsh-attachment/file-handle` 新增 `imageHandleText`）：名称、大小、摘要前缀、`attachments.publishFileHandle` 铸造的只读硬链接路径，以及当前模型无法查看图片的声明。桩以可选的逐目标 `stub` 字段随持久决策记录并原样重放——铸造路径是机器本地的，只有日志能复现模型见过的确切文本。按龄与压力目标保持规范常量桩。
- **模型切换后的首个请求刻意无视前缀稳定性**——路由已变更，提供方前缀本就已冷；结算不去保它。
- **切回视觉模型后桩保留**（模型可见 ⇔ 已记录）；模型通过 `read_image` 按路径重新查看原图，其路由门恰因路由回到视觉而放行。
- **apiproxy 的拒绝全部移除**：`selectModel`、`selectModelTarget` 与图片提示准入不再因会话含图片而拒绝纯文本模型，支撑这些检查的 `serializeImageAdmission` 缝一并移除（归档/关闭路径不再等待它）。

### 会话契约声明（v0 增量）

`image/offload` 载荷的每个目标新增一个**可选** `stub` 字段。会话契约摘要保持不变（`verify-session-contract-digest` 无需刷新基线即通过）：摘要记录的是载荷类型引用，而声明引用仍是 `ImageOffloadEventData`。持久化目录内嵌展开声明，已重新生成（`gen-persistence-catalog`、`known-event-types.ts`、双语配对重记录）。忽略未知目标字段的读取方——旧投影、变更前的不变量——不受影响，因为该字段可选且仅在存在时校验。

## Alternatives considered

- 以 `UNSUPPORTED_CONTENT` 触发响应式恢复（官方 `IMAGE_OFFLOAD_REQUIRED` 瀑布形态）：拒绝——owner 决策要求**派发前**结算，且 Harniverse 提供方不抛可绑定瀑布的持久压力码。
- 在投影的 derive 期推导桩路径：拒绝——另一台机器回放会渲染出不同路径，破坏"模型可见 ⇔ 已记录"。
- 保留 apiproxy 准入拒绝作为 UI 体感：拒绝——与结算机制矛盾（切换现在是安全的），且它逼出了额外的串行化缝。

## Consequences

纯文本路由在切换或回退后终于能继续干净运转；请求携带真实的带路径桩而不是失败。`read_image` 重看可行，因为铸造链接按内容寻址且幂等。没有附件服务的组合保持旧的响亮适配器失败（结算无法铸造路径）。桩文本与其文件句柄兄弟一致地使用中文行格式，保证提示一致。

## Verification

- `packages/compaction/image-offload-policy` 策略测试：modality 选中全部有效出现（用户与工具结果）、绕过按龄、绝不重复结算既有决策。
- `packages/compaction/compaction-image-offload` 测试：投影在连续决策间逐字渲染桩与常量桩并存并拒绝空桩；不变量伴侣拒绝空/非字符串桩；`tests/modality.spec.ts` 覆盖视觉 → 纯文本 → 视觉切换（桩保留、铸造链接字节等于保留附件、路径上 `read_image` 重新进入模型上下文）、后产图片在下一边界结算、视觉路由与模态未知路由不结算、真实 `model-policy-fallback` 路由落到纯文本目标且无 `UNSUPPORTED_CONTENT`。
- `pnpm run verify-session-contract-digest`、`pnpm run verify-persistence-catalog`、`pnpm run verify-translation-pairing` 在目录刷新后全部通过。
