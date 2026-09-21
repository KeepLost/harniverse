# `@deepseek-ai/dsh-fs-ssh`

[English](README.md) | 中文

通过 SSH 执行世界提供现有文件系统 seam。目标键、文件 URL、版本、原子写入、编辑、流式读取和字节限制均由远程机器负责。

## 模型体验

通过 [`dsh-tool-fs`](../../fs/tool-fs/README.md) 间接影响；该工具渲染此远程提供方的有界内容窗口、变更确认与提供方消息，与本地后端完全一致。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由具名消费方负责。

## 已知限制与暂缓事项

- **`readText` 上限 8 MiB**：更大的文本必须改用 `streamText`；该上限是传输契约，不是可调参数。
- **二进制读取每次调用最多 512 KiB**：`readBytes` 会把 `maxBytes` 请求截断到每帧上限；尚无分块二进制流式 seam。
- **没有元数据变更**：该 seam 只承载 stat/list/read/write/edit；目录创建、重命名、删除与权限修改仍由部署侧负责。
