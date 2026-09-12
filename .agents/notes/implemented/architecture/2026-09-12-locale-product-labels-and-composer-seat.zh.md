# Agent Note: 本地化产品名与窄卡编辑器席位

Status: implemented

[English](2026-09-12-locale-product-labels-and-composer-seat.md) | 中文

## Problem

三个浏览器界面在整体中文的产品里打出裸英文标签：编辑器权限 chip 与设置 Permission 行把 kebab 机器名转成 Title Case（`workspace-write` → `Workspace Write`）、`/permission` 弹出框与完全权限确认文案在中文句子里夹着未翻译的 `Full access`、Session Header 的导出按钮硬编码 `Session log`，而下游新增的值守模式（`Supervised`／`Unsupervised`）完全没有中文名。另外，手机竖屏下编辑器的单行控件区放不下模式 chip 加一个长模型名，turn 末尾的 meta 行（`09:15 · 用时46秒 · 首 token 6.5秒 · 54 tok/s`）溢出列外而不是换行。

## Decision

**标签解析沿用官方 deepseek-harness 的模式：机器值是身份，英文产品名是自定义哨兵。** 内置机器值仅在 host 未自定义时（`name === value || name === 英文默认名`）按 locale 产品名渲染；其余一律透传 host 自己的名字。同一个解析器形状，三个落点：

- `ui-conversation`（`PermissionSelect`、`SupervisionSelect`）：`conversation` 命名空间新增 `access.preset.*` 与 `supervision.mode.*`；值守模式额外本地化内置说明与 aria 前缀（`input.supervisionMode`）。
- `ui-permission-presets`（`presentation.ts` 的 `displayPermissionPreset(value, name, t?)`、`PermissionRow`、`/permission` 弹出框）：逐字移植官方的 `preset.*` 键到设置词典与 `permission.access` 命名空间；确认文案由 `Full access` 改为「完全权限」。
- `session-log-export`：`header.action`（`Session 日志`／`Session log`），header 按钮经弹窗已在用的同一 `PropsLocale` 席位消费。

值守模式采用用户选定的名字：`supervised` = 随时监督，`unsupervised` = 无人值守。

**编辑器的发送／停止一对离开 trailing 组，拥有自己的 `.sendSeat`。** 宽卡上该席位只是行内最右的 flex 子项（trailing 组改用 auto margin 占住右缘，替代 `space-between`，因此第三个子项不改变任何布局）。在 `@container (max-width: 460px)` 档，行变成两行网格——`tools seat` / `trail seat`——命令／附件／模式按钮在第一行，模型席位与上下文圆环在第二行，发送一对跨两行停靠右缘。

**一个教训决定了容器的位置：一行永远无法匹配针对它自身的查询。** 继承来的样式表在 `.row` 上声明 `container-type: inline-size`，然后写 `@container { .row { … } }`——死代码，因为容器查询让元素针对最近的祖先容器求值。现在卡片也携带 `container-type`：`.row` 自身的重排针对卡片测量，而 `.row` 内部的 chip 规则（含 PermissionSelect 的收缩规则）保持针对 `.row` 测量不变。

**turn 末尾的 meta 行在手机形态下换行**（`data-viewport='phone'`）：actions 行获得 `flex-wrap` 并以 `min-height` 保住单行度量，时间 span 放弃 `nowrap`，分隔点 margin 收窄。各段之间本就有空格，天然断点，无需改 DOM。横屏与桌面保持单行 hover 展示。

## Alternatives considered

- *在 host 侧本地化。* host 不知道浏览器的渲染语言；投影已经携带机器值，它是唯一跨语言稳定的身份。
- *翻译所有 host 提供的名字。* 会悄悄重命名管理员配置的预设与模式；英文默认哨兵让 host 自定义保持权威，同时内置项本地化。
- *用 `data-viewport='phone'` 驱动编辑器重排。* 真正的约束是卡片宽度而非框架：容器查询让 500px 的桌面分屏卡片保持单行、手机横屏不变，且不与框架耦合。
- *用 JS 测量并切换类名。* 网格是纯 CSS；没有 resize 观察或重排抖动。
- *手机上缩小 meta 字号。* 换行保留原字号与 hover 展示语义。

## Consequences

新增内置权限预设或值守模式现在需要在两本词典里各加一个键（en/zh 对齐校验对缺失键直接失败）。编辑器 DOM 中发送一对移出 `.trailing`；slot map 与各席位的 props 未动，桌面几何不变。`.card` 获得 `container-type: inline-size` 带来行内尺寸包含——卡片宽度本就来自父级，无布局影响。host 自定义的 kebab 预设值仍经 `displayPresetName` 转 Title Case，由新增的 presentation 专项测试覆盖。

## Testing

`input-bar.client.spec.tsx` 断言内置标签的本地化、两个选择器的 host 名透传、改写后的完全权限确认文案；`presentation.client.spec.ts` 钉住解析器的全部四个分支；CSS 契约测试断言手机换行规则与两行网格；`phone-form.e2e.ts` 在真实 390×844 页面上验证网格几何（模型行在按钮下方、发送席位跨两行），并回放一段录制往返以真实转录内容验证 meta 行换行。
