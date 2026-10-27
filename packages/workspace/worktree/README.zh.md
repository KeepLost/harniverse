# @deepseek-ai/dsh-worktree

[English](README.md) | 中文

在已挂载的文件系统与沙箱提供方之下创建保留的 Git worktree（`ctx.worktrees`），然后通过工作目录属主把新检出作为调用会话的工作目录进入。一个 worktree 是固定在本地可用 commit、branch 或 tag 上的新分支加检出 —— 不执行 fetch，且创建的检出与分支被有意保留：任何情况下都不会自动删除，创建失败后同样如此。

## 行为

`create(agent, { name?, from? })` 将分支名校验为相对 Git ref（独立于 Git 语法拒绝穿越拼写），从会话当前目录解析源仓库，固定基础提交（`from`，默认 `HEAD`），拒绝已存在的分支与已存在的检出路径，在仓库根下配置的相对 `directory` 中分配检出池（`.gitignore` 自忽略文件由首次创建池的进程一次性写入），并在不运行已配置 clean/smudge/process 过滤器的情况下检出 —— 过滤器驱动通过命令局部 `GIT_CONFIG_*` 覆盖禁用，不改动 Git 配置。

每条命令都通过已挂载的子进程运行时、在调用会话的沙箱策略下执行：清除 `GIT_DIR` 族环境选择子，设置 `GIT_TERMINAL_PROMPT`、`GIT_LFS_SKIP_SMUDGE` 与 `GIT_NO_LAZY_FETCH`，且每条命令带有截止时间、终止宽限与有界输出捕获。新检出仅在 Git 设置全部成功后才成为会话目录；失败会包装操作（`Could not finish worktree …`）并说明任何已创建产物均被保留。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `directory` | `.agents/worktrees` | 源仓库内的相对检出池；必须是无数点段的相对路径。 |
| `namePrefix` | `worktree-` | 生成分支名的前缀；必须能产生相对分支名。 |
| `gitCommand` | `git` | 遵循 `GIT_NO_LAZY_FETCH` 的可执行文件；非空。 |
| `nodeCommand` | `node` | 用于沙箱内目录分配的可执行文件；非空。 |
| `timeoutMs` | `60000` | 单条命令的截止时间。 |
| `graceMs` | `3000` | 子进程终止宽限。 |
| `maxOutputBytes` | `65536` | 每个输出流的捕获字节上限。 |

```yaml
- id: worktree
  name: '@deepseek-ai/dsh-worktree'
```

## 模型体验

间接通过 `@deepseek-ai/dsh-tool-worktree`；工作目录服务的通知宣布进入的检出。

#### KV Cache 效果

无直接失效；进入目录的通知拥有唯一一次请求前缀变更。

## 已知限制与暂缓事项

- **失败可能保留部分产物** —— 中途失败的分配会按设计留下已创建的分支或目录；重试需要新名称。
- **检出池位于源仓库内部** —— 池依赖仓库自身的忽略规则（生成的 `.gitignore` 覆盖默认布局）；以不同方式配置的池目录由部署负责。
- **仓库局部替换引用仍然生效** —— `baseCommit` 报告解析出的对象名，其检出的内容可能被替换引用改变。
