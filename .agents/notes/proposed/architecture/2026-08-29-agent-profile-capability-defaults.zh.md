# Agent Note: Agent Profile 能力默认值与用户扩展披露

Status: proposed

[English](2026-08-29-agent-profile-capability-defaults.md) | 中文

## 问题

当前交付的四种 Agent Profile 还没有表达它们预期的产品角色。Minimal 携带了不属于受控模型能力评测的辅助能力，而 Standard 系列 Profile 尚未把用户拥有的 Skill、Hook 和 MCP 服务器作为一等默认能力。交付的 Web 工具配置也因为 HTTP provider 尚未执行所需的目标边界而保持 HTTP 抓取关闭。

现有的[交付工具清单决策](../../implemented/feature/2026-07-31-even-out-shipped-tool-rosters.md)记录了早期的共同清单、仅依赖形式的 MCP 集成和关闭抓取的姿态。本提案在相应实现落地后有意取代其中的这些部分；与它们无关的 surface 清单和工具归属决策仍然有效。

## 提案

### Profile 角色

交付的 Profile 使用四种不同的能力契约：

| Profile | 面向模型的契约 |
|---|---|
| Minimal | POSIX 上提供 `bash`，Windows 上提供 `pwsh`，另加 `str_replace_editor`；不提供面向模型的 Skill、MCP、Hook、持久上下文、Web、子代理、产物、历史或直接 compaction 控制。 |
| Standard | 提供一方编码、上下文、任务、工作流、Web、Skill、Hook 和 MCP 能力，但不含 Cordis 自定义能力和 `run_code`。 |
| Code / PTC | 通过 `run_code` 呈现 Standard 的逻辑能力集，不含 Cordis 自定义能力。 |
| Cordis / 创造 | 在 Standard 之上增加 Cordis 运行时检查、插件实验和 preset 创作能力。 |

Standard 仍然是默认 Profile。四种 Profile 都继续通过现有的 Profile 组合和能力选择机制支持用户自定义。

### Minimal 的 compaction

Minimal 加载自动 compaction Provider 及其内部 summary-DAG 投影。当上下文压力要求恢复时，运行时强制执行 compaction，不向模型暴露 compaction 工具或时机选择。Minimal 不挂载直接 compaction、compaction-history、session-query 或跨会话 delivery Consumer。其内部 Session log 和 summary DAG 仍由运行时用于当前上下文重建；这不意味着提供面向模型的历史 API。

### 用户扩展

Standard、Code 和 Cordis 默认自动发现并加载用户配置的全局 Skill、Hook 和 MCP 服务器。它们默认面向模型主动披露：发现的 Skill 将其目录加入模型请求，发现的 MCP 服务器将其带命名空间的工具定义加入模型请求。用户可以禁用单个已配置条目；被禁用的 Skill 或 MCP 条目不会出现在面向模型的披露中，被禁用的 Hook 不会生效。

Skill provider 继续读取现有的项目、用户、自定义和内置根目录。全局 Skill 目录不会获得新的 ACL 或特殊文件系统能力；它们按照当前进程和操作系统权限已经提供的全路径读取行为保持可读。本提案改变发现和披露默认值，不改变文件系统读取策略。

MCP 配置由用户拥有，可以描述多个服务器实例。组合桥接读取服务器清单，并为每个条目创建一个 MCP client 实例，同时保留现有的按服务器限定工具名和连接生命周期。Minimal 不加载或披露用户 MCP 条目。

Hook 发现覆盖项目、用户、插件和策略配置层，并在支持的配置发生变化时刷新活动集合。Hook 策略仍是拦截、审计和脱敏机制；在拥有广泛进程、文件系统或网络访问权时，它不是防止秘密披露的绝对保证。

### Web 抓取

Standard、Code 和 Cordis 在 HTTP provider 拒绝不安全协议、凭据、环回与私有目标、元数据端点、解析后的无效地址以及不安全重定向后，挂载面向模型的 Web 搜索和抓取能力；这些检查由一套有界请求策略统一执行。Minimal 不挂载面向模型的 Web 能力。网络级出站控制仍属于部署责任。

### 权限姿态

三种权限模式仍为 `read-only`、`workspace-write` 和 `danger-full-access`。本变更不增加全局扩展目录读取 ACL，不改变 Skill loader 的读取路径，也不把读取、执行和网络权限拆成新的独立控制。在当前单租户姿态下，可读取路径仍然依据进程和操作系统边界保持可读。

## 考虑过的替代方案

**把 Minimal 保持为缩减版 Standard 组合。** 不予采纳，因为能力评测需要刻意收窄的面向模型契约，而不是隐藏了偶然上下文和恢复工具的 Standard 树。

**加载用户 Skill 和 MCP 但默认不披露。** 不予采纳，因为 Standard 的目的就是让已配置的用户能力立即对模型可用。用户可以在不应披露时禁用单个条目。

**继续把 MCP 作为依赖而不提供用户清单桥接。** 不予采纳，因为这样即使 MCP client 已支持所需的逐服务器生命周期，已配置的 MCP 服务器仍不会成为 Standard 系列的交付默认能力。

**为全局 Skill 目录增加特殊读取权限。** 不予采纳，因为当前沙箱和文件系统语义在单租户部署中有意允许读取所有可读路径。第二套读取策略既不能保护目标威胁模型，还会使权限契约复杂化。

**在加强目标校验前启用 HTTP 抓取。** 不予采纳，因为在 provider 边界执行协议、解析、目标、重定向和响应处理校验之前，由模型选择 URL 就是 SSRF 原语。

**把 Hook 当作完整的秘密泄漏防护边界。** 不予采纳，因为替代命令、子进程、编码方式和网络路径都可能绕过有限的 Hook 规则集。Hook 作为纵深防御存在，而不是唯一隔离机制。

## 验收标准

- 四个装配后的 Profile 暴露上述精确的面向模型能力契约，包括 Minimal 的平台相关 Shell 和隐藏的内部 compaction。
- Standard、Code 和 Cordis 默认加载用户 Skill、Hook 和 MCP 条目；逐项禁用的条目从相关活动集合或面向模型集合中消失。
- 全局 Skill 的发现和加载继续使用既有文件系统语义，不新增读取 ACL 或路径限制。
- Minimal 不提供面向模型的 Skill、MCP、Hook、持久上下文、历史、直接 compaction、Web、子代理、产物或其他上下文控制工具。
- HTTP fetch provider 拒绝不安全目标和重定向，装配后的 Standard 系列 Web Profile 只暴露加固后的抓取行为。
- Profile 组合、Skill、MCP、Hook、Web 策略、无密钥快照、构建后的 Web 和真实可运行入口测试覆盖默认值与退出选项。

## 风险

用户提供的 MCP 服务器和 Hook 可能在发现或激活时失败，并且可能在本地 Shell 沙箱之外运行，因此启动和刷新必须隔离失败并提供可操作的诊断。全局主动披露会增加提示词和工具 schema 大小，也可能把描述不佳的用户扩展暴露给模型。Web 目标校验必须与 DNS、重定向、代理行为和部署网络保持一致。有意保留的全路径读取姿态不适合不受信任的多用户部署；未来的远程执行边界属于单独的部署决策，不在本提案范围内。
