# Agent Note: 授权感知的 Settings 镜像与 principal fence 一元传输

Status: implemented

[English](2026-08-24-authorization-aware-settings-mirror.md) | 中文

## 问题

浏览器中的 Settings 消费方需要同一份 Host 描述：已暴露的 namespace、脱敏后的分层值、schema、revision、可写性和本地文档可用性。独立调用 `settings.describe` 会重复传输这份承载配置的响应，还会让每个消费方各自实现 pending read、失效、故障和陈旧 settlement 策略。注册、能力 assembly、适配器、凭据或 Profile topology 发生变化时，一个界面可能已经更新，另一个界面却仍保留旧 namespace 集合。

一元请求跨越 wire 期间，认证也可能改变。浏览器 Cookie 在 settlement 时可能解析到不同的 Grant revision，而旧响应到达前，重连也可能已经建立新的 principal。仅靠客户端 freshness counter 无法阻止 Host 在不同于发起方的 principal 下 dispatch mutation；接受旧 settings 或 credential 响应，还可能把一个 principal 获准读取的配置状态泄露到另一个 principal 的页面。模型发现也属于这条边界，因为其草稿可能携带 API key，并要求 Host 探测由调用方选择的 endpoint。

## 决策

`dsh-client-ui-settings` 为已认证连接拥有唯一的 `SettingsDescribeMirror`，并通过 `ctx.settingsScope.describe()` 暴露它。每个 namespace scope 和完整 Settings 界面都从这份共享 Host 响应派生，而不再发起另一项描述读取。该镜像只是已获授权答案的缓存，不是授权权威：Host 仍负责选择暴露的 namespace、脱敏 secret-role 字段、报告可写性，并强制执行每项读写。

传输把每个已准入 principal 投影为 `AuthenticationPrincipalIdentity`：`{ kind: 'bypass' }`，或 `{ kind: 'grant', grantId, grantRevision }`。Grant name、capability、过期时间、浏览器 session material 和 access credential 都不会进入该身份。Grant id 加 revision 标识精确的授权 generation；bypass 则是[公钥 Grant 认证决策](2026-08-17-public-key-grant-authentication.md)确立的、显式且仅限回环的准入身份。Inline-safe API wire 层拥有这份投影的结构比较；browser-safe connection 与 Fetch carrier 代码只导入该身份类型，不会把认证插件运行时值引入 client bundle。

## 共享镜像与写入折叠

镜像会在发布 `loading` 之前占有唯一的 pending `settings.describe`。所有重叠的 load 或失效都标记一次 rerun，并加入该 pending promise；settlement 在释放槽位前至多执行这一次 rerun。这样既限制并发读取，又不会丢失读取进行期间提出的 freshness 请求。首次成功前发生普通故障时，镜像回到 `idle`；成功后的故障则保留最后一份有效 view，并记录诊断。

`settings/document-updated` 和 `settings/exposure-changed` 会刷新镜像。Settings 注册或描述发生变化时，包括 Profile 拥有的 settings topology，Host 会发出 exposure 事件；能力 assembly 或 LLM 适配器 topology 变化时也会发出该事件。Models Settings 还会在 credential、adapter 和 exposure 失效后重新 join credential 与 provider-directory 状态。认证身份变化不等待这些事件：connection source 会同步撤回旧身份，镜像立即清除 view 和 error，推进 principal 与 read generation，把 pending read 标记为需要 rerun，并且只在另一个身份可用后启动新读取。

Namespace 写入仍按 scope 串行化，并以 `expectedRevision` 携带最新已知 namespace revision。成功的 `settings.mutate` 返回经过 Host 脱敏的 namespace view；scope 将该 view 折叠进共享镜像、推进 read generation，并在描述读取已 pending 时请求一次 rerun。队列中较早的写入 settlement 只推进供下一项排队操作使用的私有 revision；只有最后一项写入会发布。最后一项写入失败或被拒绝时，会重新加载权威描述。折叠绝不会从脱敏数据重建完整 user section，因此按 path 寻址的编辑不会清除浏览器无法读取的 secret 字段。

## Principal fence 一元传输

每份 Host 一元响应都携带已准入的 `AuthenticationPrincipalIdentity`。两条事件流也会在业务 frame 之前以相同身份开始。只有 `host.describe`、mux stream 与 Host stream 对同一身份达成一致后，connection generation 才可使用；任何不一致都会使该 generation 失败。之后的一元 settlement 必须同时匹配发起时捕获的身份与当前已发布的 connection 身份。

如果旧一元调用在较新的 principal 已发布后才 settlement，客户端会拒绝该陈旧 settlement，而不会撤回较新的 principal。由当前 principal 发起的调用若在 settlement 中缺失身份或身份不匹配，则会同步撤回当前 generation，并进入普通重连路径。Settings 镜像还会以自己的 principal-generation fence 包围读取、写入和响应折叠，因此即使 fixture 或直接消费方也无法在 principal 边界移动后发布异步 settlement 的值。

每个一元方法都分类为 `read` 或 `mutate`。`AbstractApiClient` 会把当前身份捕获进每个 mutating `ClientRequest` 的 `expectedPrincipal`，也会把它加入经 `respond` 发送的每个 `ClientResponse`。Host 在 dispatch 业务操作前比较该前置条件与本请求准入的 principal，不一致时返回 `authentication-principal-mismatch`。`llm.discoverModels` 虽不持久化状态，仍被有意分类为 mutation 以应用该 fence：它可能携带草稿 API key，并触发 Host 侧网络探测。读取省略 `expectedPrincipal`，因为其响应身份会在发布前校验，且没有需要 fence 的 Host 副作用。

## Settings 草稿生命周期

镜像的 principal generation 变化时，从 Settings 派生的 store 会同步清除。Namespace scope 会丢弃 value、base 与 user layer、revision 和 writability，直到新的授权描述 settlement。Models Settings store 还会推进公开的 `principalGeneration`；section 以该值作为完整本地状态子树的 key，从而 remount editor，并在新 principal 数据可以渲染前清除 provider 草稿、已输入凭据、endpoint probe、confirmation 和 pending notice。旧异步 callback 在改变 UI 状态前会检查同一 fence。

这种清除有意强于普通刷新行为。同一未变 principal 下的瞬时读取故障可以保留最后一份有效 view，但认证变化绝不会保留前一个 principal 的 Settings 值或草稿。

## 安全边界

浏览器镜像及其 fence 属于纵深防御，而不是权限检查。API Proxy 将 `settings.describe`、Settings 写入、credential 操作和携带 secret 的 discovery 归入 `harniverse.administer`；已认证 gateway 会拒绝缺少该 capability 的调用方。显式 Settings exposure allowlist 仍窄于 Settings registry，注册 namespace 不会使其自动变为远程可读写。这些规则扩展[配置平面边界](2026-07-30-config-plane-boundaries.md)，而不取代它。

所有 Settings 响应都采用 `describe({ redactSecrets: true })` 语义。Secret 值绝不会进入响应；descriptor 只揭示 write-only secret path，以及每项 secret 是否已配置。新输入的 credential 只能进入其预期的出站 credential、Settings 或 discovery 请求，而 principal 前置条件会在 dispatch 前强制执行。Envelope 上的非 secret 身份不能用作 capability claim，客户端代码也绝不会从中派生授权。

## 考虑过的替代方案

**为每个 Settings 消费方保留一份描述 controller。** 已拒绝，因为每个 controller 都会重复同一授权 payload，并分别实现失效顺序、pending-read collapse、陈旧响应 fence 和写入收敛。由 provider 拥有的镜像为所有消费方提供同一答案和生命周期，同时 namespace schema 与产品 policy 仍由领域拥有。

**只在浏览器中设置 fence。** 已拒绝，因为抑制陈旧 UI settlement 无法阻止 Cookie 或浏览器 session 已解析为另一 principal 后执行 mutation。Host 必须在业务 dispatch 前比较发起身份；即使该强制执行已经成功或 settlement 的是读取，浏览器 generation 检查仍需要阻止陈旧发布。

**认证变化时中止所有 pending 操作。** 作为唯一机制时已拒绝，因为 cancellation 可能与 Host dispatch 竞态，也无法证明响应由当前 Grant revision 产生。即使 carrier 不能及时取消，身份比较也能关闭该竞态；abort 只是生命周期优化，不是 authority。

**以 capability、Grant name 或 credential 作为 settlement 身份。** 已拒绝，因为 capability 是授权 claim 而非稳定身份，name 是可变 display data，credential 则是 secret 且生命周期短。Grant id 加 revision 可以命名精确的持久授权 generation，又不暴露这些字段；bypass 只需要其显式 kind。

**读取也要求 `expectedPrincipal`。** 已拒绝，因为 principal 已变化的读取无法修改 Host 状态，而且每份响应都已携带必须在发布前匹配的身份。Dispatch 前 fence 只用于具有 Host effect 的操作，其中包括携带 secret 的 endpoint discovery。

## 后果

Settings 消费方共享一项有界读取，并能立即收敛成功写入，同时保留 Host authority、显式 exposure、脱敏和 revision conflict。失效突发可能合并中间 revision，但一次 rerun 会观察最新 Host 状态。共享镜像也使读取故障在 Settings 界面之间保持一致，而不是让某个界面通过私有重试显得更为新鲜。

每个一元 carrier 与 stream handshake 都会携带非 secret principal identity metadata，而且每个新增一元方法都必须得到正确的 read/mutate 分类。Mutation 作者获得统一的 dispatch 前 fence；若把 Host effect 错分为 read，就会省略该 fence，因此这是安全敏感的协议错误。认证变化会有意丢弃未保存的 Settings 草稿，所以重新认证后，用户可能需要重新输入 provider endpoint 或 API key；保留这些草稿会跨越 principal 边界。

Connection 与 API Proxy 的 focused test 固定 unary/stream 身份一致、当前 principal mismatch 失效、拒绝陈旧 settlement 且不使较新 principal 失效、dispatch 前 mutation 拒绝、`respond` 和携带 secret 的 discovery。Settings mirror、integration、namespace-scope、Models、permission 和 Agent Profile 客户端测试固定一个 pending read 加一次 rerun、写入折叠与恢复、exposure 失效、principal reset、同步 draft remount，以及陈旧异步 settlement containment。
