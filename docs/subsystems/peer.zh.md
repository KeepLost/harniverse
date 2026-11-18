# Peer

[English](peer.md) | 中文

实例配对(instance pairing)连接两个 Harniverse 家(home),使一个实例的模型此后可以在另一个实例上委派和消息会话,各自运行在自己的环境里。配对本身不交换任何任务数据:它建立的是一个已认证 principal、两条持久记录和一个经过身份核验的通道锚点。家是身份锚点——一个 `instance.json`、一把 P-256 签名密钥、一份会话语料——而独占家租约已经保证每个家同一时刻只有一个运行中的进程。

Service Definition:[dsh-peer-host](../../packages/peer/peer-host)(`ctx.peerHost` + `peer/*` Remote 命名空间与事件)。共享词汇与家锚定身份位于 [dsh-peer-protocol](../../packages/peer/peer-protocol);发起方编排与目标存储位于 [dsh-peer-client](../../packages/peer/peer-client);`dsh peer` 管理应用是 [dsh-peer-app](../../packages/bundle/peer-app)。设计理由见[实例配对 Agent Note](../../.agents/notes/implemented/feature/2026-11-18-peer-instance-pairing.md)。

源码:[`packages/peer/peer-protocol/src/types.ts`](../../packages/peer/peer-protocol/src/types.ts)、[`packages/peer/peer-protocol/src/payload.ts`](../../packages/peer/peer-protocol/src/payload.ts)和 [`packages/peer/peer-host/src/index.ts`](../../packages/peer/peer-host/src/index.ts)

## 配对流程

接受方实例的 owner 运行 `dsh peer invite --endpoint <origin>`,该命令在首次使用时铸造家的身份,签发一个一次性的、能力仅限 `harniverse.peer` 的 `dshi1_` enrollment 邀请,并打印一条单粘贴的 `dsh-peer:` URI,内含端点、目标身份、可选 TLS 指纹与令牌。发起方把 URI 粘贴给 `dsh peer add`:它以 `peer-<instanceId>` 的 Grant 名登记本家公钥,兑换邀请(持有即批准),用签名挑战换短时 Access Token,然后调用 `peer/hello`。目标以自身身份作答;若与邀请中声称的身份不符则配对中止,因此两条记录互相钉死对方的家身份。邀请令牌只用于引导,与持久的 Grant 凭据相互分离。

每个 `peer/*` Remote 都要求 `harniverse.peer` 能力;未配对的调用者不持有任何能力,所有调用 fail-closed。Grant 以 `api-client` 类别创建且只携带这一个能力,而确定性的 `peer-<instanceId>` 命名加上注册表的名字唯一性,使跨 peer 的名字抢占不可能:首次配对拥有该名字。

## 记录与身份

接受方实例在其家下的 `peers.json` 持久化已配对 peer;发起方在自己家下的 `peer-targets.json` 持久化目标。两个文件都是权威——`peer/paired` 与 `peer/removed` 事件是面向未来 UI 的活进程观察,不是持久状态。`peer remove` 删除记录并撤销对应 Grant;目标上的历史会话留在其自己的语料中。

```ts type-equiv
/** Paired-peer record persisted by the accepting instance. */
interface PeerRecord {
  /** The initiator's home-anchored identity, a minted lowercase UUID. */
  instanceId: PeerInstanceId
  displayName: string
  platform: string
  arch: string
  version: string
  /** Peer capability surface approved at pairing; each field gates one Remote family. */
  surface: PeerSurface
  /** How the peer was admitted; the shipped flow is always the invitation token. */
  pairedVia: 'invitation'
  status: 'active' | 'revoked'
  firstSeenAt: string
  lastSeenAt: string
}
```

```ts type-equiv
/** Peer capability surface approved at pairing; each field gates one Remote family. */
interface PeerSurface {
  /** The peer may start and continue delegated sessions on this instance. */
  delegate: boolean
  /** The peer may deliver messages into sessions it owns on this instance. */
  message: boolean
  /** The peer may enumerate sessions it owns on this instance. */
  list: boolean
}
```

```ts type-equiv
/** Stable identity of one Harness home: a minted UUID in canonical lowercase form, validated at every boundary. */
type PeerInstanceId = string
```

`peer/hello` Remote 携带发起方的自我声明身份并返回目标身份;两侧都校验共享边界(展示名 1–64 个非控制字符,platform/arch/version 字符串有界),并以[peer 词汇表](../../packages/peer/peer-protocol)的封闭错误码拒绝。

## 传输与排除

邀请端点是 HTTPS origin,或隧道后的环回 HTTP——与所有已认证 origin 的规则一致。`dsh peer add` 直接拨号端点,或经一条 remote-hosts SSH 记录(`--ssh-host`)转发到目标的环回端口;密钥文件与 agent 登录可无头使用,加密凭据引用不可以。VM 执行世界不组合 `peer-host` 行,且该服务拒绝来自 VM 家的 `peer/hello`,因此真沙箱实例永远不会加入配对网络。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpeerhost--peerhost"></a>

### `ctx.peerHost` — `PeerHost`

Peer acceptance service; the store file is the authority and events are live-process observations.

```ts cordis-catalog
/** Answer one authenticated peer's identity readback and commit its paired record.
 * @param identity - the initiator's self-asserted home identity.
 * @returns this instance's identity and the approved surface.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async hello(identity: PeerHelloInput): Promise<PeerHello>

/** Remove one paired-peer record and report the removed record's final state.
 * @param instanceId - exact instance id to remove.
 * @returns the removed record.
 * @throws a {@link PeerError} with `RECORD_NOT_FOUND` when no such peer is stored.
 */
async removePeer(instanceId: PeerInstanceId): Promise<PeerRecord>
```

Source: [`packages/peer/peer-host/src/index.ts:43`](../../packages/peer/peer-host/src/index.ts)

<a id="peer-events"></a>

### `peer/*` events

<a id="peerpaired--emit"></a>

#### `peer/paired` — emit

Emitted after one peer's first `peer/hello` appended its record.

```ts cordis-catalog
/**
 * Emitted after one peer's first `peer/hello` appended its record.
 * @mode emit
 * @param record - the committed paired-peer record.
 */
'peer/paired'(record: PeerRecord): void
```

Source: [`packages/peer/peer-host/src/index.ts:32`](../../packages/peer/peer-host/src/index.ts)

<a id="peerremoved--emit"></a>

#### `peer/removed` — emit

Emitted after one paired-peer record was removed from the store.

```ts cordis-catalog
/**
 * Emitted after one paired-peer record was removed from the store.
 * @mode emit
 * @param record - the removed record's final state.
 */
'peer/removed'(record: PeerRecord): void
```

Source: [`packages/peer/peer-host/src/index.ts:38`](../../packages/peer/peer-host/src/index.ts)
<!-- END GENERATED cordis-surface -->
