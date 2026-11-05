# @deepseek-ai/dsh-exec-world-settings

[English](README.md) | 中文

根拥有的执行世界设置命名空间：`$DSH_HOME/settings.yaml` 的 `exec-world` 小节选择宿主组合的能力家族——宿主本地家族（默认）或 VM 家族（`@deepseek-ai/dsh-subprocess-vm` / `dsh-fs-vm` / `dsh-sandbox-vm`，基于 `dsh-vm-qemu-local`）。

## 字段

| 字段 | Schema | 默认值 |
| --- | --- | --- |
| `world` | `'local' \| 'vm'` | `'local'` |

命名空间以 `applies: 'restart'` 注册：应用引导（`@deepseek-ai/dsh-app-boot`）每次启动读取一次解析后的偏好——显式非空 `$DSH_EXEC_WORLD` 环境变量优先，与 `$DSH_PERMISSION_MODE` 的逃生口形态一致——在偏好为 `vm` 时探查 VM 提供者，并在配置树挂载前把选择发布进进程环境。探查不健康（无 QEMU 二进制或缺暂存资产）的 `vm` 偏好降级为 `local` 并在 stderr 提示一行，保证应用可启动。能力家族行的 `disabled` 表达式（dsh-base 中的 `subprocess`/`sandbox`/`fs-sandbox` 与 `vm`/`subprocess-vm`/`fs-vm`/`sandbox-vm`）对称消费该值，因此每次启动恰好挂载一个家族，提交的设置变更在下一次启动生效。解析本身位于 `@deepseek-ai/dsh-vm`（`resolveExecWorld`）；提供者探查为 `probeWorld`（`@deepseek-ai/dsh-vm-qemu-local`）。

Loader 条目并发启动，这正是该链路采用组合期静态求值而非运行时服务门控的原因：由更早行发布的服务会与提供者行的激活发生竞态。本包的 REAL 组合套件通过 Loader 引导整条链（种子文档或显式环境变量 → 引导桥 → 旗标对），QEMU 门控的 e2e 则引导真实提供者组合并在世界内驱动 bash/fs 工具形态。

vm 世界下适用已记录的组合决策：未设置的 `$DSH_PERMISSION_MODE` 解析为 `danger-full-access`（世界边界即沙箱）；显式钉住的受限模式则通过 `dsh-sandbox-vm` 组合出真实的世界内 Landlock 强制，guest 未报告后端时 fail-closed（见其 README）。

Web 客户端通过 `settings.describe` / `settings.update` 访问该命名空间（网关的 `WEB_SETTINGS_NAMESPACES` 允许清单含 `'exec-world'`），Settings 页编辑的是同一份文档。

## Model Experience

### 执行世界选择

#### 模型所见

`vm` 下模型的 bash 与文件系统工具在来宾机内执行（自有内核与文件系统）；提示词、模式与结果渲染遵循标准工具契约不变。

#### Token 影响

除工具结果内容外无影响：选择本身不增删任何提示词小节或模式字段。

#### KV 缓存影响

无；选择每次启动读取一次，不进入逐轮装配。

## Known Limitations and Deferred Work

- **重启生效，非实时** — 命名空间声明 `applies: 'restart'`；运行中的进程保留下次启动前已组合的家族。
- **UI 不做可用性探查** — 设置页在任何主机都提供两个选项；无 QEMU 主机上的 `vm` 选择在下一次启动降级并输出一行引导提示，表单内不体现。
