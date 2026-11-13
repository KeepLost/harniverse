# Agent Note:VM boot 时宿主工作区导入——锚定根成为 `/workspace`

Status: implemented

[English](2026-11-13-vm-boot-workspace-import.md) | 中文

Date:2026-11-13。范围:`packages/vm/vm-qemu-local`(新增 `src/host-import.ts`、`src/errors-host-import.ts`、`QemuLocalWorld` Config)、boot 桥(`packages/boot/app-boot`——锚点显式优先与超限预扫)、真组合 e2e。`ctx.vm` 缝、控制协议、数据面布局不动。

## Problem

M9 的 cwd 映射让宿主 cwd 下的 vm 会话解析进 `/workspace`——但除非调用方经库 API 暂存快照,世界开机即空工作区,而没有任何产品路径这么做。vm 世界因此对真实项目会话不可用:agent 打开 `/workspace` 什么都没有(使能评审的第 2 项决策)。

## Decision

**provider 在 boot 时导入锚定的宿主根。** `QemuLocalWorld` 将非空 `$DSH_VM_HOST_WORKSPACE_ROOT`(或 `workspaceImport.root`;`'off'` 禁用)经新增 `packHostWorkspace` 打包——确定性遍历(每目录按名排序)产出 v0 tar(仅文件与目录;symlink 跳过并计数)——暂存为导入镜像,并在世界 settle 前调用 `workspace.import()`,settle 的世界必然带着就位的工作区。guest 内存与载荷配对:`max(配置, ceil(字节/1MiB) × 2 + 256)`(M5 实测 100 MiB 载荷需 512 MiB)。

**上限是全链一把旋钮**:`workspaceImport.maxBytes`,否则 `$DSH_VM_IMPORT_MAX_BYTES`(非正数或非整数在 boot 响亮失败),否则 256 MiB。超限抛 `HostWorkspaceTooLargeError`,点名根、双尺寸与出路——provider 处 fail-closed,与显式 `$DSH_EXEC_WORLD` 姿态一致。

**存储偏好路径绝不把用户关在应用外。** boot 桥在即将组合 `vm` 时对启动目录做预扫(`scanHostWorkspace`,仅元数据),工作区超限则带一条点名双尺寸的提示降级 `local`;显式 env 路径保持 provider 的 fail-closed(运维的显式选择)。显式 env 覆盖路径从不扫描。

**锚点遵循逃生阀形状。** `anchorHostWorkspaceRoot` 此前无条件以 `process.cwd()` 覆盖 `$DSH_VM_HOST_WORKSPACE_ROOT`;现在显式非空值胜出,与其他 boot 事实同序——e2e 也正以此锚定提交的夹具。

## Alternatives considered

- **共享文件系统(9p)**——随 M5 一并否决:宿主侧 9p 服务器是介导面,共享 fs 模糊了路径命名的文件系统归属。
- **会话中途重导入或变更即导出**——数据面每次引导暂存一份不可变导入镜像;中途传播宿主改动需要重引导循环或新协议 op。v0 如实记录一次导入语义。
- **在 provider 而非桥处降级**——插件加载失败会让整个应用对超限项目无法启动,把用户锁在能切回 `local` 的设置 UI 之外。

## Consequences

- 存储 `vm` 偏好现在带着启动目录内容打开 `/workspace`(有界、确定性、symlink 跳过),锚点下的会话能看到自己的文件。
- 启动后的宿主改动永不进入运行中的世界;README 以此为 v0 语义。
- 导入为每次 vm boot 增加打包时间(元数据遍历加有界载荷的 tar;数据面几十 MiB/s)并使 guest RAM 与载荷配对。
- 锚点 env 现在可由运维覆盖,部署可锚定启动目录的子目录。

## Testing

- 单测(`vm-qemu-local/tests/host-import.spec.ts`):上限解析(option/env/默认、坏 env 值响亮拒绝)、扫描求和不含不规则条目、确定性打包含 symlink 跳过计数与重打包逐字节一致、超限 fail-closed 点名双尺寸、内存配对(下限、100 MiB→456、上限尊重)。
- 服务(`service.spec.ts`,经 qemu-stub——stub 现应答 `workspace.import`/`workspace.export`):env 锚定导入以 `-m 258` boot 并挂载 `ws-import.img` 盘;`workspaceImport: 'off'` 保持 256 默认。
- boot 桥(`exec-world-boot-env.spec.ts`):限内组合 `vm`;超限带双尺寸提示降级且无锚点;显式路径从不扫描;显式锚点胜过启动目录,空白重锚。
- REAL 组合、真 QEMU(`exec-world.e2e.ts` 新腿):锚点指向提交的夹具树 boot,两份文件经组合的 `ctx.fs` 从 `/workspace` 读回——证明全链(桥→provider→打包→暂存→解包→缝)端到端成立。

## Related

同日的资产发布分发笔记闭合另一使能缺口;本文构建于其上的 M9 会话 cwd 映射不变。
