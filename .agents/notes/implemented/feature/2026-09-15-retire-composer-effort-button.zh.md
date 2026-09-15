# Agent Note：移除 composer 的独立推理强度 seat

Status: implemented

[English](2026-09-15-retire-composer-effort-button.md) | 中文

## 问题

`54097d990d` 交付的独立推理强度按钮，与模型 seat 已有的能力重复：模型按钮的两级菜单既能看到生效推理强度（触发器上），也能切换它（Effort 行）。实际使用中，第二个按钮只增加了 composer 宽度，没有增加任何能力。所有者指示移除；能力声明工作的其余部分——两级模型菜单的 Effort 面板、共享的 `effort.ts` 推导、设置页声明——全部保留。

## 决策

- **在组合缝撤除 seat。** `dsh-client-ui-conversation` 不再声明 `conversation.input.effort`（契约、children 表、InputBar 渲染点），slot catalog 已重新生成。composer 尾部组重新以模型 seat 收尾；`conversation.input.right` 列表条目仍渲染在模型 seat 左侧，不变。
- **入口移除，目录不动。** `dsh-client-ui-model-selection` 回到共用一份会话级 `ModelDirectory` 的两个入口——`/model` popup 与模型 seat。`EffortButton.tsx` 及其测试删除；`effortButton.aria` 词典键随之撤销。共享的 `effort.ts` 助手保留：模型 seat 的 Effort 面板仍由它渲染，因此「先选模型、再选强度」路径及其 subagent 屏蔽与之前完全一致。
- **唯一选择事实不变。** 两个剩余表面仍通过同一目录实例上的 `session.selectModel` 提交，任一入口中的切换仍是另一入口下一次显示的内容。

## 后果

- composer 工具行在所有主题下窄一个按钮；除此之外没有布局、焦点顺序或窄卡网格变化（seat 空置后其渲染点本就是 no-op）。
- 没有 wire、Host 或会话日志层面的变化——移除仅涉及浏览器呈现。
- 2026-09-14 note 的设计论证保留为历史；本 note 撤回的是其中的第二个 affordance，不是其 seat 分析（未来 composer 若有新 affordance，仍走同样的具名 seat 模式）。

## 考虑过的替代方案

- 保留按钮但用偏好项隐藏：重复是结构性的（一个事实上两个入口），不是密度问题；偏好项会保留成本并增加一个设置面。
- 把快捷强度行为折入 `conversation.input.right` 列表条目：列表条目渲染在模型 seat 左侧，对一个要贴着模型按钮的控件来说是错误的一侧——原具名 seat 论证依然成立，只是 affordance 整体消失后不再需要替代品。
