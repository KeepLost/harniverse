# Agent Note: 压缩摘要上限默认 32768

Status: implemented

[English](2026-10-02-compaction-summary-cap-32768.md) | 中文

## 问题

`compaction-basic` 的 `maxTokens` —— 摘要调用的上限，其后还会被匹配的请求策略、模型输出能力与由 Provider 锚定的安全上下文空间进一步降低 —— 默认为 `8192`。长代理会话的摘要经常需要超出这个空间的篇幅，而该上限会静默截断它们；每个部署都得手工发现并覆写这个旋钮。

## 决策

把默认值提升为 `32768`，且仅此而已：

- `resolveConfig` 物化为 `config.maxTokens ?? 32_768`；显式配置照旧全胜。
- `compaction-lossless` 的 README 行写明相同默认值，因为它复用 `BasicCompactionConfig` —— 不存在需要移动的独立 lossless 默认值。
- 文档（`compaction-basic` README 对、`compaction-lossless` README 对、config catalog 对）记录新数值。

## 备选方案（Alternatives considered）

**65536 的余量式默认。** 否决：那样大的摘要会吃掉压缩本要释放的上下文。

**改变摘要调用上的推理 token 处理。** 否决：推理保持开启，与今天一致；只移动默认上限。

## 后果

压缩摘要现在最多可到 32k token，再由外层边界钳制。显式固定了 `maxTokens` 的部署看不到差异。该数值仍是上限而非目标：更短的会话仍摘要得更短。

## 测试

`pnpm exec vitest run packages/compaction/` —— 406 项测试，含改为断言 `maxTokens: 32_768` 的 `uses low-friction service-wide defaults`。`pnpm exec tsc -p packages/compaction/compaction-basic --noEmit` 与 `compaction-lossless` 干净；翻译配对与 config catalog 校验绿。
