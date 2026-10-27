# Agent Note: WebSocket 事件下行链启用 permessage-deflate

Status: implemented

[English](2026-10-26-websocket-permessage-deflate.md) | 中文

## Problem

connection 插件的两条 WebSocket 下行链(`/api/events.mux`、`/api/events.host`)与远程主机桥接此前从不压缩事件帧:会话事件、终端输出与长助手回合都以明文 JSON 文本过线,繁忙会话在每一帧上都全额支付带宽。wave-5 调查把官方的 WebSocket permessage-deflate(row 18)记为廉价吸收候选,并注明"下次动 webserver 时对照我们的监听器核验"。

## Decision

在 connection 配置键之后为下行链对启用 `permessage-deflate`(owner 决策,2026-10-26):

- `client-connection.websocketCompression: 'deflate' | 'none'`,默认 `'deflate'`——与官方默认一致。`'none'` 不带扩展地接受同样的升级请求。
- `'deflate'` 时,`WebSocketServer` 以 `zlibDeflateOptions: { level: 1 }` 协商扩展——官方的取值:异步压缩,相对帧 JSON 序列化保持廉价,且被压缩写操作的完成仍计为对端活性。
- Host 只对 JSON 文本达到 1,024 字符(官方阈值)的自身外发帧压缩;更短的帧保持不压缩,因为逐消息的 zlib 头会比收益还大;上行帧由对端自行决定。阈值作用于全部三个发送点:mux/host 帧泵、控制帧写入器,以及远程主机桥接。

动这块表面的同时核验了 wave-5 row 9 的 rider:我们的浏览器 cookie 名已按 scheme 区分(HTTPS 上是带 `Secure` 属性的 `__Host-dsh_auth`,HTTP 上是 `dsh_auth`),且会话是服务端持有的不透明值而非签名受众。来自 HTTP 部署的旧名 cookie 无法回放到 HTTPS 部署,因为不同 Host 进程持有互不相交的内存会话注册表;而一个监听器只服务一种协议,部署内部不存在混合 scheme 的主机。

## Alternatives considered

**不加配置键、永远开启。** 对已压缩负载,压缩在两端都要花 CPU(浏览器路由不走这两条 socket,但运维选择权仍是官方形态);有本地反向代理做传输压缩的部署可以借这个键关闭。

**更低的阈值。** 官方测得 1,024 字符是 deflate 开始占优的交叉点;沿用即可,不必重新推导曲线。

## Consequences

- 浏览器默认就会提议压缩,事件流在无需客户端改动的情况下获得带宽收益。
- 验证:四项 host 规格——启用时两条下行链均协商扩展、禁用时不协商、大帧经压缩流完整送达、超过阈值的桥接远程帧送达——加上下行链全套(48 项)与 typecheck。
