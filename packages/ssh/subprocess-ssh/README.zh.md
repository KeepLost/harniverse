# `@deepseek-ai/dsh-subprocess-ssh`

[English](README.md) | 中文

通过 SSH 执行世界提供普通受管理进程和终端。输出以有界分块拉取，标准输入和终端输入遵循背压，终端调整大小在远程执行，释放时等待远程进程范围结束。

## 模型体验

通过 [`dsh-tool-bash`](../../shell/tool-bash/README.md) 以及终端与 LSP 消费方间接影响；它们渲染此远程提供方的进程结果、有界输出尾部与终端流，与本地生成完全一致。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由具名消费方负责。
