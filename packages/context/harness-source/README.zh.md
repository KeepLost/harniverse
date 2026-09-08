# @deepseek-ai/dsh-harness-source

[English](README.md) | 中文

注册 `harness:source` 动态提示上下文（顺序 −99，在同时挂载 `app:web-surface`（−98）的组合中紧邻其前）：一个单段落，给出本 Harniverse 实现 checkout 的绝对根路径，说明 checkout 位置与当前工作目录是两个可能不同的值，指示模型用 `pwd` 获取工作目录，并将该 checkout 的用途限定为检查或扩展 Harniverse 自身。DSH 关系与第三方声明不在本文本中；它们由 [`dsh-system-prompt`](../../core/system-prompt/README.md) 固定的顺序 −100 harness 身份开头持有。

依赖 `ctx.systemPrompt`（`inject: ['systemPrompt']`）。checkout 根路径在包内推导（`HARNESS_SOURCE_ROOT`，为测试与快照归一化导出）——从本包的 `src/` 或 `lib/` 入口向上四跳，两种平面都落在仓库根上。只要插件挂载，该上下文即注册；它不受任何 surface 配置门控，因为指明实现 checkout 与 surface 无关。`dsh-web-app` 组合包在每个 Web 组合中挂载它。

## 模型体验

### checkout 根路径上下文

#### 模型看到什么

一个段落给出 checkout 根路径，并将其与工作目录区分开。

##### checkout 根路径段落

```markdown
The Harniverse implementation checkout is at <absolute repository root>. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend Harniverse itself.
```

#### Token 影响

每个会话经下一次 `dsh-system-prompt` runtime 快照携带一个短段落；按进程恒定。

#### KV Cache 影响

进程生命周期内静态，该段落不会使已组装前缀失效；runtime 快照路径追加它而不改写历史。

## 已知限制与暂缓事项

- **根路径是模块加载时的事实**——`HARNESS_SOURCE_ROOT` 从本包自身位置推导一次；安装或迁移后的副本报告的是该副本的根，进程中途迁移 checkout 不会被重新读取。
- **除 `fileURLToPath` 外不保证结尾分隔符**——做快照归一化的消费方必须把导出字符串视为不透明值并整体替换，而不是重新推导。
