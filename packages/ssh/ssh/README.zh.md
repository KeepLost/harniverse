# `@deepseek-ai/dsh-ssh`

[English](README.md) | 中文

负责 OpenSSH 连接、Helper 完整性检查、有界 RPC 传输、执行世界描述，以及机器拥有的 MCP/Skill/Hook 清单。Helper 租约和进程注册表由连接拥有，在传输丢失时关闭。

`profile` 配置是不可变的捕获权限记录，只能选择机器清单成员，不能选择本地路径、本地凭据或实时 Cordis 修改权限。

## 模型体验

无。主机别名、认证与流能力均为私有部署细节；模型可见操作全部由消费方负责。

#### KV Cache 影响

无影响；传输、租约与清单事实不会进入模型输入。
