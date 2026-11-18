# Peer 配对包

[English](README.md) | 中文

这些包连接两个 Harniverse 家,使一个实例此后可以在另一个实例上委派和消息会话。每个家锚定一个身份——铸造的 UUID、一把 P-256 签名密钥、一份会话语料——而独占家租约已保证每家一个进程。

`dsh-peer-protocol` 拥有共享词汇:`dsh-peer:` 邀请编解码、家锚定的 `instance.json`、封闭错误集与 `peer-<instanceId>` Grant 命名约定。`dsh-peer-host` 是接受方——挂在 `ctx.peerHost` 的能力门控 `peer/hello` Remote 与权威的 `peers.json`。`dsh-peer-client` 是发起方库——签名身份、`peer-targets.json`,以及核验目标身份回读的"注册—兑换—hello"编排。`dsh-peer-app`(位于 `packages/bundle/`)是 `dsh peer` 一次性管理 CLI。

配对原样复用入站认证注册表:一个邀请令牌批准一次登记,Grant 以 `api-client` 类别创建且只携带 `harniverse.peer`,没有它每个 `peer/*` 调用都 fail-closed。VM 执行世界不组合 host 行并拒绝 hello,使真沙箱实例留在配对网络之外。设计理由见[实例配对 Agent Note](../../.agents/notes/implemented/feature/2026-11-18-peer-instance-pairing.md)。

## Known Limitations and Deferred Work(已知限制与后续工作)

- 配对通道之上的委派、消息与列举 Remote 属于后续里程碑;本族只交付配对。
- hello 记录经由"邀请持有 + 注册表名字唯一性"绑定身份;调用方密钥的密码学绑定等待 Remote 边界的 principal 可见性。
