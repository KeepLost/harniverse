# `@deepseek-ai/dsh-base`

[English](README.md) | 中文

以 profile 组合包形式交付的共享 dsh 核心：[`cordis.patch.yml`](cordis.patch.yml) 在空的 profile 根之上插入全部基础插件行——模型适配器、共享的 [`agent-default-model`](../../core/agent-default-model/README.md) 选择、工具、持久化、策略、settings／credentials、遥测与宿主级 subagent provider——作为每个 profile 的 `dsh.profile.bundles` 列表中的第一层。多提供方适配器 `llm-pi-ai` 默认启用，并公开已配置的目录路由或自定义路由；原生 `llm-deepseek` 适配器则是一条默认禁用的可选行。Codex 与 Claude Code provider 以休眠状态加载；Agent Preset 分别决定自己的 agent 是否贡献任一面向模型的委派工具。后续的组合包层（例如 [`dsh-web-app`](../web-app/README.md)）和用户 profile 的 `cordis.patch.yml` 按 id 覆盖这些行；patch 会替换目标行的整个 `config`，因此模式专属的值放在各模式组合包中，而不是这里。该包没有运行时 API；profile 组合器通过 manifest（元数据清单）的 `dsh.bundle.patch` 字段解析 patch，绝不通过代码。

patch 在自身上按平台门控两个 shell 栈：`bash-sandbox`/`tool-bash` 携带 `disabled: !!js process.platform === 'win32'`（bash 没有 Windows runner），它们的孪生行 `pwsh-sandbox`/`tool-pwsh` 以取反的表达式仅在 win32 挂载——同一份 patch 文件，每个宿主恰好挂载一个 shell 栈。权限面与 POSIX 完全一致：`sandbox`/`sandbox-policy` 通过 Windows ACL 受限令牌 runner（`dsh-sandbox-local` 的 win32 链 → `@deepseek-ai/dsh-sandbox-windows-acl`）执行文件效果策略，权限切换器与 approval 服务原样运行，`fs-sandbox` 继续围栏 `ctx.fs` 写入——在其旁再挂载 `dsh-fs-local` 会重复注册 `ctx.fs` 并在加载时失败。偏好不受沙盒约束的本地 pwsh 执行器或完整访问的 Windows 主机通过其 profile 或 home 的 `cordis.patch.yml` 覆盖这些行（bash 恢复配方必须完整：禁用 `pwsh-sandbox`/`tool-pwsh` 并重新启用 `bash-sandbox`/`tool-bash`——两个执行器家族注册同一个 `bash` 服务，配方不完整会在加载时直接报错）。POSIX 主机看到的是被禁用的 pwsh 行。

行集合及其设计依据以行内注释写在 patch 文件里；[生成的组合图](../../../apps/cli/composition.md)负责渲染它。

随附的 Web 配置行会挂载 `web_search` 及全部三个官方搜索提供方：默认的 `deepseek-official`、`exa` 与 `perplexity`，分别使用 `DEEPSEEK_API_KEY`、`EXA_API_KEY` 与 `PERPLEXITY_API_KEY`。每个提供方都可以在没有密钥时挂载；只有搜索选中并执行该提供方时，缺少凭据才会导致失败。`$DSH_WEB_SEARCH_PROVIDER` 会更改未经改动的随附默认值；后续针对 `web` 行的 patch 会替换完整配置，因此优先级更高。浏览器中的实时 `web.searchProvider` 用户设置会从下一次搜索开始覆盖该组装值，清除后恢复组装值。`web_fetch` 保持禁用，且该组合包不挂载抓取提供方。

## 模型体验

通过插入的行间接产生影响：该组合包选定了随发行版交付的无 persona 提示词基座、工具集合与多提供方适配器，供各模式组合包进一步特化；它自身不贡献任何模型可见文本。

#### KV Cache 影响

无直接影响；每条插入行的影响由其所属的包负责。

## 已知限制与暂缓事项

- **patch 会替换整行 `config`**：profile 覆盖必须重述该行需要保留的每个字段；不存在深度合并层。
- **Claude SDK 的平台 CLI（命令行界面）仍在 Profile 安装闭包中**：base 组合包依赖 Claude 提供方，其生产路径解析宿主提供的 `claude`；移除 SDK 中未使用的可选载荷，推迟到产品安装闭包后续项处理。
- **Windows 的临时目录授权是按会话的私有子目录**——`workspace-write` 把写入限制在工作区与会话自己的 temp 子目录（`<temp>\dsh-<hash>`，受限子进程的 TMP/TEMP 被改写）；`read-only` 不授予任何临时目录写入权限。见 `@deepseek-ai/dsh-sandbox-windows-acl`。
