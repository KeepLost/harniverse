# @deepseek-ai/dsh-subagent-peer

[English](README.md) | 中文

peer provider 把每个子 agent 作为一条新的委派会话,经实例配对信道运行在一个已配对的 Harniverse 实例上。它是 ACP 后端的配对信道对应物:子 agent 活在另一个部署里,有自己的模型、工具、会话与治理;跨边界的只有委派 prompt 与其落定回复。

## 启动与所有权

`start(request)` 校验 prompt(仅文本块、非空、不超过宿主 prompt 上限),解析配置的配对目标,然后执行唯一的 `peer/delegate` Remote 调用——它同时提交 prompt 并等待其首次落定——之后才完成。完成即意味着远端回合已落定(或超出预算):返回的 run 的 `result` 已是终态,`dispose()` 没有剩余本地工作;传输失败或发布前取消只会让 `start` 拒绝。

返回的 run id 就是 peer 会话 id。与 ACP 子进程内作用域的会话 id 不同,peer 会话 id 在配对内唯一且可续聊:父模型可以把它作为 `peer` 工具的 `session` 参数配合同一目标继续会话。经 subagent 缝自身的续聊会被拒绝——本 provider 没有 `prepareContinuable` 能力,普通续聊调用路径会显式失败;工具行按 ACP 后端同样方式配置 `backgroundMode: 'one-shot'` 挂载。

超出落定预算仍在运行的回合以 `stopReason: 'error'` 落定,诊断里命名可续聊的 peer 会话。本地取消触达不了另一个部署的在途工作:发布前中止会让 `start` 拒绝,而被放弃的远端回合继续运行并消耗它自己的预算。

## 能力与上下文

本 provider 不声明任何启动期能力(`outputSchema`、`maxDepth`、`toolFilter`、`persona` 全为 `false`):本部署无法对另一个部署的组合施加任何约束,因此服务在任何 wire 调用之前就拒绝携带这些请求的调用。它报告 `inheritsParentContext: false`:远端会话全新开始,没有任何父侧派生的东西跨越配对信道——连工作目录也没有,因为远端工作区属于远端自己的配置。

每个委派回合消耗配对自身的治理:接受方的 surface 门控、回合预算与(工件流量的)字节预算原样生效,拒绝以封闭 peer 原因(`BUDGET_EXCEEDED`、`SURFACE_NARROWED`……)抵达并摊平进 start 拒绝。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `providerName` | `peer` | 在 `ctx.subagents` 上的注册名。 |
| `peerTarget` | 必填 | 每次运行委派到的配对实例:其精确实例 id 或本 home 配对目标存储中的精确显示名。每次运行时解析,启动后配对的目标无需重载即可生效。 |
| `dshHome` | 解析出的 home | 持有配对目标存储与签名身份的 Harness home。 |
| `settleTimeoutMs` | `120000` | 每个委派回合的落定预算;收敛到 `[1000, 900000]`(接受方宿主的上限)。 |

```yaml
- id: subagent-peer
  name: '@deepseek-ai/dsh-subagent-peer'
  config:
    providerName: peer
    peerTarget: build-workstation
    dshHome: !!js process.env.DSH_HOME

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: peer
    toolName: subagent
    maxDepth: 'provider-managed'
    backgroundMode: 'one-shot'
```

## 停止原因映射

| peer `endReason` | Harness |
|---|---|
| `completed`(或落定回合缺失) | `completed` |
| `refusal` | `refusal` |
| `max-tokens` | `max-tokens` |
| `aborted` | `aborted` |
| `error` 或未知 | `error`(未知原因以原始值作为诊断) |
| 预算点仍在 `running` | `error`,诊断命名 peer 会话以供续聊 |

## 模型体验

父模型调用普通的 `subagent` 工具;peer 传输不可见。结果把远端回复渲染为子 agent 的最终输出并发布 peer 会话 id。父侧 token 开销是 prompt 加落定回复——远端自身的工具流量从不进入父上下文。传递或取回文件仍走 `peer` 工具(`attachFiles`/`fetchFiles`):subagent 工具的 prompt 仅文本,远端产物通过远端回复已命名的只读句柄块寻址。

## 已知限制与 deferred work

- 仅一次性:subagent 缝上没有可续聊 Activation 轮——continuation manager 物化本地子会话,远端部署无法承载。续聊停留在 `peer` 工具上,配合已发布的 peer 会话 id。
- 无取消传播:本地 dispose 只放弃等待;远端回合运行到完成并消耗它自己的预算。远端中止 Remote 需要独立的 wire 决策。
- 仅文本 prompt:委派 wire 承载文本;图像或其他内容块在任何 wire 调用之前拒绝。
- 无工件桥接:文件经 `peer` 工具的上传/下载设施跨越配对,不经本 provider。

## 进程边界

wire driver 是 [`dsh-peer-client`](../../peer/peer-client/README.md):Grant 传输、请求证明与目标选择都在那里,目标存储(`peer-targets.json`)归发起方 home 所有。配对信道是真正的信任边界——身份密钥、surface 门控与接受方预算 enforcement——同进程 subagent 值不做防御性克隆。
