# Agent Note:Windows shell 后端成为用户设置(`shell-backend`、`$DSH_SHELL_BACKEND`)

Status: implemented

[English](2026-10-23-shell-backend-settings.md) | 中文

## Problem

shell 栈此前按平台硬性互斥:`bash-sandbox`/`tool-bash` 携带 `disabled: !!js process.platform === 'win32'`,pwsh 双子行取反,存在于 dsh-base 与全部四个 agent 预设。想让模型用 Git Bash 的 Windows 用户(bash 生态优于 PowerShell)在组合层面无解——唯一出路是外部 bundle patch 翻转行,即 `bash-on-windows` 插件对官方 dsh 的做法;harniverse 的融入方案评审已判定:其 escalation-inert 层已被核心吸收(`normalizeRedundantEscalation`),派生预设层已过时(预设一等化),宿主平面翻转应成为产品能力,而不是一个顺带引入 harniverse 从未采用的全量放开沙箱姿态的外挂(win32 本就默认 ACL 受限的 `workspace-write`)。

## Decision

- **根拥有的 `shell-backend` 设置命名空间**(`@deepseek-ai/dsh-shell-backend-settings`,`applies: 'restart'`,默认 `'platform-default'`,枚举 `'platform-default' | 'git-bash'`)选择 Windows 的 shell 家族;非 win32 偏好不生效。映射(`resolveShellBackend`)位于 `dsh-shell`,紧邻它命名的能力:win32 仅在 `git-bash` 下组合 bash,其余平台始终组合 bash。
- **组合链是引导期静态求值,而非运行时服务门控。** 应用引导(`dsh-app-boot`)每次启动读取一次存储的偏好——显式非空 `$DSH_SHELL_BACKEND` 环境变量优先,与 `$DSH_PERMISSION_MODE` 的逃生口形态一致——并在配置树挂载前把解析结果(`bash`/`pwsh`)发布进进程环境。dsh-base 的四个 shell 行与预设行消费同一对对称旗标:`disabled: !!js "(process.env.DSH_SHELL_BACKEND ?? (process.platform === 'win32' ? 'pwsh' : 'bash')) === '<另一栈>'"`——未设置时精确回退到今天的平台互斥,因此不经引导挂载的树(第三方组合、示例、直连 Loader 的测试)行为不变。第一版实现是在四个插件内部针对 `ctx.shellBackend` 服务做门控;REAL 组合套件抓到 vendored group 以 `Promise.allSettled` 并发启动兄弟条目,较早行的服务与执行器行的激活竞态,导致两个栈同时挂载且 pwsh 纤程静默赢得 `ctx.shell`。静态链没有可失去的顺序。
- **沙箱姿态不因选择而变**:`sandbox-policy` 保留默认值与 `$DSH_PERMISSION_MODE` 逃生口;受限 Git Bash 启动失败时逐调用报告 `SANDBOX_UNAVAILABLE`。Git Bash 能否在真实硬件的 win32 ACL restricted token 下存活,仍是方案评审的开放实证问题(wine CI 无法覆盖 koffi/ACL);README 将其记录为延迟决策门。
- Web Settings 页经网关的 `WEB_SETTINGS_NAMESPACES` 允许清单访问该命名空间(现含 `'shell-backend'`),与 `speech`、`shell` 同路。

## Verification

- `@deepseek-ai/dsh-shell` — `resolveShellBackend` 平台 × 偏好矩阵。
- `@deepseek-ai/dsh-shell-backend-settings` — 命名空间注册(restart、默认值)、提交变更跟随、种子文档解析、schema 拒绝未知值;REAL 组合 loader 套件经 app-boot 路径以 `git-bash` 种子文档引导出恰好 bash 栈(`SandboxPwsh` 缺席、`SandboxBashExecutor` 提供 `ctx.shell`、`bash` 工具在场、`pwsh` 缺席),并在 `$DSH_SHELL_BACKEND=pwsh` 下恰好 pwsh 栈——旗标翻转在非 win32 主机上被钉住。
- `dsh-app-boot` — 引导桥单测:无文档的平台互斥、按平台解析存储的 `git-bash`、显式环境变量优先(空白视为未设)、坏文档回退。
- `dsh-base` bundle 契约 — 四行在受控 `process` 上下文下对全部四种结果求值(win32/linux × 未设/`bash`/`pwsh`),命名空间行先于两个栈,不另发 windows patch 文件。
- `dsh-apiproxy` — shell-backend 命名空间的 describe 与 update 均被服务。
- 回归:shell、bundle、preset、settings、app-boot 套件绿(六个已知的 root 容器权限类失败早于本次变更且不进入改动路径);全量门禁归 CI。

## Alternatives considered

**在四个插件内针对 `ctx.shellBackend` 服务门控。** 第一版实现;因 loader 兄弟条目并发激活被否(见 Decision)——门控需要 cordis 不提供的可选 inject,硬 inject 则破坏所有无开关组合(示例、测试、第三方)。

**由开关插件动态插入条目。** 两个栈都静态禁用,插件在 settings 解析后插入选中行。确定性足够,但让设置插件拥有组合拓扑(HMR、profile dump、tree dump 都会观察到该变更),对比引导期求值一个表达式毫无收益。

**原样吸收 `bash-on-windows` 插件。** 零产品代码,但它把 `danger-full-access` + 审批 `never` 作为 win32 默认姿态带入——harniverse 从未做出的安全回退——且其 escalation-inert 与派生预设层对 harniverse 核心是死重。

## Consequences

- 提交的后端变更在下一次启动生效(`applies: 'restart'` 与引导桥的读取点一致);`settings.yaml` 热重载即时更新命名空间视图,但不改变已挂载的栈。
- `git-bash` 需要安装 Git for Windows 且 `bash` 在 `PATH`;缺二进制表现为执行器 spawn 失败,而非组合错误。
- `$DSH_SHELL_BACKEND` 进程可见(子进程可见)——与 `$DSH_PERMISSION_MODE` 同类泄露,为逃生口对称性接受。
- 方案评审中的 win32 ACL 问题自此有了具体落点:在真实 Windows 硬件上验证只需改一个设置,无需外部补丁。
