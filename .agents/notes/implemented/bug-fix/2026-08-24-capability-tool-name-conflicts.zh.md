# Agent Note: 工具名冲突不应使 Profile generation 失败

Status: implemented

[English](2026-08-24-capability-tool-name-conflicts.md) | 中文

## Problem

在 `standard` 系列的 Agent Profile 上选中持久化 shell 后，Web UI 无法开始会话：工作区无法选中，消息也发不出去。Host 日志显示 `failed to apply loader entry persistent-bash`，其根源是 `tool "bash" is already registered in this scope`。

两个随发布提供的 recipe 注册了同一个面向模型的工具名。`plugin:tool-bash` 拥有 `bash`，而承载 `dsh-tool-bash-persistent` 的组 `plugin:persistent-shell` 同样注册 `bash`。它们的原生默认值按 Profile 相反：`standard`、`code`、`cordis` 加载 `tool-bash` 并关闭 `persistent-shell`，`minimal` 则相反。因此在 `standard` 系列 Profile 上加载持久化 shell 会让两者同时处于选中状态。

一个工具名在每个 scope 只能有一个归属者，于是第二次注册抛错。抛错发生在 standing Profile 挂载内部，而在那里任何未激活的行都会使整个 generation 失败——`mountPreset` 对任何未激活行都会 reject。由于 Agent 加入的正是该 generation，结果是根本无法组装出任何 Agent，这也解释了为什么故障表现为工作区选择器失效、输入框禁用，而不是缺少某一个工具。

做出该选择时没有任何环节拒绝它。`capabilities.plan` 校验了选择可管理性、组装 recipe、硬依赖、member id 与配置字段，却从未检查两个被选中的能力是否claim同一个注册表名称。于是该冲突在编辑期被接受，直到挂载时才被发现，而那时它已经被持久化。

## Decision

当两个被选中的能力暴露同一 kind 下同名的可见 member 时，`capabilities.plan` 报告 `member-name-conflict` blocker。目录在任何挂载之前就已知每个可见 member，因此该冲突在 plan 期即可判定，而 `apply` 通过既有关卡拒绝被阻断的 plan。该 blocker 会同时给出两个claim方，便于操作者看清需要处理哪一对。只有被选中能力的可见 member 计入：隐藏 member 不注册任何东西，未被选中的能力也不贡献任何东西。

此外，`compositionPatches` 会把已经存储的冲突编译成可挂载的 generation。当两个被选中的 recipe claim 同一工具名时，该 Profile 并非原生加载的那一行保留名称，与之冲突的原生行被禁用。打开一个非默认行是操作者的显式选择，而与它冲突的行只是该 Profile 的默认值，因此禁用默认值正是该选择所要求的。若不存在这种区分，则由第一个claim方保留名称，从而让结果稳定而非依赖顺序。

两部分都必要。blocker 阻止新冲突，但在关卡出现之前存储的、或在 UI 之外编辑过的 Profile 仍必须能启动；没有编译侧的恢复，这些 Profile 会永久无法开始会话，而 blocker 也无法补救，因为损害已经被持久化。

## Scope

这是一次组装规划与补丁编译层面的改动。它不改变 Remote 能力要求、认证、持久化格式、tools 注册表的单一归属规则，也不改变无冲突 Profile 所组装的工具集合。注册表仍然拒绝重复注册；改变的是冲突选择在被存储前即被拒绝，且在已被存储时被消解。

单一归属规则本身被刻意保留。一个工具名对应两份实现是真实的矛盾，在注册表内部悄悄让一方胜出，会让「我调用的到底是哪个 bash」在组装层面无法回答。

## Testing

capabilities 规格针对随发布的真实形态钉住该 blocker：两个能力各暴露一个可见的 `bash` member，一个默认加载、另一个在其之上被选中，随后断言 `plan` 报告 `member-name-conflict` 且 `apply` 拒绝被阻断的 plan。

composition 规格针对真实的随发布 Profile（而非夹具）钉住恢复行为：构建 `standard` 目录，在 `plugin:tool-bash` 保持原生加载的同时选中 `plugin:persistent-shell`，断言两者确实都处于选中状态，并要求编译出的补丁禁用 `tool-bash`。读取随发布文件正是让该测试跟踪真实缺陷的原因；夹具可能偏离生产中实际发生的冲突。

恢复断言经过反证：移除 `compositionPatches` 中的 shadow 应用后确认它失败，说明它观察的是编译出的补丁，而不是空洞通过。在编写两处修复之前，一个覆盖全部四个随发布 Profile 的探测确认了该决策所依赖的默认值矩阵。

## Alternatives considered

**让注册表接受重复注册并保留最后一次。** 否决，因为一个工具名有两个归属者是矛盾，而不是合并。注册表的单一归属规则正是让组装可读的基础；削弱它只会掩盖未来所有冲突，而不是修正眼前这个。

**只让冲突行失败，其余 generation 正常挂载。** 否决，因为部分组装的 Profile 比被拒绝的更糟：会话会在静默缺失某个工具的状态下启动，而 `mountPreset` 的「所有行必须激活」契约正是 generation 与其记录组装相符的保证。

**把持久化 shell 的工具改名为 `bash_persistent`。** 否决，因为这两行是同一个面向模型能力的替代实现，而工具名是模型可见的契约。改名会让两个 Profile 对同一动作呈现不同的工具词汇，并改变 `minimal` 既有的模型可见面。

**只加 plan blocker。** 否决，因为它会让所有已存储的冲突永久损坏。所报告的故障来自持久化状态，而 plan 期关卡触及不到它。

**只加编译侧恢复。** 否决，因为它会在从不告知操作者其选择自相矛盾的情况下，静默丢弃一个被显式选中的能力。blocker 正是让该选择在做出的那一刻保持可见的机制。

**让随发布的 `standard` Profile 在 `persistent-shell` 旁手工禁用 `tool-bash`。** 否决，因为这只是手工修正一个 Profile 中的一对冲突。该冲突是任意两个共享 member 名的 recipe（包括用户自行编写的 recipe）的固有属性，因此规则属于规划器与编译器。

## Consequences

冲突选择现在会在编辑期被拒绝并给出两个claim方，而已经存储了冲突的 Profile 也能成功组装，由被显式选中的行拥有该名称。阻塞会话的故障形态——无法挂载的 Profile generation，表现为工作区不可选、输入框禁用——对这类冲突已经消除。

代价是已存储的冲突在编译期静默解决，而不会主动声明。这被 blocker 所限制：进入该状态需要关卡出现之前写入的、或在 UI 之外编辑过的状态，并且编译出的 generation 仍通过「能力」视图报告其解析后的 member，因此会话实际运行的内容保持可检查。

`member-name-conflict` 是公开联合类型中新增的 blocker code。对 blocker code 做穷尽 switch 的消费方必须处理它；随发布的 Web UI 以通用方式渲染 blocker 消息，无需改动。
