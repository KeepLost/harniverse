# Agent Note: Peer 事件通道、取消与传输钉校验

Status: implemented

[English](2026-11-20-peer-event-channel.md) | 中文

## Problem

M4 交付的结算台账靠盲轮询感知结算;配对复查留下的两个安全欠账——请求证明的 ±90 秒抓包重放窗、以及对已撤销 Grant 重配对时的裸 sdk-client 错误——都指向通道未定型。owner 在 roadmap 拍板:D8=b(SSE,上行仍走 HTTP;实例配对流量低、两边保持独立执行,通道只服务下行推送);D9=a(仅取消当前回合);D10=b(direct 与 SSH 转发都强制 TLS 钉校验)。

## Decision

六件窄件,各归既有接缝:

- **带单次 nonce 的请求证明**(`dsh-peer-protocol`):`PeerRequestProof` 增加 `nonce`,规范签名消息升级为 `dsh-peer-request/2:<instanceId>:<timestamp>:<nonce>`;`verifyPeerRequestProof` 返回 nonce,宿主的 `PeerNonceLedger` 首次使用即消费——偏差窗口内重放应答 `INVALID_PROOF (replayed nonce)`。按 peer 有界保留(`PEER_NONCE_TTL_MS` 视界、桶容量 256);该上界是内存卫生而非安全声明,已写入已知限制。
- **SSE 事件通道**(`dsh-peer-host`):`peer/subscribe`(证明鉴权、`list` 门控)铸出单次流令牌;精确路由 `GET /api/peer/events?token=…`——经 `ctx.webServer.register({ kind: 'exact' })` 在组合了 web server 时注册,精确路由优先于共享 `/api` 前缀——为每条订阅服务一个 `text/event-stream`。该 peer 自有会话的 `turn/end` 推送 `{"kind":"settled","sessionId"}` 帧;心跳按 `PEER_STREAM_HEARTBEAT_MS` 流动并刷新自有会话过滤集。不可猜询单次令牌即该路由的全部鉴权——不触碰 `client-connection` 任何内部,每次重连先过一枚带新 nonce 的证明。这就是通道的令牌续期答案:没有长寿命令牌需要续期。
- **提示式推送 + 常备轮询**(`dsh-peer-outbox`):每个被监视目标一条流;每帧唤起立即轮询(周期中到达的帧经 `again` 标志顺延到下次重整)。订阅被拒或流断开不改变任何行为——常备 `pollIntervalMs` 节拍继续监视,没有条目等待目标上线,M4 的"同刻复探一次"语义原样保留。结算事实源仍是 `peer/result`。
- **`peer/cancel`**(`dsh-peer-host` + `runPeerCancel` + `dsh peer cancel`):取消一个自有、常驻会话的当前回合(`delegate` 面)。运行中的回合以 user 原因中止并返回终态;空闲会话原样报告最新声明的结算;无常驻 agent 应答 `SESSION_NOT_FOUND`——取消从不冷恢复会话、从不捏造工作。
- **TLS 钉校验**(`dsh-peer-client`):`pinnedFetchFor` 为传输 fetch 构造 undici `Agent`,其 `checkServerIdentity` 要求对端证书哈希(base64 SHA-256)等于钉值 `tlsFingerprint`;被钉目标经明文 HTTP 拨号在任何字节发出前以 `PIN_MISMATCH` 失败。SSH 转发接受 `https://127.0.0.1:<port>` 邀请端点,同一校验因此贯穿隧道;未钉指纹的 HTTPS 保持 Node 信任根。
- **封闭的重配对指引**(`callPeerRemote`):Grant 挑战/令牌交换失败(`GrantAccess:` 错误)归类为 `EXCHANGE_FAILED` 并附带"删除后重新邀请"指引;传输层抛错归类为 `TRANSPORT_FAILED`(配对期间 `HELLO_REJECTED`)——顺带修正真实网络拒连在台账失败族里的分类。

`PeerEventFrame` 保持单成员闭集(`settled`):每新增一种帧都是一次 wire 契约决策,不是免费扩展。

## Alternatives considered

- **WebSocket(D8=a)**——owner 否决:M5 范围内没有任何"服务端主动上行指令"的消费者,WS 却要为一套状态机、背压与升级握手加固买单。将来若需要真双向(如 workflow 实时步骤),可在本通道之侧另加 WS——通道即插件,选 SSE 不封死 WS。
- **仅通道绑定 nonce**——否决其作为唯一重放防线:逐请求单次 nonce 无论有无通道都关上窗口,不依赖会话状态,一次性 RPC 调用方同样免疫。通道补推送;台账关窗口。
- **取消整个会话(D9=b)**——顺延:终止语义与接受方治理工作(M6)纠缠;取消当前回合即可闭合发起方闭环,不必发明 fabric 尚未拥有的生命周期。
- **可续传流(`Last-Event-ID`)**——否决:重放游标会让流成为第二结算权威。丢帧由常备轮询覆盖;每次重连经一枚新证明铸出新令牌。
- **首次拨号 TOFU 记录钉值**——否决:首连攻击者会把自己钉进去。钉值只来自邀请载荷。

## Consequences

- 流路由有意绕开 `client-connection` 的 `/api` 信任栅栏:单次不可猜透令牌(仅在证明鉴权 RPC 之后铸出)对一条无副作用只读流已是完整鉴权,CSRF/DNS-rebinding 无可乘之隙。未来任何对该路由的改动必须重新评估此推理。
- 已消费 nonce 的保留按 peer 设上界;超出上界的突发会让最老的 nonce 在偏差窗口内提前退出重放保护(已记录的限制)。
- 钉校验在每条拨号连接上验证证书,但不做证书透明度或 OCSP 检查。
- 验证:peer 组 155 测试覆盖 nonce 重放拒绝、流令牌单次/过期/容量、心跳与所有权刷新、写失败包容、路由 403/200、经真实脚本 HTTP 目标的推送唤醒与流拆除、经真实 CLI 组合的取消端到端、钉校验;peer-protocol/peer-host/peer-client/peer-outbox/peer-app 触及的全部 `src` 文件语句与分支覆盖 100%;typert 金色为 `['cancel','challenge','delegate','followup','hello','result','sessions','subscribe']`,全部 `harniverse.peer`。
