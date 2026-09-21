# @deepseek-ai/dsh-code-runtime-ptc

[English](README.md) | 中文

[`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.md) 接缝的新进程 PTC 实现：`PtcCodeRuntime` 在一个全新 Node 子进程中运行每个程序，经由共享控制通道（[`dsh-control-channel`](../../subprocess/control-channel/README.md)）通信——输入 TypeScript、宿主侧类型剥离、绑定以控制调用桥接、输出 `{ value, logs, error? }`。**这是约束，不是安全边界**：信任姿态按设计为 bash 等价（见 [Code Mode Agent Note](../../../.agents/notes/implemented/feature/2026-06-15-code-mode.md) § Trust posture），同时具备 bash 没有的约束——进程隔离、空环境、与部署 Bash 策略一致的沙箱对等、堆上限、带强制击杀的死线。

## Config

```yaml
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-ptc'
  config:
    computeMs: 60000              # busy-time budget (child-metered event-loop active time)
    maxWallMs: 600000             # wall-clock deadline; never pauses for anything
    maxOutputBytes: 67108864      # combined serialized outer-output cap (64 MiB)
    maxOldGenerationSizeMb: 512   # child heap cap (--max-old-space-size)
    nodeExecutable: /usr/bin/node # Node that runs the child (default: this process's)
    bootstrapPath: ''             # absolute preinstalled child entry (default: this package's)
```

每个字段都经过校验并给默认值；`maxOutputBytes` 是至少 4 字节的安全整数，其余数值字段为正有限数，`maxWallMs` 另外限制至多 `2147483647`（Node 的最大 `setTimeout` 延迟），`nodeExecutable` 非空，`bootstrapPath`（设置时）必须为绝对路径。在单文件可执行（yao-pkg/pkg）内部不存在子进程入口路径，运行时会改用路由变量 `DSH_PTC_RUNTIME_NODE` 复活可执行文件自身，并把堆上限放在 `NODE_OPTIONS` 中传递；打包 bin 到子进程的路由由可执行文件的入口负责。除此之外没有其他可调项。

## Design

- **每次运行一个全新进程，不做池化** — 程序的世界随子进程消亡：没有可记录的跨运行状态、状态串染不可表达、运行仅凭会话日志即可重建。
- **宿主侧在执行上下文中做类型剥离** — 程序包进 async 函数外壳，用 `node:module` 的 `stripTypeScriptTypes` 剥离（仅可擦除语法——`enum`/namespace 会被拒绝为程序 `exception` 且不派生进程），再按字节位置切回；随后作为 `AsyncFunction` 的函数体执行，顶层 `await`/`return` 可用。
- **通道按敌对端对待** — 模型代码与子进程同体，因此每个入站帧都是长度前缀 JSON，由 [`dsh-control-channel`](../../subprocess/control-channel/README.md) 传输层限界、解码并防御式分发：未知调用目标以失败应答，绑定名只做 OWN 属性解析（伪造的 `constructor` 无法沿原型链游走），沉降后的回复被丢弃，每个绑定解析值与完成值在计入前都校验为无损 JSON。无论子进程声称什么，宿主都按外层上限为每条获准日志加上完成值或诊断计账。
- **绑定拒绝类是请求数据** — 可选的 namespace 描述符给出构造器全局名和承载失败成员名的自有属性。子进程物化并注入该真实类，`instanceof` 无需硬编码 `tools` 或 `ToolCallError` 即可工作；非法或冲突的全局声明在派生进程前失败。失败路径使用模块捕获的 error 与属性定义内建函数及无原型描述符，后续模型篡改不能把被拒绝的绑定变成子进程崩溃。
- **两个独立预算，因为端是敌对的** — `computeMs` 计量子进程实测忙时（进程内 `performance.eventLoopUtilization()` 采样）：等待慢工具的程序不计账，伪造的挂起分发无法暂停它。火热同步循环会饿死子进程自身的采样器，因此 `maxWallMs` 以宿主持有的控制通道死线兜底，经关闭宽限升级到 `SIGKILL` 执行。堆溢出击杀子进程，表现为进程退出（`kind: 'worker-exit'`）。`maxWallMs` 在加载时按 `MAX_TIMER_DELAY_MS` 做范围检查：`setTimeout` 会把更长延迟钳制为 1 ms，仅做正数校验会接受一个首拍即过期的高限。
- **中间绑定值是完整 JSON** — 绑定参数与解析值经过迭代式无损 JSON 校验。程序执行前，子进程捕获自身 realm 的纯容器原型身份及仅用于外部 realm 的原生函数源检查，构造器槽篡改与用户伪造的冒充者都无法改变容器分类。它还捕获该 JSON 边界用到的全部结构与计量内建函数、以无原型方式创建属性描述符、绕过可变集合原型来保存私有遍历状态；因此对全局、原型方法或描述符形状 `Object.prototype` 字段的模型篡改都无法改变校验、线上传输或字节计账。值压平为有界深度的前序线格式穿越 JSON 帧，在对侧迭代重建。它们自身没有字节、JavaScript 调用栈或嵌套深度上限，也从不进入外层输出账本或模型上下文；provider/executor 获取边界与进程内存才是限制。
- **日志急切流入同一个外层账本** — console/stdout/stderr 文本按发出顺序以 `log` 帧过通道，每条截断到通道帧界内可编码，因此超时或被杀的程序仍能看到它打印了什么。子进程按精确 JSON 字符节计账，并在发送前对完成值与异常诊断按剩余合并预算预检；抛出的百万字节栈因此在子进程边界成为固定的 `output-limit` 诊断。绕过被修补流槽的原生 stderr 写入到达宿主的杂散管道并重复计账；对帧 fd 的原生写入会破坏通道，运行以 `worker-exit` 被包含地失败。`maxOutputBytes` 为外层 `logs` 数组加完成值或失败消息载荷的 JSON 序列化计账；固定的 `CodeRunResult` 字段名、花括号、有界错误种类标签及后续呈现空白不在这个可变载荷账本内。在上限内返回精确值；有损完成是 `invalid-output`，合并溢出是 `output-limit`，而不是替换成 inspected 字符串。
- **空环境、沙箱对等** — 子进程得到 `env: {}` 与从零构建的 argv（堆标志加入口）：没有环境凭证（强于派生命令的清洗环境规则）、没有继承的加载器标志。派生解析部署的 [`dsh-sandbox-policy`](../../sandbox/sandbox-policy/README.md) 默认策略并像 Bash 族一样经 `ctx.sandbox` 包装 argv：受限模式在没有 provider 时fail-closed（`run()` 抛出 `SandboxUnavailableError`），`danger-full-access` 原样派生，解析出的工作区根是子进程的 cwd。
- **沉降式销毁** — teardown 将在飞运行以 `abort` 失败，并在解析前等待每个子进程退出。

## 子进程入口，源码态与构建态

源码态经 Node 原生类型剥离加载仅可擦除的 `src/child.ts`；其传递闭包是 Node 内建、相对源码模块与共享的 `dsh-control-channel` 契约（经工作区的构建 exports 解析），全新 checkout 不需要本包自身未构建的 `lib/`。子进程本地与会话所属的两个 JSON 边界都围绕 JSON 帧压平并重建已校验的值，应用层嵌套永远不会触及克隆边界。构建态把旁路 `lib/child.cjs` 作为文件系统路径传入，因为 pkg 的 VFS 子进程钩子期望 CommonJS；同一路径在普通 Node 下也可用。演练该发布入口路径的仓库级要求属于[测试策略](../../../docs/testing.md)。

SDK API 是默认/具名的 `PtcCodeRuntime` 类加 `Config`。操作性的 `./child` 子路径仅作为打包派生入口存在；帧映射与执行器辅助是源码私有的实现细节。

## Model Experience

间接地经由 [`dsh-tools`](../../core/tools/README.md) 中的 Code Mode：装得下时渲染精确外层值，装不下时渲染明确的 `invalid-output` / `output-limit` 失败。只有外层 `run_code` 结果进入模型上下文并遵循其常规溢出策略；绑定流量与中间值保持在执行本地。

#### KV Cache effect

无直接失效；具名消费者拥有任何请求前缀变更。

## Known Limitations and Deferred Work

- **程序派生的 OS 进程在终止后存活** — 宽限击杀只针对子进程本身，弱于 bash-local 的进程组击杀；孤儿清理在容器后端出现前是部署侧关注点。
- **火热同步循环由 `maxWallMs` 而非 `computeMs` 终结** — 忙时采样器在这种循环内被饿死（进程没有跨进程 ELU 探针），墙钟死线才是触发的预算；其消息指名死线而非计算预算。
- **对帧 fd 的原生写入破坏通道** — JS 层 `process.stdout.write` 已被捕获，但对 fd 1 的原生式写入会与帧字节交错并使运行以 `worker-exit` 失败；读 `process.stdin` 同样会窃取帧字节。文档化的 API 面（console shim、被修补的流、绑定）保持干净。
- **一个程序必须装进通道帧界** — 引导帧携带整个类型剥离后的程序；超出 `maxFrameBytes`（默认 1 MiB）时运行以指名该界限的 `worker-exit` 失败。
- **类型剥离依赖 Node 实验性的 `stripTypeScriptTypes` API** — 若依赖行为漂移，amaro 或 sucrase 是指名的替补。
- **`computeMs` 到期最多可超出一个采样间隔** — 忙时每 25 ms 采样一次（内部常量，刻意不做配置）。
- **程序得到五方法 `console` shim**（`log`/`info`/`warn`/`error`/`debug`）— 刻意不是 Node 完整 console API。
- **中间绑定值没有字节上限** — 程序可以用一个永远不会成为外层输出的值耗尽进程内存。
- **64 MiB 默认值是拒绝边界，不是可恢复存储** — 外层溢出只能保存 `output-limit` 之后返回的有界日志与诊断；被运行时上限拒绝的字节永远不会到达溢出层。
