# Agent Note: 会话工作目录

Status: implemented

中文 | [English](2026-10-27-session-working-directory.md)

## Problem

会话的工作目录此前固定于创建之时：每个消费方（`dsh-tool-bash` 的 workdir 解析、`dsh-tool-fs` 与 `dsh-tool-lsp` 的会话 cwd、持久 shell 的启动、沙箱策略的 workspace 根、`{{cwd}}` 提示词变量）都读取不可变的 `SessionHeader.cwd`。在对话过程中更换检出 —— 进入 worktree、在项目间移动 —— 的任务无法表达这一点：各工具按 header 解析路径会继续操作原项目，而 shell 内的 `cd` 状态对其他工具不可见且不入日志。

## Decision

`dsh-working-directory` 拥有每个会话一个已记录的有效目录。其 `workingDirectory` 投影（由增量的全量 `working-directory/change` 事件折叠而来，首次变更前为 `null`）是读取面；`get()` 回退到 header cwd，再到部署默认值。`ensure()` 通过已挂载的文件系统提供方校验、首次使用时记录隐式起始目录、当前目录消失时恢复原始项目；`set()` 校验并提交。两者按会话串行，检查取消与 fiber 活性，销毁后拒绝运行。每次提交的变更通过普通 agent inbox 排入一条 `working-directory` 通知（`user/message`，source `{ kind: 'working-directory' }`）；提交后通知失败只告警、绝不回滚。挂载 system-prompt 服务时，`working-directory:current` 提示词上下文在 contexts 平面发布常驻陈述。

header 保持原始项目身份：持久化布局、工作区挂接与沙箱策略根继续由它派生，因此换目录绝不扩大可写面、也不移动会话数据。消费方通过导出的 `effectiveCwd()` 帮助函数切换（服务挂载值，否则 header），无提供方组合行为不变。environment 提示词段改为陈述起始目录且目录可变，不再承诺会话固定值。

`dsh-tool-working-directory` 挂载 `working_directory({ cd? })` 工具；base 组合挂载服务与工具，Web 通过预设行限定模型可见性，包括 `minimal` 在内的每个出厂预设都携带读取/恢复能力。

## Alternatives considered

**改写会话头。** 会话头是被存储键、工作区成员与权限根使用的不可变身份；把当前执行状态与原始项目混同会让每次 `cd` 都搬动持久数据。

**让 worktree 工具拥有目录状态。** 普通目录变更、文件系统工具与指令发现需要同一个值；Git 专属属主会重复选择与恢复逻辑。

**改进程目录或同步每个 shell。** 并发会话与运行中的子进程各有独立生命周期；会话变更影响新的基于目录的操作，而 shell 自己的 `cd` 保持局部。

**把目录保存在静态提示词中。** 可变的运行状态应作为持久状态位于保留历史之后，而非位于可复用前缀中。

## Consequences

- 重放与恢复从日志重建有效目录；较旧的读取器按加载时未知类型检查拒绝该增量事件，与 v0 additive-only digest 政策一致（基线随本 note 再生）。
- 技能目录与补全仍跟随原始项目根，子代理仍从父级 header cwd 启动 —— 两者都是已记录的后续项，而非静默分叉。
- 验证覆盖投影折叠与恢复、隐式起始记录、恢复、通知（含队列失败）、串行化、销毁、提示词上下文发布、Loader 组合端到端，以及消费方回退。
