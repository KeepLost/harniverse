# Agent Note: node-pty 构建不再再生 gyp Makefile

Status: implemented

[English](2026-10-01-node-pty-gyp-makefile-regen.md) | 中文

## Problem

Linux performance lane 在安装期从源码构建 `node-pty`（上游不发 Linux prebuilds）。node-gyp 的 make 生成器产出的 `Makefile` 带自再生配方，直接按 shebang 执行 `gyp_main.py`；pnpm 内置的 node-gyp 以 0644 模式打包该文件（pnpm/pnpm#12455），因此一旦 make 认为新生的 `Makefile` 已陈旧——与同一时间刻写下的 `binding.gyp`／`config.gypi` 之间的亚秒级 mtime 竞态——再生即以 `/bin/sh: gyp_main.py: Permission denied` 与 `make: *** [Makefile] Error 126` 失败，非确定性地击垮 `pnpm install`（job 110261333841；同一 lockfile 的前两轮通过）。

## Decision

既有的 `patches/node-pty@1.1.0.patch` 同时把安装脚本从 `node scripts/prebuild.js || node-gyp rebuild` 改写为 `node scripts/prebuild.js || (node-gyp configure && touch build/Makefile && node-gyp build)`。`configure` 落定后钉住所生成 `Makefile` 的 mtime，使所有 gyp 输入严格更旧，make 永不执行再生配方，缺失的可执行位不再重要。该分支仅在无 prebuild 的平台（Linux）执行；Windows 与 macOS lane 保持 prebuild 路径。

## Alternatives considered

- **升级 pnpm** —— 暂拒：上游 issue 未解决，已发布 pnpm 均未带可执行入口文件。
- **在 CI 中对内置 `gyp_main.py` 执行 `chmod +x`** —— 拒绝：按 workflow 修补 runner 工具链，其余消费者（开发者、其他 lane）仍暴露于同一竞态。

## Consequences

Linux 安装确定性地构建 node-pty 而不再触发再生配方；`pnpm-lock.yaml` 中的 patch hash 随之变化。以全新本地安装（`gyp info ok`）和经 `subprocess-local` 的功能性 pty spawn 往返验证。
