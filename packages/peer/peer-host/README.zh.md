# @deepseek-ai/dsh-peer-host

[English](README.md) | 中文

实例配对的接受方:能力门控的 `peer/*` Remote——带钉钥的 challenge/hello 配对,以及委派会话、续话投递与按 peer 枚举——与已配对 peer 存储。`PeerHost` 是默认导出的 `TypertRemoteService`,挂在 `ctx.peerHost`,线上命名空间 `peer`,组合于 web-app bundle。注入:无必需——agent 注册表、预设与模型服务经 `ctx.get` 解析,组合未提供时委派以 `SESSION_BUSY` 失败关闭。

## Remote 面

| Method | 线上参数 | Capability | Result |
| --- | --- | --- | --- |
| `challenge()` | `{}` | `harniverse.peer` | `{ challenge }` |
| `hello(request)` | `{ request: PeerHelloRequest }` | `harniverse.peer` | `PeerHello` |
| `delegate(request)` | `{ request: PeerDelegateRequest }` | `harniverse.peer` | `PeerRunResult` |
| `followup(request)` | `{ request: PeerFollowupRequest }` | `harniverse.peer` | `PeerRunResult` |
| `result(request)` | `{ request: PeerResultRequest }` | `harniverse.peer` | `PeerRunResult` |
| `sessions(request)` | `{ request: PeerSessionsRequest }` | `harniverse.peer` | `{ sessions: PeerSessionSummary[] }` |

`challenge` 铸出一枚单次 nonce(五分钟 TTL,未决集有上界)。`hello` 验证发起方对 `(instanceId, challenge)` 的签名,首次配对时把 base64url SPKI `identityPublicKey` 钉入记录,此后每次 hello 都按钉住的密钥验签——换钥应答 `IDENTITY_MISMATCH`,已消费或未知 nonce 应答 `CHALLENGE_EXPIRED`。无钉钥的记录(前证明时代)在首个带证明的 hello 时钉钥。某 id 的首条记录发出 `peer/paired`;已撤销的记录以 `HELLO_REJECTED` 拒绝。每次调用在 VM 执行世界中以 `PEER_UNAVAILABLE_VM` 拒绝,且 web-app 组合在 `$DSH_EXEC_WORLD === 'vm'` 时整行禁用,因此真沙箱实例永远不会配对。

`delegate`、`followup` 与 `sessions` 对调用方带时间窗的请求证明按钉住密钥验签,再检查对应的 `PeerSurface` 字段(否则 `SURFACE_DENIED`)。`delegate` 组建一个 `peer-<uuid>`、`origin: 'peer'` 的会话,工作目录解析在 `peer-work/<instanceId>/` 之下(仅相对路径;越界以 `INVALID_PAYLOAD` 拒绝),把提示词经 agent 收件箱投递,并在请求预算内等待回合结算——结算返回拼接的助手文本与结束原因,超时返回 `state: 'running'` 与会话 id。`followup` 向同一调用方自有的会话投递下一个 FIFO 回合(否则 `SESSION_NOT_FOUND`),无常驻 agent 时冷恢复。`sessions` 列出该调用方条目及推导的 `running`/`idle`/`ended` 状态。封闭失败以 `RemoteError` code `peer-failed` 上线,`details.reason` 原样携带 peer 原因。

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

- 请求证明携带时间窗而非服务端 nonce;`PEER_PROOF_SKEW_MS` 窗口内的抓包重放会被接纳。配对 hello 保留完整的单次挑战;逐调用 nonce 待会话化通道。
- `removePeer` 只从真空闲关闭忙碌的被委派 agent;运行中的回合会在其会话记录消失前跑完。
- 面的加宽与收窄是记录编辑,不是新的 Grant 能力;尚无面向面变更的审批流。
