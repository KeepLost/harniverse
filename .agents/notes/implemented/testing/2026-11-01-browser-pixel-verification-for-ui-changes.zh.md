# Agent Note：面向用户界面改动的浏览器像素级验证

Status: implemented

[English](2026-11-01-browser-pixel-verification-for-ui-changes.md) | 中文

## Problem

侧边栏批量归档选择器（见[批量归档笔记](../feature/2026-11-01-sidebar-batch-archive-picker.md)）交付时带了第五个头部按钮。组件测试通过、无障碍树列出全部五个按钮，而组装后的浏览器仍显示旧的四图标头部：`.headerActions` 用 `max-width: 92px` 加 `overflow: hidden` 自我裁剪，第四个按钮渲染出来没有可见宽度。browser-styles 测试甚至按名字断言了三按钮上限（"keeps the three desktop header actions inside the clipped header"），于是套件保持全绿，而可见产品看起来毫无变化。存在性断言看不见 CSS 裁剪，这个偏差以"改动不存在"的形式到达了所有者面前。

## Decision

每一处用户可见的客户端改动，交付前都对照真实渲染像素验证，而不仅对照 DOM 树：

- 在真实浏览器里走所有者的真实路径（`pnpm dsh web` 加重建后的客户端 bundle——注册表下发的是 `lib/client.js`，绝不是源码），到达被改动的界面，读截图：数可见控件。
- 改动几何受约束的容器（固定 max-width、overflow 控制、rail 尺寸）时，同一提交里更新 `tests/browser-styles.client.spec.ts`；该测试断言上限算术，例如四个头部按钮占用 `4 * 28px + 3 * 4px = 124px`。
- jsdom 组件测试继续覆盖行为；它们永远不作为可见性证据。

## Alternatives considered

**只信组件测试与无障碍树。** 否决：两者断言的都是存在性，被裁剪的第四个按钮恰好证明存在不等于可见；这次事故就是踩着全绿套件交付的。

**CI 里为每个 PR 加浏览器截图 diff 门禁。** 暂时否决：无钥快照回放已覆盖场景输出文本，像素 diff lane 会给每个 PR 增加数分钟成本，且这类疏漏在开发期手动捕捉很便宜。若在此纪律下裁剪类漏测仍复现，再重新评估。

**只修像素值、不记录纪律。** 否决：错误的数字只是症状，失误在验证面。没有这条规则，下一个几何受约束的容器会原样再犯。

## Consequences

每处用户可见改动多花一次手动浏览器循环（分钟级），并多维护一条 styles-spec 断言。换到的是："已交付"意味着在所有者自己的运行形态上可见——被裁剪、遮挡或零尺寸的渲染（存在性断言在结构上抓不到）会在开发期失败，而不是在所有者的第一个会话里爆发。

## Related

- [侧边栏批量归档选择器](../feature/2026-11-01-sidebar-batch-archive-picker.md)——引出本规则的事故。
- `packages/client/ui-workspace/tests/browser-styles.client.spec.ts`——本规则要求与裁剪容器 CSS 同步的几何测试。
