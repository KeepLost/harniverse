# Agent Note: Plugin configuration in the web settings page

Status: implemented

[English](2026-08-10-web-plugin-configuration.md) | 中文

## 问题

插件的一切可配置项都只存在于 `cordis.yml`。想要更长的 shell 超时、不同的搜索端点或更少的并行工具调用，用户必须找到组装文件、了解它的形状，然后重启——而 Models 页几个月来一直在证明：settings 命名空间可以在浏览器里编辑并立即生效。

支撑 Models 页的那条 seam 本就是通用的：任何插件都可以注册命名空间，`settings.describe` 会提供它的 schema、分层与 revision。缺的是两端。除 LLM 适配器与权限服务外，没有插件注册过命名空间；而对于非模型提供方的命名空间，也没有任何表层。

## 决策

六个宿主平面 settings 分节覆盖 shell 能力、agent loop、Web 搜索选择器和三个官方搜索提供方；一个浏览器侧“插件”分区聚合由各功能持有的标签页。它的“可配置”标签页渲染该部署所暴露的一切可编辑设置。

**分层不变。** 一个分节按 schema 默认值 → 插件的组装条目 → 用户层解析。每个插件把自己的 `cordis.yml` 条目作为 `base` 传入，并通过 source thunk 读取配置，因此存储的变更会作用于下一次使用，而脱离的 settings 提供方会让组装条目继续运行。schema 无法表达的约束——正有限、`graceMs` 的定时器上界、并行上限必须是正整数——成为分节的校验器，因此错误的值在写入时被拒绝，而不是到下一条命令时才失败。

**shell 命名空间命名的是能力，而非某个实现。** `SHELL_SETTINGS_NAMESPACE` 由 `@deepseek-ai/dsh-shell` 导出，因为一个宿主只组装一个 `ctx.shell` 提供方：win32 层会把 POSIX 行换成 pwsh 行，而同时挂载两者会因服务重复注册在加载期失败。因此两个家族都能用自己的 schema 与条目注册同一个命名空间而永不相撞；在平台间携带的 `settings.yaml` 也能在两边继续解析——schemastery 对象会保留当前 schema 未声明的键。

**当插件配置大于用户所拥有的部分时，分节就是一个子集。** `agent-loop` 只暴露 `maxParallelToolCalls`；它的 `agents` 数组在服务启动时被消费一次，所以存储在那里的变更只会看起来生效。

**选择与提供方选项按次投影，而不是固化。** `WebRuntime` 会注册一个只包含 `searchProvider` 的实时 `web` 分节；浏览器变更作用于下一次搜索，清除用户值会恢复组装配置，`fetchProvider` 则仍只能通过组装配置。搜索会在操作入口对选择生成快照。DeepSeek、Exa 与 Perplexity 同样读取实时的逐提供方分节与凭据，为每次搜索快照一份完整选项；挂载凭据服务时以其为最终权威，因此端点、模型、选项或轮换后的密钥均无需重新注册提供方即可变更。

**暴露仍是 Host 的白名单。** `WEB_SETTINGS_NAMESPACES` 中的 Web 条目是 `web`、`web-search-deepseek`、`web-search-exa` 和 `web-search-perplexity`；仅有注册依然不会跨越传输边界，而不在该名单中的命名空间会与未注册的命名空间得到完全相同的 `settings-not-exposed`。

**“可配置”标签页不认识任何命名空间。** `dsh-client-ui-settings-plugins` 拥有“插件”分区，通过 `settings.plugins.tab` 贡献自己的 `configurable` 页面，并在其中声明嵌套的 `settings.plugin.item` slot。它渲染注册进这个嵌套 slot 的卡片，因此带浏览器半侧的插件拥有自己的卡片与控件。每张卡片通过客户端 settings scope 绑定其命名空间，而该 scope 补上了表单所需的两样东西：原始 `user` 层——键的**存在**才标记字段被覆盖——以及把单个字段清回组装层的 `unset`。命名空间不可用时卡片什么都不渲染，因此未组装该插件的部署不会显示它的任何痕迹。

**卡片暂存修改，保存时才写入。** 控件不持有自己的草稿：暂存文本归卡片的表单所有，所有控件渲染的都是它，只有**保存**才把它变成文档变更。Web 搜索卡片绑定四个 scope，暂存选择器与全部三个提供方表单，并在提供方字段隐藏时保留其草稿。一次保存会按顺序、以非事务方式写入 `web`、DeepSeek、Exa 与 Perplexity；成功的表单会结算，每个失败表单则保留自己的草稿。settings 写入是持久且带 revision 栅栏的，因此「失焦即提交」的控件会为用户尚未决定存储、也无从预览的值花掉一个 revision；重置同样只是暂存组装默认值。schema 表达不了的约束归 Host 的校验器所有，所以每个表单在写入后回读自己的分节，并报告没有落盘的保存，而不是自行预测结果。每个提供方密钥都通过 credentials 领域以只写方式处理，并与其提供方字段一起暂存。

**随附组合会显式选择搜索提供方。** base 会无密钥挂载 `deepseek-official`、`exa` 与 `perplexity`，分别使用 `DEEPSEEK_API_KEY`、`EXA_API_KEY` 与 `PERPLEXITY_API_KEY`；除非 `DSH_WEB_SEARCH_PROVIDER` 更改未经改动的配置行，否则选中 `deepseek-official`。后续 `web.config.searchProvider` patch 会替换完整配置，因此优先级更高。不存在按密钥自动切换：同步 `available()` 无法证明异步凭据存储中存在密钥，所以只有选中的搜索执行时，缺少凭据才会导致失败。`web_fetch` 保持禁用，且不挂载抓取提供方。

## 备选方案

- **用注册期的暴露声明取代白名单。** 这才是诚实的形状——命名空间的拥有方声明自己的暴露，在本仓库之外分发的插件也无需改动 `packages/host/apiproxy` 就能呈现自己的配置。之所以暂缓，是因为它会同时改变 seam 契约、全部现有注册点与防枚举语义；而且插件要暴露任意 schema，还得先有 fail-closed 的脱敏路径：目前只能经由 union 或 transform 抵达的 secret 会被原样返回。
- **通用 schema 驱动的表单渲染器。** 再次否决，理由与 [web-config-plane 笔记](../architecture/2026-07-30-web-config-plane.md)所记一致：没有呈现词汇的字段真值产出的是无法使用的卡片。手写控件成本相当而可读性更好，且该 slot 让其他插件无需与本包协商。
- **在本页编辑 preset 挂载的插件。** 超出范围，而且不只是「尚未实现」：preset 的行把配置内联在 `agent.cordis.yml` 中，且根本无法注册 settings 命名空间——同一 preset 挂载第二个会话时会因重复注册而失败。跨 preset 共享的用户层还会覆盖 preset 用来定义其 agent 身份的字段——人设文本、委派接线——而这些字段按设计就是各 preset 各自的。
- **按执行器包各取一个命名空间，而非按能力命名的 `bash`。** 否决，因为被组装的执行器随平台不同，而设置文档不随平台不同：在 macOS 上设过超时的用户，到 Windows 上会悄无声息地失去它。
- **把搜索密钥写进 settings 分节。** 否决，因为那样字面值就必须搭乘 `describe` 响应才能被渲染。卡片只报告是否已配置各个密钥，并按各提供方分节所命名的引用经由 credentials 领域写入。
- **每个控件失焦即提交，不设保存。** 最初就是这么做的，后被替换：失焦不是决定。它每个控件花掉一个命名空间 revision，写入前不给用户任何预览或撤销的余地，还会把无效草稿悄悄丢弃——被 Host 校验器拒绝的值只是弹回原样，不给任何理由。每张卡片一个保存，才让写入成为用户执行的动作。
- **让提供方按属性逐次读取 options。** 在每个使用处读取 thunk 会悄悄破坏单次操作的一致性：`search()` 先 await 凭据解析，之后才读端点与请求选项，因此落在那段 await 里的设置写入可能把按旧分节解析出的密钥发往新分节命名的端点。每个官方提供方都会改为在操作入口只快照一次，并把该快照传进凭据解析。
- **在浏览器端校验字段，好让保存诚实。** 否决：这些约束住在拥有方插件的分节校验器里，在这里重述一遍就会让同一条规则有两个家，且可能随版本各说各话。卡片只判断自己的控件能判断的事——数字草稿是不是数字——其余交给 Host 回答，这正是保存要回读分节的原因。
- **让 Web 搜索卡片使用一个 settings 命名空间或跨领域事务。** 否决，因为选择器与各提供方分别拥有独立的 schema 与 revision，而密钥属于 credentials 领域。settings 和 credentials 都不提供跨越这些归属方的原子写入；固定顺序保存会保留成功写入与失败时的原样草稿，而不是假装能够回滚。

## 影响

用户可以在设置页编辑 shell 的命令超时与输出上限、agent loop 的并行工具调用上限，并通过一张卡片编辑 Web 搜索。该卡片公开选择器和只写密钥，以及 DeepSeek 的 `baseURL`／`model`／`apiVersion`／`maxTokens`／`maxUses`、Exa 的 `baseURL`／`searchType`／`numResults`／`highlightsPerResult`、Perplexity 的 `baseURL`／`model`／`maxTokens`／`searchRecency`；每个字段都标注是否由用户设定，并提供重置。

有三项真实代价。加入另一个暴露命名空间仍需要在 apiproxy 白名单里添一条，因此本页的覆盖面是 Host 的决定而非插件的决定。四 scope 的 Web 搜索保存按顺序而非事务执行，因此可能部分成功，但失败表单会保留草稿。而 web 部署移入 agent 平面的那些插件——文件工具、技能、压缩、todo 工具——在这里一个都不出现，而它们恰恰是用户最可能期待找到的；它们的配置仍归 preset 编辑器。

bash 与 pwsh 执行器现在把 `config` 暴露为 source thunk 之上的 getter，而不再是 readonly 字段。所有读取点本就是按次读取，因此别无变化；但若某个子类在构造期捕获 `this.config`，就会悄然把组装条目钉死。

`verify-cordis-config` 新增一项检查，代价由本分支付过：合并 master 对客户端清单字段的重命名（`dshClient` → `dsh.client`）后，本包仍声明旧名，于是整个分区从浏览器上消失，且任何地方都不报错——行照常组装、空的 node 半侧照常激活，只是浏览器 roster 扫描永远匹配不到它。这一点无从被既有门禁发现，因为组装文件区分不了 surface 插件与 Host 插件：差别在清单里。现在门禁要求 `packages/client` 包的 `./client` 导出与 `dsh.client` 声明双向一致。之所以只限这一组：Host 包的 `./client` 导出是给浏览器消费方 import 的类型化 wire face，不是 roster 要服务的插件。
