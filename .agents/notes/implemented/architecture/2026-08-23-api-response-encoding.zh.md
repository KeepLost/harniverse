# Agent Note：/api 响应编码

Status: implemented

[English](2026-08-23-api-response-encoding.md) | 中文

## Problem

每个 `/api` 响应都以原样 JSON 离开 Host。静态资源会协商 Brotli 与 gzip，RPC 载体却不会，于是产品中最大的一次传输在网络上付出了完整体积。冷历史页面以已结算的 `assistant/chunk` 事件为主：在一个真实的 20,701 事件页面上响应为 3,655 KiB，而在读者实际打开的那个工件上达到 4,161 KiB。

本地测量完全掩盖了这一点。经由回环，该页面约 1.8 s 渲染完成；而同一次点击在真实链路上让读者等了 10 s，更旧的会话超过 30 s——足以让 unary 历史超时以 `The user aborted a request` 的形式暴露出来。剩下的代价是字节数而非后端读取：持久化读取为 206-386 ms，协议序列化加客户端 schema 校验不到 0.14 s。

## Decision

Host HTTP bridge 为带缓冲的 `/api` 响应协商 `content-encoding`。提供 `br` 的请求用 Brotli 应答，提供 `gzip` 的用 gzip，其余原样发送。`content-length` 始终描述实际写出的字节数，且每个带缓冲的响应即使原样发出也声明 `vary: accept-encoding`，使共享缓存不会把已编码正文发给从未提供该编码的客户端。

这项职责属于 bridge 而非 Fetch handler。handler 保持与传输无关，因此 Electron 和测试 fixture 经由 `toFetchHandler` 驱动的进程内载体，不必为一项只有网络跳转才需要的变换付出代价。

三条边界防止编码器自己变成瓶颈。小于 1 KiB 的响应保持原样，因为在约一个 MTU 以下，已编码正文加其头部开销省不出一个往返。编码运行在 zlib 线程池而非同步执行，因为 Host 在同一事件循环上应答其他所有请求。Brotli 质量刻意低于其默认值：在实测页面上，默认值多花约 60 ms 只换来数个百分点的压缩率，等于把延迟从网络搬到 Host。

只有 `application/json` 会被缓冲，其余一切原样流过。这是白名单而非流式黑名单：事件流必须逐帧到达浏览器，会话日志 ZIP 导出在其自有容量闸门下流式输出，而未来新增的流式 content type 不应当依赖此处被记得才能保持正确。以 `q=0` 提供的 token 视为拒绝，因此声明不要 Brotli 的客户端不会收到它。上游的 `vary` 会被保留而非替换。

## Alternatives considered

**在 Fetch handler 内压缩。** 否决，因为那样会连进程内载体也一并编码——那里字节从不跨越 socket——并把传输关注点放进一个与传输无关的 seam。

**通过从协议中丢弃已结算 chunk 来减小 payload。** 此处未采用，并已在[压缩优先会话历史](2026-08-22-compaction-first-session-history.md)中记录为否决方案：插件 Definition 会收到与持久化所持有的不同的 Event 窗口，且原始 seq 连续性会改变。编码在不改变任何消费方所观察到的内容的前提下移除了约九成字节。

**Brotli 使用默认质量。** 依据实测否决：它会在本已最慢的那个请求上把网络时间转成 Host CPU 时间，而 Host 会让其他 RPC 排在其后。

**同步编码。** 否决，因为并发的按会话请求本已在事件循环上排在历史工作之后；实测 `commands/list` 与 `session.models` 尽管各自只返回约 1 KiB，其耗时却几乎与历史请求同步。

## Consequences

冷历史页面的传输量降到约原先的十分之一：在读者自己的工件上，4,161 KiB 变为 385 KiB，2,274 KiB 变为 213 KiB，均在真实 Grant 认证下于浏览器中实测。读者可见的改善随链路速度而放大，这正是它在回环通道中不可见、而在读者自己的测量中起决定作用的原因。

Host 付出了此前没有付出的 CPU，其上界由固定的质量设定限制，并已移出事件循环。带缓冲的响应会具化其正文加一份已编码副本，其上界取决于生成它的那一方；`maxRequestBodyBytes` 只约束请求，从未约束响应。因此缓冲采用针对 `application/json` 的白名单，而非仅为当时已知的那一种流式类型开例外：会话日志 ZIP 导出正是在 64 KiB 容量闸门下流式输出，以确保 Host 从不持有整个归档，而黑名单会悄然把它变成全有或全无的响应，并且重复压缩已经 DEFLATE 过的条目。现在任何未来的流式 content type 都默认安全。

这并未减少 chunk 密集页面在 Host 上序列化、或在客户端解析与折叠所需的 CPU。它们仍与事件数成正比，因此携带约 20,000 条已结算 delta 的页面依然是产品中最昂贵的一次点击。

## Verification

`packages/client/connection/tests/http-bridge.host.spec.ts` 让真实响应穿过 bridge 并解码 socket 实际收到的内容。它固定了 Brotli 与 gzip 的选择、`identity` 与缺失头部时的原样正文、每个带缓冲响应上的 `vary`、与已编码字节数相符的 `content-length`、小响应下限、`q=0` 拒绝、上游 `vary` 的保留，以及事件流与 `application/zip` 归档两者都逐块到达且既无编码也无 `content-length`。

每条断言都针对其存在意义所对应的缺陷做了变异验证：禁用编码器会复现修复前行为并失败；上报未编码长度会失败；去掉 `vary` 会失败；忽略 `q` 参数会失败；把白名单换回最初的流式黑名单会让归档用例失败——该缺陷正是这样被发现的。

真实工件测量使用读者自己的日志，经由真实浏览器应用在 `authentication: 'grant'` 下完成设备注册、所有者批准与签名挑战交换，而非回环 bypass，并确认了 `content-encoding: br` 与上述体积。
