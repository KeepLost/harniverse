# @deepseek-ai/dsh-tool-worktree

[English](README.md) | 中文

通过共享运行时（`ctx.worktrees`）创建并进入新 Git worktree 的模型工具：`create_worktree` 从本地 commit、branch 或 tag 创建新分支与检出，然后把会话工作目录更改为它。默认为 `HEAD` 与生成的唯一名称；未提交文件留在源检出中；已存在的名称会失败。之后离开检出用带 `cd` 的 `working_directory` —— 检出与分支保留。它是函数插件（`inject: ['tools', 'worktrees']`）。

## 使用

```yaml
- id: tool-worktree
  name: '@deepseek-ai/dsh-tool-worktree'
```

base 组合挂载服务与本工具；Web 与预设组合通过预设行限定模型可见性。

## 模型体验

间接通过 `dsh-worktree` 与宣布进入检出的工作目录通知。

#### KV Cache 效果

无直接影响；进入目录的通知拥有唯一一次请求前缀变更。

## 已知限制与暂缓事项

- **无代理调用会失败** —— 本工具需要调用方代理会话；非代理调用方收到工具错误。
