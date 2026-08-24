# Agent Note: Code Mode 语言分发与 Python SDK 渲染器

Status: implemented

[English](2026-07-31-code-mode-language-dispatch.md) | 中文

## 问题

Code Mode 只生成一种 SDK 形态：TypeScript。`ToolRuntime` 为 `tools:sdk` 段硬编码了 `renderToolsSdk`，且 `requireCodeRuntime` 会拒绝任何 `ctx.codeRuntime.language !== 'typescript'`。引入 CPython 后端后，程序的源语言不再固定：同一个可见工具注册表在加载 Python 运行时时必须投射出 Python SDK，而面向模型的 `run_code` schema 字符串（"Execute a Python program …"）也必须与 SDK 段的语言一致，模型才不会在 Python 运行时下看到 TypeScript 指令。

这是多语言 Code Mode 拆分中面向工具的那一半；[代码运行时 seam](../../../../packages/code-runtime/code-runtime/README.md) 已经携带 `CodeRuntime.language`。本 Note 只负责 `dsh-tools` 如何在该字段上分发。实现 `language: 'python'` 的后端由它自己的 Note 负责，单独交付。

## 决策

语言选择就是对 `ctx.codeRuntime.language` 的查表，在提示词装配时惰性解析，查 `dsh-tools` 里两张平行的表：

- `SDK_RENDERERS`（index.ts）把语言映射到它的 `tools:sdk` 渲染器——`typescript → renderToolsSdk`、`python → renderToolsSdkPy`。`tools:sdk` 段读取所加载运行时的语言并选出渲染器；`requireCodeRuntime` 拒绝其语言不在表中的 `mode: code`/`both` 运行时，并列出已知语言。
- `RUN_CODE_FLAVORS`（code-mode.ts）把语言映射到它那两条面向模型的 `run_code` 字符串（工具 `description` 与 `code` 参数描述），使一种语言的 SDK 段与它的传输 schema 始终一致。

两张表在使用前都以 `Object.hasOwn` 读取，这样名为 `toString`/`constructor` 的语言不会把继承自 `Object.prototype` 的成员解析成渲染器。两个守卫的可达性不同：`SDK_RENDERERS` 的回调内守卫不可达，因为 `requireCodeRuntime` 已在同一回调更早处校验过同一张 `const` 表（它带 `/* v8 ignore */`）；而 `RUN_CODE_FLAVORS` 的守卫是主要的、可公开到达的拒绝路径——任何缺席 flavor 表的语言都经 `run_code` 的语言感知 getter 到达它，而公共 `schemas()` 抵达那些 getter 时并未先过 `requireCodeRuntime`；测试直读 definition 上的其中一个 getter，用的是对两张表都缺席的语言。「在 `SDK_RENDERERS` 里却不在 `RUN_CODE_FLAVORS` 里」这种漂移已由共享的 `CodeSdkLanguage` `satisfies` 在 `typecheck` 处拒绝，两个守卫都看不到这种输入；它们如今负责的是所挂载运行时报告了一门两张表都缺席的语言。schema 发射通过 `peekRuntime()` 而非 `requireRuntime()` 读取运行时：`undefined`（无运行时，由直读 definition 的读者与 `schemas()` 到达，其中 doc-catalog 采集是唯一已交付的一个，而它们都不会喂给模型，因为组装路径先过 `requireCodeRuntime`）降级到 TypeScript flavor，而挂载了未知语言则 fail loud——这不是下方被否决的静默回退，那指的是为真实运行时发出错误语言的 SDK。新增一门后端语言是三处并列编辑——一个 `CodeSdkLanguage` 成员加两条表项——再加它的渲染器，以及点名已知值而非从中派生的散文（seam 侧的 `dsh-code-runtime` README 双语对、它的 `CodeRuntime.language` JSDoc 与 `docs/subsystems/code-runtime.md` 双语对；本包自己的 README 双语对与它的 `Config.mode` JSDoc，无任何 gate 检查其中任何一处），不动 `agent-loop`，也不动注册表结构。

`code-mode.ts` 只依赖运行时 Service Definition（`@deepseek-ai/dsh-code-runtime`），绝不依赖具体后端；分发在运行时按 `runtime.language` 进行。因此工具层独立于 Python 协议和后端——它只需要服务的 `language` 字段。

### Python SDK 渲染器

`py-types.ts` 渲染 `jsonSchemaToTs` 所覆盖的同一套统一工具 schema 词汇，目标为 Python：`jsonSchemaToPy` 为每个 JSON-schema 节点发出一个类型表达式，`renderToolsSdkPy` 为每个可见工具的参数与规范输出装配具名 `TypedDict`，再加一个带用法说明的 `tools` 对象，与 TypeScript 形态等价。不支持的原始构造在装配时降级而非抛错，与 TypeScript 渲染器的约定一致。输出是确定性的——工具按字典序排列，工具集不变时文本逐字节相同——因此提示词保持 prefix-cache 友好。字典序意味着单一有序的成员流：名字不是合法属性的工具以 `tools[name]` 注释出现在它排序后的位置上，而不是被分拣到末尾，与 TypeScript 形态就地为异常键加引号的做法一致。这个成员流直接决定了一件事：注释行不是语句，所以一个不发出任何方法的工具集仍需显式 `pass`。另有三条规则并非源自排序，而是 Python 特有。其一，用法约定声明这些声明只是静态存根、参数为普通 `dict`/`list` 值：`TypedDict` 读起来像一个可构造的类，模型若写 `FooArgs(field=1)` 会得到 `NameError`——TypeScript 的 `interface` 一眼就是类型，且 TS 形态的「runs type-stripped」一句已经覆盖了它。其二，描述会成为方法的 docstring，且必须作为方法体的**第一条语句**发出：放在 `async def` 之上，第一条会变成 `Tools` 的类文档、其余都是无效果表达式，导致每个方法都没有文档。其三，`list[…]` 链超过 `MAX_LIST_NESTING` 后降级为 `Any`，因为 CPython 的 tokenizer 拒绝一行中超过 200 个同时未闭合的括号，而这个块必须是可解析的 Python——与 `docLines` 转义引号和反斜杠是同一个理由。`ts-types` 两者都不需要：TypeScript 会把前置的 `/** … */` 附着到其后的成员上，其语法也不对嵌套设限。

该上限服务的标准是**语法合法性**，这条边界是有意划定的：长的 `A | B | …` union 在任何长度下都是合法 Python，故不设上限——尽管 CPython 的 `compile()` 在沿左嵌套 `BinOp` 脊柱下降时会耗尽 C 递归（在 3.9 上实测：1,000 个分支可编译，5,000 个抛 `RecursionError`）。没有任何东西会编译这个块——它是提示词文本——所以那条限制在这里没有代价；而给 union 长度封顶会作废那几个钉住 walk 线性时间与类名传播上限的深链测试。将来若有渲染器确实需要可编译的输出，应当把 union 拍平，而不是截断。

`renderType` 先用 `assertSupportedJsonSchema` 整树校验一次、随后信任它，用单个 `try/catch` 把整个遍历兜住并降级为 `Any`——与姊妹渲染器 `ts-types` 在这个 typed 同进程边界上采取的「校验后信任」姿态一致（[Trust TypeScript at typed same-process boundaries](../../../../AGENTS.md)）。它有意不设任何针对「访问器在多次读取间变值」的防御（校验后成环、`const`/`enum` 的 TOCTOU、自引用函数）：输入是第一方注册（`defineTool` 字面量或 raw 注册）或从 wire 桥接而来的纯 JSON schema——前者按 AGENTS.md 受信任，后者是 `JSON.parse` 产物、物理上不可能携带访问器，且每次调用 `renderType` 都会整树重新校验——这类输入不可达，而在此加逐形态守卫会为静态接口所禁止的值破坏与 `ts-types`（没有这类守卫）的对称。`jsonSchemaToPy(schema: unknown)` 接受 `unknown` 并对畸形 schema 返回 `Any`——TypeScript 形态 `unknown` 的对应物——但它的约定是「降级不支持的 schema」，而非「扛住对抗性的可变 schema」。

## 考虑过的替代方案

- **在 `ToolRuntime` 上加一个 `language` 配置字段。** 那样部署方就会有两处命名语言（所加载的运行时与 tools 配置）且可能相互矛盾；所加载的运行时是唯一真源，故注册表读取它而不复制它。
- **把 Python 后端 import 进 `code-mode.ts` 来检测它。** 那会把工具层耦合到具体后端，并迫使协议/后端 PR（Pull Request）先落地。按 `language` 运行时分发使该层保持后端无关、可独立发布。
- **为未知语言提供默认渲染器。** 静默回退会在比如 Ruby 运行时上发出 TypeScript SDK——模型会看到错误语言的指令。在装配处 fail loud 是本仓库对错误配置的立场。

## 后果

新增一门后端语言是三处并列编辑——一个 `CodeSdkLanguage` 成员、一个 `SDK_RENDERERS` 表项、一个 `RUN_CODE_FLAVORS` 表项——再加第二处所指向的渲染器函数，不动 `agent-loop`，也不动注册表结构。两张表（`SDK_RENDERERS`、`RUN_CODE_FLAVORS`）必须同步，且这条不变式由静态检查把关，而非交给 review：两张表都以 `satisfies` 对上述同一个 union 校验，因此只加其一而漏掉另一会在 `typecheck` 处失败。这正是该漂移风险应有的机械形式——运行时的 `Object.hasOwn` 守卫同样能捕获，但要等到有后端报告该语言之后：触发点在消费方的集成处而非漂移引入处——而只要不存在第二个后端，就永远不会触发。两张表的声明类型仍是 `Record<string, …>`，因为 `CodeRuntime.language` 是不受约束的 `string`：union 钉住 harness 交付了什么，守卫拒绝运行时报告了什么。落在这条检查之外的是点名已知值而非从中派生的散文：seam 侧的 `dsh-code-runtime` README 双语对、它的 `CodeRuntime.language` JSDoc 与 `docs/subsystems/code-runtime.md` 双语对，再加本包自己的 README 双语对与它的 `Config.mode` JSDoc。更早的 note 点名这些值时记的是当时的状态，不在此列。让它无 gate 的是两条独立理由。其一，散文根本不受类型检查，union 放在哪里都一样。其二，类型级替代在这里也不可用：Service Definition 包不得 import 其消费方的表，而 `CodeRuntime.language` 按设计保持不受约束的 `string`，即便把 union 迁进 Service Definition 也不会作用到它。用一个断言两张表键集相等的 unit test 的方案被否决：它买到的是同一条检查，代价却是把两张私有表做测试专用导出，且运行时机晚于编译器。对两张表都缺席的语言，两种运行时失败中报出哪一条随入口而异：组装路径报缺渲染器，因为 `wireSchemas` 在投影前先调 `requireCodeRuntime`；而公共 `schemas()` 先经过 `run_code` 的语言感知 getter，报的是缺 flavor 表项。工具层不依赖任何具体后端，因此它能先于 Python 协议和后端交付并可测。

显式挂载 [`dsh-code-runtime-python`](../../../../packages/code-runtime/code-runtime-python/README.md) 提供方时，两张表的 Python 分支都可到达。其真实进程、协议 mirror 与构建后入口测试钉住提供方路径，而已交付的 Profile 继续选择 TypeScript。在已交付 Profile 中选择 Python 之前，仍需补充 keyless 的组装模型 transcript；包级进程覆盖不能替代该组合证据。

Python 提供方通过只注入已声明绑定命名空间与可选错误类、绝不注入仅存在于提示词中的 `TypedDict` 声明来兑现 SDK 文本。语言切换竞态仍然存在：schema 投射与 `run_code` 执行会分别解析服务，因此在两点之间把一个后端热替换为另一个，可能让代码在不同于请求所呈现语言的运行时下执行。已交付组合不执行这种替换，但未来的动态提供方切换需要请求作用域的运行时身份，而不是再次查找。

Python 提供方把 CPython 3.10 设为下限，并接受此处描述的渲染器 Unicode 表偏斜：Node 可能把一个非 ASCII 工具派生标识符分类或大写为较旧受支持 CPython tokenizer 拒绝的形式。ASCII 工具名不受影响，异常名称仍可通过命名空间索引调用。在部署需要整个范围内支持非 ASCII 裸标识符之前，把渲染器标识符与大小写表钉到解释器下限仍属暂缓事项。
