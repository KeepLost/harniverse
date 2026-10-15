# Agent Note: 校准浅色主题的 dimmed 标签

Status: implemented

[English](2026-10-15-light-theme-dimmed-label-calibration.md) | 中文

## Problem

浅色主题下 Git 历史的提交者名与文件搜索占位符被反馈为"白底白字"近乎不可见。两者都消费 `--dsw-alias-label-dimmed`，其浅色映射原为 `--dsw-static-neutral-bluish-200`（rgb 225 229 238）——对白色表面对比度约 1.2:1，而深色主题的映射（近黑底上的 neutral-bluish-750）相对对比度明显更高。是浅色取值标定错误，而非语义错误：客户端全部水印风格文本（约 24 个 CSS 文件：占位符、统计行、提示）都继承了同样的过淡。

## Decision

**在别名所属的接缝一次性校准，而非逐处修补消费方。** 浅色主题的 `--dsw-alias-label-dimmed` 现映射到 `--dsw-static-neutral-bluish-400`（rgb 173 178 184），恢复 dimmed 层级（仍明显淡于 `label-tertiary` 的 600），同时与深色主题相对背景的距离看齐。改动仅 `ui-theme/src/styles/design-platform.css` 一行；所有消费方一并修复——这也是否决在被点名的两处改用 `label-tertiary` 的原因：那会留下其余 22 处过淡文本，并抹掉水印/tertiary 的层级区分。

## Alternatives considered

**把被点名的两处消费方改用 `label-tertiary`。** 否决：系统性过淡依然存在于其他所有位置，且抹去 dimmed 层的语义。

**加深到 500。** 否决：占位符会与真正的 `label-tertiary` 内容在密集面板里抢注意力；400 保持水印角色的可读性。

## Consequences

全部 dimmed 层文本（搜索占位符、过滤提示、统计行、提交者行）在浅色主题下变得可读，消费方零改动；深色主题不受影响。浅色表的 `label-caption` 本就映射同一个 static 400，因此两档在浅色下同值、在深色下仍可区分——当前无表面并排使用两者，不可感知；待主题下次设计梳理时可重新拉开梯度。没有 token 契约变化：名称、层级顺序、消费方集合完全一致，因此除 `verify-client-css-tokens` 外不受任何快照或门禁影响。

验证：`verify-client-css-tokens` 通过（别名在两套主题表中仍可解析）；客户端全套（`pnpm run test:gui`）保持绿色。

PR: #190 (merge)
