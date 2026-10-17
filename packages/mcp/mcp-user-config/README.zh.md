# @deepseek-ai/dsh-mcp-user-config

[English](README.md) | 中文

构建在 host 拥有的 `mcp` 设置 namespace 之上的命名的 Cordis 插件对。provider 为每条配置的服务器挂载一个宿主共享的 `mcp-client` owner——整个宿主上每个服务器只有一条连接——各预设的 consumer 则挂载 registrar 子插件，把共享连接的工具投影到该预设自己的作用域 `ctx.tools` 层。设置页（`dsh-client-ui-settings-mcp`）编辑同一 namespace，并通过本包的 `mcpManagement` Remote 读取实时状态。

## 用法

在 host/base scope 中以 `role: provider` 挂载一次同一个命名插件，然后从每个应该接收 MCP 工具的 Profile 中以 `role: consumer` 挂载它。provider 拥有唯一的 `mcp` 设置注册；每个 consumer 拥有自己的子客户端：

```ts
import {
  Config,
  apply,
  inject,
  name,
} from '@deepseek-ai/dsh-mcp-user-config'

declare const ctx: { plugin(...args: unknown[]): Promise<unknown> }
declare const profileContext: typeof ctx

await ctx.plugin({ name, inject, Config, apply }, { role: 'provider', servers: [] })
await profileContext.plugin({ name, inject, Config, apply }, { role: 'consumer', servers: [] })
```

provider 的组合配置是 base 层。用户拥有的值放在 `$DSH_HOME/settings.yaml` 的 `mcp` namespace 下：

```yaml
mcp:
  servers:
    - id: github
      serverName: github
      transport: stdio
      command: npx
      args: ['-y', '@modelcontextprotocol/server-github']
      env:
        GITHUB_TOKEN: '<write-only value>'
    - id: local-docs
      enabled: false
      serverName: local-docs
      transport: streamable-http
      url: http://127.0.0.1:3000/mcp
```

shipped Standard、Code 与 Cordis Profile 会挂载 consumer，Minimal 不会。自定义 Profile 仍自行决定是否包含此插件。

## 配置

`Config` 是单一命名插件的 row schema。`role` 默认为 `consumer`；provider row 使用 `servers` 作为组合 base，而 consumer row 保持 `servers` 为空。`SettingsConfig` 是 provider 的 `mcp` 设置 section schema。`servers` 数组默认为空，每个 `enabled` 字段默认为 `true`。

| 字段 | 传输 | 必填 | 描述 |
|---|---|---|---|
| `role` | 两者 | 否 | `provider` 注册共享设置 scope；`consumer` 读取它并挂载 Profile-local 子插件；默认 `consumer` |
| `id` | 两者 | 是 | 每个世代内配置服务器的稳定标识；`[A-Za-z0-9_-]{1,64}` |
| `enabled` | 两者 | 否 | 禁用的条目不会挂载，也不会 disclosure 工具；默认 `true` |
| `serverName` | 两者 | 是 | `mcp-client` 使用的稳定模型工具 namespace；`[A-Za-z0-9_-]{1,32}` |
| `transport` | 两者 | 是 | `stdio` 或 `streamable-http` |
| `command` | stdio | 是 | 传给 MCP SDK transport 的可执行文件 |
| `args` | stdio | 否 | 直接传给子进程的参数；默认 `[]` |
| `env` | stdio | 否 | 子进程额外环境变量；默认 `{}`，并作为 secret 字段脱敏 |
| `cwd` | stdio | 否 | 子进程工作目录；默认 `''` |
| `url` | streamable-http | 是 | MCP endpoint URL |
| `headers` | streamable-http | 否 | 请求 headers；默认 `{}`，并作为 secret 字段脱敏 |
| `toolCallTimeoutMs` | 两者 | 否 | 每次工具调用超时；默认 `60000` |
| `maxInstructionBytes` | 两者 | 否 | 包含服务器归属的 UTF-8 字节预算，须为正安全整数；默认 `32768` |
| `failOnStartupError` | 两者 | 否 | 让该子插件向桥接报告启动失败；默认 `false` |
| `reconnect` | 两者 | 否 | 现有 `mcp-client` 重连策略；默认启用、500 毫秒、30000 毫秒和 10 次尝试 |

完整数组中的 `id` 和 `serverName` 必须分别唯一。缺少传输字段、使用了不适用的传输字段、重复标识、未知字段和无效的子插件选项都会在挂载子插件前 fail closed。被拒绝的设置写入会保留上一次正确的 resolved section。

## 生命周期

- provider 验证并仅注册一次 `mcp`，随后为每条设置条目挂载一个 `McpOwnerPlugin` 子插件——禁用条目也包含在内，以停止状态存在，使启用写入不会引发 fiber 竞争。owner 经由机群链串行挂载，只有配置签名变化（而非瞬时重连状态）才会精确重挂载变化的 owner。
- 某个 owner 的连接或启动失败由机群步骤遏制，并记录只含稳定标识与错误类型的日志；不相关的 owner 继续启动。`failOnStartupError` 是独立模式开关，对共享 owner 不生效。
- consumer 为捕获世代快照中已启用且选中的每条条目挂载一个 `McpRegistrarPlugin` 子插件。registrar 按设置 id 附接到活的共享连接，并在注册表每次推送时重新同步其作用域工具注册；它从不拥有传输层。
- 重命名服务器的 `serverName` 会保留设置 id——即共享连接槽位——而公开 namespace 随之移动。固定世代保留其捕获的成员选择；从设置中移除的槽位使其所有 registrar 以 `unknown server` 失败，服务器的 instructions 跟随活的连接而非捕获的世代。
- 设置变更推进 provider 拥有的世代标识。下一次 Profile 组装捕获新设置；已有 consumer 保留其 registrar 直到所属作用域释放。密钥不进入世代签名或目录 descriptor。
- consumer 释放时等待所有 registrar；provider 释放时等待机群并关闭每条共享连接。`mcp-client` 核心负责进程关闭、工具与资源注销、capability 更新和 server-name reservation 释放。
- 两个 role 都声明 host 可用的 `settings` 和 `tools` injection。provider 使用 `settings`；consumer 使用 `ctx.get()` 读取可选的 `mcpUserConfigSettings` service，并使用注入的 `tools` scope。`minimal` 可以省略 consumer，因此不会接收 MCP 工具。

## 管理 Remote

`McpManagementService`（Typert namespace `mcpManagement`，两个操作都以 `harniverse.administer` 门禁）为设置页投影机群状态：

| 操作 | 结果 |
|---|---|
| `status()` | 每条设置条目一行：稳定 id、`serverName`、传输方式、实时连接状态（`connecting`/`connected`/`reconnecting`/`exhausted`/`stopped`/`disposed`，或 `disabled`）、失败尝试计数、当前工具清单以及当前连接世代的纪元 |
| `restart(serverId)` | 重建一条已启用服务器的共享连接；校验（`unknown server`、`server "X" is disabled`）位于机群步骤，重启无法绕过设置 |

## 消费的服务

| 服务 | 用途 |
|---|---|
| `ctx.mcpUserConfigSettings` | 读取捕获的世代快照；独立 consumer 读取当前设置 |
| `ctx.mcpConnections` | owner 创建、registrar 附接的共享连接注册表 |
| `ctx.capabilities` | 可选的私有世代捕获及服务器选择集成 |
| `ctx.tools` | 每个 registrar 都需要它来注册模型工具 |

## 模型体验

### 用户配置的 MCP 工具

#### 模型看到的内容

发现完成后，模型看到带 namespace 的 `mcp__<serverName>__<rawName>` 工具、选中服务器的 instructions，以及 Host 挂载 `mcp-resources` 时提供的共享资源工具。每个客户端通过 capability adapter 同时公开工具、具体资源与模板成员。

#### Token 影响

每个启用服务器都会在每次请求中贡献其已发现工具的数据相关 schema 成本。禁用或失败的条目不会贡献工具 schema；namespace 前缀会为每个可见定义和调用增加 token。

#### KV Cache 影响

只要捕获服务器的已发现工具及 instructions 不变，前缀就保持稳定。设置编辑改变未来世代；已有 Session 及加入其世代的子 Agent 保留原有组合。

## 已知限制与暂缓事项

- MCP 服务器自定义 prompts 仍暂缓实现。资源需要 Host 拥有的 `mcp-resources` 服务。
- 被替代的 Profile 世代在所属常驻作用域释放前保留 registrar；世代回收由 `agent-presets` 负责。
- 只有 wire consumer 请求 `ctx.settings.describe({ redactSecrets: true })` 时，设置 descriptor 才是安全的；`env` 和 `headers` 已使用 `role('secret')` 声明以支持该脱敏路径。
- Host/base 拥有 provider row，Standard、Code 与 Cordis 拥有 consumer row。自定义组合必须保留这个单 provider、scoped consumer 划分。
- 固定世代乘搭活的共享连接：捕获后被重命名的服务器同样向旧 registrar 暴露新的公开 namespace，被移除的槽位会搁浅它们直到作用域释放。
- 管理 Remote 只报告状态、不推送状态。设置页在打开期间每 5 秒轮询 `status()`，而非订阅机群事件。
