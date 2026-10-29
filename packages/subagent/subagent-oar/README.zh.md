# @deepseek-ai/dsh-subagent-oar

[English](README.md) | 中文

本包注册基于内嵌 [OAR](https://www.npmjs.com/package/@botiverse/oar) 运行时注册表的具名一次性 subagent provider。每个 provider 实例选择一个 OAR 默认运行时（当前为 `codex` 或 `claude`）；每个被接受的运行在委派会话的工作区中打开一个原生 OAR 会话，提交一个自包含的文本任务，并仅通过共享的 [`dsh-subagent`](../subagent/README.md) 结果契约返回根助手文本。原生记录、凭据与协议细节全部留在运行时内部。

## 启动与所有权

`start(request)` 只接受非空文本块序列，并从父会话派生子工作目录。随后它使用凭据擦洗后的环境叠加层探测运行时安装，按配置的模型、推理力度、启动参数与环境打开原生会话，并且只有在会话建立后才发布运行。发布前的失败或取消会释放已部分打开的会话；取消在所有后续失败分类中保持优先。

发布后的 `run.result` 流式收集根 `text_delta` 事件，并恰好结算一个原生回合：以流式文本与最后一条非空的具名根消息为准，子代理输出与私有推理绝不外露，空答案的成功回合按空的完成结果结算。本地取消在结果竞速中获胜并映射为 `aborted`；配置了 `timeoutMs` 时，回合在不依赖模型配合的情况下被限定并映射为 `error`。每个非完成结果都携带安全诊断，指明固定的阶段（`installation` / `startup` / `turn` / `abort` / `dispose`）与类别以及一行建议；原生异常文本只保留在私有 `cause` 链与宿主日志中，绝不进入模型可见的诊断。

`dispose()` 幂等：在仍可中断时请求中止原生会话，释放 OAR 会话，并让运行句柄等待同一次释放。结果失败与独立的收尾失败保持分离，收尾失败绝不丢弃已结算的答案。

## 能力与上下文

该 provider 不通告任何可选的启动期能力，并报告 `inheritsParentContext: false`。运行时收到独立的文本任务、父会话工作目录与配置的环境叠加层，但不收到父会话内容、人设、工具过滤、深度策略或结构化输出契约。原生会话 id 对运行保持私有。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `runtime` | —（必填） | OAR 默认运行时 id；未知 id 在插件激活期失败。 |
| `providerName` | `oar` | 注册到 `ctx.subagents` 的名称。 |
| `model` | 运行时默认 | 原生模型 id；省略则保留运行时的模型选择。 |
| `effort` | 运行时默认 | 原生推理力度；不支持的取值在启动期失败。 |
| `env` | `{}` | 在 subprocessor 缝隙的凭据擦洗之后应用的显式条目；`null` 表示移除继承值。 |
| `launchArgs` | `[]` | 原生进程参数，含权限设置；OAR 校验其自有参数。 |
| `timeoutMs` | 无 | 启动后的可选回合期限（毫秒），不大于 [`MAX_TIMER_DELAY_MS`](../../util/timeout/README.md)；省略时仅依赖父级取消。 |

内嵌运行时声明 `engines.node >= 24.0.0`；在更旧的宿主上，provider 会在插件激活期大声拒绝，而不是在原生代码内部失败。凭据形态的环境变量会被共享擦洗移除（`OAR_FIXTURE_API_TOKEN` 一类的密钥绝不进入子进程），而 `PATH`、`HOME` 等普通环境值在被覆盖前保持可用。

显式组合该 provider——发行的 profile 与 preset 不挂载它。两个 provider 实例加选择工具构成文档化的组合形态（见[工作示例](../../../examples/acp-agent/tests/fixtures/subagent/subagent-oar/cordis.yml)）：

```yaml
- id: subagent-oar-codex
  name: '@deepseek-ai/dsh-subagent-oar'
  config:
    runtime: codex
    providerName: oar-codex
    launchArgs: ['-c', 'sandbox_mode="workspace-write"']

- id: subagent-oar-claude
  name: '@deepseek-ai/dsh-subagent-oar'
  config:
    runtime: claude
    providerName: oar-claude
    launchArgs: ['--permission-mode', 'dontAsk', '--permission-prompts', 'none']

- id: tool-subagent-oar
  name: '@deepseek-ai/dsh-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

## 产品兼容性与证据

发布产物内嵌打好补丁的 `@botiverse/oar@0.67.0` 实现（Apache-2.0；见 `LICENSE-OAR`），只声明该运行时外部化的依赖——消费者从不安装或解析 OAR 包本身。补丁包含 Claude `--permission-mode` 透传（替代无条件的 `--dangerously-skip-permissions`）、Codex 客户端 initialize 失败清理、以及环境叠加安装探测；`pnpm patch` 在开发期应用补丁，打包步骤将其固化进 `lib/index.js`。证据：脚本化运行时单测套件、基于工作示例的 Loader 组合冒烟、环境擦洗与启动清理的 fixture e2e，以及证明内嵌补丁与外部 OAR 不可解析的打包产物测试。

## Model Experience

### 子请求

#### 模型看到什么

配置的工具（默认为 [`dsh-tool-subagent-oar`](../tool-subagent-oar/README.md) 的 `subagent_oar`）转发 `runtime`、`description` 与完整的 `prompt`；子进程看不到本会话的任何其他内容。

#### Token 效应

被委派的任务完全在原生运行时内执行；父请求只携带工具声明与工具结果，父级 token 成本与子级规模无关。

#### KV Cache 效应

委派不改变父级前缀：工具调用及其结果追加在会话尾部，父级更早的每一个 KV 条目保持有效。

## 已知限制与遗留工作

- OAR 运行时自身的下限是 Node >= 24.0.0；本 provider 在更旧的宿主上拒绝运行，而不是抬高仓库级 engine 下限（对上游根下限抬升的已记录分歧）。
- provider 只命名 OAR 默认注册表中的运行时；自定义 OAR 运行时需要暴露注册表缝隙（在出现具体需要前搁置）。
