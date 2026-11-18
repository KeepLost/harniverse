# @deepseek-ai/dsh-peer-client

[English](README.md) | 中文

实例配对的发起方:家粒度 P-256 签名身份、`peer-targets.json` 存储与"注册—兑换—hello"编排。纯库——无插件、无 Config——由 [dsh-peer-app](../../bundle/peer-app/README.md) 消费;未来的活通道插件将以同样方式组合它。

## 签名身份

`ensurePeerIdentityKey(home)` 加载或铸造 `peers/identity.pem`——每家一把、属主专有权限的 PKCS#8 P-256 密钥——并返回 base64url SPKI 公素材与 IEEE-P1363 SHA-256 签名回调。密钥对每个目标只登记一次;持有性通过标准挑战交换证明(`GrantAccess`,来自 [dsh-sdk-client](../../sdk/client/README.md))。

## 配对编排

`pairWithPeer({ invite, home, origin, fetch?, timeoutMs?, transport? })` 对一个目标跑完整流程:确保身份与密钥,然后要么复用已记录的活跃 Grant(幂等重配对完全跳过登记),要么以 `peer-<instanceId>` 登记、兑换邀请并保留已批准的 Grant id。随后每次调用用挑战换短时 Access Token,并经 Connection RPC 信封调用 `peer/hello`;若目标作答的身份与邀请声称不符则以 `IDENTITY_MISMATCH` 中止。持久化目标把端点、传输、Grant 名与 id、状态记入 `peer-targets.json`。

各阶段报告封闭原因:`TRANSPORT_FAILED`、`ENROLLMENT_REJECTED`、`REDEEM_REJECTED`、`HELLO_REJECTED`、`IDENTITY_MISMATCH`、`STORE_FAILED`。origin 必须是 HTTPS 或环回 HTTP,与邀请编解码的规则一致。

## 验证

在仓库根目录:

```sh
node_modules/.bin/vitest run --config packages/peer/vitest.config.ts
node_modules/.bin/tsc -p packages/peer/peer-client/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/peer/peer-client
```

## Model Experience

无:该库不注册任何工具、提示或 Session 事件;发起面通过未来的委派与消息包到达模型。

#### KV Cache effect

无;本包不组装任何模型输入。

## Known Limitations and Deferred Work(已知限制与后续工作)

- 幂等重配对复用已记录的 Grant;若目标已撤销它,交换失败,操作者需在删除陈旧目标记录后重新邀请。
- Access Token 仅存进程内存;未来的活通道插件负责长连接上的续期。
