# SSH 执行 Provider

[English](README.md) | 中文

这些包通过 OpenSSH 将选定的执行 Profile 运行在受信任的 POSIX 机器上。Host 保留 Agent 身份、模型访问、Session 权限、凭据和 SSH 连接；执行机器负责自己的 MCP、Skill 和 Hook 配置。

`dsh-ssh` 在导入前验证 Helper 摘要，捕获不可变的远程 Profile 选择，发布经过摘要验证的执行世界描述，并在连接关闭时清理 Helper 租约和受管理的进程范围。描述符契约拒绝 `cordis` Profile。

文件系统、子进程、沙箱和终端 Provider 是独立的 Cordis Provider。它们共享一个机器端 Helper，并使用有界的认证 RPC。远程路径不会被改写为 Host 本地路径。

## 已知限制与延后工作

Profile 和 Provider 行需要 Host 组合接线。部署必须在执行机器上安装 Helper 及其 `.machine.json` 清单，并配置启用严格主机密钥检查的 OpenSSH 别名。
