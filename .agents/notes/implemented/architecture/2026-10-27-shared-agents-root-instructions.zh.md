# Agent Note: 共享 agents 根加入用户全局指令链

Status: implemented

中文 | [English](2026-10-27-shared-agents-root-instructions.md)

## Problem

指令加载器只读取一个用户全局文件 `$DSH_HOME/AGENTS.md`。同时使用多个 agent 工具的人会把跨工具共享的指令放在共享 agent 配置根（`~/.agents/AGENTS.md`，或 `$DSH_AGENTS_HOME`）—— `dsh-skill-filesystem` 已经在那里扫描技能。这些指令只有复制或符号链接进 harness 主目录才能到达 harness —— 把单一事实源复制进 harness 拥有的数据，且无法分辨会话加载的是哪一份。

## Decision

用户全局指令作用域有两个有序根：先是 `$DSH_HOME/AGENTS.md`，然后是 `<agentsHome>/AGENTS.md`。`dsh-home-paths` 的 `resolveAgentsHome` 与 `agentsHomeDisplay` 拥有该解析（配置值、`$DSH_AGENTS_HOME`、`~/.agents`，波浪号展开与空白环境变量处理与 harness 主目录一致），因此 `dsh-agent-instructions` 与 `dsh-skill-filesystem` 都通过同一个共享解析器解析。

两个文件构成一个去除空白后的内容去重组：内容相同的共享根文件（包括常见符号链接布局）只从 harness 主目录渲染一次，并在该保留副本变更或消失时被提升 —— 基线去重与动态对账使用同一个组键。harness 主目录文件保留已记录的 `user-global` 作用域键；共享文件携带 `agents-global`，因此外部编辑、删除或新建文件都以普通转换出现，而不是新基线。名为 `user-global` 或 `agents-global` 的项目目录通过 `./` 显示转义保持自己的作用域。

## Alternatives considered

**用共享根替换 harness 主目录文件。** harness 主目录拥有 harness 专属配置，其文件是被文档化、被测试的用户全局层；移除它会为跨工具共享指令的人丢掉 harness 专属层级。

**仅在 harness 主目录文件缺失时加载共享根。** 两个文件会交替成为会话可见的用户全局文件，静默压制而非组合。

**依靠路径身份处理重复情形。** 常见布局把 harness 主目录文件符号链接到共享根 —— 两个路径、一个文件 —— 而内容相同的独立副本是常态；只有去除空白后的内容身份能同时处理两者。

## Consequences

- 共享指令无需复制或符号链接即可加载；`dsh-agent-instructions` 在 `dshHome` 旁暴露对称的 `agentsHome` 配置字段。
- 验证覆盖双根顺序与标签、`$DSH_AGENTS_HOME` 解析与空白处理、跨根基线去重与漂移提升、对账移除/提升转换，以及保留名项目作用域转义。
