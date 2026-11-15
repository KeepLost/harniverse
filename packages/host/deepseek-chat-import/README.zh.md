# dsh-host-deepseek-chat-import

[English](README.md) | 中文

将浏览器上传的 DeepSeek 聊天记录导出文件(chat.deepseek.com 的 `deepseek_data-*.zip`)导入所选工作区,作为归档会话。

## 模型

- 浏览器将 ZIP POST 到固定的 `/api/deepseek-chat-import/archive` 路由(本插件组合时由 API proxy 服务);请求体只在内存中缓冲——绝不落盘——并以 `application/x-ndjson` 的进度行加一行结局应答。单一导入槽位一次只服务一个上传;`limits` Remote 以 `harniverse.operate` 能力回报上传上限。
- `fflate` 读取归档:先读中央目录,一趟流式过程存储每个所选会话的图片(经 attachments 缝),第二趟在会话条目到达时逐个落账。预算默认 1000 个会话、512 MiB 上传、256 MiB 条目、80 字节标题;导出索引按最近更新排序选择导入哪些会话。
- 每个会话经纯读取器转换(`conversation.ts`:按 `current_message_id` 选分支,THINK/RESPONSE/SEARCH/OPEN 片段映射为步骤,`web_search`/`web_fetch` 工具调用重放),再经 `session-import` 的 `settleConverted` 入口落账:`deepseek-chat-v3` 标记、会话 lineage 前缀下的内容派生身份(因此重复导入同一会话报告为已导入,更新过的会话经 `session.continueArchive` 续接)、映射日志旁的源保留,以及永不恢复执行的归档姿态。
- 「会话导入」设置区新增导出入口:文件字段加上该区既有工作区目标;源目录目标会先提示选择工作区。

## 已知限制与待办

- 导入期间整个归档驻留内存;上传上限即其约束。
- 之后转换失败的会话的图片仍保持已存储;attachments 缝不提供删除。
