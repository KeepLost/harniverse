# @deepseek-ai/dsh-peer-app

[English](README.md) | 中文

一次性 peer 配对管理应用,由 `dsh peer` 启动(启动器别名,等价 `--profile peer`)。startup 插件经 [dsh-cmdline](../../boot/cmdline/README.md) 解析命令树并提供 `ctx.peerStartup`;runner 消费它、对 profile 家执行一次操作并请求进程退出。

## 命令

| 命令 | 侧 | 行为 |
| --- | --- | --- |
| `peer invite --endpoint <origin> [--name] [--ttl] [--fingerprint]` | 接受方 | 首次使用时铸造家身份,经本地 Grant 注册表签发能力仅限 `harniverse.peer` 的一次性 `dshi1_` 邀请,打印 `dsh-peer:` URI 及其过期时间。 |
| `peer add <uri> [--ssh-host <name>] [--timeout <ms>]` | 发起方 | 解码邀请,直接或经一条 remote-hosts SSH 转发拨号端点,并运行 [dsh-peer-client](../../peer/peer-client/README.md) 的完整配对编排。 |
| `peer list` | 接受方 | 从 `peers.json` 列出已配对 peer。 |
| `peer remove <instance-id>` | 接受方 | 删除记录,并在存在时撤销 `peer-<instanceId>` Grant。 |
| `peer targets` | 发起方 | 从 `peer-targets.json` 列出配对目标。 |
| `peer forget <instance-id>` | 发起方 | 丢弃一条目标记录。 |
| `peer run <instance-id> <prompt...> [--cwd] [--profile] [--timeout <ms>] [--async]` | 发起方 | 在已配对目标上开启一个被委派会话并等待回复;打印会话行,结算后附回复文本。`--async` 以最小预算提交并打印回执(会话与消息 id),点名 `dsh peer result` 读取方式。 |
| `peer send <instance-id> <session-id> <prompt...> [--timeout <ms>] [--async]` | 发起方 | 向一个被委派会话投递下一回合并以同样方式等待结算;`--async` 改为打印回执。 |
| `peer sessions <instance-id>` | 发起方 | 列出本实例在目标上的被委派会话及活跃状态。 |
| `peer cancel <instance-id> <session-id>` | 发起方 | 取消目标上一个被委派会话的当前回合并打印其终态;空闲会话原样报告最新声明的结算。 |
| `peer result <instance-id> <session-id> <message-id>` | 发起方 | 不投递新提示,只读一个被委派轮次的结算——异步回执背后的人工逃生门。 |
| `peer outbox` | 发起方 | 列出本 home 的结算台账(由运行中实例经 `dsh-peer-outbox` 写入);视图永不写入。 |

邀请要求目标注册表中已存在 owner Grant(引导规则);新家只有在其 owner 引导之后才能配对。SSH 拨号的 add 仅接受密钥文件与 agent 主机登录——口令与加密引用登录报 `UNSUPPORTED_CREDENTIALS`,因为一次性进程不解析任何加密凭据。

runner 组合 `remote-hosts-ssh`,使 `--ssh-host` 使用与 remote-hosts 协调器相同的传输拨号,主机记录读自 profile 家的 `remote-hosts.json`。委派命令以同样方式解析目标存储的传输——direct 端点原样拨号,`ssh` 传输在调用存活期内转发到目标的环回端口。

## 验证

在仓库根目录:

```sh
node_modules/.bin/vitest run packages/bundle/peer-app
node_modules/.bin/tsc -p packages/bundle/peer-app/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/bundle/peer-app
```

## Model Experience

无:该应用不注册任何工具、提示或 Session 事件;一次操作后即退出。

#### KV Cache effect

无;本应用不组装任何模型输入。

## Known Limitations and Deferred Work(已知限制与后续工作)

- `peer invite` 经本地注册表文件写邀请;服务实例通过其注册表 watcher 观察变更,因此已停止的实例必须先启动才能兑换邀请。
- `peer run` 与 `peer send` 默认同步:预算耗尽而回合仍在运行时打印 `state: 'running'` 并以 0 退出,操作者凭会话与消息 id 经 `dsh peer result` 读取结算;发起方台账不做任何目标不可达时的排队。
- 此处没有邀请列举或撤销命令;`dsh auth code list` 与 `dsh auth code revoke` 对所有邀请类别拥有这些操作。
