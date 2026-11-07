# `@deepseek-ai/dsh-fs-vm`

[English](README.md) | 中文

在一个执行世界的内部之上提供文件系统缝隙：每个 target、路径与字节都属于 guest。身份是词法的，读取是带编码决策的严格 UTF-8，守卫写与字面编辑按 target 串行并经世界自身的 临时文件-改名 原子替换落地，变更按逐调用沙箱策略在宿主侧检查——世界代理自身没有策略强制。

## Model Experience

Indirectly, through 文件系统工具，它们渲染本世界 provider 的读、写、编辑，与本地文件的渲染完全一致。

#### KV Cache effect

无直接失效；所指消费方拥有任何请求前缀变化。

## Known Limitations and Deferred Work

- **身份是词法的** —— target 归一化不跨缝隙，guest 符号链接别名解析为不同 target；符号链接感知的身份等待世界侧 realpath 操作。
- **新鲜度令牌携带线 stat 的粒度** —— kind、size 与线分辨率的 mtime；亚 stat-mtime 的写竞态可绕过陈旧守卫。
- **写仅 UTF-8 且不保留遗留编码或 mode** —— 可解码的既有文件交出其文本作 diff 基；不可解码的交 `before: null`，替换后文件的 mode 是世界默认。
- **`lstat` 无法区分符号链接** —— 世界只有一个 stat；需要 `symlink` 类型的路径级信任规则留在本地 provider。
- **世界线缆上限约束单次操作** —— 超过上限的读取与写载荷失败 `FS_TOO_LARGE`；大文件支持是数据面里程碑的问题。
- **不存在世界默认工作目录** —— 相对路径需要调用方 `cwd`；世界内没有宿主 `process.cwd()` 回退。位于引导锚定的宿主工作区根（`DSH_VM_HOST_WORKSPACE_ROOT`，由 app boot 在 vm 世界下设置）之下的调用方 `cwd` 一一映射到 `/workspace`；世界绝对路径的 `cwd` 原样通过；其余宿主路径按映射诊断显式失败。
