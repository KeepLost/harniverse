# Agent Note：移除模型侧 `working_directory` 工具

Status: implemented

[English](2026-11-23-remove-working-directory-tool.md) | 中文

## 问题

`tool-working-directory` 在 `working-directory` 服务之外提供了一个模型侧 `working_directory` 工具（读取生效目录，或 `cd` 进入其他目录）。官方 0.2.3 的 `session-workspace-root` 记录公布了其机群使用证据：在抽样会话的 6,229 次工具调用中，模型只用了 1 次 `working_directory`，而 61% 的 shell 命令本就自带 `cd` 前缀。这个工具还允许模型拖动会话锚点——所有消费者（文件视图、编辑边界、注入上下文）赖以解析的生效目录——使其偏离作为身份与沙箱根的 header cwd，一个极少使用的工具带来了锚点漂移代价。

## 决策

- 删除 `packages/session/tool-working-directory` 及所有组合行：base bundle、web-app 禁用行、四个 CLI agent preset、agent-presets 包映射、工具目录与模块图。模型不再拥有 `working_directory` 工具。
- `working-directory` **服务原样保留**：`header.cwd` 仍是不变的身份与沙箱根；`working-directory/change` 事件、折叠投影、`working-directory:current` 上下文与每次变更通知，继续为其真实属主（`create_worktree`、沙箱升格、未来的程序化进入）工作。
- `create_worktree` 的描述——唯一引用该工具的模型可见文本——改为用模型自己的 shell 把目录切回；worktree、检出与分支语义不变。

## 备选方案

- **保留工具**——6,229 次调用中 1 次的机群样本使用率，撑不起 `cd` 之外的第二个目录面，且锚点漂移对生效目录的每个消费者都是真实代价。
- **仅移出出厂 preset**——休眠的组合行仍要为一个证据表明模型不用的能力支付目录、schema 与评审成本。

## 后果

- 每个出厂组合（base、web、CLI preset）的线上工具列表减少一个；minimal preset 现在暴露 `[shell, str_replace_editor]`。记录过 `working_directory` 调用的会话照旧重放其记录结果——持久化历史不受影响。
- 模型换目录的方式与证据一致：在自己的 shell 调用里 `cd`。需要模型可见目录读取的会话仍有注入的 `working-directory:current` 上下文行。
- 证据：组合套件（`apps/web/tests/shipped-composition.e2e.ts`、`minimal-preset.snapshot.ts`）与工具目录生成套件更新后全绿；`agent-presets`、`tool-worktree`、`working-directory` 套件未改且全绿（173 通过）；目录与图已再生。
