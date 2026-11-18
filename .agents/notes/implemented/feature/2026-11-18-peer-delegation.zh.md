# Agent Note: 配对通道上的 peer 委派

Status: implemented

[English](2026-11-18-peer-delegation.md) | 中文

## Problem

配对(PR #324)钉住了两个家的身份,但不承载任何任务流量:已配对的发起方无法在目标上开启会话、投递后续回合或枚举自己的资产,而 M1 的 hello 信任"邀请持有 + 注册表名字唯一性",因为 Remote 边界看不到调用方 principal。委派不得放宽唯一的 `harniverse.peer` 能力,必须把每个操作限制在调用 peer 自己的会话内,并让被委派会话远离面向用户的会话列表。

## Decision

配对之外的每个 `peer/*` 请求现在都携带密码学证明。`peer/challenge` 铸出单次 nonce;`peer/hello` 要求对 `(instanceId, nonce)` 的 P-256 签名,并把验签公钥作为 `identityPublicKey` 钉入 peer 记录——此后的 hello 按钉住密钥验签,关闭记录劫持窗口。`peer/delegate`、`peer/followup` 与 `peer/sessions` 携带带时间窗的请求证明(`peerRequestMessage`、`PEER_PROOF_SKEW_MS`)并按钉住密钥验签;host 直接由证明解析调用方记录,再检查对应的 `PeerSurface` 字段。

被委派会话是普通 agent 会话,经与 API proxy 相同的服务 seam 组装——`ctx.get('agents')` 的 create/resume、部署默认模型选择与可选 `agentPresets` profile——打上 `origin: 'peer'` 标记,工作目录扎根在 `peer-work/<instanceId>/` 之下(请求仅允许相对路径)。提示词经 `agent.followup` 投递;结算以请求预算为竞速观察会话自身的公开事件窗口(`session.eventsFrom`),返回拼接的助手文本与回合结束原因,或 `state: 'running'`。会话 header 的 origin 联合类型从 `'subagent'` 扩展出 `'peer'`,API proxy 的每个面向用户的列表过滤(`session.list`、冷列表、普通会话可见性)改为只接纳 `origin === undefined` 行,因此 peer 会话只能经 peer Remote 触达。目标家下的 `peer-sessions.json` 是委派注册表;`removePeer` 丢弃该 peer 的条目并从真空闲关闭其常驻 agent。

## Alternatives considered

- **复用 subagent continuable seam**——放弃:continuable child 需要活的父 Agent 与包私有的 host 钩子;peer 在目标上没有本地父会话。
- **镜像 chat bridge(API 级客户端 + 内部 operate grant)**——放弃:那会铸造第二个更宽的凭证,并依赖 webserver 在听;进程内服务 seam 两者都不需要。
- **逐调用挑战 nonce 而非时间窗**——后置:每调用多一个往返,换取的是很窄的重放窗;配对 hello 保留完整的单次挑战。

## Consequences

线上失败现在经 `RemoteError` code `peer-failed`(`details.reason`)携带封闭 peer 原因,该 code 已注册进 API proxy 的错误词汇——M1 把所有服务端拒绝塌缩成传输故障的行为不复存在。origin 联合类型的扩宽触及核心会话校验、两个持久化格式的校验、API proxy 的 wire schema 与客户端契约;未来的任何 origin 取值都必须同步更新它们以及每一处 `origin === undefined` 可见性检查。M1 的"五处能力镜像"教训新增第六个面:`peer-failed` wire code。

## Required verification

`packages/peer/peer-host/tests` 与 `packages/bundle/peer-app/tests` 中的真 Loader 组合(挑战/钉钥、经脚本 agent 注册表的 delegate/followup/sessions、surface 拒绝、证明失败;CLI 端到端 invite → add → run → sessions → send 走真实 HTTP 与真实 grant 交换),三个 peer 包的逐文件 100% 覆盖,以及 session、persistence、API proxy 与 client runtime 的受影响套件。
