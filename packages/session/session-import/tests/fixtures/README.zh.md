# 官方来源记录

[English](README.md) | 中文

以下记录逐字复制自本地冻结的上游 `ddefc45fbc`：

- `official-v1.jsonl`：`snapshots/session/text-turn/session.v1.jsonl`
- `official-v2.jsonl`：`snapshots/sdk/bash-tool/session.v2.jsonl`
- `official-v3.jsonl`：`snapshots/sdk/bash-tool/session.v3.jsonl`

这些是上游规范化的快照记录，不是物理持久化文件。`officialArtifact()` 恢复被省略的事件序号和时间戳；v1 打包行的每个增量占用一个序号。该函数不改变载荷、来源引用、标识或已记录的工具结果结构。
