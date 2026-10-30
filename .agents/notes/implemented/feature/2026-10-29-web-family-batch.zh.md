# Agent Note: 第五波 Web 家族批量吸纳

Status: implemented

[English](2026-10-29-web-family-batch.md) | 中文

## 问题

2026-10-29 的 owner 处置将第五波 row-17 剩余产品选择作为一个批次接受（见 `UPSTREAM-ABSORPTION-REVIEW.md` Wave-5 row-17 处置）：八项 Web 家族增量加上 `keep-assistant-replies`，落到 Harniverse 自有契约上，而非上游较新的载具包（`ui-chat`、`ui-dockkit`、`file-upload` 与富文本编辑器在下游不存在）。

## Decision

- **输入框图片即加即传。** 粘贴/拖入/选择的图片在添加时立即上传 —— 后台 XHR 带进度，单项状态 `uploading → ready{ref} | error{reason}`，移除即取消，传输失败可重试，宿主拒绝只可移除且缩略图上显示原因，提交等待所有图片草稿并点名首个失败。新路由 `POST /api/attachment/upload-image`（与文件路由同信任围栏/鉴权/`harniverse.operate`；流式读取上界 `min(maxImageBytes, maxMessageImageBytes)`；媒体类型白名单；`validateImage` → `saveImage`）。适配：Harniverse 图片是内容寻址的持久 `ImageAttachmentRef`，官方按会话的内存回执注册表由 ref 本身替代（与会话无关，无需重绑）。prompt RPC 的 part 联合类型新增加法臂 `{ type: 'image'; ref: ImageAttachmentRef }`（宿主经 `readImage` 摘要校验、fail-closed；已上传字节计入 `maxMessageImageBytes`；计数覆盖两种臂）。**会话日志不变** —— `durablePromptContent` 仍引用规范存储 ref 块，由 prompt-image-refs 夹具测试钉定；session-contract 摘要基线未动。
- **纯文本派生消息引用。** 新包 `dsh-client-ui-message-quotes` 移植官方识别/渲染半边：`quote-text.ts` 近乎逐字（显式 `>` 引用块区间），基于凭据遮罩创建的 `sentUserTextRules` 缝的 `SentUserTextRule`（`id: 'quote'`），以及字面引用块渲染。已发送消息就是普通 Markdown；不持久化引用元数据，会话格式不变。选区插入半边随其依赖的富文本编辑器归 R33。
- **聊天流间距。** 官方 6→4px 进程行收紧适配到扁平 16px 列节奏上：相邻进程行 `--dsh-chat-process-gap: 4px`，助手回复前 `--dsh-chat-response-gap: 12px`，其余 16px（基于 `data-chat-flow-kind` 的负边距相邻规则）。由 `chat-flow-gap.client.spec.ts` 钉定。
- **标签条滚动到活动项。** `ui-workspace` 的 `TabStrip` 增加 `scroll-behavior: smooth` 滚动到活动标签（8px 边缘内缩），以及官方 jump-then-glide 语义：按工作空间账号（模块级 WeakMap）记录最后 `scrollLeft`，重挂载瞬时恢复，首次放置直接跳转。
- **文档站长表筛选。** 网站主题模块（`website/.vitepress/theme/`）近乎逐字移植：≥10 体行的表格获得行级搜索、清空、空状态、粘性表头偏移、打印规则；zh/en 文案；规格 `scripts/verify-doc-site-table-filter.spec.ts` 接入 `docs:check`。已记录更正：这是文档站功能，不是聊天表格。
- **会话列表摘要投影。** 已记录更正：该事项是线上载荷子集，不是渲染的摘要行。`ProjectionDefinition.summary?: boolean`（默认 true）将键排除出列表行；注册表面 `summaryKeys()`；`cachedSnapshot(meta, keys?)` 过滤缓存读取；`session.list` 行只携带摘要子集，所有打开面（历史尾、推送帧、显式读取）不变。排除键：`todos`、`sessionStats`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`plan`。
- **新建会话空白复用。** 对照官方加固逐项核查：Harniverse 已有严格预设匹配的空白复用、草稿保留、陈旧空白的镜像自愈；分歧是有意为之（宿主头是不可变的唯一权威）。补固定测试；无生产代码变更。
- **ui-user-questions 迭代。** 已回答的问答批次渲染为 `question-reply` 会话聊天节点（右对齐气泡、可折叠、可复制）；输入卡片获得 3 行 CSS 截断预览、带 aria 标签的展开/收起与换行选项描述，逐步骤重置；无选项问题保持可答，长问题不隐藏提交。仅 zh/en；不做语言扩展、CUA 钩子或定时问句变更。
- **keep-assistant-replies —— 记录性承诺，无代码。** Harniverse 没有回合折叠模型（R33 未排期；每条助手回复本来就永久可见）。自有折叠设计落地时必须默认 `foldedReplies: 'all'`。

## Alternatives considered

- **整体移植上游载具包**（`ui-chat`、`ui-dockkit`、`file-upload`、富文本编辑器）被否：Harniverse 有意不携带这些架构；所有事项落在既有缝上（`sentUserTextRules`、`ui-workspace` 的标签条、A5 上传管线、会话节点注册表）。
- **官方按会话的内存图片回执注册表**由 Harniverse 已有的内容寻址持久 `ImageAttachmentRef` 替代 —— 与会话无关，无需重绑机制。
- **列表行投影值的类型级收窄**（上游 `SessionProjectionSummaryValues`）判为低价值：列表块与打开面喂同一个高 seq 优先存储，类型分裂守不住运行时已强制的东西。
- **宿主侧空白复用复核**未添加：Harniverse 的宿主头是不可变的唯一权威（与官方预设切换记录的有意分歧），客户端严格匹配加镜像自愈即是忠实编码。

## Consequences

- `session.list` 行因摘要排除键而变小；客户端将缺失视为能力缺失，与从前一致。打开面不变。
- prompt RPC part 联合类型新增加法臂 `{ type: 'image'; ref }`；会话日志与 v0 摘要基线不变（由 prompt-image-refs 夹具测试钉定）。
- 输入框图片在添加时上传；被拒上传保留宿主原因，绝不从发送中静默丢弃。
- 问句卡片与新增 `question-reply` 节点的浏览器金标已刷新（`DSH_SNAPSHOT=refresh`）；replay 绿。
- `keep-assistant-replies` 将未来 R33 折叠设计绑定到 `foldedReplies: 'all'` 默认。

## Verification（验证）

聚焦套件：`ui-message-quotes` 15、`ui-workspace` 标签规格 76、table-filter 规格 6 + 文档三件 49、`ui-conversation` 626、投影相关六包 262、apiproxy 投影 19、runtime workspaces 28/382、`ui-user-questions` 71、图片暂存四包扫 2008、`test:gui` 7691 通过；`pnpm run build` 绿（240 工件）；改动文件 oxlint 干净；css tokens/classes 门禁绿；session-contract 摘要基线不变。有意输出变更的金标已以 `DSH_SNAPSHOT=refresh` 刷新；replay 绿。
