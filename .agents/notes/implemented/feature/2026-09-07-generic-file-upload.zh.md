# Agent Note: 通用文件上传

Status: implemented

[English](2026-09-07-generic-file-upload.md) | 中文

## 问题

图片是唯一拥有完整耐久管线（准入、内容寻址存储、模型可见内联文本）的附件类别。其他任何用户文件——PDF、CSV、日志——要到达模型只能把字节粘贴进输入框：撑大 wire prompt、绕过会话日志的可重建保证、并且躲开附件 seam 已持有的一切大小/耐久策略。A5 扩展该 seam，让任何文件遵循同一纪律：一条上传路由、一个准入事务、一套发布布局。

## 决策

三个 owner 批准的点固定了形态（简报 `A5-FILE-UPLOAD-BRIEF.md`）：`maxFileBytes` 默认 100 MiB（按 store 解析，`FileAttachmentLimits`）；发布的只读句柄位于全局 `attachments/v1/links/` 目录（`<sha8>-<leaf>`）；观察者不可上传。能力门控复用封闭的四能力词汇——路由要求 `harniverse.operate`，其"可对会话行动"的语义恰是上传权限，而非新造第五个 `harniverse.attachments` 能力（记录在案的简报偏离；零 authorize 面改动，观察者因无 operate 而被拒）。

**存储**（`c468b0e778`）：`dsh-attachment` seam 增加 `FileAttachmentRef` / `SaveFileAttachment` / `StoredFileAttachment` / `FileAttachmentLimits` 与三个默认拒绝的 `AttachmentStore` 成员（`saveFile` / `readFile` / `publishFileHandle`），未准备的 store 拒绝上传而非默默接受。`attachment-local` 实现它们：`saveFileObject` 按内容地址原样存字节（空文件无效、超限在完整结果边界拒绝）、`readFileObject` 返回字节前复验摘要、`publishFileHandle` 以净化后的 leaf 建幂等 0o444 硬链接（`UNSAFE_LEAF` 清洗、无名文件回退 `.bin`）。图片发布骨架提取为共享的 `publishObject`（耐久性、原子链接、去重校验逐字保留）。

**路由**（`1b6a0ab45d`）：client-connection Host 面的 `POST /api/attachment/upload`——信任栅栏（`isTrustedApiRequest`）→ 认证 → operate 检查（403）→ store 能力探针（501）→ Content-Length 预检（413）→ 越限即摧毁请求的分块上限累积器（413）→ 回执 JSON。请求体是原始字节而非 multipart；文件名经 `x-attachment-name` URI 编码传递。`AttachmentError` 映射 `FILE_TOO_LARGE`→413、`INVALID_FILE`→400。

**准入**（`124a1d02e0`）：prompt content 数组中的 file part 进入一个返回 `{blocks, files}` 的 `durablePromptContent` 事务——每个 file part 先经 `readFile` 验证、`publishFileHandle` 发布，然后才产生任何块；任一失败拒绝整个 prompt（attachment-error），会话从不引用未发布的句柄。模型可见形态是确定性中文句柄文本（`[文件] 名 · 大小 · sha256:前8`、只读路径、指示用 read 工具而非凭名猜测），以内联 text block 形式注入；文件字节永不进入模型请求。log-only 的 `user/file` 事件紧邻其 `user/message` 之前 append（位置关联），携带去重后的 refs，供 UI 徽章、导出清单与准入审计；`MessageSource.user.files` 把同样 refs 传给消费者。`KNOWN_SESSION_EVENT_TYPES` 是生成物，持久化目录在同一 commit 再生——不再生时 append 被 runtime 拒绝。

**客户端**（`3e2cf28877`）：XHR 上传传输（`fetch` 的上传进度无普适支持）带进度与 AbortSignal 桥接；输入框文件入口的 chip 呈现待传/出错/移除状态，沿用 B7 链接色语言；`user/file` 徽章行渲染在所属 user 消息上；提交时每个 chip 组装一个 `file` part 排在文本之前。中文产品文案（`locales.ts`）、英文代码注释。

## 备选方案

**multipart/form-data** —— 路由消费原始字节，因为传输层（Blob 上的 XHR）已持有帧结构，而为单文件体引入解析器会增加一个需要审计的边界面。

**第五能力（`harniverse.attachments`）** —— 拒绝：能力是封闭的四词汇 seam，operate 语义已覆盖"可修改会话绑定状态"，新能力需要 authorize UI、预设与文档，换来的权限与 operate 无法区分。

**把句柄文本存进 `user/file` 事件而非消息** —— 拒绝：回放与模型请求不得依赖 log-only 记录；消息自身的 content 才是权威的模型可见面，事件只是附加元数据。

## 后果

观察者不能上传（无 operate），子 profile 的 prompt 共享同一准入事务（`session.prompt` 与 `subagent.prompt` 汇入同一 admit），超限或损坏的文件死在最早的边界（路由预检、准入验证）。全局 `links/` 命名空间扁平化发布（单目录、内容寻址前缀）——sha8 前缀保证无碰撞，但跨会话的名字碰撞审计就是一次目录列举。`user/file` 刻意不是 SurfaceEventType，永不进入 surface 折叠；消费者按位置关联。100 MiB 默认值按 store 配置而非按 profile。模型可见的上传记账（句柄文本是否该进 token 预算注记）随 README 的 known-limitations 条目一并推迟。
