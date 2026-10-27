# Agent Note: 显式 worktree 创建

Status: implemented

中文 | [English](2026-10-27-explicit-worktree-creation.md)

## Problem

需要在不打扰调用方检出的情况下修改项目的任务此前没有一等路径：通过 shell 执行 `git worktree add` 可行，但对会话目录状态不可见 —— 后续所有相对路径、指令发现与提示词陈述仍指向原检出，且调用方未提交状态可能与任务编辑交错。

## Decision

`dsh-worktree`（`ctx.worktrees`）每次调用创建一个保留的 worktree：固定在本地可用 commit、branch 或 tag 上的新分支加检出 —— 不 fetch、拒绝已存在名称 —— 分配到源仓库内可配置的池（默认 `.agents/worktrees`，由生成的 `.gitignore` 自忽略），随后通过工作目录属主进入，使会话的有效目录、通知与消费方全部跟随。

每条命令通过已挂载的子进程运行时、在调用会话的沙箱策略下执行：清除 `GIT_DIR` 族选择子、设置 `GIT_TERMINAL_PROMPT`／`GIT_LFS_SKIP_SMUDGE`／`GIT_NO_LAZY_FETCH`、每命令截止时间、终止宽限与有界捕获。目录分配以静态 Node 子进程运行，使池创建遵循同一约束。检出通过命令局部 `GIT_CONFIG_*` 覆盖禁用已配置的 clean/smudge/process 过滤器而不触碰 Git 配置，并用 `--no-checkout` 加 `reset --hard` 保证检出期间不过滤器运行。穿越拼写独立于 Git 分支语法被拒绝。失败包装操作并显式保留已创建内容；任何情况下都不自动删除。`dsh-tool-worktree` 在服务之上暴露 `create_worktree` 模型工具。

## Alternatives considered

**仅用 shell。** 会话目录状态对其余每个工具都是错的；工作目录属主正是为防止这一点而存在。

**自动管理 worktree 生命周期。** 保留是刻意的：失败或被放弃的检出是取证证据，自动删除会与池的并发使用者竞争。

**检出到仓库外的全局临时池。** 破坏沙箱 workspace-root 模型：仓库内的写入处于会话的 `workspace-write` 边界内，外部池需要新的可写根策略。

## Consequences

- 池目录位于源仓库内部，由生成的 `.gitignore` 忽略；以不同方式配置池的部署自行负责其忽略规则。
- 验证覆盖 HEAD 与固定修订的创建、过滤器禁用、沙箱包装与免约束执行、已存在分支/路径与穿越拒绝、非仓库失败、包装的部分失败保留、配置校验、销毁，以及带真实仓库的 Loader 组合端到端。
