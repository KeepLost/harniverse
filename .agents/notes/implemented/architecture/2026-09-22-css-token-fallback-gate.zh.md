# Agent Note：CSS 自定义属性的回退值不是令牌的逃生门

Status: implemented

[English](2026-09-22-css-token-fallback-gate.md) | 中文

## Problem

`scripts/verify-client-css-tokens.ts` 会把客户端 CSS 中每一处 `--dsw-*` / `--ds-*` 引用对照 `ui-theme` 定义的令牌解析，却刻意接受双参数形式：`var(--does-not-exist, #000)` 因为带了回退值而通过闸门。闸门把它读成“作者处理了缺失情形”。

事实恰好相反。当令牌不存在时，回退值并不是回退——它就是交付出去的值，在每套配色下、永久如此。主题归属者无法改动它，按浅色写就的字面量在深色下会变得不可读，而这处引用在此后每一位读者眼里都像是由令牌驱动的。四个包已经从这个洞里漂移出去：`ui-terminal`、`ui-browser`、`ui-governor` 与 `ui-agent-preset` 合计引用了六个没有任何样式表定义的别名（`--dsw-alias-terminal-bg`、`-terminal-fg`、`-separator`、`-accent`、`-danger`、`-danger-contrast`，外加 `--dsw-alias-font-mono` / `--dsw-font-mono`）。终端面板那块黑底黑字的表面就是其中一个可见症状。

## Decision

对未定义自定义属性的引用无论是否带回退值都是违规，以 `fallback` 类别报出，理由是回退值就是交付值。位于**已定义**令牌之后的回退值仍然合法：那里的字面量是真正的双保险默认值，值的归属仍在令牌。

那六个未定义别名被替换为已经存在的别名，而不是定义成新令牌——分隔线按权重用 `--dsw-alias-border-l1/l2/l3`，强调色用 `--dsw-alias-state-business-primary`，危险色用 `--dsw-alias-state-error-primary` 与 `--dsw-alias-label-primary-foreground`，等宽字体用 `--ds-font-family-code`。没有向 `ui-theme` 添加任何令牌：消费者需要的每个角色那里都已有命名，而新增令牌是主题归属者的决定，必须对两套配色负责。

## Alternatives considered

- 在 `ui-theme` 里定义这些缺失别名，让现有 CSS 通过：否决——这等于追认消费者自行发明的名字，而每个新别名都需要由设计系统为浅色与深色给出有理由的取值，而不是由回退值里恰好写着的字面量决定。
- 改为告警而不失败：否决——本仓库没有告警层级，而这类漂移已经交付过两次。
- 用允许清单放行回退形式：否决——不存在“未定义令牌加字面量优于已定义令牌”的情形，因此豁免只会保住漂移。

## Consequences

`pnpm run hygiene` 现在会对该模式失败，而仓库在该规则下是干净的（372 个主题令牌，客户端每一处引用都能解析）。此后任何想要主题未命名颜色的消费者都必须去找主题归属者，而这正是我们希望发生的对话。

功能局部的自定义属性照旧可用：组件可以在自己的 CSS Module 里声明自己的 `--dsh-*` 属性并读回。闸门只管辖对共享 `--dsw-*` / `--ds-*` 命名空间的引用。

## Scope

`scripts/verify-client-css-tokens.ts`（新增 `fallback` 违规类别、引用扫描不再在逗号处停止、文件头 JSDoc 说明原因）、其测试、携带未定义别名的五个 CSS Module，以及 `docs/web-styling.md` 的规则对。
