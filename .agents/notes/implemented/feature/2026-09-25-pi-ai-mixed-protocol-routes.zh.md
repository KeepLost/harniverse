# Agent Note: pi-ai 混合协议路由与协议自有的请求装配

Status: implemented

[English](2026-09-25-pi-ai-mixed-protocol-routes.md) | 中文

## 问题

pi-ai 适配器继承了四种多提供方部署无法容忍的行为，全部经 wire 层检查与真实请求对照 pi-ai 0.82.1 确认：

1. **每条路由只有一种协议格式。** `api` 作用于整条路由，因此跨 Responses 与 Chat Completions 的 OpenAI 式 catalog 无法承载另一种协议的模型，把单个模型指向其他协议意味着把全部模型一起迁移。
2. **`streamSimple()` 折叠推理选择。** 缺席选项与显式 `off` 都变成「无推理」，Anthropic Messages 随即装订成显式 `thinking: disabled`、Responses 装订成显式最低档 effort——对自身默认就在思考的模型，这是在悄悄改写谁都没提出的请求。同一路径还会让 `adjustMaxTokensForThinking` 把思考预算加到调用方的输出上限上（W4），并使 Anthropic 列表在一页后停止。
3. **工具结果可能落在中间插入的用户文本之后。** 当任何用户消息插在工具调用与其结果之间时，pi-ai 的历史转换会用合成的「No result provided」作答该调用。
4. **发现只从已安装 catalog 作答**，无法强制实时读取端点、没有行级来源标记，Anthropic 列表忽略 `has_more`。

## 决策

**按模型的协议（路由默认、条目覆盖）。** 每个模型按自身条目的 `api` → 路由的 → 已安装 catalog 条目的 → 同门模型一致同意的顺序解析协议。解析结果与已安装条目自身协议不同即为改指（repoint）：该条目的协议专属字段不再适用。提供方构造只在 profile 未点名 `api` 且每个模型都保持 catalog 描述时复用已安装 catalog 提供方；其余每条路由按模型服务——保持 catalog 描述的模型委托给 catalog 提供方，其余每种协议各自获得一个惰性构造的提供方实例——因此一条路由混用协议而无需拆成两个用户可见的提供方。

**协议自有的请求装配。** `anthropic-messages` 与 `openai-responses` 的请求经 `piStreamOptions()` 装配的协议自身 `stream()` 选项发出，它把默认 / off / 档位 / 预算四种状态分开：Anthropic 收到协议必填的 `max_tokens`（调用方上限，缺省用模型能力）、未选择时不发 thinking 字段、`off` 显式关闭、自适应模型带 effort、预算适配进调用方上限且绝不抬高（低于 1,024 在网络 I/O 前以 `UNSUPPORTED_OPTION` 拒绝）；Responses 只在调用方点名时携带 `max_output_tokens`（低于 16 拒绝）、只为非 off 的已选档位携带 `reasoning.effort`。Temperature 只在协议能接受时随行（无思考能力、显式 off、或 Responses 未选择）。profile 的 `thinkingBudgets` 值必须是不少于 1,024 的整数。其余协议保持 `streamSimple()`。

**工具结果与调用相邻。** 两条上下文转换路径都把每个工具结果排在该轮用户文本之前，调用与作答之间不再插入任何内容。

**带来源与端点模式的发现。** wire 请求新增 `mode: 'endpoint'`（放弃 catalog 答案；需要 baseURL），每条回复行携带 `source: 'catalog' | 'endpoint'`。Anthropic 列表追随 `has_more`/`last_id`（回退用最后一行 id），上限十页、超出以 `DISCOVERY_FAILED` 失败，无法继续翻页时止于已读部分。设置界面提供两个获取动作、标记 catalog 来源的候选、允许每个模型行点名协议，并以清除覆盖后组合 base 留下的端点（而非已存储的有效值）作为探测目标。

**记录而非更改的已知限制：** 已配置/已采纳的 `maxTokens` 是部署选择并成为 seam 的请求默认值（条目层面没有「只作能力」的写法）；Responses 上未作选择的推理模型由 pi-ai 按思考关闭分派。两者均已写入包 README。

## 备选方案

**把混合协议的提供方拆成两个路由键：** 否决——为一个端点复制凭据与界面，并破坏单路由模型 catalog。

**保留 `streamSimple()` 并预先调整选项以抵消其折叠：** 否决——按协议对抗通用路径等于以更差的信息重实现同一套翻译，且抬高上限的副作用无法从外部抵消。

**强制所有协议走 `stream()`：** 否决——`streamSimple()` 自身的分派对剩余协议是正确的，接管它们的选项组装要承担每个提供方的方言却没有行为收益。

**静默截断 `has_more` 与页数上限：** 选择十页上限并显式失败；无界追随会在异常端点上死循环，静默截断又恰好藏起分页要暴露的长尾模型。

## 后果

路由级 `api` 已设置的 catalog 路由不再复用已安装 catalog 提供方（每个模型都可能被改指）；提供方复用收窄到全 catalog 场景，保住了 Bedrock/Smithy 的重建约束。UI 在 catalog 路由上的协议字段读作其模型继承的默认值并支持行级覆盖，且始终提供「未选择」选项使已存覆盖可以撤销。历史转换改为结果先行，改变了所有协议上「文本与工具作答混合」用户轮次的 wire 顺序。发现回复新增一个字段（`source`），wire 上为增量。

## 验证

wire 层断言基于真实组合与 mock SSE 服务器运行：混合协议路由按模型分派（`adapter.spec.ts`）；协议自有请求装配测试在 wire 上锁定 `max_tokens`、thinking 字段的有无、预算适配、下限拒绝与 temperature 门控；Anthropic 请求体经实况确认（`{model: 'claude-sonnet-5', max_tokens: 128000}` 且无 thinking 字段）。发现测试覆盖 mode/source/分页，含页数上限与不可继续页。聚焦套件：llm-pi-ai（264 项）、ui-settings-models（274 项、逐文件 100% 覆盖）、apiproxy 配置 round-trip，`test:gui` 全绿。实况模型检查：`gpt-5.6-sol`（function_call）、`gpt-6-astra`（message + function_call）、`claude-opus-5`（tool_use）全部 HTTP 200。快照套件（cli-mock-llm、examples）只经过 deepseek-official，不覆盖 pi-ai wire；该缺口正是 adapter 测试直接断言 wire 请求体的原因。
