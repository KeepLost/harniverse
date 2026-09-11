# @deepseek-ai/dsh-context-reset

[English](README.md) | 中文

整表面上下文重置服务（`ctx.contextReset`）。一次 reset 用一个持久检查点标记遮蔽当前全部表面节点，使下一个模型请求从全新上下文开始，而保留的日志仍保持 append-only 且可检索。本插件拥有 log-only 的 `reset/checkpoint` 锚事件与替换型 `user/message` 标记；[`dsh-session`](../../core/session/README.md) 的表面折叠在追加与重放两侧都校验它们。[上下文重置 Agent Note](../../../.agents/notes/implemented/feature/2026-09-08-context-reset.md) 拥有边界与显示决策。

## 服务契约

| 调用 | 结果 |
|---|---|
| `resetNow(agent, signal)` | 等待运行中的 agent 收敛，认领 idle 维护相位，追加一个 `reset/checkpoint` 锚与一个整表面替换标记，flush 后返回被遮蔽的 seq 集。 |
| 空表面上 `resetNow` | 返回 `null` —— 不追加任何事件、不 flush。 |
| `resetNow(agent, signal, sourceCommandId)` | 将标记的溯源与发起的手动命令关联。 |

事务是一对原子追加，无需锁括号。`sourceEventSeqs` 首位引用锚的 seq（显示检查点的切点，`compaction/start` 形状），其后稠密包含每个被遮蔽的表面节点。预期失败分类为 `ContextResetError`：

| 码 | 含义 |
|---|---|
| `busy` | 认领 idle 维护相位时 agent 存在活跃工作。 |
| `cancelled` | agent 侧维护信号中止了操作。 |
| `commit` | 标记追加被表面折叠拒绝；会话未变化。 |
| `persistence` | 标记已落盘但持久化 flush 失败。 |

被中止的请求保留其精确的中止原因。操作挂起在所属 context 的生命周期上，拆卸会先排空在飞的 reset。

## 组合

```yaml
- id: context-reset
  name: '@deepseek-ai/dsh-context-reset'
```

随附的 `dsh` base 把它与命令适配器一起装载。消费者通过 `ctx.contextReset` 使用；cordis-free 的 `./checkpoint` 叶子（`resetCheckpointSource`、`isResetCheckpointSource`、`resetCheckpointContent`）让 client 与 wire 程序不必加载 host Context 合并即可命名标记。

## 模型体验

### 按需全新上下文

#### 模型看到什么

一条 `user/message` 标记，文本逐字固定：此前历史已从其上下文移除，日志仍可检索，对话从其后的消息继续。持久事件对是 `reset/checkpoint` 锚与 `surfaceOp: {op: 'replace'}` 标记。被保留的运行时上下文快照随表面一同遮蔽，下一步经既有 context-snapshot 状态机重发完整快照。

#### Token 影响

之后的请求只携带 reset 后的表面消息与这一条标记；无论自动压力如何，更早的 token 全部离开请求。

#### KV Cache 影响

整表面替换使复用从第一个被遮蔽的历史 token 起失效。

## 已知限制与暂缓事项

- **仅 idle** —— reset 认领 idle 维护相位；运行中的 agent 会被等待而非打断。
- **仅整表面** —— 部分重置属于 compaction seam 的领地；本服务不做区间选择。
- **无快照结转** —— reset 不生成自己的摘要；全新上下文正是目的。
