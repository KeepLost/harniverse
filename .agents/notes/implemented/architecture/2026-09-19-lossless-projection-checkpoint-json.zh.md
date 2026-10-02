# Agent Note：无损投影检查点 JSON

Status: implemented

[English](2026-09-19-lossless-projection-checkpoint-json.md) | 中文

## 问题

投影检查点可以包含不透明扩展数据和消息元数据。名为 `__proto__` 的 JSON 键是普通记录数据。Zod JSON 解析器在重建对象时丢弃该自有键，因此重新打开有效检查点可能得到与回放 Session 日志不同的投影状态。

## 决策

检查点值 schema 使用 `dsh-session` 中既有的 `isJsonValue` 谓词。它执行与检查点写入器 `snapshotJsonValue` 相同的无损 JSON 规则，不重建有效对象。校验仍拒绝非 JSON 和有损值。Storage-domain 表值是不可变的借用记录；校验器不提供防御性复制保证。

移植自官方 DSH `df0145271d`，属 2026-10-02 wave-4 吸收。

## 备选方案

- **保留 `z.json()`。** 其对象重建会移除有效自有键，因此校验成功仍可能改变检查点值。
- **用 `snapshotJsonValue` 校验并复制。** 这能保留键，但会复制已经不可变的存储值。只读谓词符合 storage-domain 的借用值约定。

## 后果

每个有效自有键都在 domain 重新打开后保留，包括嵌套的 `__proto__` 与 `constructor` 属性。存储 JSON 表示未变，因此 domain 版本不变；本修改修正其读取器。回归测试通过真实 schema 校验一份状态携带自有原型名键的记录，并保留对无法无损完成 JSON 往返的值的拒绝。Session 格式版本与历史代际不变。
