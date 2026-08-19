# dsh-authentication-local

[English](README.md) | 中文

[入站认证](../authentication/README.md)的本地公钥 Grant 提供方。`$DSH_HOME/auth/grants.json` 保存 P-256 公钥、capability 集合、revision 和可选生命周期。私钥保留在设备或 API client 中。Challenge、bearer Access Token 和浏览器会话只存在于进程内存。

## 管理

```sh
dsh auth device list
dsh auth device approve <request-id> --profile owner
dsh auth grant list
dsh auth grant revoke <grant-id>
dsh auth client add automation --public-key <base64url-spki> --capability harniverse.observe harniverse.operate
dsh auth client revoke <grant-id>
```

Authenticated 实例可以在没有 Grant 时启动。静态浏览器 shell 可以提交 enrollment 请求，但本地 CLI 批准并创建第一个 owner 之前，业务 API 保持封存；没有活跃 owner 时会重新封存。人类可读的 Grant 名称由 1 至 64 个 Unicode 字母或数字组成，并可包含空格、点、下划线或连字符。无效名称、无效浏览器密钥和名称冲突会产生稳定且可处理的拒绝；意外的 registry 或审计故障仍属于服务器错误，并由 connection Consumer 记录。待处理请求受持久全局上限和每 peer 创建限制约束。Owner 浏览器可以在 `/auth/manage` 管理待处理请求和 Grant。个人设备 Grant 使用持久、不可导出的浏览器密钥；临时设备密钥只保留在内存中，其 Grant 最长 60 分钟，空闲超时 15 分钟。API client 在本地注册公钥并通过签名 challenge 交换凭据。Owner 管理路由可以签发最长 15 分钟、不可续期且不含 `harniverse.authorize` 的 Access Token。

`$DSH_HOME/auth/tokens.json` 会被作为不支持的旧格式拒绝。系统不提供迁移或 bearer 兼容模式。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | Grant registry、访问日志和 lease 根目录。 |
| `mode` | `authenticated` | `authenticated` 或显式、仅回环的 `bypass`。 |
| `watch` | `true` | 启用低延迟文件系统监听；周期 reconciliation 始终运行。 |
| `debounceMs` | `100` | Registry watcher 稳定窗口。 |
| `accessTokenTtlMs` | 10 分钟 | Access Token 和浏览器会话寿命，上限为 15 分钟。 |
| `challengeTtlMs` | 60 秒 | 一次性 challenge 寿命，上限为 5 分钟。 |
| `enrollmentTtlMs` | 10 分钟 | 待处理寿命与新批准回执轮询寿命，上限为 15 分钟。 |
| `maxPendingEnrollments` | `128` | 持久、未过期待处理 enrollment 上限。 |
| `enrollmentRequestLimit` | `5` | 每个直连 peer 在计数窗口内接受的请求数。 |
| `enrollmentRequestWindowMs` | `60000` | 每 peer enrollment 计数窗口。 |
| `maxEnrollmentPeerKeys` | `4096` | 进程内保留的 enrollment peer 计数器上限。 |
| `maxAccessTokens` | `4096` | 进程内 Access Token 上限。 |
| `maxAccessTokensPerGrant` | `64` 或更低的全局上限 | 每个确切 Grant revision 的进程内 Access Token 上限。全局 ledger 满时拒绝新 Grant，而不驱逐其他 Grant。 |
| `maxChallenges` | `4096` | 待处理 challenge 上限。 |
| `maxChallengesPerGrant` | `16` 或更低的全局上限 | 每个确切 Grant revision 的待处理 challenge 上限。 |
| `maxBrowserSessions` | `1024` | 进程内浏览器会话上限。 |
| `maxBrowserSessionsPerGrant` | `16` 或更低的全局上限 | 每个确切 Grant revision 的浏览器会话上限。 |
| `reconcileIntervalMs` | `5000` | 强制周期 registry reconciliation。 |
| `accessLogMaxBytes` | 10 MiB | 轮转前活动 JSONL 大小。 |
| `accessLogMaxFiles` | `5` | 保留的轮转文件数。 |
| `authFailureLimit` | `10` | 每个 channel 和直连 peer 在窗口内允许的无效凭据次数。 |
| `authFailureWindowMs` | `60000` | 无效凭据计数窗口。 |
| `authFailureBlockMs` | `300000` | 达到失败上限后的阻断时长。 |
| `maxAuthFailureKeys` | `4096` | 内存中保留的 limiter 状态上限。 |

## 存储与撤销

在 POSIX 上，registry 和访问文件位于 `0700` 目录下并使用 `0600` 权限。Registry 写入在 nonce owner 的跨进程锁下原子替换；强制审计追加失败会回滚变更，浏览器凭据也只在登录审计成功后发布。Enrollment 批准和 Grant 撤销与 registry 读取串行化。每次接入都会重新检查持久 Grant revision、过期和空闲状态；凭据过期时间取 Grant 绝对截止与空闲截止中的较早者。Registry 故障或最后一个活跃 owner 消失时会清除所有进程凭据、拒绝业务接入并关闭 socket，直到 reconciliation 找到活跃 owner。精确 Grant 撤销会移除对应 challenge、Access Token、浏览器会话和 WebSocket。

提供方在 WebServer bind 前取得 `$DSH_HOME/runtime/inbound-authentication.lease`，因此一个 home 的 authenticated 与 bypass 实例互斥。`$DSH_HOME/auth/access.jsonl` 记录最小化的实例、enrollment、Grant、challenge、登录和接入结果。它不记录请求体、query string、Authorization/Cookie、私钥、签名、Access Token、浏览器会话值或 Harness session id。

## 模型体验

无，因为该提供方控制外部接入而不改变模型操作。

#### KV Cache 影响

无；认证材料不会进入模型输入。

## 已知限制与延后工作

- 浏览器会话和 Access Token 位于进程内存，重启后需要重新执行签名交换。
- 访问记录是本地轮转 JSONL，不是远程审计 sink。
- POSIX mode 检查没有等价的 Windows ACL 实现。
