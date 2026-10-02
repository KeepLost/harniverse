# Agent Note: Session 声明的附件载体

Status: implemented

[English](2026-10-02-declared-session-attachment-carriers.md) | 中文

## 问题

附件授权（`session.attachment`）与 ZIP 导出的媒体发现曾按任意事件上的常见载荷字段名推断图片归属。一个可忽略插件载荷若恰好在其 `data` 中携带含图片样式附件的 `content` 数组，就能授权一次附件存储读取；两个导出测试也依赖虚构的载体形状（扁平 `data.content` 的 `assistant/message`、不存在的 `context/inserted` 事件），只有这套推断能让它们通过。

## 决策

两个读取器都按内置事件类型选择内容字段：`user/message`（数据即消息本身）、`assistant/message` 与 `tool/result`（`data.message.content`）、`agent/inbox/spliced`（校验后的 `inserted[].content`）以及 `assistant/chunk` 的 block-end 块。其余一切——包括携带同名字段的可忽略插件事件——保持不透明：活路由以 `ATTACHMENT_NOT_REFERENCED` 拒绝且不读取存储，导出器仍逐字写出完整逻辑日志，只省略媒体对象。

与官方修复不同，嵌套 tool-result 遍历保留：Harniverse v0 的 `tool/result` 消息把含附件的内容嵌套在 `tool-result` 块内，且活路由的 `imageBlockIn` 早已把递归限制在这些块中。Harniverse 没有独立的压缩载体需要纳入——v0 压缩摘要通过 `user/message` 替换操作落地，`user/message` 分支已覆盖。

## 备选方案

**扫描每个事件上的常见键名。** 字段名将在没有定义内容含义的情况下授予附件访问权，而存放在其他声明字段下的有效内容会被漏掉。

**像官方修复那样去掉嵌套 tool-result 遍历。** 官方 V4 的工具结果是扁平的，嵌套下降会读取多余的块字段。v0 的 tool-result 形状按设计把含附件的内容嵌套在内，遍历就是声明路径，而非推断。

## 后果

只在自定义事件中存放图片引用的插件无法让这些内置读取器读到它们；需要声明载体或自带读取器。新增内置内容载体现在要求同时更新两个读取器及其接受与拒绝测试（拒绝测试断言附件存储从未被读取）。虚构的导出 fixture 已修正为真实 v0 形状，测试因此兼作形状文档。

于 2026-10-02 wave-4 吸收期间移植自官方 DSH `0c44e5461d`（Tianyi Cui）。

## 验证

`api-proxy-models.spec.ts` 拒绝声明 `att-ghost` 的可忽略 `plugin/custom-note` 载荷并断言 `readImage` 从未被调用；`session-export.spec.ts` 导出嵌套的 `tool/result` 图片、跳过不透明的 `ghost` 媒体条目并逐字保留日志。apiproxy 全套：600 通过。
