# Agent Note: VM M6 — 产品接线：执行世界开关

Status: implemented

[English](2026-11-06-vm-m6-exec-world-product-wiring.md) | 中文

日期：2026-11-06。范围：组合层（`packages/bundle/base`、`packages/bundle/web-app`）、启动桥（`packages/boot/app-boot`）、一个新的设置包与一个新的客户端小节、guest rootfs（bash 载荷），以及 `dsh-vm` 的解析词汇。`ctx.vm` 缝与三个 VM 提供者不动。

## 问题

M4 之后，VM 能力家族（基于 `dsh-vm-qemu-local` 的 `dsh-subprocess-vm` / `dsh-fs-vm` / `dsh-sandbox-vm`）已实现与本地家族相同的契约，但没有任何可交付组合挂载它们：`dsh-base` 只挂本地提供者，真沙箱只能被测试和库 API 触达。路线图 M6 要求产品接线——沿 shell-backend-settings 先例（#249/#251）提供"执行世界"选择，无 QEMU 主机诚实降级，以及组合层端到端证据。

## 决策

**载体：`dsh-base` 内由设置驱动环境变量门控的行，而非独立 `bundle/vm`。** DoD 要求面向用户的选择；shell-backend 先例正是这个形态（设置命名空间、`applies: 'restart'`、启动桥环境变量发布、互斥行上的对称 `disabled` 表达式），而 patch 层的按行最后写入胜出让第二个 bundle 只是把包装问题后移。专用 bundle 之后可以再加层，无需触碰本机制。

**解析链。** `dsh-vm`（缝包）新增纯词汇：`EXEC_WORLD_ENV`、`ExecWorldPreference` 与 `resolveExecWorld(preference, availability)`——`vm` 要求存储的 `vm` 偏好与健康的提供者探查同时成立，否则 `local`。新包 `dsh-exec-world-settings` 注册根拥有的 `exec-world` 命名空间（`world: 'local' | 'vm'`，默认 `local`）。`app-boot` 的 `applyExecWorldBootEnv` 镜像 `applyShellBackendBootEnv`：显式非空 `$DSH_EXEC_WORLD` 优先（`$DSH_PERMISSION_MODE` 的逃生口形态），配置树挂载前从 `settings.yaml` 读取存储偏好，`vm` 偏好触发 `probeWorld()`（`dsh-vm-qemu-local`）探查——不健康（无二进制或缺资产）降级为 `local` 并在 stderr 提示一行，保证应用可启动。探查仅对 `vm` 偏好运行；本地主机零开销。

**行门控。** `subprocess`/`sandbox`/`fs-sandbox` 在 `$DSH_EXEC_WORLD === 'vm'` 时新增 `disabled`；四行 `vm`（qemu-local）/ `subprocess-vm` / `fs-vm` / `sandbox-vm` 以取反表达式挂载；`exec-world-settings` 注册桥读取的命名空间。环境变量未设置（未经启动桥挂载的树）组合 `local`，安全默认。shell 栈不动：它们消费 `subprocess`/`sandbox` 缝，随任一家族生效。

**vm 世界下的权限姿态（M4 已记录决策，本次落地组合）。** 世界边界即沙箱：`$DSH_PERMISSION_MODE` 未设置时在 `vm` 下解析为 `danger-full-access`（`sandbox-policy` 的 mode 与 `approval` 的 policy 表达式经世界映射）；显式钉住的受限模式仍然胜出，并通过 `sandbox-vm` 组合成诚实拒绝的会话——正是 e2e 钉住的拒绝路径。这是默认值映射，不是新权限模式。

**guest bash 载荷。** shell 工具通过世界的 subprocess 缝组合 `bash -c` 与常驻交互 bash，而 busybox 没有 bash applet，因此 `build-rootfs.sh` 现在暂存摘要锁定的 apk 链 `bash` → `readline`（`libreadline.so.8`）→ `libncursesw`（`libncursesw.so.6`），外加 `ncurses-terminfo-base`（让 readline 的 pty 模式不退化为 dumb 条目）；musl 已在 minirootfs 中。只取载荷成员——apk 控制文件永不进入世界文件系统。

**UI。** `dsh-client-ui-settings-exec-world` 镜像 shell-backend 小节并下移一位（order 17；13–16 的组合级分组已满）：同一命名空间上的宿主本地 / VM 世界单选、重启生效文案、标准设置作用域写入路径。网关的 `WEB_SETTINGS_NAMESPACES` 允许清单收录 `'exec-world'`。

## 考虑过的备选

- **独立 `bundle/vm` 作载体** — 把选择推迟到 profile 打包；没有面向用户的开关，且一旦需要开关仍离不开行门控机制。
- **`ctx.capabilities` 组合体系** — 其种类是 `tool | skill | mcp-server | subagent-provider`；执行世界提供者是服务缝后的能力*家族*，不同维度。在那里注册会重载种类词汇。
- **在小节表单内探查可用性** — Web 客户端无法探查宿主；启动桥拥有降级（DoD 的"降级/隐藏"由启动时降级加说明要求与回退的文案满足）。

## Consequences（后果）

每个部署的 base 组合现在都携带 vm 家族行（开关之外保持禁用），`dsh-base` 的依赖清单随附提供者代码；资产仍为构建而非内置，故只是代码体积。Python SDK 运行时的部署闭包相应增长（它声明了闭包门经由 app-boot 看到的 `dsh-vm` peer）。vm 世界的默认姿态是 `danger-full-access`——世界边界即隔离——除非运维钉住受限模式，组合的每个消费者都继承这一点；该钉住在 M7 之前组合出的是诚实拒绝而非 confinement。已提交的 `MINIROOTFS_SHA256` 常量修正为上游摘要，因此从未重建的旧检出此前强制的是一行格式错误的校验，而非错误的文件。

## Testing（测试证据）

- 单元：`resolveExecWorld` 矩阵；命名空间注册（默认、存储种子、提交更新、schema 拒绝）；`applyExecWorldBootEnv`（文档解析、显式/空白覆盖、不健康探查降级含提示、畸形文档、local 跳过探查）。
- REAL 组合（CI 安全，stub world）：种子文档或显式环境变量 → 启动桥 → 恰好一个家族挂载；权限默认随世界翻转；vm 侧乘坐 stub `VmWorld`，无 QEMU 主机也能钉住门控。
- REAL 组合（QEMU 门控 e2e，本机）：`$DSH_EXEC_WORLD=vm` 经 `boot()` 引导真实提供者组合——`QemuLocalWorld` 即 `ctx.vm`、guest 内 `resolveExecutable('bash')` → `/bin/bash`、`bash -c 'uname -r'` 报告 guest 的 `6.6.142-0-virt` 内核、`ctx.fs` 往返 `/workspace`、未设置的权限默认解析 `danger-full-access`；显式钉住 `workspace-write` 的一次运行断言 `sandbox-vm` 的诚实拒绝。
- 回归：受影响包全量单测清扫（386 项）保持绿；M5 的 VM e2e 套件对重建后的 rootfs（含 bash 载荷）仍然全绿。

## 偏差

- M5 提交的 `MINIROOTFS_SHA256` 常量多出一个字符（65 位十六进制）；重建时以"校验行格式错误"暴露，此处修正为上游 64 位摘要——缓存工件始终与上游一致，此前构建从未强制过错误文件。
- vm 家族的行集搭载 `dsh-base` 的依赖清单，因此每个部署都会随附提供者代码；行在开关之外保持禁用，资产仍为构建而非内置，故只是代码体积。

## Related（相关）

按 `VM-SANDBOX-ROADMAP.md`：M7（guest 内 confinement，让 `read-only`/`workspace-write` 在世界内成真）与 M8（egress 诚实化：审批卡与 guest 可见代理）；均不因本次接线改变。
