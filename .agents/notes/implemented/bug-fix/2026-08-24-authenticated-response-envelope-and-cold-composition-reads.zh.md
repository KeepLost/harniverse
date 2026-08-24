# Agent Note: Authenticated response envelope and cold composition reads

Status: implemented

[English](2026-08-24-authenticated-response-envelope-and-cold-composition-reads.md) | 中文

## Problem

Web GUI 中三个操作者可见的界面报告失败而非展示数据：设置「插件」分区中的 Profile 组装视图与插件列表视图，以及会话的「能力」视图。造成它们的是两个彼此独立的缺陷。

第一个缺陷破坏了所有经客户端连接 HTTP 请求处理器承载的 Typert Remote 调用。`serverResponseSchema` 要求 `server-response` 携带 `authentication` 字段，浏览器半侧在交付响应前会按该 schema 解析。该处理器构造信封时没有写入这个字段，于是被准入的身份只存在于 Host 侧而未出现在线路上，浏览器便把格式正确的成功响应判为无效输入。Host 侧全程是正确的：同样的 Remote 在直接经 HTTP 调用时返回真实数据，这正是该故障看起来像客户端产物或组装问题、而非信封缺陷的原因。

第二个缺陷使组装结果仅在 Agent 存活时可读。`capabilityManagement.session()` 从运行中的 Agent 解析组装，不存在时抛错。操作者从侧栏打开的会话在跑完一轮之前都是冷的，因此任何既有会话的「能力」视图都没有可读的组装——而这恰恰是操作者最想查看已启用内容的状态。

## Decision

HTTP 请求处理器在它发出的每个信封中携带被准入的身份。它对每个请求解析一次 principal 身份，并同样写入成功、错误与非法信封三类响应，使该处理器可能产生的每个响应都满足浏览器校验的 schema。该身份就是本请求已经准入的身份；处理器不新增任何认证判定，各 Remote 的必需能力仍然把关调用。

`capabilityManagement.session()` 通过会话日志记录的 Profile 读取冷会话。存活的 Agent 仍由其自身的 generation 作答；没有 Agent 时，网关从会话持久化中解析该会话记录的 `agentProfile`，并读取该 preset 的 standing generation；持久化未列出的会话视为未知，仍然显式失败。这遵循 api-proxy 中 presenter-scope 的先例：standing 挂载只组装插件，不恢复 agent、session 或 turn，因此该读取保持为纯观察。

`agentPresets` 新增 `standingCompositionRuntime(id?)`，即 `compositionRuntime(agentCtx)` 的无 Agent 对应物。它解析 preset、确保其 standing 挂载，并返回与已加入 Agent 所报告相同的 generation 标识与组装条目。把它放在 preset 名册上，使组装知识留在 standing 挂载的归属方，而不是在网关中复制挂载逻辑。

## Scope

两处改动都是读路径修正。二者均未改变 Remote 的能力要求、owner sealing、仅回环 bypass、非回环监听的 TLS、公开路由集合、会话或 Profile 的持久化格式，以及插件选择状态。信封改动补上的是 schema 本已要求的字段；它不引入新字段，也不引入新的认证结果。冷组装改动新增的是读取回退而非变更：组装 standing 挂载与一次普通 Profile 读取产生的效果相同。

归档面板与预览本已完成组装，先前探测中面板为空是因为夹具中没有归档会话。但还存在一个入口可达性缺陷：归档入口只在展开的侧栏中渲染，收起或窄侧栏没有通往面板的路径。现在入口在两种侧栏状态下都会渲染，收起状态点击后先展开侧栏再打开面板。

## Testing

信封缺陷在其产生处与消费处同时被钉住。连接 Host 半侧的规格断言发出的信封携带该身份并能通过 `serverResponseSchema` 干净解析，因此未来若有信封丢掉该字段，会在浏览器所用的 schema 处失败，而不是只在浏览器运行时暴露。api gateway 的 Host 规格对其 HTTP 分派响应钉住同一字段。

冷组装路径由网关单元测试覆盖三种结果：存活 Agent、已列出且记录了 Profile 的冷会话、持久化未列出的会话。日志早于「记录 Profile」字段的冷会话解析为默认组装，而非失败。

Web e2e 归档场景扩展了既有的归档往返：行菜单归档提交后，头部入口打开面板，归档会话被列出而非显示空态，其预览解析出已记录的消息内容。该消息断言曾被刻意改成不可能的期望以做反证，确认它观察到五条真实渲染的消息，而不是空洞通过。

WorkspaceBrowser 客户端规格覆盖了收起侧栏中的归档入口：归档控件存在，点击会调用壳层展开动作，并进入归档模式。

## Alternatives considered

**放宽 `serverResponseSchema`，让 `authentication` 变为可选。** 否决，因为该字段是响应对「Host 准入了哪个身份」的记录，而浏览器校验它正是设计生效的表现。削弱 schema 会在所有通道上掩盖该缺陷，而不是修正那一个漏写字段的生产者。

**让浏览器容忍缺失的 `authentication` 字段。** 以同样理由在更靠后一层否决：客户端的宽容会让 Host 无限期地发出欠定义的信封，两个半侧对「一个响应包含什么」将长期不一致。

**当「能力」视图读取冷会话时恢复该 Agent。** 否决，因为纯观察的读取不得启动一轮或附着 Agent。恢复会使「打开会话的能力视图」变成一次带有模型、成本与日志后果的生命周期事件。

**为冷会话报告空组装。** 否决，因为组装是日志所记录的事实，而非缺失。空结果会把已组装的 Profile 误报为没有任何能力，使该视图恰在被打开的场景下毫无用处。

**在 capability-management 网关内部读取 standing 挂载。** 否决，因为 standing 挂载归属于 preset 名册。在消费方复制「解析并确保」的序列，会让同一条组装路径出现两个归属方并可能彼此漂移。

**用单元层夹具断言归档面板内容。** 否决，因为所报缺陷针对的是经真实线路触达的组装界面：入口、面板与预览。组件夹具无法区分「已组装但不可达的面板」与「正常工作的面板」。

## Consequences

经连接处理器抵达浏览器的所有 Typert Remote 现在均可工作；三个被报告的界面渲染出真实数据。代价是响应构造多了一个必需输入，而测试现已在生产者与 schema 两处钉住它。

「能力」视图对任何已列出的会话（存活或冷）均可读，读取时若该 Profile 的 standing 挂载尚未挂载则会组装它——与任何 Profile 读取效果相同，不启动 agent、session 或 turn。持久化中不存在的会话仍显式失败，因此真正未知的 id 不会被默认组装静默作答。

Web e2e 通道与 doc-sync 存在与本次改动无关的既有失败：本环境上 golden aria 快照发生漂移，`verify-export-jsdoc` 与 `verify-package-readme-model-experience` 在本次改动未触及的文件上失败。它们已在干净工作树上确认逐字节一致，留给各自归属方处理。
