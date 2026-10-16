# Agent Note: read_image 的模型侧视图

状态：已实现

[English](2026-10-16-read-image-model-side-view.md) | 中文

## 问题

`read_image` 以持久引用加逐请求投影的方式向模型返回图片：附件存储保存原始字节，而请求路径派生有界的模型请求版本（`readImageRequest`，默认 2048² px / 1 MiB，低细节 512²）。UI 对此一无所见。工具卡片把已完结结果的图片块渲染为原始 JSON，详情面板同样如此，用户既看不到工具实际产出的图片，更看不到模型收到的那份缩放副本——而当模型误读截图时，恰恰是那份视图才说明问题。

## 决策

**暴露每条具备图片能力路由的投影策略，读取时按需投影，并让所有已完结的工具结果图片经它渲染。**

LLM 接缝承载策略。`LlmResolvedModelInfo` 新增 `imageRequestPolicy?: ImageRequestPolicy`；`resolveModelInfoFor` 在其他元数据旁校验它（`INVALID_MODEL_IMAGE_POLICY`）。DeepSeek 适配器发布其请求路径所用的同一个 `requestImagePolicyOf(model)`，且仅限 `inputModalities` 含 `image` 的目录条目；pi-ai 适配器在 pi-ai 模型 `input` 含 `image` 时发布其路由预算。不具备图片能力的路由不发布任何内容，读取即"无可解析的模型视图"。

宿主在读取时投影。`session.attachment` 接受 `variant: 'model'`：定位被引用图片，解析下一个携带它的请求的调用配置（携带事件之后第一个 step/turn 边界处生效的 header；中断轮次的日志在无边界时取结尾 header），经 `llm.resolveModelInfo` 解析该路由策略，并以 `projected: true` 加投影后的媒体类型与尺寸返回 `readImageRequest` 字节。该路径上任何失败——无策略、路由不可解析、`ATTACHMENT_PROJECTION_UNSUPPORTED`、路由错误——都以 `projected: false` 返回存储原图，旧提供方组合退化为今天的答案而非报错。投影按次计算且绝不存储：策略是随配置变化的部署与模型自有事实，持久对象保持原图。

客户端穿线 loader。运行时 `readAttachment` 透传变体；会话控制器持有 `resolveImage(sessionId, attachment, variant)`，缓存键为每 `${sessionId}:${variant}:${attachmentId}`；chat-node、details 与 tool-call 的 owner props 都以 `loadModelImage` 暴露它。ui-tool 通用消费：每个工具行经共享附件图库（模型侧 loader、本地桥接的会话命名空间标签）把结果的图片块内联渲染在折叠行之下，`ToolDetails` 在卡片下渲染同一图库。图片块从所有压平结果文本中移除——两个表面上的 JSON 团块消失。

## 备选方案

**在 `read_image` 时持久化投影字节。** 否决：投影是路由当前策略的函数；持久化一份冻结副本要么按路由膨胀持久存储，要么在策略一变时就过期，而按需读取只是对宿主上已有字节的一次有界派生。

**只服务原图并打标。** 否决其作为主行为：用户报告的核心正是模型看到的图片与工具产出的不同；仅原图的答案被精确保留为带标记的回退。

**以消息 id 为键的专用图片查看路由。** 否决：`session.attachment` 已拥有会话授权的图片读取及其引用扫描授权；平行路由会复制信任边界。

## 后果

每张带图的工具结果现在都在聊天与详情中显示图片：路由能说明时按模型收到的样子投影，不能时明确标记（`projected: false`）。线格式变更为增量式（可选请求字段、可选响应标记），回放的旧 fixture 与旧客户端不受影响。授权面积没有增长：同一声明载体扫描同时把守两个变体。

验证：apiproxy 投影测试（策略投影、无策略原图、不支持/路由失败回退）、运行时变体透传、llm 策略校验与适配器发布（deepseek、pi-ai）、ui-tool 行/详情图库渲染及 loader 接线，客户端全量套件绿。

PR: #192 (merge)
