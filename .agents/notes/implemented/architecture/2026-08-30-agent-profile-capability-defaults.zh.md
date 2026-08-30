# Agent Note：已发布 Agent Profile 能力默认值

Status: implemented

[English](2026-08-30-agent-profile-capability-defaults.md) | 中文

## Problem

已发布 Profile 的能力列表没有表达一致的能力策略。Minimal 仍携带不符合评测用途的辅助工具与持久化 shell，而 Standard 系列没有启用产品契约中描述的用户扩展和 Web 能力。用户配置也缺少一个 plugin-native 路径来发现多个 MCP server 与方言专属 Hook。

## 决策

四个已发布 Agent Profile 具有不同的模型可见契约：

| Profile | 契约 |
|---|---|
| Minimal | POSIX `bash` 或 Windows `pwsh`，以及 `str_replace_editor`；不提供模型可见的 Skills、MCP、Hooks、持久化上下文、Web、subagent、artifact、history 或直接压缩控制。 |
| Standard | 一方 coding、context、task、workflow、Web、Skills、Hooks 与 MCP 能力，但不含 Cordis 自定义能力和 `run_code`。 |
| Code / PTC | 通过 `run_code` 呈现 Standard 的逻辑能力，不含 Cordis 自定义能力。 |
| Cordis / 创造 | Standard 加上 Cordis runtime inspection、插件实验和 preset authoring 能力。 |

Standard 仍是默认 Profile，四个 Profile 都继续通过 Profile composition 与 capability selection 支持用户自定义。

## Minimal 恢复

Minimal 挂载 lossless compaction Provider 及其内部 summary-DAG projection。因此上下文压力可以触发由 runtime 拥有的压缩，但模型不会收到压缩命令、history query、session query 或 delivery 工具。模型可见工具列表始终严格为平台 shell 与 `str_replace_editor`。

## 用户扩展

Standard、Code 与 Cordis 挂载现有 filesystem Skill discovery 和 Skill tool，因此用户与项目 Skills 会主动加载，且默认向模型披露 catalog。现有 capability member restriction 可以禁用单个 Skill 条目；禁用条目不会出现在模型可见 catalog 中。不新增 Skill 专用读取 ACL。

这些 Profile 同样挂载两种 Hook 方言桥接。没有显式 `configPath` 时，每个事件都会读取新的不可变 snapshot。默认来源包括 `$DSH_HOME/hooks` 下的方言专属用户文件，以及会话 cwd 下 `.dsh/hooks` 中的方言专属项目文件。通用的 `user`、`project`、`plugin` 与 `policy` source list 可以覆盖单个默认层，`disabled: true` 或 `enabled: false` 会省略 Hook group 或 command。Minimal 不挂载任一桥接。

base composition 拥有一个 `mcp` settings Provider。Standard、Code 与 Cordis 各自挂载 scoped user-config consumer，读取 `$DSH_HOME/settings.yaml`，为每个启用服务器创建一个真实的 `mcp-client` 子插件，主动披露 namespace 工具，并隔离子插件失败与释放。禁用条目不会创建子插件或工具。不同 Profile consumer 可以通过内部 reservation owner key 暴露相同配置的公开 namespace；直接重复的 MCP row 仍保留原有加载时拒绝语义。Minimal 不挂载 consumer。

## Web fetch

Standard、Code 与 Cordis 明确暴露 `web_search` 与 `web_fetch`。本地 HTTP fetch Provider 会校验协议和 URL 凭据，拒绝非公开的字面或解析地址，检查全部 DNS 答案，在保留 Host/SNI 的同时将 Node 直连固定到已校验地址，拒绝 redirect，并保持有界响应解码。`maxRedirects` 固定为零。Firecrawl fetch 仍为显式 opt-in；已发布 base 只使用 Firecrawl search，因此 provider 参数不能绕过本地公开目标策略。Minimal 不挂载模型可见 Web 工具。

## 权限姿态

支持的权限模式仍为 `read-only`、`workspace-write` 与 `danger-full-access`。本实现不新增全局扩展目录读取 ACL，不改变 Skill loader 的读取路径，也不把读取、执行和网络权限拆成新的控制项。现有单租户 filesystem 姿态继续有效：可读取路径在进程和操作系统边界允许时即可读取，写入策略仍由 sandbox 所有。

## 验证

已发布 Web Loader composition 验证 Profile 矩阵、用户 MCP 的主动发现与披露、方言专属 Hook discovery、Minimal 排除，以及 Code SDK 呈现。Hook parser 与 bridge suite 覆盖来源默认值、按 session cwd、不可变刷新、隔离失败和禁用条目。MCP suite 覆盖 settings 所有权、多子插件生命周期、失败隔离、禁用条目、secret 脱敏和独立 Profile consumer。Web fetch 测试覆盖公开地址策略、DNS 答案校验、直连传输、redirect 拒绝、响应边界，以及通过仅测试使用的 loopback seam 进行的真实工具集成。交付前仍必须通过 package type check、lint、build 和无 key assembled test。

## Alternatives considered

**保留旧 Minimal composition。** 这样会保留持久化 shell 状态和辅助工具，但能力评测 Profile 就会依赖它本应排除的上下文控制和 session service。

**在 base composition 中挂载用户 MCP 与 Hook 集成。** 这样会简化 Standard 系列的发现，却会把模型可见扩展泄漏到 Minimal，并破坏 Profile 作用域所有权。当前设计将 MCP settings provider 留在 base，将 consumer 留在选中的 Profile；Hook bridge 则继续作为 Profile row。

**默认启用 Firecrawl fetch provider。** 远程 provider 可以在本地公开地址策略之外抓取模型提供的任意 URL。因此已发布 base 保持 Firecrawl fetch 仅显式启用，并将加固后的直连 HTTP provider 作为默认 fetch 路径。

## 后果与限制

主动披露用户扩展会增加 request schema 与上下文大小，也可能将描述不佳的用户命令展示给模型。MCP stdio server 与 Hook command 仍是受信任的外部进程；失败隔离不等于 sandbox。通用 Hook discovery 不声称支持未经确认的产品专属路径，也不提供 trust/approval layer。全路径读取是单租户部署的有意选择，不是群聊隔离方案；未来远程执行 Provider 属于独立决策。

本 note 取代 shipped-roster note 中 MCP 仅为 dependency、fetch 禁用的默认值，也取代早期 Minimal persistent/bare/no-compaction note 中关于 Web 的部分。standalone JSON-RPC 示例继续使用独立的进程所有 composition，除非未来专门决策改变它。
