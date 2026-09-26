# Agent Note: 技能无条件加载与递归发现

Status: implemented

[English](2026-09-26-skills-unconditional-visibility.md) | 中文

## 问题

技能调用策略（`SkillInvocationPolicy` 的 `modelInvocable`／`userInvocable`，由 `disable-model-invocation` 与 `user-invocable` frontmatter 驱动）把一个发现目录拆成四个象限，而没有任何出厂组合真正使用它：除 `dsh-translate-docs` 外的全部仓库技能都是完全可调用的；能力目录从策略推导 `defaultVisible`；api-proxy wire 要求每个条目携带 `modelInvocable`；SSH consumer 还要在 wire 上校验该策略。这道门禁是没有任何消费方的表面积。此外，发现只识别 `<root>/<name>/SKILL.md` 与根层 `<name>.md`，嵌套组织的技能树不可见。

## 决策

两者一并移除／放宽，接受 wire 破坏（RC 阶段，无兼容承诺）：

- `dsh-skill` 删除 `SkillInvocationPolicy`、`isModelInvocable`、`isUserInvocable`、summary／candidate／definition／registration 上的 `invocation` 字段及其全部校验。每个被发现的技能同时可供模型和用户调用；`dsh-tool-skill` 的目录与 `skill` 工具列出全部条目，用户显式 `/name` 手势路径除删除策略检查外不变。
- 本地文件系统提供方在解析时拒绝已移除的 frontmatter 键（`disable-model-invocation`、`user-invocable` 及驼峰拼写），warn 并跳过，让过时的策略文件响亮失败而非被静默错误加载。
- 发现改为递归：根下任意深度的 `SKILL.md` 都会被发现，绝不进入隐藏目录、`node_modules` 或 `.git`，深度以十层为限并用身份集合约束符号链接环。根层平铺 `<name>.md` 仍是仅限根层的形式。名为 `SKILL.md` 的目录仍会作为技能文件被探测，使畸形 bundle 响亮失败（发现不完整），保留递归化之前的行为。watcher 相关性判定随递归规则更新。
- 消费方随之调整：能力目录中技能成员默认可见；api-proxy 的 `skill.list` wire 删除 `modelInvocable`；`ui-skill` 删除仅用户描述前缀及其 locale 键；SSH `machine.skill` 响应形状删除策略；内置 badge 候选不再携带策略；删除 `scripts/verify-skill-invocation-metadata.ts` 及其门禁项；`type-equiv`、`api-catalog` 与 skills 子系统文档（中英）重新生成。
- `dsh-translate-docs` 保留原位并删除隐藏 frontmatter：由其自身 SKILL.md 的调用边界章节与仓库 AGENTS 规则（"仅显式用户调用"）约束，与其十个兄弟技能完全一致。否决了移出默认根目录的方案，因为那会使该已文档化的工作流不可达。

本注取代 2026-07-28 的技能调用策略注，原注作为历史保留。

## 备选方案（Alternatives considered）

**把策略保留为休眠表面。** 否决：四个象限没有任何出厂消费者，对未来的每个技能特性都是维护成本 —— 目录、wire、SSH 与 badge 表面各自携带的策略管线都在本次变更中删除。

**把 `dsh-translate-docs` 移出默认根目录。** 否决：该技能是已文档化、显式调用的 workflow；把它藏出发现范围会使其不可达，而不只是不可见。

## 后果

一份目录服务全部接口；需要约束自身使用方式的技能改用正文而非 frontmatter。回放带有策略旧日志的会话不受影响（策略位于 candidate 上，不在持久会话内容中）。`skill.list` 的 wire 消费方看到更小的条目形状。任意根下的嵌套技能树现在可以加载，`node_modules`／`.git`／隐藏目录永不被扫描，意外的深树保持有界。

## 测试

`pnpm exec vitest run packages/skill packages/host/capability-management packages/host/apiproxy packages/client/ui-skill packages/ssh/ssh packages/client/connection` —— 723 项测试，含新增的递归发现（嵌套 bundle、跳过目录、深层文件）、被拒 frontmatter 键、统一目录，以及重写后无策略夹具的覆盖。ACP `skill-load` 快照夹具记录统一目录，并随 golden 回放批次刷新。
