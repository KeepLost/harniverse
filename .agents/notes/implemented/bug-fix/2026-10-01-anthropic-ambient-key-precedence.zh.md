# Agent Note：Anthropic 环境认证让 API key 优先于 bearer token

Status: implemented

[English](2026-10-01-anthropic-ambient-key-precedence.md) | 中文

## 问题

未点名 `apiKeyEnv` 的 `anthropic` 路由交给 pi-ai 的环境发现；其 resolver 先读 `ANTHROPIC_AUTH_TOKEN`，再读 `ANTHROPIC_OAUTH_TOKEN` 与 `ANTHROPIC_API_KEY`，并以 `Authorization: Bearer` 发送前者。同时导出两者的环境——Claude Code 与其他客户端共用同一个 shell 时很常见——让 harness 请求用 bearer token 认证，而 OpenCode 与官方 SDK 以 `x-api-key` 发送密钥。会校验所收到的任何 bearer 的网关（实测：一个接受同一环境 `x-api-key` 的中转返回 `401 客户端认证失败`）因此拒绝了每个 harness 请求，remote-host 物化也把同样的 bearer 形态固定到被同步的主机上。

另外，一条中转回落路径发出的 Responses SSE 事件之间没有空行分隔；OpenAI SDK 把这些帧拼在一起并抛出 `Unexpected non-whitespace character after JSON at position …`，被归类为不可重试的 `PI_AI_ERROR`。

## 决策

- `routeAuth` 包装已安装的 `anthropic` catalog resolver（`anthropicKeyFirst`）：只要设置了 `ANTHROPIC_OAUTH_TOKEN` 或 `ANTHROPIC_API_KEY`，`ANTHROPIC_AUTH_TOKEN` 对它不可见；单独存在时，bearer token 仍用于认证。pi-ai 自身的解析、已存储凭据路径与标头构造保持不变。
- 物化探测经由同一个 `ambientNamesInPrecedence` 遍历提供方的环境名，因此主机与被同步的远端选中同一凭据。
- `classifyPiAiError` 把 JSON 帧解析失败映射为 `TRANSPORT`：请求本身有效，字节在传输中损坏，因此默认重试策略会重试。

## 考虑过的替代方案

- **像 Anthropic SDK 同时给出两个选项时那样发送两个标头**——否决：拒绝请求的网关无论有无 `x-api-key` 都会校验 bearer。
- **在客户端容忍未分隔的 SSE 帧**——否决：这是为了迁就一个上游缺陷而改写提供方流；重试即可抵达健康路径，无需自己维护解析器。

## 后果

只导出 `ANTHROPIC_AUTH_TOKEN` 的 Claude Code 式配置继续使用 bearer 认证；同时导出密钥却需要 bearer token 的部署应显式点名（`apiKeyEnv: ANTHROPIC_AUTH_TOKEN`、`authMode: bearer`）。由 `tests/dynamic-config.spec.ts`（请求标头与物化）和 `tests/convert.spec.ts`（归类）固定。
