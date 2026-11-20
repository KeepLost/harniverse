# @deepseek-ai/dsh-peer-host

[English](README.md) | 中文

实例配对的接受方:能力门控的 `peer/*` Remote——带钉钥的 challenge/hello 配对,以及委派会话、续话投递与按 peer 枚举——与已配对 peer 存储。`PeerHost` 是默认导出的 `TypertRemoteService`,挂在 `ctx.peerHost`,线上命名空间 `peer`,组合于 web-app bundle。注入:无必需——agent 注册表、预设与模型服务经 `ctx.get` 解析,组合未提供时委派以 `SESSION_BUSY` 失败关闭。

## Remote 面

| Method | 线上参数 | Capability | Result |
| --- | --- | --- | --- |
| `cancel(request)` | `{ request: PeerCancelRequest }` | `harniverse.peer` | `PeerRunResult` |
| `challenge()` | `{}` | `harniverse.peer` | `{ challenge }` |
| `hello(request)` | `{ request: PeerHelloRequest }` | `harniverse.peer` | `PeerHello` |
| `delegate(request)` | `{ request: PeerDelegateRequest }` | `harniverse.peer` | `PeerRunResult` |
| `followup(request)` | `{ request: PeerFollowupRequest }` | `harniverse.peer` | `PeerRunResult` |
| `result(request)` | `{ request: PeerResultRequest }` | `harniverse.peer` | `PeerRunResult` |
| `sessions(request)` | `{ request: PeerSessionsRequest }` | `harniverse.peer` | `{ sessions: PeerSessionSummary[] }` |
| `subscribe(request)` | `{ request: PeerSessionsRequest }` | `harniverse.peer` | `PeerSubscribeResult` |

`challenge` 铸出一枚单次 nonce(五分钟 TTL,未决集有上界)。`hello` 验证发起方对 `(instanceId, challenge)` 的签名,首次配对时把 base64url SPKI `identityPublicKey` 钉入记录,此后每次 hello 都按钉住的密钥验签——换钥应答 `IDENTITY_MISMATCH`,已消费或未知 nonce 应答 `CHALLENGE_EXPIRED`。无钉钥的记录(前证明时代)在首个带证明的 hello 时钉钥。某 id 的首条记录发出 `peer/paired`;已撤销的记录以 `HELLO_REJECTED` 拒绝。每次调用在 VM 执行世界中以 `PEER_UNAVAILABLE_VM` 拒绝,且 web-app 组合在 `$DSH_EXEC_WORLD === 'vm'` 时整行禁用,因此真沙箱实例永远不会配对。

`delegate`、`followup`、`cancel`、`result`、`subscribe` 与 `sessions` 对调用方带单次 nonce 的请求证明按钉住密钥验签,再检查对应的 `PeerSurface` 字段(否则 `SURFACE_DENIED`)。证明的 nonce 首次使用即被消费——偏差窗口内抓包重放以 `INVALID_PROOF (replayed nonce)` 拒绝。`delegate` 组建一个 `peer-<uuid>`、`origin: 'peer'` 的会话,工作目录解析在 `peer-work/<instanceId>/` 之下(仅相对路径;越界以 `INVALID_PAYLOAD` 拒绝),把提示词经 agent 收件箱投递,并在请求预算内等待回合结算——结算返回拼接的助手文本与结束原因,超时返回 `state: 'running'` 与会话 id。`followup` 向同一调用方自有的会话投递下一个 FIFO 回合(否则 `SESSION_NOT_FOUND`),无常驻 agent 时冷恢复。`cancel`(`delegate` 面)中止一个自有且常驻会话的当前回合:运行中的回合以 user 原因取消并返回其终态,空闲会话原样返回最新声明的结算,无常驻 agent 的会话应答 `SESSION_NOT_FOUND`。`result` 不投递新提示,只读一个自有轮次的结算——从活会话日志或冷会话持久化事件重新推导终态、回复与结束原因,轮次未完时应答 `running`;读取以 `list` 面门控。`sessions` 列出该调用方条目及推导的 `running`/`idle`/`ended` 状态。`subscribe`(同样 `list` 门控)铸出一枚单次流令牌,可在 `PEER_STREAM_TOKEN_TTL_MS` 内于事件流路由兑取。`surface`(与其余族面同样经证明认证)接收一份完整的目标能力面:纯收窄当场提交并顺带撤销任何已挂起请求,含任何扩张则把整份目标面挂入记录的单一 `pendingSurface` 槽位 —— 最新请求胜出、没有过期时间,owner 决定之前调用继续按现行能力面应答。封闭失败以 `RemoteError` code `peer-failed` 上线,`details.reason` 原样携带 peer 原因。

## 事件流

组合了 web server 时,服务注册精确路由 `GET /api/peer/events?token=<streamToken>`——精确路由优先于共享的 `/api` 前缀,`peer/subscribe` 铸出的不可猜询单次令牌即是该路由的全部鉴权。每条订阅服务一个 `text/event-stream` 响应:该 peer 自有会话的 `turn/end` 事件推送 `{"kind":"settled","sessionId"}` 数据帧,心跳注释按 `PEER_STREAM_HEARTBEAT_MS` 流动(该节拍同时从注册表刷新自有会话过滤集)。帧只是唤醒信号——结算以 `peer/result` 确认;订阅被拒或流断开对调用方没有任何影响。令牌单次有效:每次重连都经鉴权 Remote 重新订阅,因此每条流之前都有一枚带新 nonce 的证明。

## 存储

家下的 `peers.json` 是权威:严格形态校验、按插入序的记录、经 `writePeerStore` 的属主专有原子写。`peer/paired` 与 `peer/removed` 事件是活进程观察;带外 CLI 变更不发出它们。`removePeer(instanceId)` 删除一条记录并发出 `peer/removed`;打包的 CLI 另行撤销对应 Grant。

## 事件

`peer/paired(record: PeerRecord)` 与 `peer/removed(record: PeerRecord)` 仅在服务进程内、于存储提交之后发出。包 invariant 断言每个发出的变更都反映在存储文件中。

## 验证

在仓库根目录:

```sh
node_modules/.bin/vitest run --config packages/peer/vitest.config.ts
node_modules/.bin/tsc -p packages/peer/peer-host/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/peer/peer-host
```

## Model Experience

### 被委派回合

#### What the model sees

一条 `peer/delegate` 或 `peer/followup` 提示词以普通用户消息进入被委派会话自身的日志;agent 运行与同文本本地提示词完全相同的回合,模型可见面上没有任何 peer 特有标记。

#### Token effect

与同文本本地提示词一致;接受方自己的会话永远看不到 peer 提示词。

#### KV Cache effect

每个被委派会话携带自己的对话与缓存前缀,peer 回合不会复用或逐出本地会话的前缀。

## Known Limitations and Deferred Work(已知限制与后续工作)

- `removePeer` 只从真空闲关闭忙碌的被委派 agent;运行中的回合会在其会话记录消失前跑完。
- Owner 治理 Remote(`list`、`remove`、`setSurface`、`approveSurface`、`rejectSurface`、`setBudget`、`audit`)共用 `peer` 命名空间但要求 `harniverse.administer` 能力;回合预算存于 `peer-governance.json`,为每同伴可选的月度上限,按已被接受的投递回合计数,达到周期上限后以 `BUDGET_EXCEEDED` 拒绝。移除不发出任何流帧:配对侧从下一次失败的调用得知。
- 待审能力面槽位没有过期时间;更新的扩张请求将其覆盖,owner 编辑、批准、拒绝或同伴侧的收窄提交都会将其清除。
- 事件流不持有重放游标:断线丢帧由下一次 `peer/result` 读取覆盖,而非流断点续传;每次重连经一枚新证明铸出新令牌。
- 已消费 nonce 的保留按 peer 设上界;超出上界的突发会让最老的 nonce 在偏差窗口内提前退出重放保护。
