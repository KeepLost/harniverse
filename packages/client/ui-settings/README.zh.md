# @deepseek-ai/dsh-client-ui-settings

[English](README.md) | 中文

设置领域的底座，承担两项职责，本身不含任何呈现内容。它提供 `ctx.settingsScope`——每个偏好设置行绑定自己那份持久化命名空间分区所用的宿主传输层；并声明由注册方填充的设置 slot 类型：`settings.trigger`／`settings.header`／`settings.close`（界面框架内容）、`settings.action`（内容标题栏中的有序操作）、`settings.section`（每项功能一页）、`settings.plugins.tab`（“插件”分区内由各功能持有的页面）和 `settings.onboarding`（由各功能持有的有序页面）。它不依赖任何 `ui-*` 呈现包，因此任何持有偏好设置的功能都能够到它；设置**外壳**——`sidebar.settings` 占位方、它的导航与界面框架——位于 ui-settings-general，因为外壳一旦依赖 ui-sidebar，就会经 ui-layout 与 ui-theme 闭合出一条引用图环路。外壳自身的契约类型出于同一原因与外壳放在一起。

该插件注入 `connection` 与 `remote`，持有唯一共享的 `settings.describe` 镜像，并让每个绑定 scope 从 Host 已脱敏的视图派生自己的 namespace。`ctx.connection.authentication` 尚未发布经 unary／mux／host 匹配的身份前，镜像不会发起读取。连接载体会集中拒绝 Host 身份缺失或与发起身份不同的任何读写结算；随后镜像再通过 principal generation fence 决定是否发布。身份不匹配会同步撤回连接，普通失败则保留最后一份已授权视图。并发失效始终最多保留一个进行中的 describe 和一次重跑。`settings/document-updated` 与 Host 权威的 `settings/exposure-changed` 会刷新共享视图；principal 转换会在新读取开始前清空视图及所有派生 scope。写入携带单一字段路径和最近已知的 namespace revision 作为 `expectedRevision`，成功且已脱敏的响应仅在其发起 generation 仍为当前值时折入共享视图。若 spec 未提供 `decode`，非法分区一律不发布任何值。

## 模型体验

无。设置领域底座为浏览器提供偏好设置存储与 slot 声明；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **设置可用性来自授权结果**：客户端不会从 loopback 状态推断访问权。缺少 `harniverse.administer` 的 principal 只会收到 Host 拒绝，且得不到任何快照。
- **每次写入仅一个字段**：`set` 只发送单个 `set` op，因此需要同时改动两个字段的行没有事务可用，会发布两个 revision。
