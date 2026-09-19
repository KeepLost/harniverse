# Agent Note: Harniverse 以 BSD-3 再许可，原样继承的 DSH 代码保留 MIT

Status: implemented

[English](2026-09-19-relicense-bsd3-inherited-mit.md) | 中文

## Problem

Harniverse 已经积累了与官方 DeepSeek Harness（DSH）发展方向分叉的下游能力、组合与文档，但顶层 LICENSE 仍指向上游 MIT 文本。单一的 MIT 文件错误描述了下游自研部分的许可状态，也让下游再分发者拿不到针对 Harniverse 特有代码的可区分授权。

## Decision

仓库许可证变更为 BSD 3-Clause：根目录 `LICENSE` 换为带 Harniverse 版权行的 BSD-3 文本，README 许可证段落直白陈述这一划分。Harniverse 整体按 BSD-3 分发，而自官方 DSH 原样继承的部分仍保留该项目的 MIT 许可证。该 carve-out 为继承文件保留完整的归属信息，同时不必在首个 tag 发布前强制做逐文件审计；划分边界是“自上游原样继承”，而 PLUGINS.md 基线台账已经从另一个角度追踪了这一边界。

## Alternatives considered

- 全库维持上游 MIT：拒绝，因为下游自研代码在许可条款上仍与继承代码不可区分，而本分叉的方向已不再跟随上游。
- 做一次逐文件 SPDX 审计，产出含 `LICENSE.BSD-3` 与 `LICENSE.MIT` 文件清单的 `LICENSE/` 目录：暂缓，因为这是大规模机械清扫，且此后每次上游同步都要付出合并冲突成本；若首次 tag 发布的再分发需要精确文件清单，届时再做。
- 全树 MIT OR BSD-3 双许可：拒绝，因为它把下游代码默默重新按 MIT 授权，与区分分叉的意图相悖。

## Consequences

下游再分发者必须同时携带覆盖 Harniverse 整体的 BSD-3 文本与覆盖继承 DSH 部分的 MIT 声明；在逐文件审计落地之前，README 许可证段是这一划分的权威白话表述。未来的上游同步在机制上保持不变：继承文件仍是 MIT，新的下游代码默认为 BSD-3。首个带 tag 的 Harniverse 发布应重新评估合规工具是否需要精确文件清单。

## Scope

本次变更覆盖根目录 `LICENSE`、双语 README 许可证段与本 note。未改动任何包 manifest、THIRD_PARTY_NOTICES.md 或 `vendor/` 内钉住包的许可证；vendored 包保留各自原有许可证。
