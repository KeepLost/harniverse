# @deepseek-ai/dsh-peer-protocol

[English](README.md) | 中文

共享 peer 词汇:`dsh-peer:` 邀请编解码、家锚定的实例身份、hello 与请求证明、封闭错误词汇(含治理拒绝 `BUDGET_EXCEEDED`)、能力面请求信封与 Grant 命名约定。纯库——无插件、无 Config、无注册——由 [dsh-peer-host](../peer-host/README.md)、[dsh-peer-client](../peer-client/README.md)与 [dsh-peer-app](../../bundle/peer-app/README.md)消费。

## 实例身份

每个 DSH 家在首次 peer 使用时铸造一份 `instance.json`——`{ version, instanceId, displayName, platform, arch, createdAt }`,id 为小写 UUID,以属主专有权限原子写入。`ensureInstanceIdentity(home)` 读取或铸造;`readInstanceIdentity(home)` 对缺失或畸形文档以 `CORRUPT_INSTANCE` 拒绝。id 在家的生命周期内稳定;证明它的签名密钥属于发起方([dsh-peer-client](../peer-client/README.md)),不在此处。

## 邀请编解码

`encodePeerInvite(payload)` 产出单粘贴的 `dsh-peer://<base64url>` URI;`decodePeerInvite(uri)` 校验完整形态——版本、小写 UUID、有界展示名、HTTPS 或环回 HTTP 的 origin、`dshi1_` 令牌、可选的 base64 SHA-256 TLS 指纹——以封闭原因 `INVALID_URI` 与 `INVALID_PAYLOAD` 拒绝。`peerGrantName(instanceId)` 导出注册表唯一的 `peer-<instanceId>` 名,`instanceIdOfGrantName` 反向读取;共享展示名边界是 `isDisplayName`。

## 证明

两类规范签名把 Remote 调用绑定到发起方的 P-256 身份密钥。hello 证明覆盖 `peerHelloMessage(instanceId, challenge)`——`peer/challenge` 铸出的单次 nonce——因此接受方在首次配对时把 `identityPublicKey` 钉入配对记录,此后每次 hello 都按钉住的密钥验签(不符则 `IDENTITY_MISMATCH`)。请求证明覆盖 `peerRequestMessage(instanceId, timestamp, nonce)`;`verifyPeerRequestProof` 检查形状、`PEER_PROOF_SKEW_MS` 时钟窗与对钉住密钥的签名,并返回证明的 nonce,供宿主在窗口内拒绝任何重放。`verifyPeerSignature` 是两类证明共用的 base64url-SPKI ECDSA/SHA-256 验签器。流常量随行:`PEER_STREAM_TOKEN_TTL_MS` 界定一枚已铸出事件流令牌的可兑取时长,`PEER_STREAM_HEARTBEAT_MS` 命名流维持的心跳节拍;`PEER_NONCE_TTL_MS` 是宿主侧已消费请求 nonce 的保留视界。

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
- TLS 指纹钉校验仅在邀请携带指纹时生效;未钉指纹的 HTTPS 来源仍依赖 Node 信任根,钉了指纹的来源则直接拒绝明文 HTTP 拨号。
