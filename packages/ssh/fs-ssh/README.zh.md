# `@deepseek-ai/dsh-fs-ssh`

[English](README.md) | 中文

通过 SSH 执行世界提供现有文件系统 seam。目标键、文件 URL、版本、原子写入、编辑、流式读取和字节限制均由远程机器负责。

## 模型体验

通过 [`dsh-tool-fs`](../../fs/tool-fs/README.md) 间接影响；该工具渲染此远程提供方的有界内容窗口、变更确认与提供方消息，与本地后端完全一致。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由具名消费方负责。
