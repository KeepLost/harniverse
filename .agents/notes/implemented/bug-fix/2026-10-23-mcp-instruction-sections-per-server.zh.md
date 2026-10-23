# Agent Note: MCP instructions 小节按服务器区分,而非按预约键

Status: implemented

[English](2026-10-23-mcp-instruction-sections-per-server.md) | 中文

## 背景

启动日志在配置了两个及以上 MCP 服务器时,每次启动都会报:

```
mcp-client-registrar Error: prompt section "mcp:mcp-user-config-1" is already registered in this scope
```

## 诊断

`mcp-user-config` 消费者为每个 profile 世代铸造**一个**预约键
(`mcp-user-config-<n>`),并把它传给自己挂载的每一个 registrar(每台启用的
服务器一个)。`exposeScopedServer` 用 `reservationKey ?? serverName` 推导
instructions 小节的 owner,于是同一世代内所有服务器的小节名都塌缩成
`mcp:<key>`。第一个 registrar 占住名字;之后每个 registrar 的
`systemPrompt.section()` 在 `ctx.inject` 回调里抛错。fiber 机制会兜住该拒绝
(registrar 的工具与资源仍会注册——它们是独立的 effect),因此可见损害是
启动错误日志,加上第一台之后所有服务器的归属 instructions 丢失。

预约名本身(`<key>:<serverName>`,mcp-client `registrar.ts` / `index.ts`)
早已按服务器区分;只有小节 owner 丢掉了公共名。standalone 实例不受影响:
无预约键时 owner 就是 `serverName`,而它的重复会在任何小节注册之前被根
预约拒绝。

## 变更

`packages/mcp/mcp-client/src/exposure.ts` — instructions 小节 owner 现在与
预约身份一致:`reservationKey === undefined ? serverName :
`${reservationKey}:${serverName}``。一个预约键服务多台服务器时,每台服务器
各占一节。`server-context.ts` 的 owner JSDoc 与两份包 README 说明了带键的
小节名。

## 验证

- RED→GREEN:`mcp-client/tests/server-context.spec.ts` 以同一个共享预约
  owner 挂载两个 `exposeScopedServer`,断言两个 instructions 小节独立渲染
  与独立销毁;修复前失败(`Notes instructions.` 缺失),修复后通过。
- RED→GREEN:`mcp-user-config/tests/generation-composition.spec.ts` 通过真实
  Loader 引导内置 MCP 行,配置两台服务器,断言 Standard 世代组装出的提示词
  同时携带两个 `### MCP server: <name>` 归属,且两台服务器的资源调用都
  成功;修复前失败,修复后通过。
- `mcp-client` + `mcp-user-config` 全量套件:222 通过。

## 否决的替代方案

- 消费者按服务器铸造预约键:否决——该键同时命名根预约,一个消费者一个
  owner 身份让 fleet 记账保持简单;塌缩的推导只有小节名一处。
- 让 `SystemPrompt.section` 自动给重复名加后缀:否决——静默遮蔽会掩盖真实
  冲突,而不是在拥有该身份的窄边界上失败。
