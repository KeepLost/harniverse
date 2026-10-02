# Agent Note: node-pty 构建不再再生 gyp Makefile

Status: implemented

[English](2026-10-01-node-pty-gyp-makefile-regen.md) | 中文

## Problem

Linux performance lane 在安装期从源码构建 `node-pty`（上游不发 Linux prebuilds）。node-gyp 的 make 生成器产出的 `Makefile` 带自再生配方，直接按 shebang 执行 `gyp_main.py`；pnpm 内置的 node-gyp 以 0644 模式打包该文件（pnpm/pnpm#12455），因此一旦 make 认为新生的 `Makefile` 已陈旧——与同一时间刻写下的 `binding.gyp`／`config.gypi` 之间的亚秒级 mtime 竞态——再生即以 `/bin/sh: gyp_main.py: Permission denied` 与 `make: *** [Makefile] Error 126` 失败，非确定性地击垮 `pnpm install`（job 110261333841；同一 lockfile 的前两轮通过）。

## Decision

既有的 `patches/node-pty@1.1.0.patch` 同时把安装脚本从 `node scripts/prebuild.js || node-gyp rebuild` 改写为 `node scripts/prebuild.js || (node-gyp configure && make -C build -o Makefile BUILDTYPE=Release)`。再生规则的前置条件是共享的 gyp 输入（header 缓存中的 `common.gypi`、pnpm dist 内的 `addon.gypi`、邻居 `node-addon-api` 的 gyp 文件）；并行原生构建（如 `cpu-features`）可在我们的 configure 与 make 之间触碰其中任一文件，因此对生成的 `Makefile` 做任何 mtime 钉住都无法裁决该竞态——第一版尝试（`touch build/Makefile`）正是在 CI 上以此方式落败。`make --old-file Makefile` 把该裁决从 mtime 比较中彻底移除：Makefile 被声明为最新，再生配方永不执行，缺失的可执行位不再重要。该分支仅在无 prebuild 的平台（Linux）执行；Windows 与 macOS lane 保持 prebuild 路径。

## Alternatives considered

- **升级 pnpm** —— 暂拒：上游 issue 未解决，已发布 pnpm 均未带可执行入口文件。
- **configure 后钉住所生成 Makefile 的 mtime** —— 拒绝：钉住之后并行构建者仍可触碰共享 gyp 输入（CI 上已观察到）。
- **在 CI 中对内置 `gyp_main.py` 执行 `chmod +x`** —— 拒绝：按 workflow 修补 runner 工具链，其余消费者（开发者、其他 lane）仍暴露于同一竞态。

## Consequences

Linux 安装确定性地构建 node-pty 而不再触发再生配方；`pnpm-lock.yaml` 中的 patch hash 随之变化。验证包括本地复现竞态（全新 `node-gyp configure`、`touch common.gypi` 后 plain `make` 再生并死于 Error 126，`make -o Makefile` 干净构建）、经补丁行的全新本地安装，以及经 `subprocess-local` 的功能性 pty spawn 往返。
