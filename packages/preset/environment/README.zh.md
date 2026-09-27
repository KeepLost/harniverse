# dsh-environment

[English](README.md) | 中文

以可组合 row 的形式提供工作环境事实：一个静态 system-prompt section，说明操作系统、harness 执行命令所用的 shell、工作机器，以及会话内固定的工作目录。

[agent preset](../agent-presets/README.md) 挂载本 row，使其覆盖的每个 agent 在发出第一条命令之前就知道自己运行在哪里。section 文本在挂载时根据进程稳定的平台事实计算一次；只有 `{{cwd}}` 保持为 prompt 变量，按 agent 从会话头解析——会话生命周期内固定，不随轮次刷新。

## 事实及其来源

| 事实 | 来源 |
|---|---|
| 操作系统 | 粗粒度平台标签：`Linux`、`macOS`、`Windows`；其他平台原样透出 |
| Shell | harness 的执行选择：macOS 上 `zsh`，Windows 上 PowerShell，其余为 `bash` |
| 用户空间 | Linux 上为 `GNU`，存在 `/etc/alpine-release` 时为 `BusyBox`，macOS 上为 `BSD`；Windows 上省略 |
| 工作机器 | 主机名 |
| 工作目录 | 由 `dsh-agent-loop` 从会话头绑定的 `{{cwd}}` prompt 变量 |

本 row 不接受配置：所有事实都是检测到的运行时真相，不是部署选择。

## Model Experience

### environment-facts section

#### 模型看到什么

一个位于 order −90 的静态 system-prompt section，处于 harness identity 与工具指引之间，由上述事实计算而来。文本模板以检测事实为占位值；`{{cwd}}` 在渲染时按 agent 解析，其余值在挂载时固化：

##### section 文本

```markdown
You are working on the machine <machine> (<os>, <shell> shell[ with a <userland> userland]). The working directory for this session is {{cwd}}; it stays fixed for the session's lifetime.
```

#### Token effect

固定：该 section 为每个挂载本 row 的 preset 所属 agent 的静态 system prompt 增加恒定的 token 数。

#### KV Cache effect

该 section 位于静态请求前缀中，在会话生命周期内前缀稳定；只有在另一台机器或平台上重启进程才可能改变它，而那本身就会开启新的部署前缀。按 agent 解析的 `{{cwd}}` 是同一前缀的一部分，不会在会话内使复用失效。

## Known Limitations and Deferred Work

- **仅本地事实**——该 section 描述 harness 进程所在机器。远程执行世界（[`dsh-execution-descriptor`](../../sandbox/execution-descriptor/README.md)）尚未发布平台事实；待其发布后，本 row 应读取它们，使远程会话报告远程的 OS 与 shell。升级路径是在 descriptor 中增加平台字段，并在此处从会话的执行世界解析事实。
- **机器标签是主机名**——认为主机名敏感的部署可以在自己的 preset 副本中移除本 row；不存在覆盖配置，因为当前没有消费者需要它。
