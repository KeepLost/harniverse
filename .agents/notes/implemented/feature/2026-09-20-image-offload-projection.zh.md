# Agent Note: 按龄图片卸载 —— 持久化的模型请求投影

Status: implemented

[English](2026-09-20-image-offload-projection.md) | 中文

Scope: `packages/compaction/compaction-image-offload`、`packages/core/session`、`packages/compaction/compaction-settings`

## 问题

蓝图 W12 要求按图片龄卸载:第 N 个后续用户轮时卸载图片、保留原件、对模型讲真话、不推迟前缀复用。官方 Harness 只响应压力 —— `IMAGE_OFFLOAD_REQUIRED` Provider 错误触发 `offloadOldestImages` —— 而 Harniverse 的 W06 适配器已按请求解决 Provider 预算压力(静默省略、非持久),直接移植会叠加第二条压力路径,且完全没有龄语义。

## 决策

- **投影在 `deriveMessages()` 内组合**(`packages/core/session/src/index.ts`):`Session.create`/`fromRestore` 接受可选 `SessionMessageProjection[]`(`{ type, project(event, context) }`,context = `{ nodes, eventAt, messages }`)。基础折叠后,各投影针对自己的事件类型重走日志尾部,可按节点 seq 替换消息。由于 agent-loop 不变式断言 `request.messages === session.deriveMessages()`,在这里组合使请求、回放与不变式共享同一折叠 —— 官方设计的独立逐请求注册表做不到。
- **无需 stateVersion 的重放**:surface 重写会递增 `replaceGeneration`;该重置现在同时回卷 `projectionCursor`,整个投影历史在幸存节点上重放(否则一次无关的压缩替换会让占位悄然消失 —— 已由回归测试捕获)。
- **位置稳定的占位**:`stubAtPositions` 用策略的占位文本块 1:1 替换每个目标图片块,块位置永不漂移,连续决策可组合,KV-cache 前缀直到第一个被替换位置都保持可复用。
- **龄决策在 `agent/request` 结算**(`compaction-image-offload/src/index.ts`):经 `dsh-image-offload-policy` 针对持久日志解析,每个边界追加一个 `image/offload` 事件,此后投影渲染占位。`imageOffloadAfterUserTurns` 位于 `compaction` 设置命名空间;设置缺省或 `'unlimited'` 不卸载;非法存储值使该轮响亮失败。
- **压力路径保持暂缓**:当前没有 Harniverse Provider 错误携带持久压力码;W06 的逐请求省略仍是唯一的压力行为(记为已知限制)。

## 备选方案

- 逐字移植官方压力响应设计:否决 —— 此处没有 Provider 失败映射到 `IMAGE_OFFLOAD_REQUIRED`,且蓝图 W12 明确要求龄语义。
- 在 LLM 适配器请求时打占位:否决 —— 非持久、对回放与循环不变式不可见,且与 W06 省略无法区分。
- 只在 session-store 服务上注册投影(不给 `Session` 支持):否决 —— 恢复/持久化路径直接构造 `Session`;构造期投影用一条代码路径同时覆盖两者。

## 后果

展示面与 `deriveEventMessage` 保留原件;只有 `deriveMessages()` 变化。不变式伴随件复述持久 `targets` 形状(`{ messageSeq, imageIndex }`、更早 seq、类型、索引边界),并以与投影相同的方式容忍被遮蔽/窗口化目标。未挂载插件的组合派生未打占位的图片 —— 事件保持持久且惰性。`compaction-settings` README 与 session 子系统页记录该接缝。
