# Agent Note: MCP 运行时 —— 资源、服务器 instructions、作用域可见性

Status: implemented

[English](2026-09-20-mcp-resources-instructions.md) | 中文

Scope: `packages/mcp`, `packages/core/system-prompt`, `packages/capability/capabilities`, `packages/preset/agent-presets`

## 问题

蓝图 W07 要求 MCP 运行时的一半：与具备资源能力的服务器进行协议协商、`resources/*` 表面、服务器 instructions 进入系统提示词、作用域化服务器名、对资源同样成立的 Profile 成员收窄、generation 安全刷新、重复 cursor 防护，以及资源表面的模型可见快照。第一批已交付身份/可见性契约（`resource-contract.ts`）但没有运行时：工具是唯一被桥接的能力，`syncTools` 排空分页时也没有防护服务器重复返回同一 continuation cursor 的情况。

## 决策

- **独立的 `mcpResources` 接缝**（`packages/mcp/mcp-resources`）：作用域化提供者按服务器注册（`ScopedLayers` 上的 `NamedEntries`）；运行时拥有三个共享工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）与一个列出调用者作用域内可达服务器的 `mcp-resource-servers` 提示词小节。工具比提供者存活得更久 —— 销毁某个服务器只撤回它的提供者。请求经生效作用域映射路由；未知服务器明确报错。
- **连接时捕获 instructions**（`mcp-client/src/connection.ts`）：连接与发现成功后，initialize instructions 保留字面文本，添加归属（`### MCP server: <name>`），执行预算检查（`maxInstructionBytes`，默认 32 KiB，按归属后字节计），并通过逐字提示词小节公开；彻底放弃路径清除它。小节仅在非空时输出。
- **`PromptSection` 的 `interpolate: false`**（`packages/core/system-prompt`）：外部文本（instructions、服务器名列表）逐字保留花括号，而不是在严格插值下失败；该标记随 `AssembledSection` 传递，`renderPrompt` 只跳过被标记的小节。
- **原子资源发现**：支持资源的服务器在两个分页列表于当前连接内完成后，一起发布排序的具体 URI 与模板列表；失败保留最后成功的列表。资源列表变更通知、连接、工具重同步和重连触发发现。协议协商、版本拒绝与 URI 模板解析由 SDK 负责；工具发现要求协商得到 tools capability。
- **完整结果上限**：发现过程最多 1,024 个标识及累计 1 MiB 分页数据；每次分页最多 128 页，重复 cursor 在请求前拒绝，空 cursor 作为不透明值处理。完整解码资源结果最多 1 MiB（包括二进制和 metadata），模型文本最多 32 KiB（包括归属与截断提示）。渲染掩码二进制 blob、移除协议 metadata，并保留 UTF-8 字符边界。SDK 接收内存分配发生在这些限制之前。
- **请求前授权**：服务器可见性直接使用 Agent key 判断；instructions 和服务器名称使用同一判断。具体资源与 URI 模板有不同的稳定成员 id，列表按成员过滤；读取需要具体授权或 SDK 匹配成功的已授权模板。显式 allowlist 在发现过程和全局设置继承中保持有效。被拒绝的读取不发送 RPC。
- **私有世代捕获**：`mcp-user-config` 通过通用 capability adapter 钩子在 Profile consumer 挂载前捕获设置。公开签名只包含提供者 revision，不包含凭据。设置替换选择新的常驻世代；保留的客户端使用原有配置和授权重连。被排除服务器在子插件激活前省略；目录发现会重试并发设置变更，确保签名与捕获客户端一致。
- **无密钥验证场景**：真实 SDK 协议测试覆盖可接受与不支持版本，以及仅资源服务器启动。Loader/Profile 测试使用内置 MCP 行与真实本地 SDK 服务器，覆盖 Minimal 排除、模板授权、设置替换和保留世代。单元测试断言拒绝时零网络调用与完整字节上限，补充既有 request-header 和 tool-result 的 Session 日志契约。

## 备选方案

- 把资源保留在 `mcp-client` 内：否决 —— 多个服务器各自注册一个提供者；工具与提示词小节必须共享、作用域化，并能独立于任何单个连接被销毁。
- 把展开后的模板 URI 当作具体目录条目：否决，因为参数形成开放集合；独立模板成员改为授权 SDK 匹配成功的展开 URI。
- 通过现有 `tools/change` 流程捕获 instructions：否决 —— instructions 是与连接/放弃生命周期绑定的每连接状态，而非工具集变化。
- 在 `agent/request` 上加每请求包装来强制可见性：否决 —— 强制属于工具实际调用的资源表面，在那里未作用域调用者与未来消费者也被覆盖。

## 后果

Host 拥有共享资源服务，Standard-family Profile 拥有捕获的客户端，Minimal 省略这些客户端。仅工具 allowlist 排除资源与模板；不受成员限制的服务器无需在目录中列出每个展开 URI 即可读取。列表变更通知在捕获世代内刷新拓扑，设置与选择编辑影响未来组装。资源内容订阅和服务器自定义 prompts 仍暂缓实现。被替代的常驻世代按既有 Profile 生命周期保留进程，直至 owner 释放。
