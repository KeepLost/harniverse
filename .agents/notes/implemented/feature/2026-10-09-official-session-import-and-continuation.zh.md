# Agent Note: 导入官方 DeepSeek Harness 会话并继续对话

Status: implemented

[English](2026-10-09-official-session-import-and-continuation.md) | 中文

## 问题

Harniverse 已经能把官方会话日志映射为只读归档（[session-import 运行时](2026-09-20-session-import-runtime.md)、[官方 v4 导入](2026-10-04-official-v4-session-import.md)），但用户无法用到它。唯一入口是原始的 `POST /api/session/import` 路由，web 客户端里没有任何地方调用它。即便经由该路由，导入在官方构建实际写出的日志上也会失败：官方默认写多帧 Zstandard 的 `session.vN.jsonl.zstd`，而导入器把上传内容当作纯 UTF-8 解码。没有任何东西扫描 `$DSH_HOME/sessions` 中的官方日志，同一个文件导入两次会产生两个归档，官方标题会丢失，而客户端在重连之前不会知道归档存在。

归档除了查看也做不了别的。从官方构建迁移过来的用户想带着这段历史继续聊，而归档守卫禁止导入的会话运行。

## 决策

功能在现有接缝之上有三个表面，各归其插件所有。

**导入器接受真实的官方日志，并拥有归档身份**（`dsh-session-import`）。它经 `decodeZstdArtifact` 逐帧解码 Zstandard 工件 —— 该函数由拥有此容器的 JSONL 后端新导出 —— 丢弃 EOF 截断的末帧，并把源字节原样保留为 `.source.jsonl.zstd`。归档 id 为 `session-imported-<sha256(foreign id)[:16]>-<sha256(text)[:16]>`：同样的内容总是映射到同一 id，所以第二次导入会抛出 `ImportConflictError`（原始路由上为 409）而不是重复，无论它经由哪种编码或哪个 workspace 到达；源件增长后得到同一 lineage 前缀下的新 id，扫描正是靠这一点区分“有更新”与“已导入”。存在性检查读取 `persistence.list()`，因为 JSONL 目录按 cwd 分组，同一 id 出现在两个项目目录里会让列表产生歧义。`describe(artifact)` 不持久化地报告一个工件会导入成什么。最新的官方标题映射为一条使用 `user` 来源的原生 `session/title`，因为它是来源信息，而不是由映射消息推导出来的。标记新增可选的 `source.sessionId` 与 `source.cwd`。每次结算完成的导入都会发出 `session/imported`；API 代理把它转为 `host/session-added`，因为归档以分离状态持久化，永远不会触发 `session/created`。`sessionImport` 投影单元向客户端报告标记的来源信息。

**host Remote 在服务端机器上发现并导入**（`dsh-host-official-session-import`，命名空间 `officialSessionImport`，所有方法均为 `harniverse.operate`）。`scan` 遍历配置的根目录（web-app 捆绑传入 `dshHomePath('sessions')`，即官方构建共用的目录），每个会话目录保留最新的 `session.vN.jsonl[.zstd]`，经导入器描述并按大小与 mtime 缓存，再根据已持久化的 id 把每个候选标为 `new`、`imported` 或 `updated`。`importSources` 把不透明 id 解析回其根目录下并拒绝其他任何形式；`importUpload` 接收在解码前后都限制大小的 base64 日志。目标是一个已注册的 workspace，或者 `source-cwd`，即官方会话自身目录处的 workspace，按需注册。结果逐项返回、从不抛出。由于该行位于 web-app 捆绑中，remote-server 组装也带上了它，网关现有的 Remote 转发会把调用送到目标机器，由那台机器扫描并导入到它自己的 DSH home。

**继续对话会新建会话；归档仍是归档**（API 代理中的 `session.continueArchive`，种子来自 `dsh-session-import`）。`continuationSeedOf` 去掉标记与导入器的提示，以一条说明出处与损耗的模型可见说明开篇，在改写 surface 引用的同时重新编号事件，并用核心的中断工具结果关闭未得到回答的工具请求，使下一次 provider 请求结构完整。代理像 `session.create` 一样组装继续会话（agent profile、model profile、预设拒绝），把它放在所选 workspace，否则放在归档所在的 workspace，再否则放在归档的 cwd，并且不记录谱系，因此归档仍可删除。`import/record` 标记还会结束会话的空白阶段，因此没有轮次的归档永远不会被复用为 workspace 的空白会话。

**浏览器一侧**（`dsh-client-ui-session-import`）新增“会话导入”设置分区 —— 按机器目标扫描、带状态的多选、目标选择、上传、逐项结果以及会等待归档行出现的“打开”操作 —— 以及位于 `conversation.input.dock` 的归档停靠栏：它读取 `sessionImport` 投影，经 `ctx.conversation.blocks` 提出 composer 阻塞，并提供 agent 预设选择与“继续对话”，后者调用新的 `ISessions.continueArchive` 并打开继续会话。

## 考虑过的替代方案

**解除归档守卫，允许归档恢复。** 否决：归档是官方构建所做之事的保留记录，其映射日志缺少恢复后的 Agent 所需的系统提示词与请求 header。继续会话保持记录完整，并把损耗明确地摆在模型面前。

**让继续会话的种子以 `parentSession` 指向归档。** 否决：代理会拒绝删除带非子代理后代的会话，于是只要存在继续会话，归档就永远删不掉，而谱系对普通会话没有其他作用。

**扩展 `session.fork` 以接受归档。** 否决：fork 继承源会话的组装并在轮次边界切分，而继续会话选择新的组装并取整段历史；一个 RPC 承载两种含义，就需要只对某一种来源有效的选项组合。

**浏览器使用原始上传路由。** 否决：精确路由由页面所在 Host 服务、从不转发，因此上传到远程主机会落到错误的机器上；Remote 以多三分之一字节为代价携带 base64。

**通过导入索引去重。** 否决：由内容派生的 id 不需要第二份要与删除保持一致的持久状态，而 `persistence.list()` 已经能回答存在性。

**用 composer 接管链展示归档提示。** 否决：链选择器只读取 owner props，其中不带投影值；停靠栏通过自己的 hook 读取投影，现有的阻塞注册表负责禁用输入框。

## 后果

用户打开 设置 → 会话导入，看到目标机器上的官方会话，把它们导入到原工作目录或所选 workspace，打开归档，并用所选预设继续对话。重新导入未变化的日志会报告“已导入”；已更新的日志会导入为第二个归档。

持久化变更都是增量的：`import/record` 新增两个可选的 source 字段（其 payload 类型名不变，因此会话契约摘要不变），导入的归档带有 `session/title` 事件，`sessionListMetadata` 的折叠语义改变，所以其 `stateVersion` 升为 2，过期的缓存行会被丢弃。此次变更之前导入的归档保留随机 id，扫描不会把它们识别为已导入。

模型只在继续会话中看到导入的历史，开头是 session-import README 中固定下来的出处说明；继续会话的第一次请求以整段映射历史作为输入。

验证：session-import（身份、Zstandard、描述、标题、投影、事件、继续种子）、JSONL 整件读取器、Remote（发现、故障、服务、生成的契约、导入到已注册 workspace 的真实 Loader 组装）、代理的 `continueArchive` 与导入宣告、客户端运行时的 `continueArchive`，以及客户端包均达到 100% 的行与分支覆盖。`apps/web/tests/session-import.e2e.ts` 以无密钥方式驱动已发布的 web 组装：扫描会话根目录中的官方 v4 Zstandard 日志，把它导入到其 cwd 处的 workspace，打开带停靠栏且输入框不可用的归档，再继续对话，并在 host 日志中断言继续会话的种子；另外四个场景的设置导航 golden 增加了新的分区。
