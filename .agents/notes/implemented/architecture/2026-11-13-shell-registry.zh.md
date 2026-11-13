# Agent Note: Shell 注册表——可按会话选择的 shell 与唯一解析器

Status: implemented

[English](2026-11-13-shell-registry.md) | 中文

## Problem

shell-backend 偏好在词汇上只属于 Windows(`'platform-default' | 'git-bash'`;`resolveShellBackend` 把非 win32 的所有存储值折叠为 bash),而 owner 要求每个操作系统都提供 shell 选择:设置页注册 shell、会话创建时按设置默认选择、shell 失效时中途切换。底下的硬要求是:模型必须始终确切知道自己运行在哪个 shell 下——"模型以为是 X、执行器跑的是 Y"必须不可能——且每次变化都要准确及时地到达模型侧。

## Decision

在既有路由化 shell 缝上做三层泛化,顺带修掉 macOS 的事实文本谎言(事实说 bash、执行器跑 zsh):

- **词汇表先行**(`@deepseek-ai/dsh-shell`):存储的栈偏好变为全平台生效的 `'platform-default' | 'bash' | 'pwsh'`;注册表模型并入——内置 id `posix`/`pwsh`(不可删除)、自定义条目 `{id, path, label?}`、方言类分类器(POSIX bash/zsh/sh/dash/ksh 与 PowerShell 路由到两个已组合栈;fish/nu 在设置校验期响亮拒绝),以及唯一解析器 `resolveEffectiveShell(registry, override, probeTable)`,返回 `{entryId, label, stack, executablePath, factText, degraded?}`。注册表化之前的日志值直接折叠:旧 `'bash'`→`posix`、`'pwsh'` 本就是内置 id,重放无需迁移;加性策略下 `SESSION_FORMAT_VERSION` 保持 0(digest 已复核)。
- **注册表设置与启动发现**:`shell-backend-settings` 改造(pre-release 更名)为 `shell-registry-settings`,持有命名空间 `shell-registry`(`applies: 'restart'`)并把解析后的文档暴露为 `shellRegistry` 服务。启动桥每次启动读一次存储文档,发布 `$DSH_SHELL_BACKEND`(栈;显式 env 仍优先)与 `$DSH_SHELL_DEFAULT_PATH`(自定义默认条目的可执行文件,供单栈 base 组合使用)。路由器在执行世界内经 `resolveExecutable` 探测内置与每条注册表条目;任一探测通过的 shell 所路由的家族即可挂载;`availability()` 加宽为逐条目状态加默认条目;发往默认家族的未盖章请求携带其探测解析出的绝对路径。
- **带承诺携带的会话选择**(`dsh-session-shell`):持久覆盖变为条目 id(`session-shell/change` 载荷加宽,重放时折叠旧值);`switch(agent, entry)` 对照探测表校验;`session.create` 接受可选 `shell`(在创建任何东西之前校验;出生事件即使等于当日默认也持久化,因此后续默认变化不会移动已钉住的会话);`host.describe` 携带启动稳定的 shell 快照供创建抽屉使用;`session.shell`/`session.switchShell` 改说条目。

三条硬规则让 X-vs-Y 在结构上不可表达,并在决策发生处执行:

1. **一个事实源**:提示词事实、工具目录限制与执行戳全部派生自 `resolveEffectiveShell`;任何消费方不得自行解析 shell。
2. **一次物化**:每次 `systemPrompt.assemble` 把会话生效 shell 冻结为派发承诺(所有 assemble 消费面按契约都是模型可见的,因此重冻结总伴随模型看到的文本);`dsh-tool-bash`/`dsh-tool-pwsh` 仅在承诺携带物化可执行文件——条目探测解析出的绝对路径,或绝对路径配置原样——时从该承诺盖章 `shellPath`,执行器原样派生盖章路径,绝不重走 PATH 解析;未探测成功的裸 PATH 名条目不盖章,由所属执行器经自身平台知识解析(`dsh-pwsh-local` 的知名位置与 Windows PowerShell 5.1 兜底),PATH 探测看不到 shell 的宿主因此仍可执行(2026-11-13 回归修复:裸名盖章曾覆盖该解析,使商店版/非 PATH 安装 pwsh 的 Windows 宿主以 `spawn pwsh ENOENT` 失败)。请求中途的切换因此不能让在途调用跑到该请求未被告知的 shell 上。
3. **解析器内闭门**:孤儿或不可用目标在解析器内部降级为平台内置并报告 `degraded` 原因,事实命名实际运行的 shell;切换到不可用条目拒绝;创建时显式选择不可用条目使创建失败。

事实行按实际可执行文件的 basename 命名(绝不是条目 id)及其语法类,仅对声明绝对路径的条目展示路径,PATH 名内置项因此保持主机稳定文本。切换后的首次组装追加一条钉版本变更通知(`The session shell changed from X to Y; shell commands now run under Y.`);在途请求按其冻结承诺完成。

## Alternatives considered

- **按 OS 扩宽旧家族 union**(把 zsh/fish 做成家族):否决——家族是已组合的栈(执行器+工具+方言契约);让可执行文件注册表路由到两个真实栈,交付自由而不交付未测试的栈。
- **条目仅经 env 串给路由器**:否决——设置文档才是用户侧来源;桥只发布启动稳定的栈(加默认路径),探测读进程内 `shellRegistry` 服务。
- **运行中失效的推送式可用性事件**:否决——挂载只发生在启动期;"shell 死了"的运行时形态就是调用失败,因此可用性按反应式重读(切换失败/面板重绑),不加投机通道。
- **不可用条目静默回退到同栈兄弟**:否决——显式用户选择是信任;解析器的降级自我报告,事实跟随真相。
- **工具改名为中性 `shell`**:暂否——提示词事实承载真实 shell 身份;改名广泛改变模型可见面而功能零增益(门留着)。

## Consequences

- Windows 语义保持(`platform-default`→pwsh;`bash`/`posix`→Git Bash 栈),macOS/Linux 获得真实选择,含 unix 上的 pwsh(支持矩阵:web 组合环境的 CI 增加 `DSH_SHELL_BACKEND=pwsh` Linux lane)。
- 旧 `shell-backend` 命名空间与 `git-bash` 值在 pre-release 窗口消亡:携带它们的设置文档在加载期响亮失败,迁移一行(`shell-registry: default: bash→posix`)。
- 条目 CRUD UI、创建抽屉选择器与条目级终端面板切换器是后续 PR;本次交付缝、RPC 面与栈级 UI 适配。
- 单栈宿主保持 `switchable: false`(无路由器、无逐会话切换);其自定义默认可执行文件仅当栈与组合一致时经 `$DSH_SHELL_DEFAULT_PATH` 进入执行器配置。

## Verification

- 单元:解析器(默认/显式/不可用/孤儿/旧值折叠/事实钉版本/未探测裸名不盖章)、路由器(条目探测、经条目挂载家族、默认条目采纳、env 钉、默认路径盖章)、设置契约(slug/保留/重复/方言/默认校验)、session-shell(生效解析、串行切换、旧词汇、派发承诺冻结与请求中途稳定、变更通知恰好搭载一次组装、按栈限制、孤儿降级)、启动桥(文档形状、覆盖优先、路径发布规则)。
- REAL 组合:注册表 loader smoke 经真实 Loader 引导 种子文档 → 启动桥 → 旗标对;bundle spec 钉住 XOR 门控;session digest 复核未变。
- 事实/金夹具:PATH 名主机上的内置事实行逐字节稳定(金夹具不变);web e2e 设置节重定向到 `shell-registry`。

<!-- dsh-translate-docs: language-switch(zh, en) -->
