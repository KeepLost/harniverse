# Agent Note: 新会话页 hero 相位吸底——输入框不再跳动

Status: implemented

[English](2026-11-14-conversation-hero-dock.md) | 中文

日期:2026-11-14。范围:`packages/client/ui-conversation`(ConversationRoot hero 布局、EmptyHero/HeroShell 标记、InputBar hero 内边距与手机触控规则)与 `packages/client/ui-layout`(帧的 `data-short-viewport` 属性)。不涉及 slot 契约、phase 判定与 textarea 身份——本次重构只改布局与 chrome 归属。

## 问题

新会话页把 composer 整栈(标语 + 工作区行 + 卡片)浮在列的垂直居中位置,而活跃会话把同一张卡片吸在底部。提交第一段草稿时输入框会从中屏跳到底边;settle 阶段还需要隐藏座位来避免闪跳。Codex/OpenCode 参照布局——标语居中在上、composer 停靠在下、极简空态——从构造上消除跳动,在手机上也更安静。

## 决策

- **hero 卡片停靠在活跃卡片的确切位置。** `HeroShell` 移出 `.composerStack`,进入 composer 座位上方的新 `.heroShellHost` 兄弟节点;host 占满剩余视口(`flex: 1 0 auto`),栈落底。`align-self: center` 保留水平居中;栈保留与停靠卡片完全一致的宽度公式。hero 的 `padding-bottom: 32px` 底垫移除;InputBar hero 变体继承与停靠态相同的 `0 clearance 8px` 内边距——hero → active 不再移动任何东西(settle 闪跳在几何上已消失,可见性门保留作双保险)。
- **光晕跟随卡片。** `.heroGlow` 重新锚定栈底(72px = 8px 底垫加半张静息卡片),椭圆继续以输入卡为中心。
- **键盘信号归帧所有。** AppFrame 跟踪 `visualViewport`,当可视视口缩水 ≥120px(软键盘或系统面板;更小阈值会因浏览器工具栏漂移而闪烁)时发布 `data-short-viewport`。特性 CSS 按唯一断点教义选帧属性——不引入特性自带的 `matchMedia`,与 `data-viewport` 同一机制。
- **手机触控目标不破坏行网格。** 在 `data-viewport='phone'` 下:发送圆钮放大到 44px(同时去掉桌面端的 −2px 光学校正——它会令跨行座位偏离两行网格中线);附件圆钮保持 28px 视觉、以透明 `::before` 命中区扩到 44px(tools 行不得高于发送座位);工作区 chip 两个按钮提到 44px;卡片以 `max(8px, env(safe-area-inset-bottom))` 抬离 home indicator。

这是对 figma 75:8208/313:14109(居中 hero)的有意偏离;停靠布局取代该页(owner 批准的方向:新会话页向 Codex/OpenCode 参照看齐)。移动 `HeroShell` 时一并删除其死节点 `.body` 与遗留 `.workspaceRow` 规则。

## 备选方案

- **第三方皮肤插件的 CSS 覆盖**(子串类名选择器、`!important`、DOM 打桩)——拒绝:源码是我们自己的;原生布局让门禁(css-tokens/css-classes)保持意义、DOM 保持诚实。
- **不动标记、纯 CSS 压缩 hero** —— 跨模块哈希类定位被 `verify-client-css-classes` 按设计拦死;移动 chrome 归属才是诚实表达。
- **在帧上发布键盘压缩 CSS 变量** —— v1 消费者(hero 收缩姿态、后续 composer 限高)用属性足够;出现需要连续值的消费者时再补 px 变量。

## 后果

- 提交草稿不再移动输入框;settle 可见性门保留,但不再为几何跳变补偿。
- 短视口(键盘打开)下 hero host 保持 `flex: 1 0 auto`,列可滚动、浏览器把聚焦的 textarea 顶到键盘上方;后续可在 `data-short-viewport` 下收缩品牌图。
- `data-short-viewport` 是帧发布的新属性;特性 CSS 可像 `data-viewport` 一样选用。

## 测试

- `ui-layout/tests/app-frame.client.spec.tsx`:静息不带属性;桩定 300px 可视视口缺口后翻转、回落后清除;`resize` 与 `scroll` 双监听注册。
- `ui-conversation/tests/skeleton.client.spec.tsx`:hero 钉住新结构——品牌图位于 `[data-composer-seat]` 之外,工作区 chip 与 textarea 在其内;hero → active 翻转仍保住同一 textarea DOM 节点。
- 浏览器 e2e(全部回放绿):`phone-form`(10/10——含 44px 圆钮下的两行堆叠)、`cold-blank-session`、`composer-tab-geometry`、`composer-draft-scroll`、`conversation-column-overflow`(22/22),以及整个 web 回放套件——仅存两项环境性失败:`hmr-live`(dev server 就绪超出 60s 窗口,干净树同样失败)与一次负载噪声的启动计时(干净构建 3/3 通过)。
- 真实登录验证:对全新 `DSH_HOME` 启动 `pnpm dsh --profile web`,经产品配对页配对设备、CLI `pnpm dsh auth device approve` 批准,在 1440×900 与 390×844 下截图新会话页——两种视口卡片均离视口底边 8px,标语居中于上方空间,无横向溢出。

## 相关

GUI 测试系统笔记定义了本次验证遵循的阶梯;web-styling 文档的帧属性教义是键盘信号落在 ui-layout 而非 conversation 包的原因。
