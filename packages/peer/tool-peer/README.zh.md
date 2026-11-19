# @deepseek-ai/dsh-tool-peer

中文 | [English](README.md)

面向模型的 `peer` 工具:在已配对的 Harniverse 实例上运行一条提示词并返回结算回复,或续聊既有的委派会话。它拥有面向模型的 schema、目标解析、预算与结果渲染;一切协议关注点——请求证明、Grant 传输、direct/SSH 拨号——都在 [`@deepseek-ai/dsh-peer-client`](../peer-client/README.md) 中,配对通道加固时模型所见不变。

## 工具面

注册一个工具(名称可配置,默认 `peer`)与一段使用策略提示词小节,把它限制在用户点名的已配对实例上。参数:`target`(显示名或精确 instance id;id 优先于歧义名)、`prompt`(至多 32768 字符,与接受方主机的上限一致)、可选 `session`(要续聊的委派会话 id)、可选 `timeoutMs`(结算预算,默认 120000,钳制在 1000–900000)。

一次调用从配置 home 下的 `peer-targets.json` 解析目标、签出时间窗请求证明,并经 `peer/delegate`(新会话)或 `peer/followup`(续聊)投递提示词。结构化输出携带 `sessionId`、`state` 与结算的 `reply`;渲染文本总是点名 session id,模型可据此续聊。超过预算仍在运行的回合返回 `state: 'running'` 与续查引导,而不是阻塞轮次。结束原因不是 `completed` 的结算回合,以及每一个封闭 peer 原因(`SESSION_NOT_FOUND`、`TRANSPORT_FAILED`……)都转为点名原因的工具错误。超限回复在配置上限(默认 50000 字符)处截断并附提示。

## 配置

工具行之外无配置:`toolName`、`dshHome`、`defaultTimeoutMs`、`maxResultChars` 都是 Loader 校验的普通插件 `Config` 条目。已配对目标的可达性就是配对边界本身——工具只拨号 home 属主配对的目标,接受实例的 surface 字段仍在彼端约束每个 peer 能做什么。

## 事件

无;本工具不注册自己的 Session 事件。委派回合存于接受实例的会话库,带 `origin: 'peer'`。

## 验证

`tests/peer-tool.spec.ts` 覆盖目标解析矩阵(id 优先、歧义与未知名称、非活跃记录)、预算两端钳制、running/settled/error 渲染、截断、schema 级参数校验与 fiber 卸载。`tests/loader-composition.spec.ts` 通过真实 Loader 启动插件、对脚本化配对目标断言模型可见的结果文本。组装级行为由 [acp-agent 示例](../../../examples/acp-agent/README.md)的 ACP 快照场景钉定,其组合包含本工具。

## 模型体验

### 委派到已配对实例

#### 模型所见

一个带 `target`、`prompt` 与可选 `session`/`timeoutMs` 参数的 `peer` 工具;结果点名委派 `sessionId`,并逐字携带 peer 实例的回复文本(超上限截断)。

#### Token 效果

工具描述与参数计入发起方工具目录;每次调用的提示词与回复以一次工具调用进入本地日志各一份。提示词本身投递到——并计入——接受实例上的委派会话,不重复进入任何本地会话。

#### KV Cache 效果

`peer` 调用不会在接受实例上扩展或唤起本地缓存前缀:委派会话在那里持有自己的前缀。在发起方,这次工具调用是本地会话中普通的一行工具记录。

## 已知局限与遗留工作

- 结算在预算内同步:仍在运行的回合返回稍后续查的引导;没有发起方 outbox 在目标不可达时排队提示词或轮询结算(委派 outbox 里程碑负责)。
- 父步骤中止不会取消进行中的 peer 调用;单次调用传输超时约束等待时长,活跃通道的取消随会话化通道一起推迟。
