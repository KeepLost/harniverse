# Agent Note：终端面板的挂载、呈现与触摸形态

Status: implemented

[English](2026-09-22-terminal-panel-presentation.md) | 中文

## Problem

W13 终端面板交付时功能正确、观感不可用。三个缺陷叠加在一起，而覆盖该功能的测试套件一个都看不见：

- xterm 面被无条件地打开到承载空态提示的同一个容器里，于是提示仍在无障碍树和布局盒中，xterm 追加的节点却盖在它上面。在尚未创建终端时，面板就是一整块带光标的黑色矩形；输入无处可去，因为根本没有可写入的附件。在提示自身中心调用 `document.elementFromPoint()` 返回的是 `.xterm-screen`。
- `new Terminal({ scrollback: 1000 })` 没有传 `fontSize`、`fontFamily` 或 `theme`，因此单元格在两套配色下都按 xterm 默认渲染——裸 `monospace`、15 像素、`#000` 上的白字——而周围产品用的是主题的代码块表面。
- 面引用了 `--dsw-alias-terminal-bg` 与 `--dsw-alias-terminal-fg`，而没有任何样式表定义它们。真正交付出去的是 `var(…, #000)` 里的回退值。

面板有一份 100% 覆盖的 jsdom 组件测试和通过的插件测试。jsdom 没有布局引擎也不应用 CSS，因此一切关于观感与尺寸的断言在结构上就不可能失败，而且没有任何浏览器通道打开过这个面板。

## Decision

挂载、呈现与触摸支撑各自获得明确的归属。

面与占位提示在渲染中成为互斥分支，而非兄弟节点：视图计算出唯一的 `placeholder` 值（`no-session`、`empty` 或无），只在确实有终端可显示时挂载 xterm 容器，并随最后一个终端退场。改为隐藏容器的方案被否决：FitAddon 测量父元素的计算盒，隐藏容器会拟合成一行两列，首次真实拟合就是错的。

呈现经由 CSS 传递、在 JavaScript 中读回。xterm 只接受以构造选项形式给出的颜色与度量，单靠层叠无法为它上色。面从已定义的主题别名声明 `--dsh-terminal-{bg,fg,cursor,selection,font-family,font-size}`，组件用 `getComputedStyle` 解析这六个属性并喂给终端。`theme/change` 发布会推进一个经 inject 的 `hooks` 间隔发布的外观修订号；修订号重新解析属性、赋值 `terminal.options` 并重新拟合。这样配色仍由主题归属者掌控，而组件既不需要 ctx 引用，也不需要第二条订阅。

重新拟合的触发条件从容器 resize 扩展到 `visualViewport` 的 `resize`/`scroll`（软键盘会缩小可视视口而布局视口不变）以及 `document.fonts.ready`（首次拟合必然使用回退字体的度量，真实字体加载后必须纠正列数）。

触摸得到的是一条控制键条，而不是被缩小的桌面版。屏幕键盘无法产生的九个序列——Esc、Tab、Ctrl C/D/Z 与四个方向键——直接写入终端；按钮抑制默认的 mousedown，使焦点不离开终端、键盘不收起。键条在 `@media (pointer: coarse)` 下出现，手机形态则如 `docs/web-styling.md` 要求，来自框架自身的 `[data-viewport='phone']` 发布（隐去标题、44 像素目标、12 像素单元格），而非私有媒体查询。

## Alternatives considered

- 保留单一容器并切换提示的 `z-index` 或 `visibility`：否决——提示不是 xterm 唯一盖住的东西，而且没有附件的已挂载终端仍会吞掉按键。挂载条件才是真正的事实。
- 硬编码一套与主题无关的传统深色终端配色：否决——产品已经通过 `--dsw-alias-markdown-code-block` 渲染类终端表面，固定配色只会从相反方向重新引入本记录正在修复的不可读问题。
- 向 `ui-theme` 添加 `--dsw-alias-terminal-*` 令牌：否决——面板需要的每个角色都已有定义好的别名，而新增一对令牌需要由主题归属者为两套配色给出理由，而不是由一个只想要名字的消费者决定。
- 在 `ui-layout` 里做一个通用的移动端键盘工具条服务：延后——单一消费者不足以确立契约，而终端所需的转义序列并非通用 UI 关切。

## Consequences

空面板现在看起来就是空面板；已创建的终端以产品的代码块表面、产品的代码字体和主题的光标强调色渲染，并随配色实时切换。手机宽度产出可用形态：一个真能中断运行中命令的 `Ctrl C` 按钮、44 像素控件，以及能让 80 列屏幕保持完整的单元格尺寸。

证据搬到了能够失败的地方。`apps/web/tests/terminal-panel.e2e.ts` 在真实浏览器中对真实 PTY 打开面板，断言提示在 `elementFromPoint` 中胜出且 `.xterm` 节点数为零、活的提示符与回显、计算出的字体与背景、由 PTY 报出的 `tput cols`、按指针类型决定的键条可见性，以及包含真实中断的手机形态。组件测试保留 jsdom 能回答的行为，其文件头现在写明它不能回答什么。

`ui-terminal` 新增 `theme` 注入（以及相应的包、tsconfig、模块图边）。面板仍是纯浏览器侧载体：这里没有任何东西对模型可见。

## Scope

`TerminalPanelView.tsx`（占位互斥、呈现解析、重新拟合触发、键条）、`controller.ts`（`TerminalAppearance` 事实）、`index.ts`（主题注入与外观存储）、`TerminalPanelView.module.css`（声明属性、键条、手机区块）、`xterm-base.module.css`（按已安装的 `@xterm/xterm` 重新取材并令牌化）、键条分组的语言键、两份包内测试、新增的浏览器 e2e 及其宿主程序注册、包 README 对、以及 `docs/web-styling.md` 中关于 JavaScript 取值呈现的规则。
