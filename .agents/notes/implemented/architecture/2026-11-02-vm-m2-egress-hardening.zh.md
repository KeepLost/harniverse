# Agent Note: VM M2——沙箱包装器与审批制 egress

Status: implemented

[English](2026-11-02-vm-m2-egress-hardening.md) | 中文

## Problem

[协议 v2 里程碑](2026-11-02-vm-exec-fs-protocol.md)已经在 guest 里跑真实操作，但计划验收矩阵还有两行未证明：guest 的隔离声明（T5）停留在无人断言的 QEMU 调用细节上，而 QEMU 子进程本身以宿主用户身份运行、文件系统不受限——宿主纵深（T7）不存在。egress 则因"没有网卡"而全有全无，没有任何缝隙可以让出站请求被审批或拒绝（T6）。

## Decision

**`qemu-wrap`（C，约 200 行，由 `assets/build-rootfs.sh` 在带 C 编译器的 Linux 上产出）。** 一个包装器、一套策略，在 `execvp` 之前全部施加：

1. rlimits——CPU 3600 s、地址空间 8 GiB、1024 个 fd、256 个进程、单文件 1 GiB。
2. Landlock——handled 覆盖全部 FS 权限位；`/` 之下授予读+执行（不存在的路径静默跳过，故 `/dev/kvm` 只在存在处额外授予读写）；**全部**写侧权限（含 `TRUNCATE`，因为 QEMU 以 `O_TRUNC` 打开控制台日志）只授予唯一的 `--scratch` 目录。规则集是强制的：内核拒绝它就让引导失败，而不是无约束地跑子进程。
3. uid 降权——root 时清空补充组、`setgid/setuid(65534)`；`--must-drop` 在条件不满足时以退出码 77 拒绝。非 root 宿主上 Landlock 与 rlimits 依然生效。

`openWorld`（`sandbox: 'auto'`，默认）在包装器就绪时经它启动：`descriptor.sandboxed` 如实上报，`probeWorld().sandboxed` 可预检。root 宿主上 scratch 目录 chown 给 65534，且**启动资产先复制进去**——降权后的 uid 无法穿越任意宿主路径（挂在 `/root` 下的工作区会读 `EACCES`，这与 Landlock 无关：Landlock 叠在 DAC 之上，从不豁免 DAC）。

**Egress 中继（`egress.ts`，宿主侧）。** `world.egress.open(host, port)` 先问该世界的 `EgressPolicy` 审批回调；没有策略、或策略拒绝，一律 `EgressDeniedError`——默认即拒绝，无需主动开启。放行的请求经 `node:net` 拨号（5 s 连接预算），双向流式，句柄统一登记、随世界销毁关闭（`destroy` 触发 `closeAll`）。T6 的双档（默认拒绝、审批放行中继）在单测套件里对本地 mock TCP 服务器证明——guest 全程不参与，这正是要点：没有网卡就没有 guest 侧 socket 面可供攻击或误配。

## Alternatives considered

- **窄读白名单的 Landlock 而非全树只读+执行：** 按宿主精确列举（qemu 二进制、ROM 目录、ld 缓存）跨发行版与 qemu 版本极其脆弱；"处处可读、除 scratch 外无处可写"保住了真正要紧的安全性质（不写宿主、canary 在 DAC 之外也读不到），且规则集能扛升级。canary 的机密性由 uid 降权 + 文件模式承担，T7 有断言。
- **guest 侧 egress agent 走控制协议：** guest 可见的 socket API 会增加协议面、guest 解析风险与每连接一次审批往返，且当前没有消费者；宿主中继才是未来 ctx 接线真正需要的缝隙。随数据通道一起延后。
- **给降权 uid chmod `/dev/kvm` 或加 ACL：** 库去改宿主设备权限是不可接受的副作用。改为：沙箱化世界的 `auto` 加速停留在 TCG（降权 uid 打不开 `/dev/kvm` 的地方），文档记为限制；显式 `accel: 'kvm'` 被尊重，在 DAC 拒绝处响亮失败。

## Consequences

收获：T4–T7 对真实 guest 全绿。T4：八个 fs 操作与宿主参照一致、错误码对齐（`ENOENT`、`ENOTEMPTY`），1000 文件写+读回循环在沙箱生效的 TCG 下字节精确、约 6.8 s（写 ≈ 3.7 s、读 ≈ 3.1 s）。T5：guest 根目录恰为固定 minirootfs 布局（加 agent 挂载点），用户态进程只有 `/init` 与探针自身（内核线程除外），`/sys/class/net` 只有 `lo`，guest 写永不落宿主。T6：默认拒绝与审批放行双档均证明。T7：受监管子进程以 uid 65534 运行（以 `/proc/<pid>/status` 断言），scratch 外的 root 专属 canary 读 `EACCES`，scratch 外写入被拒，而世界全程可用——包装器下世界就绪约 2.9 s，与不包装无异。

代价：root 宿主每次引导付出内核+initrd 复制（约 14 MiB）进 scratch 目录；沙箱化的 `auto` 世界在降权 uid 打不开 `/dev/kvm` 处停留于 TCG；包装器仅限 Linux（其他平台 `sandboxed: false`）；`mkdir` 语义暴露出一个真实的对齐事实——guest `mkdir` 是单层的，等价于不带 `recursive` 的 `fs.mkdir`，已由 T4 矩阵钉住。
