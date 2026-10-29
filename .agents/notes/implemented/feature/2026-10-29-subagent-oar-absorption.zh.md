# Agent Note: OAR subagent delegation absorption

Status: implemented

[English](2026-10-29-subagent-oar-absorption.md) | 中文

## 问题

上游 wave-5 增量交付了基于 `@botiverse/oar` 运行时库的实验性一次性委派家族（`subagent-oar` + `tool-subagent-oar`）：内嵌 OAR，把其默认运行时（Codex、Claude）包装为共享缝隙上的 subagent provider，并让模型按调用选择运行时。Harniverse 此前没有通往 OAR 维护的运行时适配器的路径；2026-10-29 的 owner 裁决接受吸纳该家族，同时否决插件市场、Liveshare、Translator 与按需 bundle 安装。

## 决策

以 subagent 组下的两个产品包吸纳，按我方契约适配而非照搬上游实验性包装：

- `dsh-subagent-oar`（`packages/subagent/subagent-oar`）——在 `ctx.subagents` 上注册具名 provider 的函数插件。移植的运行语义不变：纯文本任务校验、父会话工作目录派生、经凭据擦洗的环境叠加层（含安装探测，依赖下述补丁）、子代理隔离的根答案选择、分阶段安全诊断、取消优先、幂等释放。发布产物通过 tsdown `alwaysBundle` **内嵌**打好补丁的 `@botiverse/oar@0.67.0`，随包携带 `LICENSE-OAR`（Apache-2.0）；声明的是该运行时外部化的依赖而非其本身。
- `dsh-tool-subagent-oar`（`packages/subagent/tool-subagent-oar`）——运行时别名选择工具。由于我方异步激活机制要求可续聊 provider，而 OAR provider 是一次性的，该工具经 `ctx.subagents.start()`（规范的一次性路径）在调用内结算运行，替代上游"立即激活 + 事后完成通知"的形态。

上游针对 `@botiverse/oar@0.67.0` 的补丁集原样携带（`patches/@botiverse__oar@0.67.0.patch`、`patchedDependencies` 与带资质说明的 `minimumReleaseAgeExclude` 条目）：Claude `--permission-mode` 透传（替代无条件的 `--dangerously-skip-permissions`）、Codex 客户端 initialize 失败清理并等待进程退出、环境叠加安装探测。

## 适配与偏差（均为有意）

1. **不设 experimental 层级。** 上游把该家族放在 `packages/experimental/` 并以 `dsh-experimental-*` 命名；我们保持 subagent 产品组与朴素命名，与 `dsh-subagent-codex` / `dsh-subagent-claude-code` 一致。
2. **Node 下限按能力声明。** 上游因 OAR 把根 engine 下限抬到 `>= 24.9.0`；我们保持 `^22.19.0 || >= 24.0.0`，并在插件激活期对低于内嵌运行时声明的 `>= 24.0.0` 下限的宿主大声拒绝（row-13 分歧记录不变；约束属于选择组合该能力的一方，而非整个仓库）。
3. **组合归示例所有。** 无 preset 行、不进入发行 profile；工作组合位于 `examples/acp-agent/tests/fixtures/subagent/subagent-oar/`，同时充当 Loader 冒烟证据——与 codex/claude-code 产品 provider 相同的选择性进入形态。
4. **工具同步结算。** 见上；完成通知投递模型仍保留给可续聊 provider。
5. **裁撤面。** 不带 `locale/*.json`/图标（我们无 plugin-manager UI）、无按调用 `cwd` 参数（我方缝隙从父会话派生子目录）、无实机 permission-mode e2e（我方 messages fixture 无法编排 tool-use；打包产物测试仍断言补丁后的 argv——存在 `--permission-mode`、不存在 `--dangerously-skip-permissions`——permission-mode 语义本体位于上游补丁内）。
6. **许可。** Apache-2.0 署名以包内 `LICENSE-OAR` 与生成的第三方 notices 双路径携带。

## 备选方案

**改扩 `dsh-subagent-codex`/`dsh-subagent-claude-code`。** 否决：owner 裁决明确吸纳的是 OAR 家族——一个自维护、自带适配器的上游运行时抽象；我们的原生 provider 仍是集成更深的产品路径，二者在共享缝隙之后共存。

**跟随上游抬高根 engine 下限。** 否决：没有其他 Harniverse 依赖需要 Node 24，已记录的分歧保留更宽的下限；按能力拒绝让约束只落在选择进入的组合上。

**把 OAR 作为常规依赖引入。** 否决：发布产物会为消费者解析未打补丁的 OAR，破坏 provider 依赖的安装探测叠加与权限透传。

## 后果

- lockfile 在打过补丁的 0.87.1 主线之外，新增 OAR 作用域的 `@earendil-works/pi-ai@^1.3.0` / `pi-coding-agent@^1.3.0` 解析；它们是内嵌运行时的外部化要求，绝不进入我们的 LLM 路径。
- 证据：脚本化运行时单测套件（32 + 8 项）、Loader 组合冒烟、环境擦洗与启动清理 fixture e2e、打包产物内嵌证明，以及面向装有原生 agent 的 owner 的选择性 `DSH_OAR_E2E` 实机运行。
- 0.67.0 之后的上游 OAR 版本需要先重验补丁集与打包产物断言再行升级。
