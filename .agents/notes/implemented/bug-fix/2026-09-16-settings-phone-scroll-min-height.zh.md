# Agent Note: 设置面板手机端滚动失效 — 纵向 flex 的 min-height 陷阱

Status: implemented

[English](2026-09-16-settings-phone-scroll-min-height.md) | 中文

- 日期: 2026-09-16
- 影响面: `@deepseek-ai/dsh-client-ui-settings-general`(SettingsRoot 外壳 CSS)
- PR: 待补(修复 PR 合并后回填 SHA)

## Problem

手机端(`data-viewport="phone"`)打开设置,向下拖动时底部内容拉不出来:选项区底部一截被裁在视口外,且无法滚动回看。桌面端正常。

## 根因

phone 形态下 `.panel` 由横向 flex 变为**纵向** flex(`flex-direction: column`)。内容列 `.content` 只声明了 `min-width: 0`,没有 `min-height: 0`;纵向 flex 项的默认 `min-height: auto` 使内容列拒绝收缩到内容高度以下,于是整个内容列越过面板底缘,被 `.panel { overflow: hidden }` 裁掉。`.options` 自身的 `overflow-y: auto` 因此永远不会触发——它的盒子长到了内容高度(`scrollHeight === clientHeight`),滚动条不存在,溢出部分在面板裁剪之下不可达。

桌面端不受影响:row 方向下 `.content` 的高度来自 stretch(面板高度确定),`.options` 的 `flex: 1; min-height: 0` 正常接管滚动。

实测(chromium 390x844,修复前):`.options` 底缘 871 > 视口 844,`clientHeight === scrollHeight === 755`,`scrollTop` 恒 0。

## Decision

`.content` 补 `min-height: 0`(桌面 row 方向无影响),把收缩权还给 flex 链,`.options` 重新成为唯一滚动容器。这是嵌套 flex 滚动容器的规范形态:每一层滚动祖先都需要显式 `min-height: 0`(横向对应 `min-width: 0`),否则某一层的内容高度会"顶穿"外层。 `.content` 补 `min-height: 0`(桌面 row 方向无影响),把收缩权还给 flex 链,`.options` 重新成为唯一滚动容器。这是嵌套 flex 滚动容器的规范形态:每一层滚动祖先都需要显式 `min-height: 0`(横向对应 `min-width: 0`),否则某一层的内容高度会"顶穿"外层。

## Alternatives considered

- 改为面板自身滚动(phone 下 `.panel { overflow-y: auto }`):否决——头部与标签条会随内容滚走,且桌面 row 布局需要第二种滚动形态。
- 面板打开期间对 body 加 `position: fixed` 滚动锁:否决——治的是背后页面滚动这一非故障路径;缺失的滚动在面板内部。

## Consequences
- 所有"纵向 flex + 内部滚动"的面板都应自查同款声明;本次只修设置外壳,不扫全库(其余面板未报症状,避免无验证的批量改动)。
- e2e 断言的是几何不变量而非像素,不依赖具体分区内容长度。

## Testing

- `apps/web/tests/phone-form.e2e.ts` 设置用例新增滚动几何断言:选项区底缘落在视口内、`scrollHeight > clientHeight`、程序化滚动可达 `maxScrollTop`——"不再被裁""确实有滚动""滚动到底可达"。
- `pnpm run test:gui` 4971 绿;`DSH_SNAPSHOT=replay pnpm run test:web` 282 绿(无快照漂移——aria 快照不承载几何)。
