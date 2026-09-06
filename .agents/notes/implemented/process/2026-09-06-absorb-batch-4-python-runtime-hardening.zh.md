# Agent Note: Absorb 批次 4 — Python CodeRuntime 有界积压与载入时解释器校验

Status: implemented

[English](2026-09-06-absorb-batch-4-python-runtime-hardening.md) | 中文

## 问题

Absorb-soon #13 以三步加固了官方 Python `code-runtime` 提供方，而我们的独立实现尚未吸收。它为两条无界的单次运行队列设界：敌意子进程可以发出无限个永不结算的 `call` 帧（每个都钉住一个宿主绑定 Promise），也可以停止消费 `reply` 帧而让宿主在 stdin 背压里持续写入。它在校验时对绑定元数据做一次快照，使敌意 getter 无法在校验、boot 装帧与派发之间换值或再次抛出。它还在插件加载时校验所配置的解释器——先解析为可执行文件，再在强杀超时下探测它确为 CPython 3.10+——而不是把所有失败推迟到宿主已投入运行之后的 `worker-exit`。

## 决策

按契约级移植到我们的 fd-3 JSONL runtime。`MAX_PENDING_BINDING_WORK = 1024` 同时约束两个方向：`onCall` 统计在途已派发调用，在派发第 1025 个之前把该次运行结算为 `worker-exit`（`call backlog exceeded 1024 in-flight binding calls (a binding never settled)`），并在异步体的 `finally` 中递减；`sendReply` 统计已写入但尚未被流冲刷的回复帧（`writeFrame` 转发的冲刷回调负责递减），达到上限即结算 `worker-exit`（`reply backlog exceeded 1024 frames the child has not consumed on stdin`）——我们子进程的回复读取线程使真实溢出不可达，因此该上限是经 fake 流验证的纵深防御。`validateBindings` 对 `global`、`functions`、`errorClass.name`、`errorClass.memberNameProperty` 各只读取一次，存入仅含函数值成员的 null-prototype `ValidatedNamespace` 快照；boot 帧与派发都消费该快照，getter 无法再次触发，`__proto__` 成员按自有属性派发。构造器在纯限额检查之后，一次性解析 `pythonExecutable`（`resolvePythonExecutable`：绝对路径或含分隔符路径按可执行普通文件检查，裸名在绝对 Host `PATH` 条目上扫描，Windows 追加 `.exe` 变体），再探测它（`execFileSync -I -c 'import sys; print(sys.implementation.name, …)'`、仅 `TMPDIR` 环境、5 秒超时加 `SIGKILL`、1 KiB 缓冲）；解析失败与非 CPython 或低于 3.10 的探测都在插件初始化时 reject，且每次运行都 spawn 已存储的绝对路径，加载之后的 `PATH` 变更无法更换解释器。绑定校验的拒绝消息与 spawn 环境（仅 `PATH`）保持不变。

## 考虑过的替代方案

**官方的 open 日志持有加封（bca392e6d1）与零内容跳过（d9ed44d62c）。** 附证据的 NO-OP：我们的 `LogMessage` 携带完整 `text` 字符串，没有 `open` 续写字段（src/protocol.ts），子进程每次写出发送一个完整帧，宿主已对日志准入（`OutputLedger`）与帧行（`JsonLineReader`）做字节设界，不存在可加封或可洪泛的分片数组。

**回复队列的排水循环压实（8e9d5467b0）。** 结构上不适用：我们没有回复数组；计数加冲刷回调的上限以同一不变式替代队列。

**与上游一致的仅 Unix 加载校验。** 拒绝：我们的提供方同样发布在 Windows 上；解析会尝试 PATHEXT 式的 `.exe` 变体，探测本身平台无关。

## 后果

敌意程序无法通过永不结算的绑定调用钉住无界宿主工作；停止消费回复的子进程以有界 `worker-exit` 显形，而非无界 stdin 缓冲。一次读取的绑定快照关闭了校验与 boot／派发之间的 getter TOCTOU。配置错误的解释器（`pythonExecutable` 指向目录、不可执行文件、PATH 上缺失的名字、非 CPython 解释器或低于 3.10 的 CPython）现在在插件初始化时以精确消息失败，而非运行中失败。缺少可探测 CPython 3.10+ 的部署完全无法加载该提供方，且插件加载会启动一个短暂的探测子进程。证据：RED 先行的 fake 套件用例复现了缺失上限（超时）、未探测的加载与 5 次读取的 getter；真实 CPython 测试钉住 `/bin/echo`、`pypy`、`cpython 3.9`、探测失败与 node 的加载拒绝、加载后删除包装器的路径，以及 5000 帧原生 fd-3 洪泛结算为调用积压 `worker-exit`；聚焦包套件 46/46。
