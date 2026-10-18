# Agent Note: 共享 MCP 连接与按预设作用域注册

Status: implemented

[English](2026-10-14-shared-mcp-connections.md) | 中文

## 问题

经 `mcp` 设置 namespace 配置的 MCP 服务器此前每个预设各跑一条连接：`dsh-mcp-user-config` 的每个 consumer 都挂载自己的 `mcp-client` 子插件，三个预设暴露同一服务器就要孵化三个服务器进程、三次发现、三套重连机——而设置页既看不到也修不了它们。Web GUI 完全没有 MCP 管理面；社区插件 `dsh-mcp-manager-plus` 写的是旧式 `cordis.patch.yml` 行，profile 格式已不再接受。

## 决策

连接是宿主全局的；注册保持按预设。这一切分放在 `dsh-mcp-client` 内部，使两种模式共享同一条暴露路径：

- `McpConnectionsRegistry`（`ctx.mcpConnections`）为每个设置 id 维护一个只管传输的监督器。`McpOwnerPlugin` 把一个监督器作为子 fiber 挂载；它从不注册工具，且其激活在首次连接尝试结束之前就返回——每条连接立即启动并在后台并行推进，慢的或不可达的服务器绝不会拖慢组合启动，也不会拖慢随组合启动的 web 监听。
- `McpRegistrarPlugin` 按设置 id 附接到一条运行中的共享连接，把工具清单投影进自己的作用域 `ctx.tools` 层，公共命名、能力与提示词小节规则与独立模式一致（`exposeScopedServer` 是两种模式共用的唯一暴露路径）。
- `dsh-mcp-user-config` 的 provider 挂载 owner 机群（经机群链串行；只有配置签名变化才重挂载对应 owner）；每个 consumer 为其捕获世代中已启用且选中的条目各挂载一个 registrar。

权限隔离不变：预设仍通过能力组合决定暴露，同一连接上的两个预设可以持有不同的成员选择。按机器的作用域是设计的自然结果——`mcp` 设置 namespace 不参与远程主机同步，连接活在拥有该设置的宿主进程里。

### 语义变化

- 每服务器一个共享 owner：`failOnStartupError` 是独立模式开关；共享 owner 的启动失败由机群步骤遏制，并经注册表暴露。owner 激活从不等待首次尝试——`connection.ready` 在后台落定，后续 owner 的挂载也绝不串行阻塞在一条进行中的尝试后面。
- 重命名 `serverName` 保留设置 id，连接槽位存续而公开 namespace 移动。重命名前固定的世代保留其捕获的成员选择，但跟随活的连接；从设置移除的槽位使其 registrar 以 `unknown server` 失败。
- 服务器的 instructions 提示词小节跟随活的连接，而非捕获的世代。

## 管理面

`McpManagementService`（Typert namespace `mcpManagement`，两个操作都以 `harniverse.administer` 门禁）提供 `status()`——每条设置条目一行，含实时状态、尝试计数、工具清单与连接纪元——以及 `restart(serverId)`，其校验（`unknown server`、`server "X" is disabled`）位于机群步骤，重启无法绕过设置。浏览器插件 `dsh-client-ui-settings-mcp` 在设置 scope、该 Remote 与能力目录的只读预设引用之上渲染设置分区（id `mcp`，order 17）；分区打开期间实时状态每 5 秒轮询。导入接受 OpenCode `mcp` JSON（外加标准 `mcpServers` 形状与单个服务器对象）。

## 验证

- `packages/mcp/mcp-client/tests/shared-connection.spec.ts` 覆盖注册表、owner/registrar 生命周期与连接抖动下的作用域注册（包内 180 测试，每文件 100 % 覆盖率）。
- `packages/mcp/mcp-user-config/tests/` 覆盖机群（重挂载纪律、世代捕获、每服务器一 owner）与 Remote 的投影及校验（40 测试）。
- `packages/client/ui-settings-mcp/tests/` 覆盖注册/HMR 处置、合并店铺、解析器与每个组件分支（90 测试，每文件 100 % 覆盖率）。

## 备选方案

**每服务器一个 registrar 加引用计数。** 注册表本可以只暴露裸连接，让每个 preset 的 registrar 持有自己的传输客户端，最后一个引用离开时关闭。这能让 `mcp-client` 保持 standalone 形态，但一次重连要在每个 registrar 上重放，发现结果可能在同一服务器的不同 Profile 间漂移，而且设置页仍然没有单一的所有者可查询状态。它输给了 owner/registrar 拆分——每服务器付一个 supervisor，状态读取变成注册表的一次读。

**保留每 Profile 连接，只补管理面。** 最初的痛点——一个已配置服务器跑三个进程——将原样保留；管理面要为一条设置项报告三行，`restart` 需要带部分失败语义的扇出。作为绕着真正缺陷打的补丁被否决。

**把注册集中到 owner。** 让 owner 直接暴露工具会使暴露变成 host 全局，破坏权限模型：成员选择是 capability 组合拥有的、按 preset 的决定。registrar 子件保住了这条边界，代价是每个（preset, 服务器）对一个 fiber。

## 后果

无论多少 Profile 选中同一条设置项，host 对每个设置 id 至多跑一条连接——更少的服务器进程、一次发现遍历、一台重连机——但共享所有权使失败语义更粗：启动失败的服务器通过 fleet 步骤上报而不是让挂载它的 Profile 失败，`failOnStartupError` 在 standalone 模式之外不再适用。拆分在 `dsh-mcp-client` 里增加了第二对插件（owner、registrar）和一个注册表服务，fleet 签名重挂载意味着设置编辑会重启受影响的连接而不是就地修补。换来的东西：设置页终于能看到并修复每一条连接，preset 在一条共享传输上保持隔离的成员选择，而暴露契约（`exposeScopedServer`）在 standalone 与共享两种模式间保持单一来源。
