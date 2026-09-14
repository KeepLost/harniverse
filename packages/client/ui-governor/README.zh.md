# @deepseek-ai/dsh-client-ui-governor

[English](README.md) | 中文

资源看板，浏览器半：一个侧栏底部触发器占用中心列，呈现「会话即进程」总览——每会话 CPU tick、对照有效限额的内存热条、活动命令数、违约徽标、内联内存配额协商（MiB）、执法档位徽标、全局预算条，以及宿主磁盘/网络哨兵。数据经生成的 `governor` Remote（`ctx.remote.governor`）按采样节奏轮询，因此页面构造上就是脚本使用的同一 HTTP API 面。节点半不注册宿主行为；宿主服务位于 `@deepseek-ai/dsh-governor`。

## Composition

```yaml
# host row (the service this board reads)
- id: governor
  name: '@deepseek-ai/dsh-governor'
# browser row
- id: ui-governor
  name: '@deepseek-ai/dsh-client-ui-governor'
```

看板注册 `sidebar.footer.action`（触发器）与 `center.view`（看板），共享一个查看 store 支撑按压态；配额编辑调用 `sessionQuotaAdjust`（宿主侧 `harniverse.operate` 门控）。一个 `settings.section` 注册（id `governor`，排在 Plugins 页之后——运行时治理随宿主配置而来）构成「资源治理」设置页。

设置页承载全局配额：全局内存预算——自动（宿主侧解析为物理内存与自身 cgroup 上限中较小者的 80%）或自定义 GiB 数值。写入经客户端 settings 作用域（`ctx.settingsScope.bind({ namespace: 'governor' })`）通过 `settings.mutate` 落入 `governor:` settings 节，由设置域的 `harniverse.administer` 门授权；无该能力的身份看到只读表单。宿主服务的 settings 钩子在变更时热重解析并重应用预算，无需重启。表单旁显示的生效预算经 `configGet` 回读——解析归宿主，页面从不禁自算。会话级配额默认继承全局预算，始终是按会话的决定（agent 的 `resource-quota` 工具或看板内联协商），绝不进 preset 字段；CPU、磁盘、网络按设计仅观测，cgroup 档将交换预算钉在 0，rlimit 档不做交换限制。

## Model Experience

None, as the board and the settings page consume the governor Remote and the settings scope only.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- 看板按固定 5s 节奏轮询，与 governor 默认基线间隔一致；推送通道（转发事件白名单）保留为 sanctioned 升级。
- 按命令下钻（样本环、对端清单）推迟；v1 呈现按会话聚合。
- 设置页读取生效预算分立即与 600 ms 后两次，覆盖宿主侧异步的 settings 应用；应用后展示值可能短暂滞后。
