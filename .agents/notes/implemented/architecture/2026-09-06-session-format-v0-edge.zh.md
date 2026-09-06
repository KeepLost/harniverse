# Agent Note: 会话格式 v0 边——全分类面

Status: implemented

[English](2026-09-06-session-format-v0-edge.md) | 中文

## 问题

Wave-2 A1 决策要求 Harniverse 把当前会话词汇声明为格式 **v0**，使未来任何词汇演进都有挂靠锚点，且不采纳上游 v2 词汇或其四包家族。审计发现机械边已完整建成：两个后端都把 `SESSION_FORMAT_VERSION`（`0`）盖入已存储头（JSONL 头行的 `version` 字段、SQLite 的 `sessions.version` 列），协调器加载路径对其余每个版本 fail-closed 拒绝为 `SessionFormatUnsupportedError` 并带方向感知文案（"升级 harness"，绝不"损坏"），JSONL 读取器在校验今天的头形状之前先行拒绝外来版本。缺失的是可编程分类面：任何需要刻画已存储日志版本的消费者（列表、诊断、未来导入流）要么重放加载路径的异常行为，要么手写比较，语义没有单一归属。

## 决策

向 `dsh-session-persistence` seam 增加一个纯全函数：`classifySessionFormatVersion(version, currentVersion = SESSION_FORMAT_VERSION)` 把任意值映射到 `current`、`migration-required`、`unsupported`、`malformed` 四者恰好之一。分类域是非负安全整数；其余为 `malformed`，更新版本为 `unsupported`，更旧一代为 `migration-required`。因为 `0` 是最老一代，默认参数调用当前永远不产生 `migration-required`——第二个参数使该语义在测试中可达可钉，生产代码无死分支，per-file 覆盖门禁无需 ignore 注释。该函数是 seam 唯一的新公共值；后端、协调器、拒绝文案保持原样，不引入迁移链或代际重命名（与上游平行的 `migration-required` 类为首次未来版本提升保留，届时一并带上迁移设计）。

## 考虑过的替代方案

**把分类折进 `sessionFormatVersionRefusal` 或 `SessionFormatUnsupportedError` 路径。** 否决：那些是加载路径的拒绝机制；列表或导入消费者必须在不构造拒绝的情况下分类头，异常形状的控制流是回答全问题的错误面。

**省略 `currentVersion` 参数、等第二个代际出现再加 `migration-required`。** 否决：该类正是 A1 决策要声明的锚点；只在需要时才加会令未来迁移设计无处挂靠，且无生产分支的枚举成员是对公共类型的谎。

## 结果

消费者可用一次全函数调用刻画任意已存储头版本；四值面作为 v0 边声明记录在 seam README 与 persistence 子系统页。一切现有路径行为按构造不变（函数是增量的；未迁移任何调用方）。证据：RED 先行 spec（`format-classification.spec.ts`，实现前 module-not-found）覆盖全部四类含注入 current 的旧代语义；包套件 686/686 绿；包级 `tsc --noEmit` 干净；Cordis 目录再生成后 `doc-sync` 29/29。
