# Agent Note: Python 代码运行时让每次运行独占一个敌意对等进程

Status: implemented

[English](2026-08-25-python-code-runtime-provider.md) | 中文

## Problem

code-runtime Service Definition 与 Code Mode Consumer 已经描述 Python，但唯一可执行的 Service Provider 仍在 worker 线程里运行剥离类型后的 TypeScript。官方 Python 包中的 fd 3 声明并不执行程序。可用的 Python 后端必须拥有子进程、bootstrap、绑定桥接、输出 ledger、资源限制、取消与 teardown，同时保留相同的 error-as-result 和可移植绑定约定。

子进程执行模型编写的代码，并可向每个继承的描述符写入任意字节。TypeScript 类型无法使其帧可信，单纯进程隔离也无法把同宿主 Python 变成沙箱。

## Decision

`@deepseek-ai/dsh-code-runtime-python` 是显式选择的 Service Provider。`PythonCodeRuntime extends CodeRuntime`，报告 `language: 'python'` 与 `isolation: 'process'`，每次运行都以 `shell: false`、空环境和包自有的标准库 bootstrap 启动一个全新的已配置可执行文件。已交付的 Profile 与 bundle 均不选择它；替换既有 `code-runtime` Cordis 配置项属于部署决策，而现有 `dsh-tools` 语言分发会提供 Python SDK 与 `run_code` 文本。

bootstrap 在 fd 3 上接收 `boot` 元数据，在可用处应用 `RLIMIT_CPU` 与 `RLIMIT_AS`，确认就绪后再接收独立的 `run` 帧。它把源码包装进 `async def __dsh_main__()` 以支持顶层 `await` 与 `return`，根据元数据物化命名空间和有类型绑定异常，并把每个绑定参数、回复与完成值校验为无损 JSON。Python 层 stdout、stderr 与 console 风格写入共享有序控制流；Host 保留 stdout/stderr 管道，作为原生写入的有界兜底。

Host 在解析前封顶每条 JSONL 行，拒绝会被 `JSON.parse` 舍入的整数 token，逐字段校验并重建已识别的子进程帧，忽略格式错误／未知帧与重复 call id，并以自有属性查找绑定。同一个结算所有者处理 done、进程错误／退出、CPU 信号、墙钟超时、中止、输出溢出与 dispose。它会终止子进程并等待 `close`，随后才 resolve 运行或完成 teardown。程序与进程结果通过 `CodeRunResult.error` resolve；只有无效配置、无效可移植绑定与 dispose 后调用才 reject。

进程边界的失败文本采用静态文本或经过路径清理且有界的文本。Host 绑定 reject 会变成程序侧有类型消息 `binding call failed`，而不会携带可能包含路径或凭据的任意 Host 异常。进程不会收到 ambient environment，但仍与 Host 共享文件系统、网络、工作目录和身份；此提供方明确不作沙箱声明。

TypeScript 与 Python 协议声明公开可执行的字段清单 mirror 检查。真实子进程测试覆盖成功代码与日志、绑定 resolve 与 reject、敌意／格式错误帧、无效输出、CPU／墙钟超时、中止、输出上限、全新运行状态、dispose 后完全停稳，以及构建后包入口。

## Alternatives considered

**把官方仅含协议的包当作后端。** 拒绝，因为声明与 mirror 测试并不拥有进程执行、取消、输出或完全停稳；挂载该包无法满足 `CodeRuntime.run()`。

**通过 shell 命令或既有 shell 工具运行 Python。** 拒绝，因为 shell 插值会增加注入边界，使 fd 所有权与取消变得间接，并把提供方生命周期移进 Consumer。直接 `spawn()` 会把可执行文件选择与进程结算留在 Service Provider 内。

**让 Python 成为已交付默认值。** 拒绝，因为既有 Profile 有意选择 worker 线程提供方，Code Mode 组合也独立地需要显式选择。新后端不得静默改变源语言或已交付的模型指令。

**声称子进程是安全沙箱。** 拒绝，因为同用户进程即使受到资源限制且使用空环境，仍能访问同一套宿主资源。强边界属于容器或沙箱提供方。

## Consequences

部署可以在不改变面向模型的工具或 agent loop 的情况下组合真实 Python Code Mode。每次运行都支付 CPython 启动成本，且没有持久内核状态。CPython 3.10 是最低受支持解释器，与既有 Python SDK 语法一致。

资源执行随操作系统而异：Host 墙钟计时器、进程终止、帧上限与输出 ledger 在所有平台上保留，`resource` 限制只在暴露它们的平台应用。Python 无法区分显式 `return None` 与从包装函数末尾自然退出，因此两者都返回 JSON `null`。原生 fd 1 与 fd 2 写入仍有界，但跨独立管道时只有操作系统事件顺序。在 3.10 下限上，此提供方接受 Python SDK 渲染器对非 ASCII 工具派生标识符存在的 Node／CPython Unicode 表偏斜；ASCII 名称不受影响，且命名空间索引访问仍然可用。
