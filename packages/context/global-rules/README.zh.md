# `@deepseek-ai/dsh-global-rules`

中文 | [English](README.md)

用户级全局规则编辑的 Service Definition（`ctx.globalRules`）：读写 harness 主目录下的 `AGENTS.md` —— 即 `dsh-agent-instructions` 加载器视为 `user-global` 作用域的文件 —— 并以内容指纹作为新鲜度令牌实现乐观冲突检测。作为插件加载后注册为 `ctx.globalRules`；设置面板的 wire 面（API 代理上的 `globalRules.read` / `globalRules.write`）是主要 Consumer。

## 解析与上限

主目录解析与加载器完全一致：显式 `dshHome` 配置优先，其次非空 `$DSH_HOME`，最后 `~/.dsh`（`resolveDshHome`）。写入上限默认等于加载器的单文件源上限（1 MiB），保证编辑器接受的内容一定能被加载器的默认配置读取；组合包若覆盖其一，应同时设置两者。`maxSourceBytes` 配置可覆盖上限。

展示路径始终为符号形式（`~/.dsh/AGENTS.md` 或 `$DSH_HOME/AGENTS.md`）；绝对机器路径绝不离开宿主。

## 契约

- `read()` 返回 `{ exists, content, version, displayPath, maxBytes }`；文件缺失时 `exists: false`、内容为空且无令牌；除缺失以外的异常向调用方抛出。
- `write(content, expectedVersion?)` 先按 UTF-8 字节数（多字节安全）执行上限检查，再在给定 `expectedVersion` 时比对磁盘内容的令牌 —— 不一致即以 `conflict` 拒绝并携带当前令牌，并发外部修改不会被静默覆盖。省略令牌则无条件写入。写入成功时若主目录缺失会先创建，并返回新令牌。
- 令牌是内容本身的 sha256 前缀：重写相同内容令牌不变，因此冲突检测关注内容同一性而非写入历史。“比对—写入”是尽力而为的乐观锁，不是事务。

编辑的生效由加载器自身的 reconcile 完成 —— 新会话在第一步读取，活跃会话在下一次文件操作后感知；本服务不额外做任何传播。

## Model Experience

间接发生：本服务只编辑 harness 主目录下的 `AGENTS.md`，由 `dsh-agent-instructions` 基线链将该文件渲染为持久的用户全局指令消息；编辑或保存规则不会从本包发出任何模型请求。

#### KV Cache effect

无；本包既不组装也不发送 provider 请求。

## Known Limitations and Deferred Work

- **乐观锁不是事务** —— 版本比对与写入是两个文件系统步骤，两个并发写入者可能同时通过检查；后写者获胜。锁文件或基于 rename 的替换推迟到出现真实冲突报告再做。
- **缺失文件没有令牌** —— 加载到 `exists: false` 的客户端无法在保存时表达“仍然缺失”，因此其无条件写入可能覆盖此间新建的文件；冲突提示只对加载过内容的客户端出现。
- **一个文件、一个作用域** —— 只服务用户级 `AGENTS.md`；项目级文件与 `AGENTS.local.md` 覆盖层仍归加载器（和工作区编辑器），不在本包范围内。
