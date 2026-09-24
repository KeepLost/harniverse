# Harniverse 桌面应用

[English](README.md) | 中文

Electron 外壳展示共用且启用身份认证的 Harniverse Web 应用。业务行为仍由 Host 插件提供。本目录还负责生产打包、离线资源校验、全新安装冒烟检查命令和原生更新事务。

## 生命周期与身份认证参考

外壳保留一个窗口和一个活动连接。启动本地 Host 会在独立的桌面主目录中创建外壳拥有的子进程，使用发行版拥有的可执行 Profile 和依赖闭包。[桌面 Host](../desktop-host/README.md) 组合启用认证的 Web 插件与应用内的 Service Providers；启动不加载用户可执行补丁，也不安装包。连接现有 Host 时接受 HTTPS 或回环 HTTP，并遵循该 Host 的普通注册与批准流程。回环地址（包括 SSH 隧道）不会授予本机进程或文件系统所有权。

本地首次使用通过私有父子进程 IPC 精确批准浏览器的 P-256 公钥。浏览器持久化不可导出的设备密钥，使用共享的签名质询／交换及续期流程；Host 重启时恢复记录中的精确 Grant 关联。撤销或过期需要普通认证恢复。自有 Host 和每个外部源分别使用独立的持久化浏览器分区。[预加载脚本](src/preload-web.ts) 仅暴露经过主框架验证的固定操作，不提供原始 IPC、shell、任意文件系统访问或永久认证绕过。

原生目录选择沿用现有目录选择器能力，仅供自有 Host 使用。外部 Host 保留自己的文件系统与选择器行为。应用不会注册操作系统登录启动；用户登录后自行启动 Harniverse 并选择本地 Host。计划任务仅在该 Host 运行期间执行。关闭窗口会隐藏到保留的托盘／菜单栏图标，会话、终端和计划任务继续运行；Show 可重新打开窗口。注销、重启和显式退出都会停止自有 Host。显式断开连接或退出时，如果自有工作仍在运行或状态未知，会发出警告并提供重试；确认 Host 已停止后，即使退出状态不干净，外壳也可以释放连接。桌面断开连接或退出后，外部 Host 继续运行。

渲染进程恢复期间保留 Host 所有权，直到释放完成。串行连接切换防止自有子进程重叠运行，再次启动应用会打开现有实例。所有权与打包决策的理由见[桌面架构记录](../../.agents/notes/implemented/architecture/2026-09-24-desktop-shell-lifecycle.md)。

## 发行包参考

[package.json](package.json) 固定 Electron 与 electron-builder 的版本，并声明 `com.keeplost.harniverse` 应用标识。主要 CI 矩阵构建 Linux x64 AppImage、Windows x64 NSIS、macOS arm64 DMG，以及各自的解包目录。工具接受其他 x64/arm64 组合，但此矩阵不证明它们具备发行资格。安装包须在目标操作系统上构建，使用兼容的原生依赖和预先准备的 Electron；构建期间可以获取安装器工具。这些命令生成未签名的资格验证产物。当前源码品牌使用同一个 Harniverse 蓝色 H 图案作为原生窗口、托盘以及生成的 PNG、ICO 和 ICNS 图标，Electron 默认图标已固定到这一资源系列；品牌化 Linux x64 产物已通过本地资格验证。macOS 保留 Electron 原有的可执行文件签名，验证 runAsNode fuse 而不改写它。发布者签名和公证需要单独的发行门禁，并校验最终签名运行时的资源清单。

组装器读取已构建、按冻结锁文件安装依赖的工作区，复制桌面入口、预加载脚本、渲染资源、`apps/desktop-host/lib/index.js`、CLI 配置、Web `dist`，以及已安装的生产依赖和 peer 依赖闭包。工作区发布清单选择构建产物和许可证；第三方 JavaScript、原生载荷和辅助可执行文件予以保留。pnpm 链接转为物理文件，版本冲突转为嵌套依赖，兼容的依赖环通过祖先包解析，无法用无链接布局表达的循环版本冲突明确报错。输出可迁移，不依赖工作区或包存储目录。构建和依赖准备在组装前完成，可以访问软件仓库；组装与启动不会安装依赖。

`packaging-assembly.ts` 生成 `runtime-input.json` 和 `assembly.json`，记录目标、锁文件 SHA-256、解析后的包版本以及必需的入口和原生文件路径。所有运行时路径相对于输出根目录。生成的启动契约如下：

```json
{
  "schemaVersion": 1,
  "platform": "linux",
  "arch": "x64",
  "startup": {
    "shell": "lib/entry.js",
    "host": "lib/desktop-host.js",
    "web": "web/index.html"
  },
  "browser": {
    "executable": "browser/chrome",
    "version": "149.0.7827.55",
    "revision": "1228",
    "playwrightVersion": "1.61.1"
  },
  "requiredFiles": ["lib/preload.cjs", "renderer/index.html"]
}
```

上面的 browser 对象展示 Linux x64 的生成形态；组装器会将目标平台的 Chrome for Testing 可执行文件路径，以及固定的 Playwright、Chromium revision 和浏览器版本写入 `runtime-input.json` 与 `offline-assets.json`。当前固定载荷为 Playwright 1.61.1、Chromium revision 1228、Chrome for Testing 149.0.7827.55。暂存通过私有临时目录写入 `<output-dir>/<platform>-<arch>/app`，拒绝覆盖已有暂存结果。`offline-assets.json` 记录每个文件的大小、权限和 SHA-256、启动路径、浏览器元数据、目标、应用标识和包管理器完整入口。检查会拒绝缺失、变更、重复、未列出或禁止携带的资源、越界链接、缺失的已声明生产依赖，以及启动入口和相对导入中明显依赖系统命令或包安装的代码。导出检查选择 Node import/require 条件，排除源代码和类型入口；通配导出表示可能存在的子路径，不是必需文件。静态检查不能证明原生 ABI 或动态导入兼容性；可执行资格检查和应用冒烟测试提供运行时证据。

运行时文件策略保留依赖中的 JavaScript、`node_modules`、许可证、原生库、预构建二进制和辅助可执行文件，排除应用源代码、测试、调试映射、类型声明、名为 `.env` 的秘密文件，以及上游桌面产品、Office、市场、插件管理器、browser-use、computer-use 和更新源资源。组装按操作系统和 CPU 选择兼容的可选包，并检查原生机器头；Linux 发行使用 glibc。组装前应准备目标平台的原生依赖。`afterPack` 钩子在 electron-builder 完成依赖过滤后，将完整封存目录复制为物理资源，保留辅助文件与权限，再次校验清单。

工作区组装必须通过 `--pnpm-dir` 提供完整的 pnpm **11.7.0** 包，包含 `bin` 和 `dist`，并记录完整入口 `node_modules/pnpm/bin/pnpm.mjs`。核心启动使用 Electron 内置 Node，不调用系统 Node、pnpm、Corepack 或网络安装。消费者执行可选包操作时，以 `ELECTRON_RUN_AS_NODE=1` 模式调用 Electron 和该完整入口。底层预组装输入检查器仍可表示包管理器不可用，但生产组装器拒绝缺失或版本不符的载荷。

Git 操作需要安装 Git；Python 执行需要兼容的 Python。核心桌面启动不依赖这两者。生产组装器要求固定 Playwright 包提供完整的目标平台浏览器载荷，包括 Chrome for Testing；载荷缺失或操作系统／CPU 不匹配时会在发布前失败。打包 Profile 从 `offline-assets.json` 锚定浏览器路径，验证它仍位于发行目录内，并在 Host 启动前将现有 `browser-controller` Provider 的 `executablePath` 设置为该文件，同时使用 `sandbox: 'auto'`。Electron 外壳窗口不能满足 Session 绑定的 CDP 浏览器依赖。

## 命令教程

这些开发命令要求 Node 24 或更高版本。先按冻结锁文件安装依赖并构建工作区、桌面外壳、桌面 Host 和 Web 前端。在目标平台的原生 runner 上显式准备固定版本的 Electron 和浏览器下载；此命令只下载／准备构建输入，不组装或打包应用：

```sh
node apps/desktop/scripts/packaging-ci.ts --provision-electron --provision-browser
pnpm run build
pnpm run build:desktop
node apps/desktop/scripts/packaging.ts prepare --output-dir /absolute/stage --pnpm-dir /absolute/pnpm-11.7.0 --platform linux --arch x64
node apps/desktop/scripts/packaging.ts check --output-dir /absolute/stage --platform linux --arch x64 --electron-dist /absolute/electron-linux-x64
node apps/desktop/scripts/packaging-native.ts --app-dir /absolute/stage/linux-x64/app --executable /absolute/electron-linux-x64/electron
node apps/desktop/scripts/packaging.ts package --output-dir /absolute/stage --platform linux --arch x64 --format AppImage --electron-dist /absolute/electron-linux-x64
```

`prepare` 默认组装当前工作区；`--workspace` 选择另一已构建检出，`--runtime-dir` 选择已组装输入。需要可复用输入时，运行 `node apps/desktop/scripts/packaging-assembly.ts --output-dir /absolute/new-runtime --pnpm-dir /absolute/pnpm-11.7.0`；输出目录必须不存在，父目录必须存在。`--stage-dir` 选择用于检查或打包的已有暂存目录。`--electron-dist` 指向包含可执行文件和固定版本 `version` 文件的解压目录。`check` 和 `--check-only` 只读且不下载任何内容。缺少 Electron、Playwright 或浏览器资源时，命令给出修正信息并以非零状态退出。打包使用 `--publish never`，不配置更新源。

安装包构建成功后，会在 AppImage、NSIS 可执行文件或 DMG 旁写入 `<artifact>.manifest.json`。其中包含 `schemaVersion: 1`、`product: "dsh-harniverse"`、`appId: "com.keeplost.harniverse"`、应用版本、Node 平台名称、架构、精确产物文件名与最终 SHA-256。本地更新器要求两个文件保存在一起。校验和证明字节完整性，不能证明发布者身份。

跨平台 CI 驱动命令为 `node apps/desktop/scripts/packaging-ci.ts --output-dir /absolute/fresh-output [--pnpm-dir /absolute/pnpm-install]`。它从 pnpm/Corepack 命令位置或明确提供的 pnpm/action-setup 目录定位固定版本的完整包，要求固定 Playwright Chromium 载荷，组装并打包原生安装器，验证最终可执行文件，执行认证 Host/CDP 与全新安装冒烟，生成保留权限的 `*-unpacked.tar` 和 `qualification.json`。Linux 使用独立 Xvfb 显示，Windows CI 使用原生 PowerShell。`--check-only` 只读前置条件，不下载或构建；`--verify-only` 检查已有打包输出。显式 `--provision-electron --provision-browser` 为原生 runner 准备已安装 Electron 包和 Playwright Chromium；这些是明确的构建下载，不配置更新源。三个桌面作业均阻塞 `all checks passed`，仅在资格验证成功后上传产物。

原生资格检查使用全新的主目录和空 `PATH`：验证 Electron 版本、架构与 runAsNode fuse，执行 Koffi 原生调用、sharp/libvips 图像编码和 SQLite，通过 node-pty 启动 Electron，经控制通道执行 PTC 子进程程序，并运行捆绑 pnpm 的版本命令。`package` 在 electron-builder 前执行此门禁。最终打包后应对其可执行文件再次运行检查，验证 fuse 和复制后的原生载荷。`--check-only` 仅检查前置条件，不执行原生代码，也不能证明 ABI 兼容性。原生失败需要重建或准备匹配目标的载荷，再组装新的暂存目录。

对完成的目录构建执行全新安装冒烟检查：

```sh
node apps/desktop/scripts/packaging-smoke.ts --app-dir /absolute/unpacked/resources/app --executable /absolute/unpacked/harniverse --check-only
node apps/desktop/scripts/packaging-smoke.ts --app-dir /absolute/unpacked/resources/app --executable /absolute/unpacked/harniverse
```

macOS 的应用目录位于 `Harniverse.app/Contents/Resources/app`，Windows 使用打包后的 `.exe`。只检查模式验证资源和可执行文件是否存在，不启动应用。实际冒烟运行使用全新的主目录和用户配置目录，排除提供方凭证，清空 `PATH`，并传入 `--harniverse-clean-install-smoke`。应用须在本地启动并完成身份认证、等待自有 Host 退出后，向 `HARNIVERSE_DESKTOP_SMOKE_REPORT` 指定的位置写入 JSON 回执，再于 120 秒内成功退出。回执要求 `schemaVersion: 1`，`offlineAssetsLoaded`、`authenticated`、`ownedHostStopped` 为 true，`systemNodeUsed`、`systemPackageManagerUsed`、`networkInstallUsed` 为 false；证据必须标识资源清单的 SHA-256 与固定的 Electron 版本。不支持此回执协议的发行包会检查失败。运行器在失败时终止自己创建的进程组，并移除临时配置目录。无显示器的 Linux 使用 `xvfb-run -a`；`--no-sandbox` 仅供明确以 Linux root 运行的冒烟检查。此冒烟检查不能替代各目标平台上的安装升级、签名、系统集成和原生 ABI 测试。

最终品牌化本地 Linux x64 AppImage 与解包目录产物通过了认证 Host／CDP 浏览器检查、空命令路径的全新安装冒烟和原生资格检查。其资源清单 SHA-256 为 `0acb0a809a1433abc933c47862604401b2c911cb68548654fd4204c86db7518f`。浏览器产生了 12,079 字节 JPEG 帧，标题正确、一次本地请求、关闭后零页面且确认退出状态为 0。全新安装回执还记录了认证前 401、签名交换、插件引导、UI 渲染、Session 列表、重启后复用设备密钥、Host 存活时关闭／隐藏、重开和两次确认 Host 关闭。

Linux x64 和 macOS arm64 桌面 CI 作业已完整通过。Windows 是剩余的平台资格缺口：桌面资格检查在等待 Host-ready 120 秒后失败，完整原生 Windows 作业在删除陈旧租约所有者文件时因 `EPERM` 失败。这些修正必须由新的 Windows CI 运行验证；[桌面架构记录](../../.agents/notes/implemented/architecture/2026-09-24-desktop-shell-lifecycle.md#consequences)保留运行与本地回归证据。发行签名和公证仍是独立的发行门禁。

## 更新与恢复参考

打包应用中的原生 **Install update…** 菜单选择本地发行产物及其相邻的 `<artifact>.manifest.json`。更新器验证 Harniverse 产品／应用标识、严格递增的版本、匹配的操作系统／CPU、精确文件名与 SHA-256，在请求同意前将验证后的字节暂存于私有目录。manifest（元数据清单）的校验和用于验证完整性，不能证明发布者身份；应选择可信来源的发行产物。不提供更新源或自动下载，渲染进程不能指定安装器路径或命令。

同意后，自有 Host 必须报告会话与任务均为空闲。更新器依次检查活动、锁定新准入、再次检查，再等待 Host 确认关闭并成功退出后安装。活动计划任务必须暂停或完成。工作活跃或状态未知、加锁失败、关闭未成功都会阻止安装。外部连接仅断开，不停止或更新其 Host。[事务控制器](src/update.ts) 在副作用执行前原子持久化[日志](src/update-journal.ts)，并保留失败信息用于恢复。

对于当前运行且可写的 Linux AppImage，替换流程保留并验证旧可执行文件，原子替换目标，然后重新启动。安装失败只能恢复本次事务验证过的旧字节，拒绝覆盖无关替换文件。启动恢复可从原路径或验证过的保留可执行文件恢复中断的便携更新。无法原地替换时，单独启动所选 AppImage，当前安装继续保留。Windows NSIS 与 macOS DMG 更新交给原生安装器或 Finder；按其提示完成操作后再启动 Harniverse。这些原生交接不支持自动回滚安装器的变更。

恢复会重放日志并拒绝不一致的元数据。安装前操作中断需要重新同意。以预期的新应用版本启动会记录完成；这是版本启动检查，不是完整的运行时健康验证。保留的 AppImage 仍然可用。恢复绝不控制独立拥有的 Host；恢复失败会禁用本次启动的更新功能，并保留日志与旧可执行文件。

## 本地验证

```sh
node --test apps/desktop/tests/packaging*.test.ts
node node_modules/typescript/bin/tsc -p apps/desktop/tsconfig.packaging.json
node --check apps/desktop/scripts/packaging-after-pack.cjs
```

这些测试和语法检查不需要 Electron 可执行文件、图形会话、提供方或网络访问。快照回归使用 Node，通过记录的文件 URL，从包含 `#` 和 `%` 的临时路径真实导入生成的观察插件。这些检查不会生成安装包，也不能证明二进制打包成功。
