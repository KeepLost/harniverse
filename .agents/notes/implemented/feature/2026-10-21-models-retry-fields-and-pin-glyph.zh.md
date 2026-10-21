# Agent Note：模型卡片上的提供方重试字段与置顶菜单字形

Status: implemented

[English](2026-10-21-models-retry-fields-and-pin-glyph.md) | 中文

## 问题

对照 OpenCode Web 行为的两个缺口：（1）上游线路繁忙会直接打断会话进度——引擎本来就会对瞬时模型请求故障做重试（`dsh-llm-retry` 执行每个提供方的 `retryPolicy`：有界 `normal` 重试带指数退避与抖动，或无界 `always`），但策略只能手工编辑 `settings.yaml` 才够得着，多数用户因此永远只有默认的两次重试，而 OpenCode 核心自身以 2s→10s 封顶的调度重试十次；（2）工作区行菜单的置顶/取消置顶项是唯一没有前导图标的条目，破坏了重命名/分叉/归档等兄弟条目的图标纪律。

## 决策

- **模型卡片的「自定义设置」折叠区为每个适配器家族增加请求重试三件套**（`llm-deepseek` 与 `llm-pi-ai` 都在 profile 根部嵌有 `RetryPolicySchema`）：重试次数加首次/最大重试间隔，以**秒**键入。写入以一条 `settings.mutate` 路径 op 落到 profile 的 `retryPolicy` 上，并在客户端归一化：间隔换算为引擎的毫秒，未填的间隔沿用生效值，且上限抬升到不低于首次间隔——存储的 profile 因此永远不会违反 `resolveRetryPolicy` 的 initial≤max 不变式（30 秒首次间隔配 10 秒默认上限时，两个值都写成 30 秒，而不是送去一个宿主会拒绝的 profile）。全部字段清空即取消该覆盖。卡片始终写入有界的 `normal` 策略——无界 `always` 模式仍归 `settings.yaml` 所有，因为次数字段表达不了它，而静默改写部署的 `always` 等于把一次策略反转伪装成一次编辑。占位符显示生效值（无任何解析时为引擎默认 2 / 0.5 秒 / 10 秒），因此卡片说清了清空字段会退回什么。客户端校验镜像引擎规则：非负安全整数的次数、小于计时器上限的正数间隔、两者都显式时首次不大于上限。
- **置顶项获得 `IconPinOutline16`**——手工绘制的图钉（圆环针头加渐细针身），采用描边系列的风格，因为本地设计数据没有可导出的图钉字形。同一字形同时服务置顶与取消置顶两种标签态，与其他无切换的兄弟条目一致；[ui-primitives README](../../../../packages/client/ui-primitives/README.md) 记录了手工绘制出处。图标集计数 spec 更新为 73。

引擎零改动：`dsh-llm-retry`、`retry-policy.ts` 与 `agent/request-error` 瀑布流都未触碰——本次变更只是把既有的每提供方策略缝暴露出来，位置正是 [config-plane 笔记](../architecture/2026-07-30-web-config-plane.md)所说的精选字段之家。

## 验证

- `packages/client/ui-settings-models` —— 321 项测试（五个新重试用例跑在真实 `ModelsSection` 挂载上：归一化写入、上限自动抬升、生效间隔保留与无 `backoff` 读取、非法次数/间隔/次序拒绝并禁用提交、经 `validateDraft` 的 deepseek 整分节写入）；per-file 100% statements/branches/functions/lines。
- `packages/client/ui-primitives` —— 图标集计数 73，每个字形以 `currentColor` 渲染且无硬编码配色。
- `packages/client/ui-workspace` —— 置顶菜单项现在携带 svg 字形，由既有置顶/取消置顶行菜单测试断言。

## 备选方案

**经 schema 生成表单暴露原始 `retryPolicy` 对象。** 零逐字段代码，但该 schema 是 union（`normal`/`always`），通用表单无法有意义地渲染，而且毫秒优先的字段恰恰容易招来现在这套归一化所防止的不变式违例。否决；手写卡片是精选字段的既定缝。

**把重试设置加到模型方案（Profile）而非提供方卡片。** 重试归提供方路由所有——引擎按每个注册路由解析一份策略，而非按 profile——因此 profile 级字段需要第二层解析，也无法管辖跨 profile 使用的提供方。否决；卡片才是所属配置所在。

**复用现成字形（星标/书签）作置顶。** 零新代码，但两者读起来都是收藏而非置顶，且设计系统对这两种语义都没有导出路径。手工图钉与描边系列风格一致，同为 16px 视框。

## 后果

- 秒↔毫秒换算住在卡片里（`retryPatch`/`retryFailureOf` 为包测试导出）；引擎默认值以展示常量镜像，未来引擎默认变化需要同步更新此处占位符。
- 按提供方固定 `mode: 'always'` 的部署继续可用，但卡片上的任何重试编辑都会把该提供方切换为写入的有界策略——提示文案说明重试有界，README 写明 `always` 的所有权边界。
- 图标库新增一枚手工字形；未来设计系统的图钉导出可就地替换路径数据。
