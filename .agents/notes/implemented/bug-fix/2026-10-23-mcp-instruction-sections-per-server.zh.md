# Agent Note: MCP instructions 小节按服务器区分,而非按预约键

Status: implemented

[English](2026-10-23-mcp-instruction-sections-per-server.md) | 中文

## Problem

配置两个及以上 MCP 服务器时,每次启动都会打出 `mcp-client-registrar Error: prompt section "mcp:mcp-user-config-1" is already registered in this scope`,且第一台之后的所有服务器在每个 profile 组合里丢失归属 instructions。`mcp-user-config` 消费者为每个 profile 世代铸造一个预约键(`mcp-user-config-<n>`)并传给自己挂载的每一个 registrar(每台启用的服务器一个),而 `exposeScopedServer` 用 `reservationKey ?? serverName` 推导 instructions 小节的 owner,于是同一世代内所有服务器的小节名都塌缩成 profile 作用域内的 `mcp:<key>`。第一个 registrar 占住名字;之后每个 registrar 的 `systemPrompt.section()` 在 `ctx.inject` 回调里抛错,该拒绝被 cordis 兜住,registrar 的工具与资源(独立 effect)仍会注册,可见损害只剩错误日志与缺失的 instructions。

## Decision

`packages/mcp/mcp-client/src/exposure.ts` 中 instructions 小节的 owner 现在与根预约身份一致:`reservationKey === undefined ? serverName : `${reservationKey}:${serverName}``。一个预约键服务多台服务器时每台各占一节;standalone 实例不变(裸公共名,其重复在根预约处、先于任何小节注册被拒绝)。`server-context.ts` 的 owner JSDoc 与两份包 README 说明了带键的小节名。

## Alternatives considered

**消费者按服务器铸造预约键。** 否决——该键同时命名根预约,一个消费者一个 owner 身份让 fleet 记账保持简单;塌缩的推导只有小节名一处。

**让 `SystemPrompt.section` 自动给重复名加后缀。** 否决——静默遮蔽会掩盖真实冲突,而不是在拥有该身份的窄边界上失败。

## Consequences

- 含 N 台启用服务器的 profile 世代现在携带 N 个互不相同的 instructions 小节(`mcp:<key>:<serverName>`),启动错误与静默丢失消失。
- 带预约键的小节名变长;`mcp:` 前缀除排序外无消费者,不受影响。
- standalone 暴露保持文档记载的 `mcp:<serverName>` 名与既有重复语义。

## Testing

`packages/mcp/mcp-client/tests/server-context.spec.ts` 以同一个共享预约 owner 挂载两个 `exposeScopedServer`,断言两个 instructions 小节独立渲染与销毁;修复前失败(`Notes instructions.` 缺失)。`packages/mcp/mcp-user-config/tests/generation-composition.spec.ts` 通过真实 Loader 引导内置 MCP 行、配置两台服务器,断言 Standard 世代组装出的提示词同时携带两个 `### MCP server: <name>` 归属且两台的资源调用都成功;修复前失败。`mcp-client` 与 `mcp-user-config` 全量套件通过(222 个测试)。
