# Agent Note：Wave-6 MCP manager 吸收（probe、watch、插件注册服务器）

Status: implemented

[English](2026-11-11-wave6-mcp-manager-absorption.md) | 中文

## Problem

上游 `dsh-mcp-manager`（0.2.2 线）携带三项 harniverse `mcp-user-config` 插件对缺失的机群能力：不挂载即可测试单条服务器配置的 `probe`、向管理面推送机群变更的 `watch` 流、以及在注册插件生命周期内加入机群的插件自带服务器。harniverse 已有 status/restart Remote 与共享连接；这三个差量即吸收目标（台账行 5,差量 2/3/4）。

## Decision

把三者全部吸收到既有的机器自有机群上，保留 wave-3 的配置所有权分歧与 W07 的宿主共享连接 + scoped-registrar 模型：

- **`probeServer(config, options)`** 以独立导出进入 `dsh-mcp-client`：经共享传输工厂连接、读取服务器身份、在显式上限（`timeoutMs` 整体预算、`maxPages`、`maxToolNames`、`signal`）下分页 `tools/list`、在有界宽限内关闭。它不注册任何东西、不占用命名空间；失败以阶段分类的 `McpProbeResult`（新增公共 `./types` 子路径）返回，并附独立结算的关闭结果，而不是抛出异常。
- **`mcpManagement.probe(serverId)`**（`harniverse.administer`）探测任意已配置或已注册条目——禁用条目同样应答，设置页可在启用前先试连。
- **`watch` 以 `mcpManagement/fleet-changed` 落地**：上游流依赖 stream 模式 Remote，而 harniverse 的 typert 协议没有该模式。管理服务改为订阅共享连接注册表（成员关系与 owner 替换）加上每条活句柄的变更馈送（状态迁移），并在每次变更提交后发出一个无载荷、隔离监听器的 `@mode emit` cordis 事件。该事件加入 `API_REMOTE_FORWARDED_EVENTS`；设置页收到后立即重新联表，并保留 5 秒轮询兜底。
- **插件注册**：`ctx.mcpUserConfigRegistrations.register(serverName, entry)` 为调用方插件的生命周期贡献一台服务器。entry 携带除 `id`/`enabled`/`serverName` 之外的全部配置字段，按配置条目同等校验，以铸出的 `registered-<serverName>` id 挂载，并与 Settings 双向共享 `serverName` 命名空间——注册拒绝已配置的名字，设置校验器（闭包引用活注册集）也拒绝已注册的名字。移除——返回的 disposer 或拥有包裹 `ctx.effect` 的插件 fiber——等待共享 owner 拆卸完成，因此工具在插件释放结算前已撤下。已注册服务器以只读方式进入能力目录（`manageable: false`）、在全局面上为每个预设挂载 scoped registrar（consumer 跟随活注册集而非其捕获世代）、在 `status()` 行携带 `source: 'registered'`，且绝不渲染为可编辑的设置行。
- 设置页为每张卡渲染 probe 动作（probing/done 视图带本地化摘要）、注册徽标（有机群动作但无编辑/删除/开关），并在每次转发的机群变更上重新联表。

## Alternatives considered

**逐字移植上游 watch 流。** 拒绝：它需要 `@Remote({ mode: 'stream' })`，一次与批次体量严重失称的 typert 协议演进；转发事件 + 重新联表通道在 harniverse 既有线缆上交付同样的用户可见行为。

**让注册走能力捕获路径。** 拒绝：注册是活的插件效应，不是世代作用域的选择——捕获它会在插件释放后搁浅陈旧工具。consumer 跟随活集合，而设置条目保持世代钉定。

## Consequences

插件现在可以随注册向每个预设提供一台 MCP 服务器，设置页可在启用前测试任意条目，机群状态变化在提交瞬间到达页面。状态行新增加性 `source` 判别；catalog、子系统页（`tools.md`/`settings.md`）、api-catalog 与生成的 typert 工件携带新接口。wire 流式仍是已记录的天花板：未来的 stream 模式 Remote 可以替换事件+轮询通道而无需触碰服务缝。
