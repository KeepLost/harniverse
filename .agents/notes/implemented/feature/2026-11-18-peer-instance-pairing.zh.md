# Agent Note: Harniverse 家之间的实例配对

Status: implemented

[English](2026-11-18-peer-instance-pairing.md) | 中文

## 问题

两个 Harniverse 实例无法协作:remote-hosts 栈部署的是被锁定、受 ownerless-exit 约束的镜像,而非配对用户自己运行中的实例;两个家之间不存在已认证 principal、记录或通道。配对不得削弱入站认证,必须在重启后存活,且绝不能接入真沙箱(VM)实例。

## 决策


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

## 备选方案

按 remote-hosts 模式为每个 peer 部署专用镜像被否决:它拥有目标凭据且在发起方离开时退出,与"配对两个独立持有的实例"相悖。为 peer 扩展浏览器 enrollment 元数据也被否决,理由与 grant 类别映射的存在相同:注册表已建模 API client,新类别只会重复。把调用方 Grant 密码学地绑进 peer 记录则等待 Remote 边界的 principal 可见性;确定性的 `peer-<instanceId>` 命名加注册表名字唯一性今天即可达到同等完整性。

## 后果

Grant 类别映射、能力词表、typert 装载器列表、desktop Grant 校验器与覆盖 lane 各自新增了配对条目;未来每个新能力或 enrollment 类别都必须同步这五处镜像。hello 记录信任"邀请持有 + 注册表名字唯一性"而非密码学调用方绑定——今天的 Remote 边界表达不了它;委派与消息 Remote 在下一个里程碑交付其 durable 发件箱之前保持不挂载。
