# Agent Note：自定义模型能力声明——图像输入、思考档位及其分派

Status: implemented

[English](2026-09-14-custom-model-capability-declaration.md) | 中文

## 问题

经模型设置页接入的自定义（手工声明）模型，除了 id、显示名和两个容量之外什么都声明不了。适配器 schema 早已拥有的能力字段——`input` 模态、`reasoningEfforts`、分派方言——只能写 YAML，页面自己的那句摘要所言不虚：其余一切都在 `settings.yaml` 里。后果在下游层层放大：

- 支持图像的本地模型永远被判纯文本：`read_image` 拒绝它、含图消息预检拒绝切换模型，两者都正确地跟随一份没有任何界面让运维作出的声明。
- 推理模型完全不出档位控制（"不出假 off 控件"的刻意姿态），而能让换模型直接落在正确档位上的每模型默认档位，连 YAML 里都不存在。
- 思考开关走一条具名格式都拼不出的字段的本地端点没有任何逃生通道：`chat-template` 恰恰因为 `chatTemplateKwargs` 未暴露而被配置面扣留。

## 决策

**声明面（本次变更）。** 模型设置页的每模型展开区现在承载能力区，只写 `llm-pi-ai` schema 已校验的字段：

- **图像输入**——勾选框写 `input: [text, image]`；不勾选把字段留给已安装条目与路由默认。DeepSeek 目录编辑器为 `inputModalities` 增加同一勾选框。
- **推理**——勾选后声明可选档位（`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`，至少一档非 `off`），每档可另填线上拼写（留空即规范拼写；`off` 留空即不发送），外加 `defaultReasoningEffort`：某个已声明档位、`off`，或 `default`——模型显式的"不发送档位"，挡住路由级 `reasoning` 默认值。取消勾选是移除声明而非存 `false`；从 catalog 模型剥除推理仍是 YAML 编辑。
- **分派（仅 openai-completions 路由）**——`thinkingFormat` 下拉，以及 `chat-template` 下的 `chatTemplateKwargs` 编辑器（字段名 → 字面量 / `thinking.enabled` / `thinking.effort`，均可加 `omitWhenOff`）。离开该格式会连同丢弃 kwargs。

**schema 侧。** `PiAiModelProfile.defaultReasoningEffort` 入 schema；`chat-template` 解禁、`chatTemplateKwargs` 入 `PiAiCompatProfile`，按模型 → 路由解析，且在解析后的格式不是 `chat-template` 时拒绝（死配置是运维要到请求体里去追的笔误）。解析按模型携带 `configuredDefaultEffort`，`resolveModel` 优先于路由默认——`describableReasoningLevel` 语义不变。

**消费侧刻意不动。** `reasoningInfo`、档位选择器、`read_image` 的路由门、apiproxy 预检全都读解析后的元数据，保存的声明无需任何消费侧改动即生效。会话内模型选择器旁的档位按钮刻意留给后续 PR。

## 证据

- `llm-pi-ai` 套件（242 测试）：每模型默认档位优先级（钉住 / `default` 压制 / 继承）、声明集外默认档位与无声明默认档位的拒绝、带 kwargs 的 `chat-template` 物化、其它格式下 kwargs 的拒绝，以及既有 compat 开关矩阵。
- `ui-settings-models` 套件（252 测试）：表单往返——图像 + 收窄档位集 + 线上拼写 + 默认档位；空档位集拒绝阻断 Apply；chat-template kwargs 落成 `{$var}` 对象；DeepSeek `inputModalities` 勾选框替换目录数组中的一行。
- `pnpm run test:gui` 330 文件 / 4938 过；`typecheck`、`lint:contracts-ready`、`doc-sync` 29/29；`docs/config-catalog.md` 再生成，两个 README 双语对同步。

## 考虑过的替代方案

**从列表端点默认暴露能力。** 没有任何列表端点报告模态或推理协议（适配器自己的 discovery 只读 id 和容量）；过度声明的猜测会在消息已持久之后才被提供方在回合中拒绝。声明仍是运维的主张，页面也如此说明。

**表单里的 `false` 拼写。** 取消勾选即移除字段，保住了"继承已安装条目"的表达；为少见的剥除 catalog 模型推理的场景做三态控件，是在 YAML 已有答案的地方花表单复杂度。

**逐档线上取值输入处处都有、含 `off`。** 保留——`off` 留空已表示"不发送"，填值则点名 openrouter `none` 一类方言要发的内容，同一个输入两者兼顾。

## 后果

自定义模型的能力缺口从根上闭合：一个声明面、schema 校验、下游所有门控原样读取。已知天花板移到仅剩的一处：思考开关在任意*顶层*字段中仍无具名格式（chat-template 只嵌在 `chat_template_kwargs` 下）；闭环路径是自定义 stream 包装，在真实服务器需要之前记为缓办。
