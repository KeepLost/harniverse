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

看板注册 `sidebar.footer.action`（触发器）与 `center.view`（看板），共享一个查看 store 支撑按压态；配额编辑调用 `sessionQuotaAdjust`（宿主侧 `harniverse.operate` 门控）。

## Model Experience

None, as the board consumes governor Remote state only.

#### KV Cache effect

None; this plugin neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- 看板按固定 5s 节奏轮询，与 governor 默认基线间隔一致；推送通道（转发事件白名单）保留为 sanctioned 升级。
- 按命令下钻（样本环、对端清单）推迟；v1 呈现按会话聚合。
