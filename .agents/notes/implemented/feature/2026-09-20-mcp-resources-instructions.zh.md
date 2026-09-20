# Agent Note: MCP 运行时 —— 资源、服务器 instructions、作用域可见性

Status: implemented

[English](2026-09-20-mcp-resources-instructions.md) | 中文

Scope: `packages/mcp/mcp-resources`, `packages/mcp/mcp-client`, `packages/core/system-prompt`

## 问题

蓝图 W07 要求 MCP 运行时的一半：与具备资源能力的服务器进行协议协商、`resources/*` 表面、服务器 instructions 进入系统提示词、作用域化服务器名、对资源同样成立的 Profile 成员收窄、generation 安全刷新、重复 cursor 防护，以及资源表面的模型可见快照。第一批已交付身份/可见性契约（`resource-contract.ts`）但没有运行时：工具是唯一被桥接的能力，`syncTools` 排空分页时也没有防护服务器重复返回同一 continuation cursor 的情况。

## 决策

- **独立的 `mcpResources` 接缝**（`packages/mcp/mcp-resources`）：作用域化提供者按服务器注册（`ScopedLayers` 上的 `NamedEntries`）；运行时拥有三个共享工具（`list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`）与一个列出调用者作用域内可达服务器的 `mcp-resource-servers` 提示词小节。工具比提供者存活得更久 —— 销毁某个服务器只撤回它的提供者。请求经生效作用域映射路由；未知服务器明确报错。
- **连接时捕获 instructions**（`mcp-client/src/connection.ts`）：连接与工具同步成功后，initialize instructions 被修剪、归属（`### MCP server: <name>`）、预算检查（`maxInstructionBytes`，默认 32 KiB，按归属后字节计），并通过逐字提示词小节公开；彻底放弃路径清除它。小节仅在非空时输出。
- **`PromptSection` 的 `interpolate: false`**（`packages/core/system-prompt`）：外部文本（instructions、服务器名列表）逐字保留花括号，而不是在严格插值下失败；该标记随 `AssembledSection` 传递，`renderPrompt` 只跳过被标记的小节。
- **失败被抑制的资源发现**：服务器声明 `getServerCapabilities().resources` 时，连接把分页 `resources/list` 排空到排序的 URI 缓存（cursor 防护）；发现失败记录日志并保留旧缓存。缓存 URI 供 capability snapshot 成员（`mcp-resource` kind）与触发 generation 刷新的名称+URI 变化比较使用 —— 因此资源发现与工具同步一样是 generation 安全的。
- **所有分页排空处的重复 cursor 防护**（`tools.ts` 的 `cursorGuard`）：服务器返回它已返回过的 cursor 时，本次尝试作为无效分页失败，工具与资源皆然。
- **可见性在 wire 层强制执行，而非目录层**：`restrict()` 在工具限制旁记录每作用域资源可见性；注册进 `mcpResources` 的提供者包装沿调用者作用域链解析最近记录并强制执行 —— 读取不可见 URI 的 `resources/read` 抛错，`resources/list` 结果过滤为可见 URI，模板不过滤直接透传（没有可过滤的稳定身份）。非作用域组合不受限制；被卸载的服务器拒绝一切。
- **以无密钥的真实组合证据替代录制快照**：`resources.spec.ts` 启动真实的 stdio MCP fixture 服务器（含字面量花括号的 instructions、文本 + 二进制 + 配置资源、一个模板）并端到端断言模型可见表面；录制快照装置需要提供商密钥，fixture 服务器路径刻意避开它。

## 备选方案

- 把资源保留在 `mcp-client` 内：否决 —— 多个服务器各自注册一个提供者；工具与提示词小节必须共享、作用域化，并能独立于任何单个连接被销毁。
- 对模板列表也按可见性过滤：否决 —— 模板 URI 在 capability 契约中没有成员身份；过滤要么发明身份要么产生误导。
- 通过现有 `tools/change` 流程捕获 instructions：否决 —— instructions 是与连接/放弃生命周期绑定的每连接状态，而非工具集变化。
- 在 `agent/request` 上加每请求包装来强制可见性：否决 —— 强制属于工具实际调用的资源表面，在那里未作用域调用者与未来消费者也被覆盖。

## 后果

`mcp-client` 获得可选的 `mcpResources`/`systemPrompt` 集成，组合时激活；没有它们时桥接行为与之前完全一致。capability descriptor 现在包含资源成员，因此仅针对工具成员编写的 Profile allowlist 继续工作（工具 id 不变），新资源成员在收窄前默认可见。订阅（`resources/listChanged`）未被桥接 —— 缓存在连接、重同步与重连时刷新；已记录为已知限制。分页防护把此前无限排空变成了被抑制的尝试失败。
