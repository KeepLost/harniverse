# Agent Note：表单控件统一来自共享原子组件，对话框与工作台在壁纸上保持清晰可读

状态：已实现

[English](2026-10-12-ui-controls-and-surface-layering.md) | 中文

- 日期：2026-10-12
- 范围：`@deepseek-ai/dsh-client-ui-primitives`（`Select`、`Modal`）、`@deepseek-ai/dsh-client-ui-theme`（强调色、对话框与不透明接缝）、`@deepseek-ai/dsh-client-ui-skin` 与 `@deepseek-ai/dsh-skin-library`（`dialogOpacity`）、所有设置页面包、`@deepseek-ai/dsh-client-ui-workspace`、输入框席位上的各类 dock，以及 `scripts/verify-client-css-classes.ts`
- PR：#TBD（merge）

## 问题

所有者报告了四类可见缺陷。第一，设置里的原生控件看起来没有样式：模型方案下拉框、插件导出按钮、会话导入的文件选择，以及语音输入的准备按钮，都是裸的浏览器控件，和旁边有样式的元素格格不入。第二，启用壁纸或皮肤后，工作台的分区标签条、搜索框以及“工作区/暂存区”切换在半透明列上画了不透明的图层底色，看上去像灰色色块。第三，设置对话框和所有共享 `Modal` 无法由用户调成不透明或半透明，并且在深色皮肤上，即使设为 100% 仍被 `--dsw-alias-bg-layer-2` 里内置的 0.85 alpha 封顶。第四，这些现象背后还有一类隐蔽的源码缺陷：被客户端打包器丢弃的 CSS Modules `composes`、没有任何规则的类名，以及只出现在伪类里、永远匹配不上的修饰类。

## 决策

- `ui-primitives` 新增 `Select`：带 forwardRef 的原生 `<select>`，边框与圆角同 `Input`，带自绘下拉箭头和强调色聚焦边框，不自带宽度。有意保留浏览器自己的选项列表：键盘、触屏和读屏选择器照常可用，也不必重新实现弹层。设置、会话导入、语音输入、资源治理、IM、能力和 Agent 预设页面现在统一使用 `Select`、`Button` 和 `Input`，不再自己给原生控件写样式；`body` 设置了 `accent-color`，其余复选框和单选框会跟随皮肤强调色。
- 工作台去掉分区标签条、搜索框和筛选字段上的不透明底色；“工作区/暂存区”切换改为发丝边框轨道加 alpha 选中态（预览模式切换保持一致）；输入框席位上的各类 dock 与输入框使用同一块接缝底板，因此在壁纸上依然清晰。
- 设置和 `Modal` 读取新的 `--dsw-surface-dialog` 接缝，由第四个滑块“设置与对话框不透明度”（`dialogOpacity`，0.6 到 1，默认 1）驱动。不透明伴生令牌（`--dsw-opaque-*`）声明在 `@supports (color: rgb(from red r g b / 1))` 保护之下，因此深色皮肤上的 100% 是真正不透明；不支持相对颜色语法的引擎会回退到别名，而不是渲染出不可见的对话框。强制不透明模式把所有接缝绑定到各自的不透明伴生令牌。引导舞台和遮罩不在范围内。
- 被删除的 diff 行此前在红色文字后使用实心 red-400 的 secondary 别名，两种配色下都难以辨认；现改为错误色的 14% 淡染，与新增行使用 tertiary 淡染的做法一致。
- `verify-client-css-classes` 是新增的静态门禁，与 `verify-client-css-tokens` 并列接入：它拒绝 `composes`、拒绝没有 `.x` 规则的 `css.x`，也拒绝只出现在伪类里的修饰类。`docs/web-styling.md` 记录了该规则。

## 备选方案

- 用完全自定义的下拉框代替原生 select：不采用，因为这要为设置表单重新实现焦点、前缀匹配、触屏和读屏行为，却没有可见收益。
- 全局降低对话框 alpha，只保留一个“面板”滑块：不采用，因为对话框承载表单和长文本，所有者希望它默认不透明，而侧栏保持玻璃感；独立滑块且默认 1，可让旧文档保持不变。
- 逐个修改各皮肤内置的 alpha 来解决深色封顶：不采用，因为用户导入的皮肤包带有自己的值；不透明伴生令牌能一次修复所有皮肤。

## 影响

- 本次变更之前写入的文档没有 `dialogOpacity`，加载时按 1 处理，因此现有用户看到的对话框保持完全不透明，除非自己移动滑块。
- 在别名本身已半透明的深色皮肤上，“面板”“输入框”“菜单”滑块仍然基于原始别名混合，而不是不透明伴生令牌；这是本次变更已知的局限。
- 输入框、引导界面和 KaTeX 样式表中仍有硬编码颜色，不属于本次变更。

## 测试

- 新增的 CSS 约定测试固定了每条改动规则（每个受影响包里的 `*-styles.client.spec.ts`，包括被删除 diff 行的淡染），`Select` 有独立的原子测试，对话框链路在 `ui-skin`（默认 1、缺少该字段的旧文档按 1 加载、强制不透明绑定）和宿主 schema 中均有覆盖，`scripts/verify-client-css-classes.spec.ts` 覆盖新门禁。
- `pnpm run test:gui` 通过（486 个文件，6964 项通过）；`pnpm run build` 通过；`verify-client-css-tokens` 与 `verify-client-css-classes` 通过（154 个 CSS Modules，2522 处类名引用全部解析）；对全部 75 个改动的 TypeScript 文件执行 oxlint 通过；`pnpm run duplication` 仍为 124 处克隆，未变化；客户端与 skin-library 的逐文件覆盖率没有违规。
- 对 31 个受影响文件（设置、模型、插件、会话导入、语音、皮肤、工作台、编辑器、终端、浏览器、输入框 dock、markdown、侧栏）执行 replay 模式 web e2e：只出现两处预期的 golden 差异，均已刷新并逐项审阅（`session-import` 上传控件的名称、`skin` 的第四个滑块）。`skin.e2e.ts` 新增“keeps Settings and dialogs fully opaque by default and lets the slider turn them translucent”。
- 在真实 Chromium 中逐张查看了截图：浅色默认与星云紫壁纸加磨砂材质下的各设置页、工作台的 文件/搜索/变更 标签、工作区/暂存区切换，以及 diff 预览。100% 时对话框面板各处采样为同一颜色；60% 时壁纸透出。被删除行的对比度问题正是在这一轮发现的，并在修复后重新核对。
- 此处未验证：完整的 55 分钟 replay 全量（CI 会分片执行）、Windows，以及 Chromium 之外的浏览器。
