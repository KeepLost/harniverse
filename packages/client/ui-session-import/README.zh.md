# `@deepseek-ai/dsh-client-ui-session-import`

[English](README.md) | 中文

“会话导入”设置分区与归档停靠栏：用户在这里把官方 DeepSeek Harness 的对话作为只读归档带进 Harniverse，并把其中一段在新会话里继续。它是仅浏览器的插件，基于 [`@deepseek-ai/dsh-host-official-session-import`](../../host/official-session-import/README.md) 的 `officialSessionImport` Remote（`ctx.remote.officialSessionImport`）与 [`@deepseek-ai/dsh-host-apiproxy`](../../host/apiproxy/README.md) 的 `session.continueArchive` RPC；node 一侧不注册任何 host 行为。

## 组装

```yaml
# host row (the Remote this section drives) is owned by the web-app bundle
# browser row
- id: ui-session-import
  name: '@deepseek-ai/dsh-client-ui-session-import'
```

插件注入 `officialSessionImport` 命名空间服务，因此没有挂载导入 Remote 的 host 永远不会激活它。它以 id `session-import`、order `22` 注册进 `settings.section`，位于 IM 机器人（21）与语音输入（25）之间；在 `conversation` 服务存在后，再以 id `session-import-archive`、order `-100` 注册进 `conversation.input.dock`，让归档提示排在停靠栏最前。

## 行为

- **按机器扫描。** 分区挂载时扫描当前指向的机器，机器目标变化时重新扫描，并清空上一台机器的选择与结果。它显示扫描的根目录、每个候选一行（标题，否则首条提示，否则“未命名会话”；源工作目录、轮次、更新时间与大小；以及 未导入 / 已导入 / 有更新 状态），还有一个折叠的列表列出无法提供的日志及原因。
- **选择并导入。** 每行是以标题命名的复选框；“全选未导入”选中所有当前版本尚未导入的候选。“导入到”提供“原工作目录（自动创建工作区）”—— 即每个源件自身目录处的 workspace，按需注册 —— 以及所有已注册的 workspace。导入时在一次 `importSources` 调用中发送所选项，逐项显示结果（已导入、已导入但没能加入工作区、之前已导入，或带 Host 详情的失败原因，以及有损映射省略了多少条记录），然后重新扫描。
- **上传。** 文件输入接受官方的 `session.vN.jsonl` 或 `.jsonl.zstd` 文件；超过该机器上限的文件在读取前就被拒绝，文件以 base64 编码经 `importUpload` 导入到所选目标。
- **打开。** 每个结算完成的结果都提供“打开”：分区最多等待五秒让归档出现在会话列表中（Host 以 `host/session-added` 宣告导入），然后打开它并关闭设置；仍未出现时改为显示提示。
- **归档停靠栏。** 在 `sessionImport` 投影非空的会话上，停靠栏说明这段对话是只读导入，显示源工作目录，并提供 Agent 预设选择（默认预设，然后是 `agentPresets.list` 中可用的预设）与“继续对话”。继续时调用 `ISessions.continueArchive`，打开新会话，失败时就地报告。在其他会话上停靠栏不渲染任何内容。
- **输入框不可用。** 在会话 scope 存续期间，插件经 `ctx.conversation.blocks` 对归档提出 composer 阻塞，于是输入框被禁用，占位文字为“这是只读归档，点上方的“继续对话”接着聊”，模型选择仍可用。
- **无障碍。** 控件是带标签的原生按钮、复选框、选择框与文件输入；每行复选框以标题作为名称、以详情作为描述；上传提示是输入框的描述；状态使用 `role="status"`，失败使用 `role="alert"`；停靠栏是有标签的 region。

## 状态与接线

`createSessionImportStore()` 声明分区共享的视图状态（扫描阶段、最新扫描、选择、目标、导入进度、最近结果与最近一次本地拒绝）；`createArchiveDockStore()` 声明停靠栏的状态（预设列表、进行中的继续、各归档的失败）。组件经 `useStore` 读取，只经声明的 actions 写入。操作层（`controller.ts`）驱动 Remote、预设列表线路与 sessions 面，并经这些 actions 发布结果；分区的机器目标经 inject 的 `hooks` 隔间送达。`/client` 入口只导出 `apply`、`inject` 与类型。

## 模型体验

Indirectly, through the archive dock's `session.continueArchive` call; [`dsh-session-import`](../../session/session-import/README.md) owns the continuation seed the model sees.

#### KV Cache effect

本包自身没有影响；继续会话在第一次运行轮次时由种子建立自己的前缀。

## 已知限制与暂缓事项

- **重新导入已更新的会话会新增归档** —— “有更新”的候选导入为第二个归档；分区不提供删除旧归档的操作。
- **没有逐项目标** —— 一次导入批次落到同一个目标选择；混合源目录与显式 workspace 需要两次批次。
- **上传在浏览器中整体读入** —— 文件发送前在内存中做 base64 编码，因此很大的日志会占用不超过机器上限的浏览器内存。
