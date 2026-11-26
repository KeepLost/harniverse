# Agent Note: MCP OAuth —— 被动连接，经管理 Remote 显式授权

Status: implemented

[English](2026-11-26-mcp-oauth-streamable-http.md) | 中文

## 问题

`streamable-http` 类型的远程 MCP 服务器可能以 401 拒绝所有请求并指向 OAuth 2.0 Protected Resource Metadata：客户端必须发现授权服务器、取得客户端信息（动态注册或配置的 id）、在浏览器中完成 PKCE 授权码流程，并持续刷新访问 token。桥接器过去只能附加静态 `headers`，因此这类服务器无法使用：每次尝试都失败，supervisor 耗尽重连预算，模型得到一台没有工具也没有原因的服务器。任何解决方案都受三项约束。机群连接在启动时以及每次设置变更时启动，因此该路径绝不能打开浏览器或注册客户端。浏览器只能返回 Host 控制的监听器。而协议代码必须位于已声明 MCP SDK 的地方——[`dsh-mcp-client`](../../../../packages/mcp/mcp-client/README.md)——设置 namespace 与管理 Remote 却位于 [`dsh-mcp-user-config`](../../../../packages/mcp/mcp-user-config/README.md)，后者既未声明 SDK 也未声明凭据 seam，且不得新增依赖。

## 决策

连接保持被动；授权是 `mcpManagement` Remote 的一项显式操作。

- **配置**（`packages/mcp/mcp-client/src/config.ts`）：Streamable HTTP 条目新增 `oauth: true | { clientId?, scope?, requestTimeoutMs = 10000, authorizationTimeoutMs = 600000 }`。`oauth` 与同一条目上的 `Authorization` 标头并存是校验错误，由 `resolveOAuthConfig` 在最早可判定的位置抛出——`dsh-mcp-client` 的插件加载、共享机群的 owner 加载，以及 `dsh-mcp-user-config` 的设置写入——未知选项、非 HTTPS 且非回环的 endpoint、stdio 条目上的 `oauth` 同样如此。
- **授权记录**（`packages/mcp/mcp-client/src/oauth-store.ts`）：每台服务器一份自包含、带版本的 JSON 文档，存于凭据 seam 引用 `mcp_oauth_<服务器键的十六进制>` 之下，其中键是共享 owner 的设置 id，或独立行的 `serverName`。它把 endpoint URL、授权服务器、客户端信息、resource 指示符、配置的客户端 id 与 scope，以及 token 彼此绑定。只有当所有绑定都与当前配置一致时，授权才会被使用。
- **被动会话**（`packages/mcp/mcp-client/src/oauth-session.ts`）：传输层的 endpoint 请求经由一个附加 bearer 的 fetch 发出；超过刷新期限的 token 会按授权引用在整个进程内单飞且串行地刷新，退出登录或已提交的授权会排在同一记录的刷新之后。没有可用授权时，连接停在新状态 `waiting-authorization`，原因为 `missing`、`expired`、`binding`、`rejected` 或 `scope`，保留最后成功的清单，且不消耗重连预算。工具与资源调用以 `McpLocalError` 失败，code 为 `MCP_AUTHORIZATION_REQUIRED`，消息为 `MCP OAuth requires authorization: <reason>`。被拒绝的请求在一次强制刷新后重试一次；再次 401 记为 `rejected`，403 `insufficient_scope` 记为 `scope`。瞬时失败仍走普通重连循环。探测会附带已存储的授权，否则把缺失授权报告为连接失败。
- **协议流程**（`packages/mcp/mcp-client/src/oauth-flow.ts`）：逐步组合 SDK 的离散函数（`discoverOAuthServerInfo`、`registerClient`、`startAuthorization`、`exchangeAuthorization`、`refreshAuthorization`、`extractWWWAuthenticateParams`）。每个 OAuth 请求都经由一个强制 HTTPS 或回环、单请求截止时间、不跟随重定向的 fetch 发出，且既不携带资源标头也不携带已存储的 token。动态注册的客户端在重定向 URI 不变时被复用；不再认识它的授权服务器会使记录失效。
- **显式授权**（`packages/mcp/mcp-user-config/src/authorization.ts`）：`startAuthorization`、`cancelAuthorization` 与 `signOut` 是位于 `harniverse.administer` 之后的 Remote 方法。每台服务器一次尝试，依次经过 `starting`、`waiting-browser`、`exchanging`、`committing`，然后结算为 `authorized`、`cancelled` 或 `failed`，受每次授权服务器请求的 `requestTimeoutMs` 与覆盖浏览器等待及令牌交换的 `authorizationTimeoutMs` 约束；再次 start 会加入等待中的尝试。状态行新增 `authorization`（状态与原因）和 `attempt`（id、阶段、截止时间），每次阶段变化都复用转发的 `mcpManagement/fleet-changed` 事件。
- **回调路由**：在尝试存续期间，于 `ctx.webServer` 上注册为精确的公开路由 `/mcp/oauth/callback/<服务器 id 的 sha256 十六进制>`。它只接受重定向 URI 自身的 authority，要求 GET，判定参数形状，以常量时间把一次性 `state` 与等待中的尝试比较，并以两张静态双语言页面之一应答，不回显任何请求值。失败只记录为安全的本地消息，绝不记录授权码、state 或 token。
- **重定向 origin**：默认取 web 监听器自身 origin 的回环形式。浏览器提供的 origin 仅在为回环，或为 HTTPS 且被连接的 `isTrustedWebOrigin` 接受时才被接受——即部署 `trustedHosts` 之上的 `/api` Host 围栏，见[入站认证规则](../../../../docs/subsystems/authentication.md)。该方法是在所属包之外唯一一处增量编辑。
- **UI**（[`dsh-client-ui-settings-mcp`](../../../../packages/client/ui-settings-mcp/README.md)）：服务器卡片展示授权状态，并提供授权、取消、退出登录，以及——在 Host 应答后——指向授权页面的普通链接；编辑器的 OAuth 小节承载客户端 id、scope 与两个超时。全部文案由 locale 拥有，含中文与英文。

架构保持 plugin-native：每项注册都是 Cordis effect，回调路由由其 effect disposer 释放，三个包仅经由连接句柄、带类型的 wire 行以及以结构化方式读取的可选服务（`credentials`、`webServer`、`connection`）彼此到达，因此无需新增包依赖，也无需更改 lockfile。

## 为何不使用 SDK 自带的 `authProvider` 编排

`StreamableHTTPClientTransport` 会在 401 与 403 时调用 SDK 的 `auth()` 编排器。该编排器按自己的节奏执行动态注册与浏览器重定向，把传输层的 `requestInit.headers` 转发给授权服务器 endpoint，并且会让被动连接注册客户端或重定向。因此会话在自己的 fetch 中附加 bearer，仅在显式流程中调用离散协议函数。上游 DeepSeek Harness 在 SDK v2 上得出了同样的划分，v2 的传输层改为暴露一个 token 钩子；其代码仅用于设计比较。

## 已知限制

- **局域网访问**：默认重定向 origin 是回环。另一台机器上的浏览器必须提供自己的 origin，而连接仅在该主机位于 `trustedHosts` 时接受它；随附的 CLI 会把机器的局域网 IP 字面量推导进该列表。
- **以名字访问 HTTPS**：以 `https://<name>` 访问的部署需要该名字位于 `trustedHosts`；否则回环默认值会产生一个证书不匹配的重定向 URI，浏览器无法完成回调。
- **拒绝回环或 IP 字面量重定向 URI 的授权服务器**无法在回环部署中使用；需要具名的 HTTPS 部署。
- **独立行**（`cordis.yml`）没有进程内授权路径；它们使用已存储在其 `serverName` 下的授权。
- **外部编辑**授权记录在连接等待期间不会被观察；连接在下一次挂载或 `resume()` 时重新判定授权。
- `McpOAuthCredentialStore` 位于 `src/types.ts`：`/types` 子路径在每个 Client 类型程序中都映射到源码，因此必须不含运行时导入，否则类型感知的 Client 检查会丢失 `Context` 合并。
- **被替换的连接会取消其尝试**：在浏览器仍打开时重新挂载 owner，会把尝试结算为 `cancelled`。

## 备选方案

- **传输层的 `authProvider` 加 SDK 的 `auth()` 编排器**——拒绝：它会隐式注册与重定向，而被动路径绝不能这样做；它还会把资源标头转发给授权服务器 endpoint。
- **独立的 OAuth 服务，或从 `dsh-mcp-client` 新增子路径导出**——拒绝：`verify-plugin-entry-exports` 只允许插件入口上的 Loader 字段与 `Service`/`Error` 类，新子路径需要根 `tsconfig.base.json` 的路径映射，且两者都没有第二个消费者。连接句柄本就跨越了包边界。
- **客户端注册与 token 分开存储**——拒绝：一份记录就是退出登录与绑定校验的一个单元；被服务器遗忘的注册会使授权随之失效。
- **让回调经由 `/api` 桥或 `authorizeHttpRequest`**——拒绝：授权服务器的重定向是跨站导航，信任围栏会拒绝它，而且浏览器会话 cookie 是 `SameSite=Strict`；一次性 state 才是认证应答的依据。
- **由卡片脚本化 `window.open`**——拒绝：Remote 调用会超出浏览器的用户激活窗口，弹窗会被拦截；卡片改为显示一个链接。
- **接受任意浏览器提供的 origin，或一概不接受**——拒绝：任意 origin 会让调用方把授权码送到自选主机；一概不接受会使局域网与具名部署不可用。
- **在 OAuth 请求上跟随同源重定向**——拒绝：被重定向的 token 或注册请求会把请求体带到元数据从未指明的目的地。

## 后果

- 缺失或被拒绝的授权成为一个一等、可解释的静息状态，而非静默的重试循环；模型与设置页都能看到原因。
- token 绝不会进入日志、状态行、事件或 UI：状态只承载状态、原因与过期时间，授权页面 URL 只返回给 `startAuthorization` 的调用方。
- 在重新生成之前，已生成的 Typert 产物以及 API、client、config 与 Cordis 目录都是过期的；Remote 方法已存在于源码中，而设置页对它们的接线只能在重新生成的 Remote 之上通过类型检查。
- 授权绑定其 endpoint 与选项，因此更改 `url`、`clientId` 或 `scope` 需要重新授权；比其连接存活更久的尝试会被取消，而非转移。

## 验证

- `packages/mcp/mcp-client/tests/` 下的 `oauth-config`、`oauth-flow` 与 `oauth-session` spec 以真实 SDK 客户端与 auth 函数驱动一个回环 fixture，后者提供受 bearer 保护的 MCP endpoint、protected-resource 与 authorization-server 元数据、注册、授权与 token endpoint：被动静息状态及其原因、单飞刷新、401 与 403 的恢复、退出登录、resume、绑定、探测、PKCE 注册、issuer 绑定、无元数据的服务器，以及传输规则。
- `packages/mcp/mcp-user-config/tests/authorization.spec.ts` 与 `oauth-settings.spec.ts` 覆盖 Remote 操作、回调路由（形状、state 重放、authority、方法、截止时间、取消、安全日志）、重定向 origin 校验、任何 owner 挂载前的设置拒绝，以及端到端授权一台机群服务器的真实组合。
- `packages/client/connection/tests/rpc-host.host.spec.ts` 覆盖 `isTrustedWebOrigin`；`packages/client/ui-settings-mcp/tests` 覆盖控制器、卡片、编辑器与 apply 接线。
- 每个被触及的源文件在聚焦运行下都满足逐文件 100% 覆盖率门禁。
