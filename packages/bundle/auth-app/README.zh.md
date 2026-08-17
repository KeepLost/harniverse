# `@deepseek-ai/dsh-auth-app`

[English](README.md) | 中文

这是一次性认证管理组合包。`dsh auth` 启动该 profile，并将余下参数转发给 `auth-startup`；后者拥有 `token add`、`token reset`、`token delete` 和 `token list` 命令语法。注入的 `auth-runner` 调用本地具名 token 管理 API，仅在 add 和 reset 时写出生成的密钥，并通过 launcher 提供的 `ctx.appExit` 请求有界退出。

该组合包不会把 `dsh-authentication-local` 挂载为网络认证服务，不会打开端口，也不要求已有 token。因此它能在空 Harness home 中创建首个 token。

## Model Experience

None, as this one-shot management app neither creates an Agent nor contributes model context.

#### KV Cache effect

None; the bundle performs no model request.

## Known Limitations and Deferred Work

- 该应用仅管理本地具名 token Provider；其他认证 Provider 各自拥有自己的管理界面。
