# Agent Note: Web 文件与会话引用

Status: implemented

[English](2026-08-24-web-file-and-session-references.md) | 中文

## 问题

Web 组合器需要一个同时提供工作区路径和既有会话的 `@` 补全面，但 Harniverse Remote 路由要求明确的能力元数据，而现有 session-reference 服务已经拥有快照安全与交付语义。文件选择必须保持为用户编写的路径，不能隐式读取或附加；会话选择必须保留不透明身份和现有不可信快照边界。

## 决策

`@deepseek-ai/dsh-file-reference` 定义纯路径候选约定、语法、提示文本，以及带有 `harniverse.observe` 的认证 `fileReferences/list` Remote。`@deepseek-ai/dsh-file-reference-local` 提供按 Agent 划分的有界工作区搜索：默认排除 `.git` 和 `node_modules`，不遍历目录符号链接，拒绝路径逃逸，遵循调用方取消，并在 `tool/result` 后使索引失效。

`@deepseek-ai/dsh-client-ui-reference` 注册一个浏览器 `@` source。它并发请求文件和会话候选，按文件后会话的顺序并以分组标题渲染；带引号的目录查询保持在文件领域；每个领域的失败都独立降级为空结果。文件选择插入普通 `@path` 文本，目录选择继续补全。会话选择保留服务提供的规范 `@[label](dsh-session:...)` mention 作为原子引用值；身份不会由标题重建。

本地 Provider 只有在有效 Agent 工具注册表暴露 `read` 时，才添加稳定的「声明检查前先读取」指引。session-reference 服务暴露带认证的仅元数据候选，并在其置前的 `agent/pre-step` 监听器中准备规范 mention，把冻结的不可信快照上下文放在可读直接消息之前。Web bundle 显式组合这些包；fixture Remote 面通过同一连接约定提供确定性的文件和会话元数据。

## 考虑过的替代方案

**原样复制官方 UI 和传输包**——不采用，因为 Harniverse 拥有固定的 Web 启动、slot 组合、Remote 认证元数据和现有占位符／引用事务模型。本适配只保留必需约定，并通过 Harniverse 现有 face 进行组合。

**选择文件后立即读取或附加**——不采用，因为补全只负责发现。路径保持为普通提示词文本，模型必须在声称检查前调用有效的 `read` 工具。

**根据展示标题重建会话身份**——不采用，因为标题是可能缺失、重复或变化的元数据。Host 提供的规范 URI 保持为选择和提交时携带的身份。

**把能力加入每个默认组合**——不采用，因为现有 Web composition 拥有该浏览器行为。其他 Profile 保持不变，除非显式挂载 Provider 和 client 插件。

## 后果

路径发现具有有界的本地成本和按 Agent 管理的可释放缓存；直接目录补全读取当前条目且不跟随符号链接。已挂载的本地 Provider 只为真正能够调用 `read` 的 Agent 添加一个可缓存提示段；候选标签和文件内容不会进入模型上下文。

会话引用在 agent pre-step 读取并冻结源快照之前仍然只是元数据。持久上下文继续保留现有不可信警告、投影、保留预算和来源顺序。Remote 在缺少 `harniverse.observe` 时拒绝，fixture 调用覆盖与 client 相同的端点名称和规范 wire 值。

## 测试

专项测试覆盖语法、遍历、排除目录、符号链接与 cwd 隔离、取消、缓存失效、条件化 read 指引、规范会话序列化、pre-step 顺序、文件／会话独立失败、带引号 token、目录继续补全、fixture Remote 路由以及 Web patch 组装的 host／browser 行。Host 和 client Remote 类型检查通过；生成的 Cordis 与 config catalog 已刷新。完整 Web／build 验证仍受本功能之外的基线类型和文档失败限制。
