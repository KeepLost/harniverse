# @deepseek-ai/dsh-peer-host

[English](README.md) | 中文

实例配对的接受方:能力门控的 `peer/hello` Remote 与已配对 peer 存储。`PeerHost` 是默认导出的 `TypertRemoteService`,挂在 `ctx.peerHost`,线上命名空间 `peer`,组合于 web-app bundle。必需注入:无——解析出的家之下的存储与身份文件是唯一状态。

## Remote 面

| Method | 线上参数 | Capability | Result |
| --- | --- | --- | --- |
| `hello(identity)` | `{ identity: PeerHelloInput }` | `harniverse.peer` | `PeerHello` |

`hello` 校验发起方的自我声明身份,读取本家的 `instance.json`(绝不铸造——从未发过邀请的家以 `CORRUPT_INSTANCE` 作答),提交或刷新 peer 记录,并以本实例身份加已批准面作答。某 id 的首条记录发出 `peer/paired`;已撤销的记录以 `HELLO_REJECTED` 拒绝。每次调用在 VM 执行世界中以 `PEER_UNAVAILABLE_VM` 拒绝,且 web-app 组合在 `$DSH_EXEC_WORLD === 'vm'` 时整行禁用,因此真沙箱实例永远不会配对。

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

无:该插件不注册任何工具、提示或 Session 事件;已配对面通过未来的委派与消息包到达模型。

#### KV Cache effect

无;本插件不组装任何模型输入。

## Known Limitations and Deferred Work(已知限制与后续工作)

- Remote 看不到调用方 principal,因此 peer 记录信任"邀请持有链 + 注册表名字唯一性",而未把 grant id 绑进记录;未来的挑战签名 hello 会以密码学方式绑定调用密钥。
- 面的加宽与收窄是记录编辑,不是新的 Grant 能力;尚无面向面变更的审批流。
