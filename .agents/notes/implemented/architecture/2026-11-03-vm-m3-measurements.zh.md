# Agent Note: VM M3 —— 诚实计量、可重复性与风险销账

Status: implemented

[English](2026-11-03-vm-m3-measurements.md) | 中文

## Problem

PoC 计划的最后一批验收行仍未落地：T8（TCG 下真实负载数字——sha256、tar+gzip，以及喂给 workspace 形态决策的 fs 数据点）与 T10（引导可重复性 ±20 %、100 组操作 RSS 漂移 <10 %），外加研究报告 §7 风险清单——其中 1/2/4/5 只有拿到这些数字才能关闭。

## Decision

全部经由公开宿主 API（`openWorld` / `world.exec` / `world.fs`）测量，宿主侧壁钟计时——这是宿主库调用者体验到的数字——并由一个 e2e 套件（`tests/bench.e2e.ts`）以 `[bench]` 行打印每个数字；套件只断言结构（引导偏差 ≤ ±20 %、RSS 漂移 < 10 %），从不断言绝对时间：绝对时间是环境属性，所以 MEASUREMENTS.md 把环境记录在数字旁边。fs 数据点采用采样（1 MiB、64 KiB 块）而非饱和灌注——单次操作成本线性逼近 10 s 控制回复预算，采样测的是同一条斜率而不必贴着超时生活。

## Alternatives considered

- **guest 侧计时（busybox date）：** busybox 无亚秒时钟，且 guest 数字还需传输修正；围绕 await 调用的宿主计时才是调用者的真相。
- **用 512 KiB 块饱和灌注 20 MiB `fs.writeFile`：** 单次 512 KiB 写实测 ≈ 9.7 s，正贴 10 s 回复预算——运行会在它试图刻画的那条超时上抖动。64 KiB 块低一个数量级。
- **给 T8 上硬性吞吐/时间线：** 计划要的是诚实数字而非通过线；CI 宿主的方差会把任何绝对线变成 flake。T10 保留计划阈值，因为两个探针都是比值型且宿主稳定。

## Consequences

- `tests/bench.e2e.ts`（T8/T10）并入 e2e 矩阵；本容器上包级 e2e 全量 20 测试全绿，每轮后清理 qemu 残留。
- `packages/vm/vm-qemu-local/MEASUREMENTS.md` 记录 2026-11-02 运行：sha256 20 MiB ≈ 31.2 MiB/s（宿主倍数 ≈ 10.7×）、tar+gzip 100 MiB ≈ 13.8 MiB/s（≈ 12.3×）、控制协议 fs 64 KiB 块 写 ≈ 0.05 MiB/s / 读 ≈ 0.2 MiB/s（UART 天花板在 fs API 上的实测）、三连引导偏差 ≤ 中位数 2.5 %、100 组写+读 RSS 漂移 0.5 %。
- README 实测段新增 T8/T10 两行并链接 MEASUREMENTS.md；批量传输限制条目在 exec 输出数字旁补上 fs 写数字（≈ 0.05 MiB/s）。
- 研究报告 §7 清单以数字指针关闭风险 1/2/4/5；3/6/7/8 保持开放并附 PoC 时代注记（recipe 已入 repo、降权后的 DAC 事实佐证 §2.5 约束、Windows/macOS 与 qemu CVE 跟随不变）。
- workspace 形态含义就此量化：元数据与小文件走控制协议即可（T4 的 ≈ 3.7ms/op）；批量载荷必须有专用数据面（9p 或 virtio-blk）——正是风险 2 要的决策输入；按计划 §6，9p 采用本身仍在范围外。
