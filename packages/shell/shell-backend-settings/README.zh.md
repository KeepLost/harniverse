# @deepseek-ai/dsh-shell-backend-settings

[English](README.md) | 中文

根拥有的 shell 后端设置命名空间:`$DSH_HOME/settings.yaml` 的 `shell-backend` 小节选择 Windows 上组合的 shell 家族——PowerShell(平台默认)或 Git Bash。非 Windows 平台该偏好不生效,始终组合 bash。

## 字段

| 字段 | Schema | 默认值 |
| --- | --- | --- |
| `backend` | `'platform-default' \| 'git-bash'` | `'platform-default'` |

命名空间以 `applies: 'restart'` 注册:应用引导(`@deepseek-ai/dsh-app-boot`)每次启动读取一次解析后的偏好——显式非空 `$DSH_SHELL_BACKEND` 环境变量优先,与 `$DSH_PERMISSION_MODE` 的逃生口形态一致——并在配置树挂载前把选择发布进进程环境。shell 行的 `disabled` 表达式(dsh-base 与 agent 预设中的 `bash-sandbox`/`tool-bash` 与 `pwsh-sandbox`/`tool-pwsh`)对称消费该值,因此每台主机恰好挂载一个 shell 栈,提交的设置变更在下一次启动生效。映射本身位于 `@deepseek-ai/dsh-shell`(`resolveShellBackend`):win32 仅在 `git-bash` 下组合 `bash`,其余平台始终组合 `bash`。

Loader 条目并发启动,这正是该链路采用组合期静态求值而非运行时服务门控的原因:由更早行发布的服务会与执行器行的激活发生竞态。本包的 REAL 组合套件通过 Loader 引导整条链(种子文档 → 引导桥 → 旗标对),并钉住两个栈的结果。

Web 客户端通过 `settings.describe` / `settings.update` 访问该命名空间(网关的 `WEB_SETTINGS_NAMESPACES` 允许清单含 `'shell-backend'`),Settings 页编辑的是同一份文档。

选择 `git-bash` 需要安装 Git for Windows(`bash` 可在 `PATH` 解析)。沙箱姿态不因选择而改变:win32 仍处于 ACL 受限沙箱(默认 `workspace-write`),受限 Git Bash 启动失败时由执行器逐调用报告 `SANDBOX_UNAVAILABLE`。

## Model Experience

### Windows shell 后端选择

#### 模型所见

Windows 上选择 `git-bash` 后,模型的终端工具为 `bash`(Git Bash)而非 `pwsh`;提示词、schema 与结果渲染其余部分遵循标准 shell 工具契约。

#### Token 影响

除工具互换外无影响:选择本身不增删任何提示词小节或 schema 字段。

#### KV Cache 影响

无;该选择每次启动读取一次,不进入逐轮组装。

## Known Limitations and Deferred Work

- Git Bash 在 win32 ACL restricted-token 沙箱下的行为尚未在真实 Windows 硬件上验证(wine CI 无法覆盖 koffi/ACL 路径);选择 `git-bash` 后若受限运行器启动失败,将以每次调用报告 `SANDBOX_UNAVAILABLE`,保留/限制/搭配全量放开确认的决策取决于该实证结果。
