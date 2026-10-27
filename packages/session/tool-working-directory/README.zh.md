# @deepseek-ai/dsh-tool-working-directory

[English](README.md) | 中文

面向模型的 `working_directory` 工具，构建于会话工作目录服务（`ctx.workingDirectory`）之上：读取当前目录，或用 `cd` 更改。相对路径按当前目录解析。既有的 shell 与运行中的进程保留各自目录。它是函数插件（`inject: ['tools', 'workingDirectory']`）。

## 使用

```yaml
- id: tool-working-directory
  name: '@deepseek-ai/dsh-tool-working-directory'
```

base 组合挂载服务与本工具；Web 与预设组合通过预设行限定模型可见性。省略 `cd` 时校验并返回当前目录（首次使用时记录隐式起始）；提供时提交持久的 `working-directory/change` 并排入模型可见通知。失败以指名缺失目录的普通工具错误呈现。

## 模型体验

间接通过 `dsh-working-directory`，其通知与上下文拥有持久记录。

#### KV Cache 效果

无直接影响；所属服务的通知与上下文拥有任何请求前缀变更。

## 已知限制与暂缓事项

- **无代理调用会失败** —— 本工具需要调用方代理会话；非代理调用方收到工具错误。
