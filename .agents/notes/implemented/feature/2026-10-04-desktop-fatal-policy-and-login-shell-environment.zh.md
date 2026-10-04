# Agent Note：桌面致命失败策略与登录 shell 环境 —— 崩溃报告、首错对话框、继承完整环境的 Host、打包 DevTools

Status: implemented

English | [中文](2026-10-04-desktop-fatal-policy-and-login-shell-environment.md)

范围：`apps/desktop`（`src/login-shell-environment.ts`、`src/duration-env.ts`、`src/node-environment.ts`、`src/crash-report.ts`、`src/fatal-recovery.ts`、`src/entry.ts`、`src/main.ts`、`src/owned-host.ts`、`src/locale.ts`）

## 问题

官方同步 639ed01539 的 R17/R18/R25/R26 行：上游为它的桌面产品加固了面向 GUI 启动的登录 shell 环境导入、带原生致命恢复对话框的崩溃报告文件，以及主窗口的打包 DevTools。Harniverse 的桌面持有不同的外壳生命周期——单窗口、托盘持有的后台存续、入口进程拥有的退出、没有插件管理器——因此每项能力都必须落到我们自己的契约上，而不是照抄。

## 决策

- **启动时读取一次登录 shell 环境**（`login-shell-environment.ts`）。POSIX GUI 启动只继承会话管理器的环境，因此 `entry.ts` 在启动时发起恰好一次读取，并把该 promise 交给外壳；`will-quit` 会中止它（未取得实例锁的二次启动因此在退出前经由同一钩子中止自己的探测）。候选依次是账户记录中的登录 shell（而非 `$SHELL`）、`/bin/zsh`、`/bin/bash`、`/bin/sh`；每个候选以交互式登录 shell（`-ilc`）运行，其 rc 文件在两个标记之间输出 NUL 分隔的 `env` 转储，stdin 关闭（提示符读到 EOF），并设置探测防护变量（`DISABLE_AUTO_UPDATE`、`ZSH_TMUX_AUTOSTARTED`、`ZSH_TMUX_AUTOSTART`），避免 oh-my-zsh 更新提示与 tmux 自启阻塞无终端的读取。读取在收尾标记处完成——rc 启动的后台子进程可能在 shell 退出后仍占着 stdout。shell 值叠加于继承环境之上，但跳过探测会话自身的键（`PWD`、`OLDPWD`、`SHLVL`、`_` 与防护变量）以及启动器持有的 `DSH_*`/`ELECTRON_*` 名称：Desktop 在读取前已解析 `DSH_HOME` 等路径，Host 因此保持继承值。该 promise 绝不 reject——每个失败的候选都记录日志并返回继承环境。每个候选以 `DSH_DESKTOP_LOGIN_SHELL_TIMEOUT_MS` 为限（默认 10000 毫秒；共享的 `duration-env.ts` 读取器接受 1000–2147483647 的整数）；超时或中止会杀死探测所在的独立进程组。`win32` 原样返回继承环境——那里的 GUI 启动本就继承注册表环境。
- **自有 Host 继承用户的真实环境。** `connectNow` 在创建 Host 前等待这次共享读取，`owned-host.ts` 以合并环境加 `ELECTRON_RUN_AS_NODE=1` 启动它（`node-environment.ts`）。旧的大写字母白名单 `launchEnvironment` 已删除：用户的 `HTTP_PROXY`/`HTTPS_PROXY` 与 `SSH_AUTH_SOCK` 现在能到达 Host 及其全权限 shell——Host 本就以用户身份执行，藏起用户自己的登录变量换不来任何隔离。
- **对话框之前先写崩溃报告**（`crash-report.ts`）。每次致命失败写一个仅所有者的本地文件，位于 Electron 日志目录；`launchDesktopShell` 在 ready 之前经 `app.setAppLogsPath()` 设置平台惯用路径，使第一份报告即落在其下，`start()` 会清理旧报告。文件为 `0o700` 目录中的 `0o600` 文件，命名为 `crash-<可排序时间>-<来源>.log`，保留最新 10 份；清理只触碰与该语法精确匹配的文件名。内容：事实头（时间、来源、按 Host 就绪划分的 `startup`/`running` 阶段、应用/平台/Electron/Node/区域、shell pid）、经 inspect 的错误及其可枚举属性与 cause 链（有界分段），以及渲染进程 error 级控制台尾部（64 KiB，先整行丢弃最旧行，单条超长行保持完整）。写入失败记录日志并退化为无路径对话框——诊断辅助绝不阻塞恢复。
- **首错原生恢复**（`fatal-recovery.ts`）。先等待崩溃报告（以 1 秒为界）以便对话框标明文件；对话框提供「退出／重启」（默认重启），显示错误尾部并附截断提示，恢复操作自身失败时循环重问。`EADDRINUSE` 使用专门文案（退出占用进程后重启）。报告去重：第一个致命失败持有对话框，后续报告立即返回；恢复驱动的停机期间不弹对话框，但报告仍会持久化。
- **致命来源与对上游的有意偏离。** 来源为 `host`（自有 Host 启动失败或死亡，包括未确认即退出）、`renderer`（主框架 `did-fail-load`，忽略被取代加载的 `-3` 中止导航，以及 `render-process-gone`）与 `main`（外壳启动失败——只写报告：`launchDesktopShell` 写报告后重新抛出，`entry.ts` 以退出码 1 退出；窗口与托盘存在之前对话框无法接管结局，因此上游的启动失败对话框被「持久化报告 + 入口退出」取代）。上游另有 `web-boot` 致命来源与「禁用插件」对话框按钮；两者均被有意省略——本桌面没有插件管理器，插件状态在 Host 一侧，既不存在 web-boot 边界，无主可属的按钮只会是死界面。
- **主窗口的打包 DevTools。** `BrowserWindow` 设 `devTools: true`，外加两个隐藏的 `toggleDevTools` 菜单角色（一个保留角色的平台快捷键，一个固定 F12）：打包后的渲染进程无需可见菜单项即可检查，托盘菜单不含它们。`win32` 仅以这两个隐藏角色替换可见的应用菜单——托盘已在那里持有外壳界面；其他平台保留可见的 Harniverse 菜单并追加隐藏角色。
- `locale.ts` 新增致命对话框文案（致命摘要、启动失败标题、EADDRINUSE 建议、截断提示、报告路径、重装建议、恢复操作重试、退出/重启），并删除已死的 `recoveryUnavailable`/`windowRecoveryUnavailable`/`stateWindowStopped` 键。

## 备选方案

**每次 Host 启动时各导入一次登录环境。** 否决：rc 文件有副作用（更新检查、会话横幅）；每次应用运行读取一次，使每次启动看到同一视图，且这些副作用只付一次。

**保留大写字母白名单启动环境。** 否决：白名单静默丢弃用户的代理与 agent 变量——而这正是桌面启动的全权限 shell 本该继承的变量。

**照抄上游的 `web-boot` 致命来源与「禁用插件」按钮。** 否决：本桌面没有插件管理器；不存在 web-boot 进程边界，按钮也没有可禁用的对象。

**外壳启动失败时弹致命对话框。** 被「入口 `exit(1)` 并持久化报告」取代：窗口与托盘存在之前，没有任何界面能承载对话框循环，而入口的退出本就是结局。

## 后果

桌面启动的 Host 现在看到用户真实的登录环境（代理、agent 套接字、语言设置），而不是会话管理器的残缺环境；每次致命失败都会在任何用户交互之前留下完整、仅所有者可读的诊断。代价是：每次启动一个有界探测子进程，以及完整用户环境到达 Host——这与用户亲自运行 Host 的信任相同，自有 Host 模型本就如此假设。隐藏的 DevTools 角色让打包诊断可达，又不宣传开发者界面。

## 验证

- `apps/desktop/tests/login-shell-environment.spec.ts`：配置默认值与覆盖、候选顺序（账户记录不可读时只用固定 shell）、分隔符解析、合并规则（排除探测会话与启动器持有的名称）、win32 透传、POSIX 探测合并 rc 导出并忽略其他输出、逐候选失败记录并尝试下一个、rc 启动的子进程占用 stdout 时在收尾标记处完成、超时连同后台子进程结束 shell、中止结束运行中的 shell 进程组并跳过其余候选。
- `apps/desktop/tests/duration-env.spec.ts`：毫秒环境变量边界；`node-environment.spec.ts`：以给定环境进入 Node 模式并压制恶意的 `ELECTRON_RUN_AS_NODE` 值。
- `apps/desktop/tests/crash-report.spec.ts`：可排序命名、事实/错误/控制台渲染与缺失说明、分段边界、`0o600` 写入拒绝覆盖既有名称、目录创建与写失败降级、保留数清理（仅匹配名称）及其失败报告、永不切断单行的有界控制台尾部。
- `apps/desktop/tests/fatal-recovery.spec.ts`：对话框之前持久化报告并在详情中标明、带截断提示的尾部缩短、短错误完整显示、尾部截断的代理对安全处理、EADDRINUSE 专属文案保留报告行、重启经 stop 执行且 stop 失败时重弹对话框、退出路径在 stop 失败时仍退出、重复报告立即返回不再弹窗、报告写入慢或失败仍打开对话框。
- `apps/desktop/tests/main.spec.ts` / `owned-host.spec.ts`：渲染进程崩溃与自有 Host 失败经原生对话框上抛并写入报告、无法启动的 Host 按启动阶段报告、创建自有 Host 前等待共享登录 shell 读取、隐藏 DevTools 菜单角色不进托盘（win32 仅隐藏角色的应用菜单）、自有 Host 以给定环境在 Node 模式启动。
- 三个操作系统上的打包资格验证仍由 CI 桌面作业负责。
