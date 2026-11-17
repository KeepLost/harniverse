# Agent Note:tool-hooks——三作用域与会话持有 hook 层

Status: implemented

[English](2026-11-18-hook-scopes-session-layer.md) | 中文

## 问题

`hook_add`/`hook_remove`/`hook_list` 落地时只有单一存储目标:工作区的 Claude-Code 方言项目文件。这把会话的 hook 耦合到共享的工作区工件上——同目录两个会话悄悄共享(并可能互相覆盖)彼此的 hook 安装,没有任何东西把 hook 绑定到创建它的会话,也不存在跨工作区跟随用户的范围。supervision 体系早已展示了想要的形态:`supervision/mode` 与 `sandbox/mode` 都是会话日志状态——读时折叠、重启重放、对同伴会话不可见、无外部存储。

## 决策

- **三个作用域,一个工具面。** `hook_add`/`hook_remove` 接受 `scope: 'session' | 'workspace' | 'global'`(默认 `session`);`hook_list` 分组报告三者,会话组附带 `changeable` 门控状态。workspace 沿用项目文件;global 新增 home 文件(`$DSH_HOME/hooks/claude-code.json`,保留外来键,`maxHooks` 按存储分别计数);session 存于会话日志。
- **会话层是 log-only 持久状态**(`hook/config`,与 `hook/invoked`/`hook/result` 同族,声明于 `dsh-hook-protocol`):每次变更追加完整快照——`todo/write` 先例——因此折叠是末事件胜、压缩安全、重放可恢复。`foldSessionHooks(events)` 是唯一读取;工具用它做校验与列举,与 `sandbox/mode` 的折叠完全一致。
- **桥优先运行会话层。** `dsh-hooks-claude-code` 在每个挂点折叠会话并把所得 matcher 组前插到一切文件源之前——特异性序 `session → user → project → plugin → policy`。权限结果本就与顺序无关(`mergeHookOutputs` 取最严决策);顺序只决定上下文注入顺序、stop 理由叙述与审计顺序。显式 `configPath` 只覆盖文件发现,从不覆盖会话本身。
- **子代理下种式一次性继承。** 在 `subagent/start` 时,把父级折叠集作为一条带 `source: 'delegation'` 的 `hook/config` 追加到全新子级日志(`sandbox/mode` 的下种先例;父级经作用域事件载体由 `carrierKeyOf` 取回)。已携带任意 `hook/config` 事件的子级永不再下种;父级后续变更不传播到运行中的子级。孙代自然继承,因为父级自身的折叠已包含其继承集。
- **会话级改动仅限 supervised,失败即关闭。** 会话作用域的 `hook_add`/`hook_remove` 要求有效监督模式(有服务用 `ctx.get('supervision')`,否则事件折叠,再否则 `unsupervised`)为 `supervised`;拒绝信息点名救济途径(请用户切换监督,或改用文件作用域)。规则写进工具 schema,让模型从工具面本身习得。文件作用域刻意不加限制——它们是用户可审查的磁盘工件,限制它们会改变无关行为。
- **唯一适配器,置于 harness home。** 生成的适配器从各 hook 文件旁迁移到 `$DSH_HOME/hooks/tool-hooks-adapter.mjs`(仍按内容守护)。文件条目保留 `<configPath> <hookName>` argv 查找;会话条目经 `--run` 内联真实命令,因此会话 hook 完全不需要文件。指向旧的同目录适配器的既有条目在那些文件存在时继续工作。

## 会话格式影响(v0 增量)

`hook/config` 是新的 merge-extensible、log-only 会话事件(非 surface 事件,无 `surfaceOp`):载荷 `{ hooks: SessionHookSpec[]; source?: 'delegation' }`。digest 基线(`docs/session-contract-digest.json`)已重生成;`SESSION_FORMAT_VERSION` 在增量-only 政策下保持 `0`。运行时数据关系由 `dsh-hook-protocol` invariant 伴随件在追加时强制:非空唯一名称、可移植事件词汇、非空命令、正整数超时,以及 delegation 下种仅可作为会话的首个 `hook/config`。

## 备选方案

- **会话状态 + 文件投影**(会话为真相源,文件为物化副本):需要投影所有权、分歧对账、以及文件内按会话开槽(`sid`)防止并发会话互相覆盖。否决——三个隔离存储严格简单于一个存储加一份缓存。
- **桥侧服务暴露会话层**(tool-hooks 注册 provider 供桥注入):为一次对会话事件的折叠引入服务拓扑与可选依赖缝。否决——桥在每个挂点本就持有会话;直接读日志保持 `sandbox/mode` 的"无外部配置存储"性质。
- **活血缘继承**(子级分发时折叠父日志):能传播运行中父级变更,但每次分发耦合两份日志并复杂化压缩。否决,采用上述下种式写时复制继承。
- **把简单 stdout 契约升级为协议一等输出方言**(会话 hook 免适配器):长期更干净,但要改动所有桥共享的 codec。推迟;home 适配器加内联 `--run` 以零协议变更达到相同行为。

## 后果

- 同工作区两个会话看不到彼此的会话 hook;workspace 与 global 文件仍是显式共享机制,`hook_list` 展示全部三层及来源提示(`managed`、位置名、`changeable`)。
- 会话级 hook 靠重放渡过重启,靠"仅最后一个 `hook/config` 快照有义"渡过压缩;文件被删或损坏绝不会丢失会话的 hook。
- 每次受管调用仍付出一个 `node` 适配器进程;手写方言条目不受影响。
- 监督门控意味着 unsupervised 会话无法用会话 hook 重新武装自己;它必须开口请求——这正是设计意图。
- 可移植词汇(`pre_tool` …)与 CC 挂点映射现在位于 `dsh-hook-protocol` 的会话层,未来 Codex 方言的会话层有了自己的映射之家。

## 验证

- `packages/hooks` 单测:274 例全绿;per-file 门下 `tool-hooks` 与 `hook-protocol` 的 src 达到语句/分支/函数/行 100%。
- 会话层层序经真实组合证明:`hooks-claude-code` 桥测试用会话级 `prompt_submit` hook 加文件级 hook 驱动真实 agent loop,断言会话层注入的上下文在模型请求中先于文件层。
- 监督门控经执行器在全部四种模式(事件钉定 supervised/unsupervised、服务默认两向)、折叠回退与失败即关闭默认下测试;下种以真实 `carrierKeyOf` 键针对作用域 `subagent/start` 载体测试。
- 文档门禁:catalog/config-catalog/module-graph 重生成并同步 zh 镜像,会话契约 digest 重生成且 `--check` 干净,翻译配对 1344/1344 一致,包 README Model Experience 与 limitations 门全绿。
