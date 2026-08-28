# Agent Note: 公钥 Grant 认证与端点 capability

Status: implemented

[English](2026-08-17-public-key-grant-authentication.md) | 中文

## Problem

长期具名 bearer 凭据把所有调用方作为同一个逻辑用户接入。HTTP 认证在 RPC 分发前丢弃已接受身份，Typert Remote endpoint 没有授权元数据，而 legacy method 的硬编码例外会在操作迁移到 Typert 时被绕过。远程手机、临时公用电脑和自动化程序还需要不同持久方式，不能在每个客户端放置同一个可重复使用的 bearer secret。

## Decision

`dsh-authentication` 将 `AuthenticationPrincipal` 贯穿 HTTP、legacy API Proxy、Typert Gateway 和 WebSocket 请求。Grant principal 包含精确 Grant id 与 revision、过期时间和 capability。封闭 capability 为 `harniverse.observe`、`harniverse.operate`、`harniverse.administer` 和 `harniverse.authorize`；profile 只是管理便利，不是授权输入。`authorize` 与 administration 保持独立；`operate` 包含 agent 执行，而所选 preset 可能暴露 shell 和文件系统影响。

每个网络操作声明一个 capability。`RpcMethodMap` 拥有编译器完备的 legacy capability map。Typert decorator 强制 capability option，generator 将其发射，Loader 和 registry validation 拒绝遗漏或未知值，strict 或 source-runtime Gateway claim 将相同 policy 暴露给 Connection。Connection 在选择 handler 前解析 policy；未知、撤回、有歧义或未分类 endpoint 即使在回环也会被拒绝。显式回环 bypass 获得全部已知 capability，但不会绕过 endpoint 识别。

认证使用固定的 `Enrollment -> Grant -> Access` 生命周期。Enrollment 是短期待处理公钥请求，不授予 API access。本地 Provider 对未过期待处理记录设置全局上限，并按直连 peer 限制创建尝试。Owner 批准后在 `$DSH_HOME/auth/grants.json` 创建持久 P-256 Grant，并为浏览器提供新的有界批准回执窗口，因此临近 pending 截止的批准仍可被观察。一次性 challenge 绑定 instance id、Grant revision、用途、nonce、签发时间和过期时间；客户端提交 IEEE-P1363 ECDSA/SHA-256 proof。成功交换产生短期进程内 Access Token 或 HttpOnly 浏览器会话。Access 凭据不能自行续期，不会超过 Grant capability，并在进程重启时消失。配置把 Access 与浏览器凭据上限固定为 15 分钟、challenge 上限固定为 5 分钟、pending 或 approved enrollment 轮询上限固定为 15 分钟。

个人浏览器在 IndexedDB 保存不可导出的 WebCrypto 私钥，并通过再次签署 challenge 续期短期会话，包括携带仍有效 Cookie 的页面刷新。续期在半生命周期启动，每次签名交换最多等待十秒；瞬时失败会按有上限的指数退避重试，即使先前 Cookie 已过期也不停止；窗口聚焦、标签页恢复可见或网络恢复时会唤醒已到期工作。只有有效认证 Cookie 却没有可续期个人设备密钥时，普通应用不会被放行。该生命周期仍可取消：logout 会中止并排空已启动的交换，再清除交换可能产生的 Cookie。临时公用设备密钥只留在内存；对应 Grant 不含 `authorize`，最长 60 分钟，空闲超时 15 分钟。签发凭据采用配置截止、Grant 绝对截止和 Grant 空闲截止中的最早者，因此已打开的 WebSocket 不能超过临时 authority。API client 通过本地 `dsh auth client add` 注册 P-256 公钥；`GrantAccess` 合并签名交换、在 `clear()` 时使进行中的发布失效、保留 `Request` 语义，并续期短期凭据。Owner 可以签发最长 15 分钟、不可续期、使用显式 capability 子集且不含 `authorize` 的应急 token。

`dsh-authentication-local` 保留每个 home 唯一网络实例 lease、强制的隐私最小访问日志、按 peer 和 Grant 限制的有界 rate/capacity、原子 private-file 写入、watch 加周期 reconciliation，以及 fail-closed 行为。并发接入按一个 event-loop 批次串行处理，共享一次持久 registry 读取和批量访问日志操作，同时每个请求仍保留独立校验、决策与 JSONL 记录；批次审计持久化前，已接受调用方仍会被阻塞。精确 Grant 撤销会清除对应 challenge、Access Token、浏览器会话和 WebSocket；socket 也会在 principal 过期时关闭。Connection 拥有 Cookie 解析，只把选中的不透明浏览器会话值传给 Provider。非预期 RPC 实现故障在 server 侧记录，并向远程调用方返回稳定通用消息。浏览器 Host/Origin/Fetch-Metadata 信任 fence 保持独立，bypass 仍仅限回环，非回环 Web 服务仍要求 TLS。

Authenticated Web 可以在没有 Grant 时以 sealed 状态启动。静态 shell 可以在浏览器插件加载前创建 enrollment；插件 bundle、插件 topology SSE、业务 HTTP 和事件 WebSocket 都要求经过认证且 principal 具有各自声明的 capability。本地 `dsh auth device approve <request-id> --profile owner` 引导第一个活跃 Grant，而且实例必须仍有 owner 才会解除 sealed。最后一个活跃 owner 消失时会清除进程凭据、拒绝业务接入并关闭事件 socket，直到 reconciliation 发现新的活跃 owner。后续 owner 浏览器通过 `/auth/manage` 批准、撤销和签发应急凭据。独立 auth profile 不挂载网络 Provider 或 WebServer。

硬切换拒绝 `$DSH_HOME/auth/tokens.json`。系统不提供迁移、长期 bearer 兼容或递归 token minting 层级。本决策完全取代已归档的具名 token [入站网络认证决策](../../archived/feature/2026-08-16-inbound-network-authentication.md)，同时保留其 trust fence、TLS、lease、访问日志和 fail-closed 要求。

## Alternatives considered

**持久 bearer refresh token。** 拒绝，因为只靠 possession 的凭据从个人或公用设备复制后仍然有效。持久 server record 加私钥 proof 可以定向撤销，而不保存可重复使用的续期 secret。

**递归 token 层级。** 拒绝，因为能够 mint 等价凭据的凭据会混淆 enrollment、批准和使用。三个固定阶段使每种 authority 和生命周期明确。

**保留一个 privileged method 例外列表。** 拒绝，因为 transport 迁移会改变 dispatcher，并可能静默跳过仅作用于 legacy 的列表。强制 endpoint 元数据和默认拒绝把授权放在该选择之前。

**引入动态 authorization Service。** 拒绝，因为当前 policy 是确定性的 principal claim 加一个 endpoint requirement。当前没有需要该 Service 的 restriction 或 policy backend，增加它只会引入额外运行时 topology。

## Consequences

远程入侵被短期凭据以及持久 Grant 的 capability 和生命周期约束，但活跃的 `operate` principal 仍可通过启用 shell 的 preset 获得代码执行能力。公用机器无法变得可信；内存密钥和临时 Grant 只会降低离开后的持久性。

所有新增 endpoint 都必须分类其影响，所有 Typert 声明都必须携带 capability 元数据。未来端点、preset 或 workspace 级 restriction 可以扩展 Grant policy，而不改变四个影响类别。组装后的 keyless Web 测试证明 enrollment 批准和签名交换之前不会加载任何插件 bundle；聚焦测试固定 challenge replay 拒绝、精确撤销、过期、capability 拒绝、临时限制、SDK 续期、审计回滚和 sealed 启动。
