# Peer

[English](peer.md) | 中文

实例配对(instance pairing)连接两个 Harniverse 家(home),使一个实例的模型此后可以在另一个实例上委派和消息会话,各自运行在自己的环境里。配对本身不交换任何任务数据:它建立的是一个已认证 principal、两条持久记录和一个经过身份核验的通道锚点。家是身份锚点——一个 `instance.json`、一把 P-256 签名密钥、一份会话语料——而独占家租约已经保证每个家同一时刻只有一个运行中的进程。

Service Definition:[dsh-peer-host](../../packages/peer/peer-host)(`ctx.peerHost` + `peer/*` Remote 命名空间与事件)。共享词汇与家锚定身份位于 [dsh-peer-protocol](../../packages/peer/peer-protocol);发起方编排、目标存储与共享传输拨号位于 [dsh-peer-client](../../packages/peer/peer-client);面向模型的 `peer` 工具是 [dsh-tool-peer](../../packages/peer/tool-peer);`dsh peer` 管理应用是 [dsh-peer-app](../../packages/bundle/peer-app)。设计理由见[实例配对 Agent Note](../../.agents/notes/implemented/feature/2026-11-18-peer-instance-pairing.md)。模型侧工具的决策见[peer 工具 Agent Note](../../.agents/notes/implemented/feature/2026-11-19-peer-tool.md)。

源码:[`packages/peer/peer-protocol/src/types.ts`](../../packages/peer/peer-protocol/src/types.ts)、[`packages/peer/peer-protocol/src/payload.ts`](../../packages/peer/peer-protocol/src/payload.ts)、[`packages/peer/peer-protocol/src/proof.ts`](../../packages/peer/peer-protocol/src/proof.ts)、[`packages/peer/peer-host/src/index.ts`](../../packages/peer/peer-host/src/index.ts)和 [`packages/peer/peer-host/src/delegate.ts`](../../packages/peer/peer-host/src/delegate.ts)

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
  /** Base64url SPKI pinned at the first proof-bearing hello; absent only in pre-proof records. */
  identityPublicKey?: string
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

```ts type-equiv
/** Timestamp-windowed signature authenticating one peer Remote request. */
interface PeerRequestProof {
  /** The caller's home-anchored identity; resolves the pinned record. */
  instanceId: PeerInstanceId
  /** Claim time in epoch milliseconds; the host rejects values outside the skew window. */
  timestamp: number
  /** Single-use nonce minted per request; the host rejects any replayed nonce inside the skew window. */
  nonce: string
  /** Base64url IEEE-P1363 ECDSA/SHA-256 signature over the canonical request message. */
  signature: string
}
```

```ts type-equiv
/** Result of one delegate or follow-up call. */
interface PeerRunResult {
  /** Session id that owns the turn; safe to reference in later calls. */
  sessionId: string
  /** Accepted prompt message id. */
  messageId: string
  /** Whether the turn settled within the budget. */
  state: PeerRunState
  /** Concatenated assistant text of the turn, present once settled. */
  reply?: string
  /** Why the turn ended, present once settled; `completed` names success. */
  endReason?: string
}
```

`peer/hello` Remote 携带发起方的自我声明身份并返回目标身份;两侧都校验共享边界(展示名 1–64 个非控制字符,platform/arch/version 字符串有界),并以[peer 词汇表](../../packages/peer/peer-protocol)的封闭错误码拒绝。

## 委派

`peer/delegate`、`peer/followup` 与 `peer/sessions` 在接受方实例上为已配对的发起方运行真实会话。每个请求都携带由钉住身份密钥签名、带时间窗的请求证明；host 先由证明解析调用方记录、再检查对应的 surface 字段，因此 peer 只能触达自己的会话。`peer/delegate` 组建一个 `origin: 'peer'` 会话，工作目录解析在 `peer-work/<instanceId>/` 之下（仅允许相对路径），并把提示词经 agent 收件箱投递；结算从会话自身的事件窗口观察，返回拼接的助手文本与结束原因，超预算则返回 `state: 'running'`。`peer/followup` 以同样方式投递下一个 FIFO 回合，agent 不在位时冷恢复会话；`peer/sessions` 列出调用方的注册表条目及推导的 `running`/`idle`/`ended` 状态。`origin: 'peer'` 的会话不出现在任何面向用户的会话列表里，只能经 peer Remote 触达。

移除 peer 会删除其会话注册表条目，并在真空闲时关闭其常驻 agent；发起方的 `dsh peer run/send/sessions` 按存储的传输解析目标——direct 端点原样拨号，`ssh` 传输在调用存活期内转发到目标的环回端口。

发起方的模型经一方工具 `peer`([dsh-tool-peer](../../packages/peer/tool-peer))触达同一通道:它按显示名或 instance id 解析已配对目标,在有界结算预算内经 `peer/delegate` 或 `peer/followup` 投递提示词,并渲染点名 session id 的结算回复;超预算仍在运行的回合返回续查引导而不是阻塞。该工具不新增任何可达性——它只拨号 home 属主配对的目标,接受方的 surface 字段仍门控每个 Remote 族。

`peer/result` 是只读的结算伴侣:它从活跃会话日志——冷会话则从持久化事件——重新推导一个已拥有轮次的终态、回复与结束原因,不投递新提示,回合仍未结算时回答 `state: 'running'`。它门控在 `list` surface 上,存在的意义是让结算读取永远不需要一次多余的模型回合。`peer/cancel`(`delegate` 面)补上发起方的取消闭环:以 user 原因中止一个自有且常驻会话的当前回合并返回其终态——空闲会话原样报告最新声明的结算,无常驻 agent 的会话应答 `SESSION_NOT_FOUND`,取消因此从不捏造工作。

现在每份请求证明都携带一枚被签名覆盖的单次 nonce:宿主在首次使用时消费该 nonce,并拒绝偏差窗口内的任何重放,关上了纯时间窗证明留下的 ±90 秒抓包重放窗。

## 结算台账

委派是双方在线的契约:目标不可达立即失败,发起方结算台账([dsh-peer-outbox](../../packages/peer/peer-outbox),`ctx.peerOutbox`,web-app 组合)从不排队未投递的工作。它只跟踪已被在线目标接受、但超出工具预算的轮次:工具把这样的轮次持久登记,实例内的常驻监视器按轮询间隔经 `peer/result` 读取其结算。瞬时传输故障恰好获得**同刻复探一次**;第二次故障即终态失败条目(`TARGET_UNREACHABLE`)——台账不等待任何人。结算的轮次在空闲维护阶段以一条 `peer` 来源的排队 user 消息把截断回复投回发起会话,同会话按提交顺序投递;会话不再活跃则以 `OWNER_SESSION_NOT_LIVE` 失败并保留回复供 `dsh peer outbox` 查看。台账是持久存储,实例重启后由下一次轮询恢复全部跟踪。终态条目有保留上限,`dsh peer run/send --async` 以最小预算提交并打印 `dsh peer result` 可回读的回执;`dsh peer cancel` 在目标上中止运行中的回合,其条目经同一通道结算。

## 事件流

`peer/subscribe`(证明鉴权、`list` 门控)铸出一枚单次流令牌;精确路由 `GET /api/peer/events?token=…`——由 `peer-host` 在组合了 web server 时注册,优先于共享的 `/api` 前缀——为每条订阅服务一个 `text/event-stream`。流为该 peer 自有会话的每个 `turn/end` 推送一帧 `{"kind":"settled","sessionId"}`,并按固定节拍发送心跳注释;令牌即该路由的全部鉴权,因此每次重连都先过一枚带新 nonce 的证明。通道被有意设计为单向且仅作提示:帧是唤起立即结算读取的信号,绝不是第二事实源——台账保留常备轮询兜底,被拒的流不改变任何行为,也没有任何机制为离线目标排队工作。上行请求(投递、取消、续期)仍是普通的鉴权 Remote 调用,通道因此不新增任何可达面。

## 传输钉校验

邀请可以按 base64 SHA-256 指纹钉住目标的 TLS 证书。被钉的目标必须经 HTTPS 拨号——直连,或经邀请端点为 `https://127.0.0.1:<port>` 的 SSH 转发:客户端为传输 fetch 构造一个 `checkServerIdentity`,凡不哈希到钉值的证书一律拒绝(`PIN_MISMATCH`),且两种路径下校验都骑在同一条 TLS 连接上。被钉的目标经明文 HTTP 拨号在任何字节发出前即失败;未钉指纹的 HTTPS 来源保持 Node 信任根。

## 治理

接受方实例拥有治理面。其 owner 的 administer Remote —— `list`、`remove`、`setSurface`、`approveSurface`、`rejectSurface`、`setBudget`、`audit` —— 与 peer 线共用 `peer` 命名空间但要求 `harniverse.administer` 能力,peer 令牌无法触达;Web 仪表盘的「配对同伴」标签页(`ui-peer-admin`)经挂载的客户端契约消费它们,并在转发的 `peer/paired` / `peer/removed` 事件上重新拉取列表。

能力面变更遵循审批流:owner 的直接编辑立即生效;而同伴自己的 `peer/surface` 请求陈述一份完整的目标能力面 —— 纯收窄(或等价面)当场提交并顺带撤销任何已挂起请求,含任何扩张则把整份目标面挂入记录的单一 `pendingSurface` 槽位,最新请求胜出,没有过期时间。请求待批期间,调用继续按现行能力面应答;批准提交挂起面,拒绝将其丢弃,同伴从下一次 `peer/surface` 调用或其它族面的拒绝得知结果。

回合预算存于 `peer-governance.json`:每同伴一个可选的月度上限,按已被接受的投递回合计数(`delegate` 首回合与 `followup` 回合同样计),UTC 自然月,未设置即不限。闸门在投递之前 —— 被限额的 `delegate` 不铸造会话,被限额的 `followup` 在会话查找之前检查 —— 回合一经接受投递即计数,无论其后结算如何;并发在途投递可超出上限,至多以其自身数量为上界,拒绝以 `BUDGET_EXCEEDED` 携带周期与限额。管理 `audit` 只回应仅元数据的会话行(实时状态、时间戳、创建标签);全文留在常规会话视图,而这些行的存续期等于配对生命周期 —— 移除结束该同伴的委派会话、丢弃其治理条目并发出 `peer/removed`;配对侧在下一次调用解析不到记录时得知移除,按设计没有任何流帧宣告它。

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
/** Mint one single-use pairing challenge for the hello proof exchange.
 * @returns the nonce to sign and its lifetime boundary.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async challenge(): Promise<{ challenge: string }>

/** Answer one authenticated peer's identity readback and commit its pinned paired record.
 * @param request - the initiator's identity plus its challenge signature.
 * @returns this instance's identity and the approved surface.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async hello(request: PeerHelloRequest): Promise<PeerHello>

/** Remove one paired-peer record, end its delegated sessions, and report the removed record.
 * @param instanceId - exact instance id to remove.
 * @returns the removed record.
 * @throws a {@link PeerError} with `RECORD_NOT_FOUND` when no such peer is stored.
 */
async removePeer(instanceId: PeerInstanceId): Promise<PeerRecord>

/** Start one delegated session for the calling peer and await its first settlement.
 * @param request - proof, prompt, and optional working directory, profile, and budget.
 * @returns the minted session and its first turn's terminal state.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async delegate(request: PeerDelegateRequest): Promise<PeerRunResult>

/** Deliver the next turn into one session the calling peer owns.
 * @param request - proof, session id, prompt, and optional budget.
 * @returns the delivered turn's terminal state.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async followup(request: PeerFollowupRequest): Promise<PeerRunResult>

/** Read one owned turn's settlement without delivering another prompt.
 * @param request - proof, session id, and the accepted turn's message id.
 * @returns the observed turn state, reply, and end reason.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async result(request: PeerResultRequest): Promise<PeerRunResult>

/** Enumerate the calling peer's own delegated sessions.
 * @param request - proof of the calling peer.
 * @returns the caller's session summaries, newest activity first.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async sessions(request: { proof: PeerRequestProof }): Promise<{ sessions: PeerSessionSummary[] }>

/** Cancel the current turn of one session the calling peer owns.
 * @param request - proof and the caller's own session id.
 * @returns the cancelled turn's terminal state.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async cancel(request: PeerCancelRequest): Promise<PeerRunResult>

/** Mint one single-use event-stream token for the calling peer.
 * @param request - proof of the calling peer.
 * @returns the stream token and the heartbeat cadence.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async subscribe(request: { proof: PeerRequestProof }): Promise<PeerSubscribeResult>

/** Request one surface change: a pure narrowing commits immediately, any widening parks for owner approval.
 * @param request - proof plus the complete desired surface.
 * @returns the surface in force and whether the desire is pending owner approval.
 */
@Remote({ requiredCapability: 'harniverse.peer' }) async surface(request: PeerSurfaceRequest): Promise<PeerSurfaceResult>

/** List every paired peer with its governance state for the owner admin surface.
 * @returns admin views, newest activity first.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async list(): Promise<{ peers: PeerAdminView[] }>

/** Remove one paired peer, end its delegated sessions, and drop its governance entry.
 * @param input - exact instance id to remove.
 */
@Remote({ requiredCapability: 'harniverse.administer', exportName: 'removePeer' }) async remove(input: { instanceId: PeerInstanceId }): Promise<void>

/** Set the granted surface directly; the owner's own decision needs no approval step.
 * @param input - exact instance id and the complete new surface.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async setSurface(input: { instanceId: PeerInstanceId; surface: PeerSurface }): Promise<PeerAdminView>

/** Commit the parked widening surface a peer requested.
 * @param input - exact instance id carrying a pending surface.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async approveSurface(input: { instanceId: PeerInstanceId }): Promise<PeerAdminView>

/** Drop the parked widening surface a peer requested; the surface in force stays unchanged.
 * @param input - exact instance id carrying a pending surface.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async rejectSurface(input: { instanceId: PeerInstanceId }): Promise<PeerAdminView>

/** Set or lift one peer's monthly delivered-turn budget.
 * @param input - exact instance id and the new cap; an absent cap lifts the budget.
 * @returns the updated admin view.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async setBudget(input: { instanceId: PeerInstanceId; monthlyTurns?: number }): Promise<PeerAdminView>

/** Audit one peer's delegated sessions; metadata only, transcripts stay in the session view.
 * @param input - exact instance id to audit.
 * @returns the peer's session summaries, newest activity first.
 */
@Remote({ requiredCapability: 'harniverse.administer' }) async audit(input: { instanceId: PeerInstanceId }): Promise<{ sessions: PeerSessionSummary[] }>
```

Source: [`packages/peer/peer-host/src/index.ts:46`](../../packages/peer/peer-host/src/index.ts)

<a id="ctxpeeroutbox--peeroutbox"></a>

### `ctx.peerOutbox` — `PeerOutbox`

Peer outbox service; the storage-domain ledger is the authority.

```ts cordis-catalog
/**
 * All ledger entries, earliest submission first.
 * @returns every stored entry.
 */
list(): PeerOutboxEntry[]

/**
 * Track one accepted-but-running delegated turn. The entry is durable from
 * this call onward: an instance restart resumes the watch on its next poll.
 * @param input - target, peer session, watched turn, and owner session.
 * @returns the stored entry.
 */
async track(input: PeerOutboxTrackInput): Promise<PeerOutboxEntry>
```

Source: [`packages/peer/peer-outbox/src/index.ts:60`](../../packages/peer/peer-outbox/src/index.ts)

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

Source: [`packages/peer/peer-host/src/types.ts:11`](../../packages/peer/peer-host/src/types.ts)

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

Source: [`packages/peer/peer-host/src/types.ts:17`](../../packages/peer/peer-host/src/types.ts)
<!-- END GENERATED cordis-surface -->
