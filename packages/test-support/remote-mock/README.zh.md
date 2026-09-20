# `@deepseek-ai/dsh-remote-mock`

[English](README.md) | 中文

面向 web 客户端单元测试的可编程 Connection carrier mock：真实的 `AbstractApiClient` 线格式表面，unary 分发按 `RpcMethodMap` 键控，SSE 下行链路手动泵送，附带 bypass 认证 double，以及把真实 `dsh-client-connection` 插件引导到它们之上的挂载助手。

carrier 使用与生产 transport 相同的 JSON 信封、信封回显校验和 `UNARY_VALUE_SCHEMAS` 值解析，因此通过 mock 的测试运行的就是真实客户端请求/响应路径——被替换的只有网络。用 `mock.on(method, handler)` 编排处理器；未编排的方法以 HTTP 500 大声失败，抛出的 `RemoteMockRpcError` 落到 `internal` RpcResult 分支。mux 与 host 流通过向 `mock.muxDownlink` / `mock.hostDownlink` 推送帧来驱动，每个打开的下行链路记录其 `since` 续传游标。

## 挂载助手

`mountRemoteConnection(ctx)` 提供 `clientAuthentication`（bypass double）与 `connectionCarrier` 覆写，随后原样应用 connection 插件，返回 mock、double 与挂载后的 `ctx.connection` 句柄。需要完整代际握手的测试在同一个 mock carrier 上驱动 `handle.start(...)`。

## Model Experience

无：该 carrier double 替换 web transport，不调用真实模型。

#### KV Cache effect

无；请求在测试进程内终结，从不触及 provider 缓存。

## Known Limitations and Deferred Work

- **两份手写的逐用例 fake 仍然保留** —— `packages/client/connection/tests/fake-api.client.ts` 与 `packages/client/runtime/tests/fake-api.client.ts` 早于本包，服务于带延迟时序的 fixture 形态套件；待这些套件迁移后再收敛到本 carrier。
- **不做 capability 执行** —— mock 不评估 `RPC_METHOD_CAPABILITIES`；授权拒绝路径需要改用进程内 handler 注入。
