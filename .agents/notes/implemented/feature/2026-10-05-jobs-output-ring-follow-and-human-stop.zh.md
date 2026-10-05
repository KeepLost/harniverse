# Agent Note: jobs 输出环、follow 与人工停止

Status: implemented

[English](2026-10-05-jobs-output-ring-follow-and-human-stop.md) | 中文

范围：`packages/jobs/jobs`、`packages/jobs/jobs-local`、`packages/host/apiproxy/src/api/jobs.ts`、`packages/host/apiproxy/src/api/jobs.schema.ts`、`packages/client/ui-jobs`

## 问题

Wave-4 吸收行 R1/R2/R3/R10：官方树为 jobs 提供了逐作业输出环与不消费的 `follow`、保留 owner 完成通知的人工 `kill`、启动时前台、超时后转入后台的命令、`workflow` 的 `run_in_background`，以及取消默认唤醒上限。Harniverse 仅有 roster 的 `ui-jobs` 不具备这些表面，而模型的消费型 `read` 游标一旦支撑实时人工查看器，就会吃掉完成通知。

## 决策

- 每作业一个有界、不消费的字节窗口（`OutputRing`），默认容量 `DEFAULT_FOLLOW_RING_BYTES = 256 * 1024`，归配置所有；生产者保持其唯一的消费型 `read` 游标不动。
- `follow` 从绝对偏移读取环内字节（钳制到保留窗口内），且绝不将作业标记为已上报。
- `kill` 增加 `{reason, reported}` 载荷：模型普通 kill 保持 `reported`；人工停止传 `reported: false`，使普通完成通知仍送达 owner。
- apiproxy 以 `harniverse.operate` 能力暴露 `jobs.follow` / `jobs.kill`。
- Bash 作业超时后转入后台（`promoteOnTimeout` 默认 true）；`workflow` 增加 `run_in_background`；移除后台作业唤醒上限（可选设置保留）。
- Roster 行展开为实时输出面板，配两步停止。

## 备选方案

**采纳官方 `job-controller` 包形态。** 否决——A3 对专用控制器包的既有否决继续有效；注册处已负责准入。

**用消费型 `read` 游标支撑查看器。** 否决——这会把作业标记为已上报、与模型的读取竞争，并消费模型仍需要的字节。

**在 `ui-terminal` 上开只读入口供查看器使用。** 推迟——`ui-terminal` 未导出只读表面；查看器以等宽只读面板交付，而非在本批次加宽另一包的 API（记为已知限制）。

## 后果

输出环是 W15 累积路径，具备代码可验证的界（默认 256 KiB，归配置所有）与环界单元测试。人工与模型停止的上报语义不同且不丢完成通知。后台准入仍走既有的有界准入门；移除唤醒上限未新增累积路径。

## 验证

`packages/jobs` 的环界、不消费 follow、人工与模型停止上报差异的单元测试；超时转后台结果与后台 workflow 的无键快照；覆盖 follow 与两步确认停止的浏览器 e2e。
