# Harniverse 家之间的实例配对

[English](2026-11-18-peer-instance-pairing.md) | 中文

- 日期:2026-11-18
- 类别:feature
- 范围:packages/peer/*、packages/bundle/peer-app、入站认证 enrollment 类别、`dsh peer` 启动器别名

## 决策

两个 Harniverse 实例以家对家方式配对。家锚定身份:`instance.json` 为每个家铸造一个小写 UUID id(绝不重铸),发起方以 `peers/identity.pem` 下的一把 P-256 密钥签名,而独占家租约已保证每家一个进程。配对原样复用入站认证注册表:`dsh peer invite` 签发一次性的、属于新 `peer` enrollment 类别的 `dshi1_` 邀请,能力限定为新的正交能力 `harniverse.peer`;`dsh peer add` 以确定性的 `peer-<instanceId>` 名登记、兑换邀请(持有即批准)、交换挑战并调用 `peer/hello`。Grant 以 `api-client` 类别创建,且只携带这一个能力。两侧互相钉死对方实例 id:邀请声称目标的 id,回读不符则以 `IDENTITY_MISMATCH` 中止。

放弃的东西:把调用方 Grant 密码学地绑进 peer 记录。Typert Remote 边界不向服务方法暴露已认证 principal,因此记录信任"邀请持有 + 注册表名字唯一性"(首个 `peer-<id>` 登记拥有该名字;第二把密钥无法抢占)。绑定调用密钥的挑战签名 hello 等待边界上的 principal 可见性。

## 为什么家锚定配对

remote-hosts 栈已经能按 SSH 主机部署并驱动一个无头镜像实例,但那个实例被锁定、被拥有、且受 ownerless-exit 约束——是镜像而非对等体。配对转而面向用户自己运行中的实例:不部署、不同步凭据、没有镜像语义。两侧各自保留模型凭据与设置;跨越边界的只有配对事实。传输刻意不锁死 SSH:邀请端点是 HTTPS 或环回 HTTP,`--ssh-host` 只是复用 remote-hosts 注册表与传输的一种拨号方式,且仅支持密钥文件与 agent 登录。

Fail-closed 规则:每个 `peer/*` Remote 都要求 `harniverse.peer`;VM 执行世界不组合 `peer-host` 行(`$DSH_EXEC_WORLD === 'vm'` 禁用该条目),服务额外拒绝来自 VM 家的 hello;邀请要求已存在 owner grant(引导规则);邀请令牌只用于引导,与持久 Grant 凭据分离。

## 面

- 新包:`dsh-peer-protocol`(词汇、编解码、身份)、`dsh-peer-host`(`ctx.peerHost`、`peer/hello`、`peers.json`、`peer/paired`/`peer/removed` 事件)、`dsh-peer-client`(签名身份、`peer-targets.json`、配对编排)、`dsh-peer-app`(`dsh peer invite|add|list|remove|targets|forget`)。
- 认证增量:`harniverse.peer` 能力;`peer` enrollment 类别兑换为 `api-client` grant;enrollment 路由接受该类别。
- 组合:web-app bundle 中的 `peer-host`;`peer` 内置 profile 与启动器别名;CLI 依赖。

## 必需验证

- Loader 组合的真实 HTTP 端到端配对(登记、兑换、交换、hello、两侧存储)见 `packages/peer/peer-client/tests/pairing.spec.ts`,CLI 级往返见 `packages/bundle/peer-app/tests/peer-app.spec.ts`。
- 封闭原因拒绝:已消费邀请、篡改身份、不可达 origin、VM 守卫、已撤销 peer、畸形存储与载荷。
- Provider 侧的邀请类别路径(`invitation-runtime.spec.ts`)与能力词表断言。
- `pnpm run build` 重新生成 `peer/hello` 的严格 Remote 契约;`packages/peer/peer-host/tests/typert.spec.ts` 执行生成的 schema。
