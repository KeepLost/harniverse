# @deepseek-ai/dsh-code-runtime-python

[English](README.md) | 中文

[`@deepseek-ai/dsh-code-runtime`](../code-runtime/README.md) seam 的全新 CPython 进程 Service Provider。它以 `language: 'python'` 与 `isolation: 'process'` 注册 `ctx.codeRuntime`；每次 `run()` 都启动一个 Python 进程、执行一个异步函数体、等待进程退出，并且不向下一次运行保留任何状态。

此提供方需要显式选择。已交付的 Profile 均不选择它。已经启用 Code Mode 的部署可把 `code-runtime` Cordis 配置项替换为：

```yaml
- id: code-runtime
  name: '@deepseek-ai/dsh-code-runtime-python'
```

`dsh-tools` 读取 `ctx.codeRuntime.language`，因此现有 `run_code` Consumer 会投射其 Python SDK 与 Python schema 文本，无需 Python 专用工具或 agent-loop 分支。

## 配置

| 配置键 | 默认值 | 约定 |
|---|---:|---|
| `pythonExecutable` | `python3` | 直接传给 `spawn()` 的非空可执行文件名或路径；不经过 shell 解释。该可执行文件必须提供 CPython 3.10 或更高版本。 |
| `cpuSeconds` | `60` | 正整数秒的 `RLIMIT_CPU` 软限制；Python 暴露 `resource.RLIMIT_CPU` 时应用。 |
| `maxWallMs` | `600000` | 正数 Host 墙钟上限，包含 bootstrap 与等待绑定的时间。 |
| `maxAddressSpaceMb` | `512` | 正整数 MiB 的 `RLIMIT_AS` 软限制；仅在平台将其计为地址空间时应用。macOS 将 `RLIMIT_AS` 别名为 `RLIMIT_RSS`，因此该限制在 macOS 上不生效；CPU 与宿主挂钟上限仍然生效。 |
| `maxOutputBytes` | `67108864` | 有序日志加完成值或失败消息的合并序列化预算。 |
| `maxControlBytes` | `67109888` | 控制 JSONL 帧的最大宽度；必须比 `maxOutputBytes` 至少多 1 KiB。此提供方上限也约束单个绑定参数或 resolve 值帧。 |

无效配置会使插件初始化失败。缺失可执行文件、解释器退出、资源终止、格式错误的超宽帧、程序异常、超时、中止、无效完成值或输出溢出都通过 `CodeRunResult.error` resolve；无效可移植绑定、dispose 后误用与无效配置会作为 Service Definition 误用而 reject。

## 进程与协议

Node 以 `['-I', '-B', py/bootstrap.py]`、`shell: false` 和仅用于解析裸可执行文件名的 Host `PATH` 启动 `pythonExecutable`。bootstrap 会在模型代码运行前清空自身环境。标准输入承载 Host 到子进程的控制帧，fd 3 承载子进程到 Host 的帧，每行一个无版本号 JSON 对象：Host 发送 `boot`、等待 `boot-ack`、发送 `run`、用 `reply` 服务 `call` 帧，并接受一个 `done`。`src/protocol.ts` 与 `py/protocol.py` 镜像每个必填和可选字段；真实 `python3` mirror 测试会检查两侧的完整帧清单。

Host 把每个子进程帧都当作敌意输入：先封顶行宽再解析，拒绝会被 JavaScript 舍入的整数 token，逐字段校验并重建已知帧，忽略未知／格式错误的帧与重复 call id，以自有属性查找绑定，并重新校验完成值。子进程错误与 Host 进程失败只公开有界诊断，不公开进程路径、环境值、stack 或原始协议 payload。

bootstrap 只使用 Python 标准库。它把模型源码包装进 `async def __dsh_main__()`，使顶层 `await` 与 `return` 可用；将每个命名空间注入为异步函数，物化可选的有类型绑定异常，并把参数、回复与完成值校验为无损 JSON。Python 层 stdout/stderr 写入和 `console.log`／`warn`／`error` 调用共用一条有序协议流；绕过 `sys.stdout`／`sys.stderr` 的原生写入仍由 Host 作为有界兜底输出捕获。

dispose 会把提供方标为不可用，把每个实时运行结算为中止，终止每个子进程，并在 Cordis fiber 完成前等待所有子进程退出。

## 模型体验

### Python Code Mode 选择

#### 模型看到什么

[`dsh-tools`](../../core/tools/README.md) 中的 Code Mode 根据此提供方的 `language` 描述符选择既有 Python SDK 与 `run_code` 文本，再把有界日志、无损 JSON 完成值或经过净化的失败渲染进保留的工具结果。

#### Token 影响

选择此提供方会以 Python 形态替换 TypeScript Code Mode SDK 与工具描述 token；运行结果只保留由 Consumer 选出的有界日志、完成值或失败。

#### KV Cache 影响

选择此提供方会把新装配请求中的 Code Mode SDK 与 `run_code` schema 从 TypeScript 改为 Python；未改变的 Python 装配保持稳定前缀。

## 已知限制与暂缓事项

- **进程隔离不是沙箱**：模型代码与 Host 共享文件系统、工作目录、网络和操作系统身份。由 bootstrap 清空的环境会减少意外继承凭据的风险，但不会建立安全边界；敌意代码的约束应使用容器后端。
- **资源限制依赖平台**：只有 Python 的 `resource` 模块及相应限制存在时才应用 `RLIMIT_CPU` 与 `RLIMIT_AS`；`maxWallMs`、进程终止、控制帧与输出上限在所有平台上仍由 Host 执行。
- **Python 无法区分显式 `return None` 与从异步函数末尾自然退出**：两者都以 JSON `null` 完成；需要「完成值缺席」的调用方无法通过 Python 函数返回语义表达该区别。
- **原生 fd 1／fd 2 写入会绕过有序 Python 流**：Host 仍会捕获并约束它们，但操作系统通过两条独立管道投递时无法保证原始的跨 fd 顺序。
- **Python SDK 渲染器遵循 Node 的 Unicode 标识符表**：CPython 3.10 可能拒绝由较新 Unicode 版本新增字符形成的非 ASCII 工具标识符；ASCII 工具名不受影响，异常名称仍可通过命名空间索引访问。
