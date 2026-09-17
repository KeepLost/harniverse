# Agent Note: 当前上下文条带属于整个轨迹面板底部,而不是横向 ledger 容器内部

Status: implemented

[English](2026-09-16-context-strip-band-placement.md) | 中文

- 日期: 2026-09-16
- 影响面: `@deepseek-ai/dsh-client-ui-trajectory`(ContextStrip 摆位与样式)
- PR: #857e25018f (merge)

## Problem

当前上下文条带最初挂在 `.ledger` 内——该容器是未声明方向的 `display: flex`(默认 row)。横向条带于是被当成 row 子项布局:交叉轴 stretch 把它拉成账本右侧一条全高、按内容宽的竖列,分界线画在错位竖列上,方块清一色中性填充、role 无视觉表达。composer 间距变量也定义在 `.ledger` 上,兄弟条带无从消费。

## Decision

把 `<ContextStrip>` 移出 `.ledger`,作为 `.root`(纵向 flex)最后一个子元素,变成全宽底部条带;`--dsh-trajectory-bottom-clearance` 从 `.ledger` 上提到 `.root`,条带的 `margin-bottom` 与表格滚动内边距消费同一变量,悬浮输入框不再遮挡。条带取 35px tab 条节奏,`border-top` 分界线用 `border-l2`,方块按 `data-role` 上 role 色(user=品牌蓝、assistant=business primary、tool=business tertiary、context=中性),hover 统一描边;落地的压缩摘要保持 warn 色系斜纹。空态显示文案而非空白占位。

## Alternatives considered

- 留在 ledger 内并把容器改纵向:否决——row 布局与表格分栏共用,且条带会跟随 ledger 几何而非锚定面板底部。
- 在滚动表格容器内做 sticky 条带:否决——跟随滚动视口而非面板,且 sticky 偏移要二次镜像 composer 间距。

## Consequences

- `.ledger` 回归单一职责(表格分栏);面板底部要加带状面都走 `root 尾子元素 + 间距 margin` 形态。
- 间距变量升级为面板级:新的底部锚定面消费同一个 `--dsh-trajectory-bottom-clearance`,不再各自推导 composer 高度。

## Testing

- `tests/request-context.client.spec.tsx`:role 戳记(每方块 `data-role`)、空态文案、方块数与点击定位。
- `pnpm run test:gui` 4972 绿;`DSH_SNAPSHOT=replay pnpm run test:web` 绿——容器移动与类名变化对 aria 快照透明,无快照漂移。
