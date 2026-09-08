# @deepseek-ai/dsh-command-reset

[English](README.md) | 中文

面向人类的 `/reset` 控制，基于 [`ctx.contextReset`](../context-reset/README.md)。本插件通过 [`ctx.commands`](../../interaction/commands/README.md) 注册一条全局命令，任何组合了命令适配器的表面无需唤醒冷 Agent 即可发现它。执行时解析宿主的 context-reset 服务，不进入模型 turn。[上下文重置 Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-context-reset.md) 拥有边界与显示决策。

## 命令契约

| 输入 | 结果 |
|---|---|
| `/reset` | 用一个检查点标记遮蔽当前全部表面，持久化 flush 完成后报告被遮蔽的历史条数。 |
| 无历史的 `/reset` | `No history to reset yet.` —— 不追加任何事件。 |
| `/reset <任意内容>` | `Usage: /reset (no arguments)` —— 命令不接受参数。 |

命令只依赖 `resetNow(agent, signal, sourceCommandId)`。未组合 `ctx.contextReset` 的组合收到 `Context reset is unavailable in this composition.`。派发 UI 的取消信号经 seam 透传。每次已解析调用记录 executor 拥有的 log-only 事件对 `command/run` / `command/done`；两者都不进模型历史。成功时 `command/done.sourceEventSeq` 指向标记的 `user/message` 事件，呈现层可据此把命令生命周期折叠进检查点。

预期 `ContextResetError` 码映射为稳定的直接错误：

| 码 | 直接结果 |
|---|---|
| `busy` | `Context reset is unavailable because the session has not reached a closed-turn boundary. Try again once the current turn settles.` |
| `cancelled` | `Context reset cancelled.` |
| `commit` | `The history changed before it could be reset. The conversation is unchanged.` |
| `persistence` | `Context reset finished, but the session could not be saved.` |

插件拆卸先注销 `/reset`，再排空所有已开始的 handler。reset 运行期间提交的 prompt 仍按普通 FIFO 接受，仅在 flush 完成后开始。

## 组合

```yaml
- id: context-reset
  name: '@deepseek-ai/dsh-context-reset'
- id: command-reset
  name: '@deepseek-ai/dsh-command-reset'
```

随附的 `dsh` base 把它与 `context-reset` 一起装载，Web client 提供命令适配器。显示历史的首页在 reset 锚处截断（`compaction` 检查点形状）；更早的历史滚动一次即达。

## 模型体验

### 用户 `/reset` 控制

#### 模型看到什么

斜杠输入与直接结果不进入模型请求。被接受的 reset 留下一条逐字固定的 `user/message` 标记；其前的一切离开模型上下文，但在日志中保持可检索。

#### Token 影响

命令生命周期不增加模型 token。成功的 reset 使之后的请求不再携带更早的表面 token。

#### KV Cache 影响

发现与命令记账不影响缓存。整表面替换使复用从第一个被遮蔽的历史 token 起失效。

## 已知限制与暂缓事项

- **仅 idle** —— `/reset` 等待运行中的 agent 收敛；排队的 prompt 不被打断。
- **无参数** —— 无参形式保证跨命令适配器的行为稳定。
- **仅命令适配器** —— 没有 `ctx.commands` 的表面无法调用，直接使用服务 seam。
