# @deepseek-ai/dsh-working-directory

[English](README.md) | 中文

每个会话一个已记录的有效工作目录，由唯一服务（`ctx.workingDirectory`）拥有。会话可以在对话过程中更换目录；变更通过已挂载的文件系统提供方校验、作为持久会话事件提交、在所选目录消失时恢复到原始项目，并通过普通的注入通知告知模型。

不可变的会话头继续标识原始项目目录；本服务拥有当前值及其历史。既有的进程、终端与持久 shell 保留各自进程内的目录；写权限不受影响：沙箱策略根继续从原始 header cwd 派生，因此换目录绝不会扩大可写面。

## 状态与事件

- `working-directory/change` —— 携带变更后完整绝对目录的全量会话事件。在永久 additive-only 政策下对 v0 格式为增量；digest 基线记录了该新增。
- `workingDirectory` 会话投影 —— `string | null`，由事件流折叠；首次变更前为 `null`，`get()` 回退到 header cwd，再到部署默认值。
- 模型可见通知 —— 每次提交的变更通过 agent inbox 排入一条 source 为 `{ kind: 'working-directory' }` 的 `user/message`，因此重放能重建模型当时看到的内容。

`ensure()` 校验当前目录、首次运行时记录隐式起始目录，并在当前目录消失时恢复原始项目（提交后通知失败只告警、绝不回滚）。`set()` 校验目标并提交变更。两者按会话串行，服务销毁后拒绝运行。挂载了 system-prompt 服务时，`working-directory:current` 提示词上下文在 contexts 平面发布 `Current working directory: "<path>".`。

消费方（`dsh-tool-bash`、`dsh-tool-fs`、`dsh-tool-lsp`、`dsh-tool-bash-persistent`、`dsh-agent-instructions`）通过导出的 `effectiveCwd()` 帮助函数按有效目录解析相对路径；本服务未挂载时回退到 header cwd。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `defaultDirectory` | 启动目录 | 无 header cwd 会话的绝对回退值；相对值会导致插件启动失败。 |

```yaml
- id: working-directory
  name: '@deepseek-ai/dsh-working-directory'
```

## 模型体验

间接通过 `working-directory:current` 上下文与每次提交变更注入的一条通知；`dsh-tool-working-directory` 拥有直接模型交互。

#### KV Cache 效果

该上下文是动态状态而非静态前缀：提交的变更会使可复用前缀失效一次，与任何其他运行时上下文更新完全一致；后续请求保持稳定，直至下一次变更。

## 已知限制与暂缓事项

- **技能目录与补全仍跟随原始项目根** —— 实时技能发现读取 header cwd；跟随有效目录是有消费方需要时的后续项。
- **子代理从父级的原始项目启动** —— 子会话的 header cwd 是父级的 header cwd；在子代理 seam 处捕获父级当前目录的事项暂缓。
- **提示词上下文被抑制会隐藏每次请求的陈述** —— 该上下文走普通 contexts 平面；抑制运行时上下文的组合会失去常驻陈述（通知仍会持久记录变更）。
