# Agent Note: 业务接入从不对未知凭据限速

Status: implemented

[English](2026-10-26-restart-admission-lockout.md) | 中文

## Problem

某运维方的服务器因一次无关的内存耗尽被强制重启。重启后，已配对设备先持续收到 `invalid-credential`，随后变为 `rate-limited`，任何浏览器都无法进入；再次重启只会重演这次封锁。

该事故可用真实的 `dsh web` 组合复现：两台已配对设备共开五个标签页，以 SIGKILL 杀掉 Host，再在同一 home 上重新启动。十秒内，各标签页的重连在 `http-api` 通道上从 `127.0.0.1` 出示了十个未知的浏览器会话 Cookie，达到默认 `authFailureLimit` 10。provider 随即按 `authFailureBlockMs`（5 分钟）封锁该通道与 peer。每个标签页此时已完成一次新的签名交换并持有有效 Cookie，但封锁检查先于凭据校验，于是 207 个有效请求被拒，直到重启约 5 分 20 秒后封锁自然解除。同一地址后的所有设备共用这个桶，每次重启都会重演。

三处缺陷叠加：

- 接入把未知的浏览器会话和 Access Token 当作猜测来计数。两者都只存在于进程内存，重启会让上一进程签发的所有值同时变为未知；仅四个标签页的重连流量就会超过上限。两者都是服务端签发的 256 位秘密，计数起不到任何保护作用。该计数器源自[入站网络认证 Note](../../archived/feature/2026-08-16-inbound-network-authentication.md)，当时凭据是运维方手工输入的具名 token；公钥 Grant 重构已从接入路径移除所有可猜测的秘密，计数器却保留了下来。
- 封锁检查先于校验，因此有效凭据与无效凭据一同被拒。
- `/auth/status` 把被限速的检查报告为 `200` 且 `authenticated: false`，页面因此把它当成失效 Cookie 并再发起一次签名交换，状态图标也只显示重连中。

## Decision

`LocalAuthentication.authenticate()` 不再计数失败，也不施加封锁。未知、格式错误或过期的浏览器会话或 Access Token 一律为 `invalid-credential`；有效凭据无论其 peer 之前出示过什么都会被接受。

失败限速器（`authFailureLimit`、`authFailureWindowMs`、`authFailureBlockMs`、`maxAuthFailureKeys`）只覆盖两种校验可猜测输入的操作：无效的浏览器登录证明，键为 `browser-login:<peer>`；无效的邀请口令兑换，键为 `invitation-redeem:<peer>`。配置键与默认值不变，其文档写明了这一范围。

`/auth/status` 对 `rate-limited` 接入决策返回 `429`、`Retry-After` 和 `no-store`，与 connection Consumer 的其他路由一致。本地 provider 已不再为接入产生该决策，但 Service Definition 仍允许它，因此状态路由不得把它转译为「未认证」。浏览器的 `check()` 遇到非 OK 状态时抛出错误，而不是发起交换。

## Alternatives considered

**先校验，再查询封锁。** 有效凭据会被接受，但封锁期间无效凭据仍会从 401 变为 429。这没有任何安全收益，因为 256 位的值无论如何都猜不中，而计数器仍会是每次重启都会触发的警报。

**提高默认上限。** 重连流量随打开的标签页数以及同一地址后的设备数增长，合法部署可以达到任何固定阈值，而不可猜测的值根本不需要阈值。

**跨重启持久化浏览器会话。** 沿用原 Note 的理由否决：这会新增一种携带秘密的持久格式，而签名重新交换已能在数秒内恢复接入。

**按转发的客户端地址作为限速键。** 可信代理处理仍不在范围内，按客户端拆桶也无法消除误报。

## Consequences

- Host 重启让每个标签页付出一次签名交换的代价；同一地址后所有设备的所有标签页都会在数秒内恢复。
- 针对业务接入的猜测毫无收益。Access Token 秘密与浏览器会话各含 256 个随机位，未知值直接在进程内存中被拒，不读取注册表，因此无限次无效接入除了每个请求本就写入的访问记录外不增加任何开销。
- 浏览器登录证明（对一次性 challenge 的 ECDSA P-256 签名）和邀请口令保留按 peer 的限速器。重连流量永远不会到达该限速器，因此重启无法触发它。
- 为应对本次事故而调高 `authFailureLimit` 的运维方应在升级后移除该覆盖；它现在只会削弱登录与兑换的限速。

## Testing

- `packages/auth/authentication-local/tests/runtime.spec.ts`：在 `authFailureLimit: 2` 下，同一 peer 在全部三个通道上出示十二个未知 bearer 与会话值，每个都是 `invalid-credential`；随后同一 peer 新交换得到的浏览器会话与 Access Token 均被接受。改动前第三个值就已是 `rate-limited`。该测试替换了原先锁定 bearer 封锁行为的测试。
- `packages/auth/authentication-local/tests/failure-containment.spec.ts`：窗口过期与键表上限测试改由无效浏览器登录证明驱动。
- `packages/client/connection/tests/browser-auth-routes.host.spec.ts`：`/auth/status` 对被限速的决策返回 `429`、`Retry-After: 3` 和 `no-store`。
- `apps/web/tests/authentication-restart.e2e.ts`：在 `authFailureLimit: 2` 的认证 Web 组合中，两台 Chromium 设备各配对两个标签页，关闭 Host 后在同一 home 与端口上重新启动。每个标签页都回到 "Connected; authentication is valid"，重启后的访问日志中 `invalid-credential` 记录多于上限且没有任何 `rate-limited` 记录。改动前同一运行有 64 个请求被以 `rate-limited` 拒绝，45 秒内没有任何标签页恢复。
