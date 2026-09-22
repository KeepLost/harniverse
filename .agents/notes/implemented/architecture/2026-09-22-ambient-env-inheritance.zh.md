# Agent Note:全访问信任的环境变量继承

Status: implemented

[English](2026-09-22-ambient-env-inheritance.md) | 中文

## 问题

每个子进程生成都把它的显式 `env` 合并到 `scrubbedParentEnv()` 之上——即移除了 `SENSITIVE_ENV_PATTERN`(`KEY|PASSWORD|SECRET|TOKEN`,大小写不敏感)与 `DSH_*` 名称后的 harness 父环境。`danger-full-access` Shell 是有文档的全信任执行模式,但凭据形状的变量(`AWS_TOKEN`、`GITHUB_API_KEY` 等)却在其中无声消失,使用户自己的工具在 harniverse 内的行为不同于其交互式 tmux Shell——这恰恰是 full-access 要避免的失败模式。

## 决策

subprocess 接缝在 `SubprocessSpawnSpec` 与 `SubprocessTerminalSpawnSpec` 上获得显式的 `ambientEnv?: 'full' | 'scrubbed'`。`'scrubbed'`(默认,即原有行为)从脱敏父环境基底出发;`'full'` 从 harness 自身的 `process.env` 逐字出发。显式 `env` 条目在两种模式下都合并在其上。只有执行模式已授予子进程全访问信任的调用者才标记 `'full'`:bash/pwsh 本地 provider 在 `spec.sandboxPolicy.mode === 'danger-full-access'` 时,以及 W13 用户终端控制器(显式叠加 `TERM=xterm-256color` 与 `DSH_SESSION_ID`)。面向模型的 PTY(`terminal-bash`)保持脱敏基底:其受控提示的就绪检测机制不受影响,且模型可见的进程不得无声接收用户从未选择转发的凭据。`'full'` 继承的是 harness 启动时刻的快照;之后在不相关 Shell 里的 `export` 永远不会传播进运行中的 harness。

## 备选方案

- 始终继承完整环境:否决——脱敏对受约束与模型可见的生成是真实防御;只有全访问信任的调用者可以选择退出。
- 处处脱敏并记录该损失:否决——没有环境变量继承的 full-access 破坏了用户自己的工具链契约(凭据、`DSH_*` 相邻的工具变量),而这正是该模式的目的。
- 按变量的白名单:否决——模式无法知道用户的工作流需要哪个凭据形状的名称;模式级信任正是策略已定义的边界。

## 后果

`resolveExecutable` 保持脱敏基底(PATH 查找不受影响)。受约束的生成、模型子进程与模型 PTY 与之前逐字节一致。全访问 Shell 与用户终端现在匹配用户的交互环境,差异仅剩有文档的 `ENV_OVERRIDES`(模型输出的 `NO_COLOR`、`TERM=dumb`、分页器设置)与 harness 启动快照。测试通过探测变量覆盖了 subprocess 与 terminal 两条路径的完整继承与默认脱敏。

## 范围

带 JSDoc 的 spec/接缝类型、本地 provider 的 `childEnv` ambient 开关、两个本地 Shell provider 的条件标记、终端控制器生成、subprocess-local/bash-sandbox/pwsh-local 的聚焦测试,以及 subprocess 子系统页的类型等价块。
