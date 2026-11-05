# Agent Note: VM M7 — 世界内 confinement：诚实的受限档

Status: implemented

[English](2026-11-06-vm-m7-guest-confinement.md) | 中文

Date: 2026-11-06. Scope：vm 世界的 sandbox 能力（`packages/vm/sandbox-vm`）、世界描述符（`packages/vm/vm`）、guest agent、包装器二进制与 rootfs 资产（`packages/vm/vm-qemu-local`），以及 `dsh-base` 的策略回退根。`ctx.vm` seam 契约、控制协议与所有消费方原样组合。

## Problem

`sandbox-vm` 对 `read-only` 与 `workspace-write` fail-closed——v0 世界 guest 没有世界内限制后端，这两个模式只能拒绝。路线图给出两条 spike 路径：富化 rootfs 引入 Landlock 可用的 guest 工具链，或在 world agent 内做 op 级强制。目标是在不弱化世界边界叙事、不动 `ctx.sandbox`/`ctx.vm` 共享契约的前提下，让受限模式变成真正的 `ConfinedArgv`。

## Decision

guest agent 本就是我们自己的静态 musl Rust 二进制，"rootfs 工具链"的框定随之消解：限制后端以第二个 cargo bin `dsh-vm-confine` 随 `build-rootfs.sh` 进入 rootfs 的 `/bin/dsh-vm-confine`。它对自身施加 Landlock 规则集后原样 `execvp` 调用方的 argv——包装与受限命令之间不残留 runner 进程。`sandbox-vm.confine` 以 `/bin/dsh-vm-confine --ro / --rw <roots>… -- argv…` 包装 argv，授权拼写沿用宿主 Landlock 方言（处处可读；read-only 只写 `/dev/null`，workspace-write 另加工作区根与世界的 `/tmp`），`enforcement: 'full'`、EACCES 拒绝方言（`permission denied`）与 `dsh-vm-confine:` runner 失败签名。vm seam 不动：`confine` 的契约就是纯 argv 包装，subprocess seam、控制协议与所有消费方原样组合。

诚实性由描述符承载：agent 启动期探测 spawn `/proc/self/exe --landlock-probe`（短命进程内构建并施加最大规则集——真正施加限制才是唯一诚实信号；PID 1 自身永不限制），通过后在 `welcome`/`announce` 宣告 `landlock` 能力；`VmWorldDescriptor` 新增世界中性的 `guestConfinement: 'landlock' | 'none'` 事实，世界未证明后端时 `confine` 保留 fail-closed 的 `SANDBOX_UNAVAILABLE` 拒绝。能力字符串对协议 v3 是纯附加——旧 guest 只是不报 `landlock` cap。

固定的 guest 内核（Alpine `virt` 6.6.142，摘要锁定 apk）自带 `CONFIG_SECURITY_LANDLOCK=y` 且 `CONFIG_LSM` 首位即 landlock，ABI 上限 3（REFER/TRUNCATE）；包装器协商 ABI 并掩蔽更新的访问位，镜像 `native/landlock-run` 语义（非目录授权只保留文件兼容位——`/dev/null` 授权即如此；无法打开的授权根闭合失败）。

顺带闭合一个组合漏洞：`dsh-base` 的 `sandbox-policy.workspaceRoot` 回退到宿主 `process.cwd()`，把宿主路径泄漏进一个它毫无意义的世界；该表达式现在按 `$DSH_EXEC_WORLD` 分支（vm → 世界内 `/workspace`），镜像 M6 的模式表达式。

## Alternatives considered

- **协议携带策略（exec 消息加 confine 字段）** —— 否决：要改 vm seam 类型、线上协议与 `subprocess-vm`，却仍然拦不住 agent 未中介的进程效果（guest 里 bash 直接写文件）；包装器是内核级强制，严格更强。
- **仅对 agent 中介的 op 做 op 级强制** —— 出于同一诚实性缺口否决：它能限制 `ctx.fs`/`ctx.vm` 调用，却管不住 guest 子进程，等于宣称一个模式并不兑现的边界。（fs seam 自 M5 起就在 `fs-vm` 内有宿主侧逐调用策略围栏——那部分从来不是缺口。）
- **busybox 式单一多调用二进制** —— 否决：经 lib face 共享 `guest/src/landlock.rs` 的第二个 bin target 同等静态体积下更清晰。
- **vm 下重新启用 `fs-sandbox`** —— 否决：`fs-vm` 拥有世界 fs seam 的逐调用策略围栏（`enforcePolicy`），行门控维持 M5 的设定。

## Consequences

- vm 世界下的受限模式是真的：越权写在 guest 内以 EACCES 拒绝，读与获准的汇放行，`danger-full-access` 仍是 vm 默认组合（不变）。
- 包装器开销实测 p50 ≈ +9.3 ms/exec（裸 ≈ 19.7 ms，受限 ≈ 28.9 ms，20 样本，TCG）——相对世界边界叙事可忽略。
- vm 组合下携带宿主 cwd 的会话仍会授予世界中不存在的根；包装器将其报告为 runner 失败（fail-closed），与 `fs-vm` 自 M5 起的同一前提一致。把会话 cwd 映射进世界记为会话组合长尾（路线图 M9）。
- 资产必须重建（`build-rootfs.sh`）才有包装器与能力宣告；旧缓存 initramfs 诚实报告 `guestConfinement: 'none'`，受限模式拒绝。

## Testing

- 单测（`sandbox-vm/tests/sandbox.spec.ts`）：注册、两种包装形状（授权拼写、`full`、方言、runner 规则）、`'none'` 时带新理由的 fail-closed 拒绝、abort 透传。
- REAL Loader 组合（CI，`sandbox-vm/tests/loader.spec.ts` + stub fixture）：会话解析的策略流入包装；无后端世界诚实拒绝。
- QEMU 门控 e2e（`sandbox-vm/tests/confine.e2e.ts`，真 provider）：完整语义矩阵——read-only 拒 `/etc` 与 `/workspace` 写、放行读与 `/dev/null`；workspace-write 放行 `/workspace` 与 `/tmp`、拒 `/etc`；不存在的 workspace 根以退出码 3 与 `dsh-vm-confine:` 签名呈现。
- M6 e2e 更新：钉住 `workspace-write` 的那次引导现在断言边界两侧（界内写通过、界外写拒绝），取代旧的拒绝断言。
- guest 侧包装器矩阵冒烟（10/10）在 TS 插座落地前直接对重建后的世界跑过。

## Deviations

相对 DoD 无偏差。路线图对路径①（"rootfs 富化"）的框定最终不需要任何外部工具链——agent crate 本身就是工具链；作为 spike 结论记录于此，而非偏差。

## Related

- 路线图：`VM-SANDBOX-ROADMAP.md`（workspace 根）M7 ✅；M9 持有会话 cwd 世界映射长尾。
- `2026-11-05-vm-m5-data-plane-workspace.md`（本作所依的 rootfs 管线）、`2026-11-06-vm-m6-exec-world-product-wiring.md`（本作落地的组合）。
- 宿主方言对齐：`packages/sandbox/sandbox-local/src/profiles.ts`、`native/landlock-run/packages/entry/src/main.c`。
