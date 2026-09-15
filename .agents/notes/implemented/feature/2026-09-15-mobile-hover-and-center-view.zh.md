# Agent Note：触屏安全的悬停表面与中列视图呈现修复

Status: implemented

[English](2026-09-15-mobile-hover-and-center-view.md) | 中文

## 问题

日常使用暴露了四个呈现缺陷。iOS Safari 上，按钮说明文字（tooltip）在点按后常驻屏幕、没有可靠的消除路径——点按会合成 `mouseenter`，但配对的 `mouseleave` 只在稍后点按命中另一个可交互元素时才派发，因此点空白处常常清不掉悬停状态。竖屏下，composer 的模型菜单以右缘对齐到贴近屏幕左缘的触发器，向左展开溢出屏幕。代码块的 sticky 语言横幅（`z-index: 6`）画在中列视图层（`z-index: 5`）之上，切到定时任务或资源看板后语言标签仍浮在看板上。而在看板/任务视图里重新点击侧栏中已是当前的会话不会退出视图——帧的退出 effect 以当前会话的**取值**为键，重选同一会话时它不变。

## 决策

- **悬停是指针能力，在使用处探测。** `hoverCapablePointer()` 读取 `(hover: hover)`；Tooltip 的 mouse-enter 路径与 HoverCard 的 pointer-enter 路径在触屏主输入下抑制其表面。键盘 focus 保留气泡（真实的 blur 总会跟随），能力未知（无 `matchMedia`）时默认可悬停，jsdom 保持桌面形态。
- **用方向而非应用断点刻度。** 模型菜单在 `@media (orientation: portrait)` 下锚定 `left: 0` 向右展开；横屏保持右锚定向左展开。竖屏平板也被覆盖——`data-viewport` 的 phone-only 刻度会漏掉；方向是设备事实，不是布局几何。
- ** containment 优先于 z-index 竞赛。** `.centerConversation` 增加 `isolation: isolate`：会话子树原子化绘制于中列视图层之下，任何后代堆叠（今天的 sticky 横幅、未来的 fixed 悬浮件）都被限定，无法穿透。没有任何单个 z-index 需要移动。
- **选择是手势，不是取值。** 会话列表快照携带 `selectionSeq`，一个由每次选择写入（`select`、`selectSubagent`、`clearSelection`，含重选当前 id）推进的计数器。AppFrame 的退出 effect 依赖它，于是所有选择路径——工作区树、归档列表、子代理目录——统一退出中列视图。

## 后果

- 触屏主输入完全不显示悬停标签；锚点带 `aria-label`，读屏与桌面体验不变。
- 竖屏规则是纯 CSS，随 composer 渲染处生效；菜单的组件逻辑零改动。
- `selectionSeq` 是对象层快照里的普通单调数字；store 的引用稳定性契约不受影响。测试夹具补充了 `selectionSeq: 0` 字面量。
- 覆盖：触屏抑制（两个原语）、竖屏锚定、重选退出、计数器推进的新 spec。

## 考虑过的替代方案

- 触屏 tooltip 自动隐藏计时器：粘滞窗口仍然存在，还引入用户未要求的行为；抑制是决定性的。
- 抬高中列视图层高过横幅 z-index：与每个未来 sticky 元素展开竞赛；isolation 终结这一类问题。
- 在侧栏点击处理器里清除中列视图：只覆盖一个入口表面，还增加跨插件服务依赖；计数器以一个对象层事实覆盖所有选择路径。
