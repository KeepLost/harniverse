# `@deepseek-ai/dsh-auth-app`

[English](README.md) | 中文

这是一次性本地 Grant 管理组合包。`dsh auth` 启动该 profile，并将余下参数转发给 `auth-startup`；后者拥有 `device`、`grant` 和 `client` 命令组。`device list` 只显示待处理 enrollment；`grant list` 显示已批准设备和 API client Grant 及其 id、名称、类型、capability 和过期时间。注入的 `auth-runner` 批准待处理设备 enrollment、列出或撤销 Grant、注册 API client 公钥，并通过 launcher 提供的 `ctx.appExit` 请求有界退出。

该组合包不会把 `dsh-authentication-local` 挂载为网络服务，也不会打开端口。因此它可以在封存的 Harness home 中批准第一个 owner 设备，而不要求已有凭据。

其 manifest（元数据清单）声明 `dsh.bundle.homeOwnership: "shared"`，因此 Web 持有 home 租约时，认证管理仍然可用。注册表操作保留自身的协调机制。启动器对同一 profile 的调用实施互斥；添加未声明共享的组合包会使整个组合要求独占（参见 [profile 所有权](../../boot/app-boot/README.md#profiles)）。

## Model Experience

None, as this one-shot management app neither creates an Agent nor contributes model context.

#### KV Cache effect

None; the bundle performs no model request.

## Known Limitations and Deferred Work

- 该应用仅管理本地 Grant Provider；其他认证 Provider 各自拥有自己的管理命令。
