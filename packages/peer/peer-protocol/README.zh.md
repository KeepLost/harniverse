# @deepseek-ai/dsh-peer-protocol

[English](README.md) | 中文

共享 peer 词汇:`dsh-peer:` 邀请编解码、家锚定的实例身份、封闭错误词汇与 Grant 命名约定。纯库——无插件、无 Config、无注册——由 [dsh-peer-host](../peer-host/README.md)、[dsh-peer-client](../peer-client/README.md)与 [dsh-peer-app](../../bundle/peer-app/README.md)消费。

## 实例身份

每个 DSH 家在首次 peer 使用时铸造一份 `instance.json`——`{ version, instanceId, displayName, platform, arch, createdAt }`,id 为小写 UUID,以属主专有权限原子写入。`ensureInstanceIdentity(home)` 读取或铸造;`readInstanceIdentity(home)` 对缺失或畸形文档以 `CORRUPT_INSTANCE` 拒绝。id 在家的生命周期内稳定;证明它的签名密钥属于发起方([dsh-peer-client](../peer-client/README.md)),不在此处。

## 邀请编解码

`encodePeerInvite(payload)` 产出单粘贴的 `dsh-peer://<base64url>` URI;`decodePeerInvite(uri)` 校验完整形态——版本、小写 UUID、有界展示名、HTTPS 或环回 HTTP 的 origin、`dshi1_` 令牌、可选的 base64 SHA-256 TLS 指纹——以封闭原因 `INVALID_URI` 与 `INVALID_PAYLOAD` 拒绝。`peerGrantName(instanceId)` 导出注册表唯一的 `peer-<instanceId>` 名,`instanceIdOfGrantName` 反向读取;共享展示名边界是 `isDisplayName`。

## 验证

在仓库根目录:

```sh
node_modules/.bin/vitest run --config packages/peer/vitest.config.ts
node_modules/.bin/tsc -p packages/peer/peer-protocol/tsconfig.json --noEmit --incremental false --composite false
node_modules/.bin/oxlint --config .oxlintrc.json packages/peer/peer-protocol
```

## Model Experience

无:该库不注册任何工具、提示或 Session 事件;配对面属于 host 与 client 包。

#### KV Cache effect

无;本包不组装任何模型输入。

## Known Limitations and Deferred Work(已知限制与后续工作)

- 身份文档不携带密钥素材;未来的密钥轮换路径通过"撤销后重新配对"替换发起方密钥,而非扩展此格式。
- 载荷携带 TLS 指纹但传输层尚未强制校验;今天的直连 HTTPS 依赖 Node 信任根。
