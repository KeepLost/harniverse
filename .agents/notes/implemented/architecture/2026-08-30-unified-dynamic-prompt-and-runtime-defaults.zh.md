# Agent Note: 统一动态提示词上下文与内置运行时默认值

Status: implemented

[English](2026-08-30-unified-dynamic-prompt-and-runtime-defaults.md) | 中文

## Problem

内置 Agent Profile 描述的是不同能力，但不能仅因为某个 Profile 的能力 roster 更小，就让它采用另一套 persona 或运行时提示词机制。静态系统段落混合了稳定身份、session 专属 checkout、Web 表层和 persona 事实。用户 Hook 兼容桥默认加载，工作区指令发现支持 Claude Code 文件名，TODO 自动续作也被记录为没有进一步语义区分的插件用户消息。

## Decision

所有内置 Profile 使用同一套 `dsh-system-prompt` 组装路径。稳定身份使用静态 system section `You are an AI agent powered by Harniverse.`。deployment persona、作用域内的 `dsh-persona` persona、harness checkout 上下文和 Web 表层上下文都改为动态上下文，并组装进持久化 runtime-context snapshot。Minimal 只通过自身挂载的能力与其他 Profile 区分，不使用独立的静态 persona、complete prompt 路径或 runtime-context 抑制器。

deployment persona 与作用域内 Profile persona 使用同一个命名的动态上下文槽位 `deployment:persona`。作用域内 persona 通过正常的作用域优先级替换 deployment 值，`{{model}}` 与 `{{cwd}}` 在组装时插值。已交付 Profile 行不再通过 `complete` 或 `includeRuntimeContext` 实现能力差异。

checkout 与 Web 表层文本保留既有措辞和顺序，但通过 `systemPrompt.context()` 而不是 `systemPrompt.section()` 注册。Web 与 checkout 上下文继续受现有 Web 表层配置控制。子 agent persona 覆盖也使用同一动态上下文注册与作用域遮蔽机制。

Claude Code 与 Codex 兼容桥保留显式启用能力，但在所有已提交的 shipped composition 中默认禁用，包括 ACP 示例组合。Cordis 原生 Hook 扩展点不依赖这些桥，保持独立。

工作区指令 loader 的内置项目文件名为 `AGENTS.md` 与 `AGENTS.local.md`。即使显式列出，`CLAUDE.md` 与 `CLAUDE.local.md` 也会被拒绝；无关的同目录自定义候选名仍可配置。固定用户全局文件仍是 `$DSH_HOME/AGENTS.md`，不修改仓库中的 `CLAUDE.md` 符号链接。

TODO 自动续作为了兼容当前 Session surface 与协议，仍表示为 user-role 消息，但其插件 source 增加 `form: 'system-injection'`。默认续作会说明这是系统自动注入而非用户请求，并要求模型在所有工作完成后把每个 TODO 标为 `completed` 再停止。显式的 `autoContinueMessage` 仍由调用方拥有其文本。UI 与 Trajectory 的 source 展示会显示专用 form，而未知 form 继续降级为不透明内容。

## Verification

system-prompt、persona、agent-loop、app-boot、Web-app、subagent 和 shipped-composition 测试固定静态身份、动态上下文顺序、作用域遮蔽、首次请求组装以及 Minimal 的共用加载路径。Hook、agent-instructions、TODO、runtime provenance、conversation 和 Trajectory 测试固定禁用默认值、拒绝 Claude Code 候选、system-injection source、完成提示和面向用户的标记。生成的 catalogs 与 graph 文档已从当前源码刷新，并通过新鲜度门禁。

## Alternatives considered

**让 Minimal 保持静态 complete persona。** 不采纳，因为能力 roster 更小不构成第二套提示词组装机制的理由。这会让 Prompt 行为取决于 Profile 实现，而不是挂载的能力。

**为 `dsh-persona` 增加 `dynamicContext` opt-in 开关。** 不采纳，因为所有已交付 persona 都需要同一行为；开关会保留不必要的双路径，并给未来 Profile 漂移留下入口。

**为 TODO 续作新增 Session system-message 事件。** 本次不采纳，因为现有 Session surface、delivery 和 wire 路径已经用 user-role 表示注入上下文。source 元数据可以表达生产者和展示语义，无需改变持久协议。

**删除 Hook bridge package，而不是禁用配置行。** 不采纳，因为显式兼容使用仍受支持，且 bridge 实现本身独立于 shipped default。

**只移除 CLAUDE 默认值，但允许显式配置 CLAUDE 候选。** 不采纳，因为这会保留本次决策要移除的支持，使实际契约取决于隐藏配置。

## Consequences

首次请求在 `request.system` 中保留 Harniverse 身份与其他静态工具引导；checkout、Web 定位和 Profile persona 出现在有日志记录的动态 runtime-context 消息中。persona 移入动态上下文后受现有 snapshot 生命周期管理，因此显式关闭全部 runtime context 的 deployment 不能用该设置实现内置 Profile。既有 Session raw log 仍保留历史 CLAUDE 内容；loader 不删除历史，但当前发现和恢复对账不再加载这些名称。

Hook 兼容能力在 shipped default 中保持显式启用，而 Cordis 原生 Hook 继续独立运行。TODO 续作无需引入新的 Session 角色或事件，就能在持久数据和 UI 中与人工用户消息区分。UI 对新 form 使用专用标记，并保留对未来 form 的不透明回退。
