# @deepseek-ai/dsh-shell-registry-settings

[English](README.md) | 中文

根拥有的 shell 注册表设置命名空间:`$DSH_HOME/settings.yaml` 的 `shell-registry` 小节保存用户注册的 shell 条目,以及未作单独选择的会话回退使用的默认值。两个内置 id 无需注册即可寻址——`posix`(平台默认 POSIX shell:macOS 为 zsh、Linux 为 bash、Windows 为 Git Bash)与 `pwsh`(PowerShell)——显式默认在**所有平台**生效。

## 字段

| 字段 | Schema | 默认值 |
| --- | --- | --- |
| `default` | `'platform-default' \| 'posix' \| 'pwsh' \| <条目 id>` | `'platform-default'` |
| `entries[].id` | 唯一小写 slug,不得为保留 id | — |
| `entries[].path` | 可执行文件路径或 PATH 名,须归入已服务的方言类 | — |
| `entries[].label` | 可选显示标签(默认:可执行文件的 basename) | — |

校验在最早可解析点响亮失败:保留或畸形 id、重复 id、不在已服务方言类(POSIX bash/zsh/sh/dash/ksh;PowerShell pwsh)内的可执行文件、以及指向未注册条目的默认值,都会使命名空间注册或更新失败。

命名空间以 `applies: 'restart'` 注册:应用引导(`@deepseek-ai/dsh-app-boot`)每次启动读取一次存储文档——显式非空 `$DSH_SHELL_BACKEND` 环境变量优先,与 `$DSH_PERMISSION_MODE` 的逃生口形态一致——并在配置树挂载前把解析出的栈发布为 `$DSH_SHELL_BACKEND`(自定义默认条目的可执行文件另发布为 `$DSH_SHELL_DEFAULT_PATH`,供单栈宿主使用)。shell 行的 `disabled` 表达式对称消费该值,因此每台主机恰好挂载一个 shell 栈,提交的设置变更在下一次启动生效。进程内,该插件把解析后的文档暴露为 `shellRegistry` 服务:shell 路由器挂载时经它探测每个条目,session-shell 解析器经它读取宿主默认的唯一来源。

Loader 条目并发启动,这正是组合期链路保持静态求值而非运行时服务门控的原因:由更早行发布的服务会与执行器行的激活发生竞态。本包的 REAL 组合套件通过 Loader 引导整条链(种子文档 → 引导桥 → 旗标对),并钉住两个栈的结果。

Web 客户端通过 `settings.describe` / `settings.update` 访问该命名空间(网关的 `WEB_SETTINGS_NAMESPACES` 允许清单含 `'shell-registry'`),Settings 页编辑的是同一份文档。

沙箱姿态不因任何选择而改变:条目经由已组合栈的既有约束执行,所选 shell 在受限下启动失败时由执行器逐调用报告 `SANDBOX_UNAVAILABLE`。

## Model Experience

### Shell 注册表默认值

#### 模型所见

运行时上下文的 shell 事实按会话生效条目命名真实 shell(例如 `zsh` 及其 POSIX 兼容语法说明),由 `@deepseek-ai/dsh-shell` 的唯一解析器生成;注册表本身不增删任何提示词小节或 schema 字段。

#### Token 效应

除 session-shell 上下文本就贡献的一行钉版本事实外,无其他效应。

#### KV 缓存效应

无;注册表每次启动读取一次,不进入逐轮组装。

## Known Limitations and Deferred Work

- 单栈宿主(无 shell 路由器的 dsh-base 组合)经 `$DSH_SHELL_DEFAULT_PATH` 采用自定义默认条目的可执行文件,但无法按会话切换;切换需要路由器组合。
- win32 ACL 受限令牌沙箱下的 Git Bash 尚未在真实 Windows 硬件上验证(wine CI 无法执行 koffi/ACL 路径);受限 Git Bash 在约束下遭遇 runner 启动失败时逐调用报告 `SANDBOX_UNAVAILABLE`,保留/门控/与全访问配对的决策搭载该结果。
