# @deepseek-ai/dsh-context-inspector

[English](README.md) | 中文

agent 下一个模型请求面的只读审计清单。服务复用 agent 循环使用的同一组组装原语——`systemPrompt.assemble` + `renderPrompt`、会话 surface 折叠(`deriveMessages` 的逐节点推导)、共享 token meter——因此其输出是真实请求的投影,而非重新实现。伴随测试钉住这一主张的最强形式:与发出请求同一步内捕获的 manifest,等于该请求的 system 文本与有序消息。

## 契约

`ctx.contextInspector.manifest(agent, signal?)` 返回:

- 有序 `segments`——一个 system 段(渲染后的提示词)加上按会话顺序每个 surface 节点一段,各携带 role/种类、160 字符文本预览、估算 token 数、派生它的日志 `seq`,以及(摘要检查点)该检查点替换的 `shadowedSeqs`——审计压缩影响的日志关联把手;
- `tools`——下一请求发现的工具名;
- `totalTokens`——meter 对组装后 surface 的估算。

调用零变更、零唤醒;对空闲与运行中的 agent 都安全。

## 组合

```yaml
- name: '@deepseek-ai/dsh-context-inspector'
```

base 组合已挂载。展示面消费者(Web 审计抽屉、CLI 导出)搭乘同一服务,属后续工作。

## 模型体验

### 审计清单

#### 模型所见

无。检查器是 host 侧只读的;不引入任何会话事件、提示词段或工具。其产出的清单与真实 `llm.stream` 调用携带的 `system` + `messages` 一一对应。

#### Token 效应

请求期无。构建清单花费一次组装与一次测量遍历。

#### KV 缓存效应

无;请求输入不变。

## 已知限制与后续工作

- **尚无展示面消费者**——服务随其等价性测试落地;Web 审计抽屉与 CLI 导出在下一车次。
- **预览截断**——段携带有界预览;完整保真度留在 seq 所指的会话日志中。
- **空闲投影**——manifest 描述的是"下一个"请求面;在途请求的精确信封在其自身边界可观测。
