# Agent Note：模型页页面级请求重试卡片与置顶菜单字形

Status: implemented

[English](2026-10-21-models-retry-fields-and-pin-glyph.md) | 中文

## 问题

对照 OpenCode Web 行为的两个缺口：（1）上游线路繁忙会直接打断会话进度——引擎本来就会对瞬时模型请求故障做重试（`dsh-llm-retry` 执行每个提供方的 `retryPolicy`：有界 `normal` 重试带指数退避与抖动，或无界 `always`），但策略只能手工编辑 `settings.yaml` 才够得着，多数用户因此永远只有默认的两次重试，而 OpenCode 核心自身以 2s→10s 封顶的调度重试十次；（2）工作区行菜单的置顶/取消置顶项是唯一没有前导图标的条目，破坏了重命名/分叉/归档等兄弟条目的图标纪律。

## 决策

- **模型方案页面在提供方行列表上方新增页面级请求重试卡片**——始终可见、不折叠、不按提供方拆分，因为用户面对的问题姿态是"我的模型请求怎么重试"，整页一个答案。引擎接缝保持按提供方（`dsh-llm-retry` 明确拒绝插件级策略；`resolveRetryPolicy` 逐 profile 根读取），因此卡片把**一份共享三件套扇出**到 settings schema 在 profile 处声明了 `retryPolicy` 的每个提供方行（`llm-deepseek` 的整分节根与每个 `llm-pi-ai` 路由 profile；没有该字段的 schema、无法解析的路径、未加载的 namespace 一律跳过，绝不写入）。每个 namespace 一次 `settings.mutate` 携带全部 op——三个字段全清空时对每个目标 `unset`，否则写入 `normal` 模式策略、两次间隔都以**毫秒**落盘（键入用**秒**），留空字段取引擎默认，且上限抬升到不低于首次间隔，存储的 profile 因此永远不会违反 `resolveRetryPolicy` 的 initial≤max 不变式。读回：所有已存用户层策略一致时预填字段；不一致（或全未设置）则留空并显示引擎默认占位符（2 / 0.5s / 10s），不一致状态会明说——保存即统一覆盖。校验镜像引擎规则：次数为非负安全整数、间隔为正的有限秒数且低于计时器上限、两者都填时首次 ≤ 上限。无界 `always` 模式仍归 `settings.yaml`：次数字段表达不了它，而静默覆盖部署的 `always` 等于把策略反转伪装成一次编辑。保存按钮写"全部应用 / Apply to all"，因此无论查询还是读屏地标导航都不会与某张提供方卡片自己的"应用/保存"相撞。
- **置顶项获得 `IconPinOutline16`**，一个以描边系列风格手工绘制的字形：箭头向上、尖端顶住上方横线——正是行菜单"置顶"一词对应的中文习惯字形（本地设计数据没有可导出的图钉字形）。同一字形同时服务置顶与取消置顶两种文案，与其余无切换态的兄弟条目一致；[ui-primitives README](../../../../packages/client/ui-primitives/README.md) 记录了手工绘制出处。图标集计数 spec 升至 73。

引擎零改动：`dsh-llm-retry`、`retry-policy.ts` 与 `agent/request-error` 瀑布均未触碰——本次变更只是把既有的按提供方策略接缝，经由[配置平面笔记](../architecture/2026-07-30-web-config-plane.md)已经拥有的 settings 写入路径呈现出来。

## 验证

- `packages/client/ui-settings-models` —— 330 个测试（针对卡片直挂真实 namespace fixture 新增 13 个用例：schema 驱动的目标解析含不可解析/无字段跳过、引擎默认占位符、一致读回、不一致报告、按两个 namespace 各自 revision 的归一化扇出、上限自动抬升、全清空的 unset 清扫、非法次数/间隔/次序拒绝并禁用保存、冲突停止并显示消息、写入被拒、陈旧栅栏下成功/冲突/拒绝一律静默、只读禁用）；per-file 100% statements/branches/functions/lines。
- `packages/client/ui-primitives` —— 图标集计数 73，每个字形以 `currentColor` 渲染且无硬编码色板。
- `packages/client/ui-workspace` —— 置顶菜单项现在携带 svg 字形，由既有的置顶/取消置顶行菜单测试断言。
- 无密钥 e2e 金标（`apps/web/tests/snapshots/models-settings/*.expected.md`）有意刷新：卡片出现在每种姿态的行列表上方。

## 考虑过的替代方案

**把重试字段按提供方放进各自卡片的「自定义设置」折叠区。** 第一版交付的正是这个；它把设置埋进每张卡片一层的折叠区里，把全局姿态（用户真正要的、与 OpenCode 对齐的东西）变成 N 处操作。已否决，改用页面级卡片；想让某条路由单独偏离的部署通过 `settings.yaml` 写它的 `retryPolicy`，扇出覆盖只在下一次显式保存时替换它。

**引擎级全局重试默认值。** 能消除扇出，但接缝翻倍：`dsh-llm-retry` 刻意持有"提供方拥有 `retryPolicy`"的所有权，全局默认值需要核心管道加一条优先级规则，换来的收益（未来提供方自动继承）README 已把"再保存一次"写清。已否决。

**通过 schema 生成表单暴露原始 `retryPolicy` 对象。** 零逐字段代码，但该 schema 是 `normal`/`always` 的 union，通用表单无法有意义地渲染，而且毫秒优先的字段恰恰招致归一化现在所防止的不变式违反。已否决；精选字段的手写界面是既定接缝。

**复用现成字形（星标/书签）作置顶。** 零新代码，但两者都读作收藏而非置顶，设计系统对这两种含义也没有导出路径。手绘的"箭头顶横线"字形在同一 16px 盒内匹配描边系列风格。

## 后果

- 秒↔毫秒换算与扇出逻辑都在卡片内（`RequestRetryCard.tsx`；辅助函数为包测试导出）；引擎默认值被镜像为展示常量，未来引擎改默认值需要同步更新这里的占位符。
- 保存卡片会在每个持有重试的 profile 上具化用户层 `retryPolicy`——包括尚无用户子树的目录路由——因此页面的 settings.yaml 每个提供方多出一个策略块；之后采纳的提供方保持引擎默认直到再次保存（README 已说明）。
- 按提供方固定 `mode: 'always'` 的部署继续工作，直到保存该卡片——那会把所有目标切到写入的有界策略；提示文案写明重试有界，README 写明 `always` 的所有权边界。
- 图标库多一个手绘字形；未来设计系统导出图钉时原地替换路径数据即可。
