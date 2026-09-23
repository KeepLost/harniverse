# Agent Note: 桌面外壳的所有权与浏览器认证生命周期

Status: implemented

[English](2026-09-24-desktop-shell-lifecycle.md) | 中文

## Problem

桌面窗口为 Web 应用增加了本机进程和文件系统权限。回环连接也可能是 SSH 隧道，因此地址不能证明本地所有权。当界面和 Host 生命周期共用隐式释放路径时，关闭窗口可能中断正在运行的会话。

## Decision

[Electron 外壳](../../../../apps/desktop/src/main.ts)拥有一个窗口和一个活动连接。本地连接仅拥有发行版控制的 Host 工厂返回的子进程。`existingHost` 连接接受 HTTPS 或回环 HTTP，并将进程、凭据和工作区路径保留在所连接的 Host 上。渲染进程请求不能选择可执行文件、配置文件或包管理器命令。

窗口加载共享 Web 入口。沙箱中的[预加载脚本](../../../../apps/desktop/src/preload-web.ts)创建或复用已持久化的不可导出 P-256 浏览器密钥，仅通过自有子进程的私有注册通道发送公钥。Host 记录精确的密钥、注册和 Grant 关联；后续启动恢复该关联并重新检查实时 Grant。撤销、过期或认证不可用都不能重新创建权限。共享的[浏览器认证生命周期](2026-09-08-browser-authentication-lifecycle.md)负责签名会话交换、续期、撤销和恢复。自有 Host 使用稳定回环源及持久化浏览器分区，与每个外部源分别隔离。已消费的引导不能批准另一个密钥；现有 Host 使用普通浏览器注册。引导不会通过渲染进程桥提供永久绕过或持有者凭据。

上下文桥仅暴露固定操作，不包含原始 IPC 对象。主进程检查自有 WebContents、精确的主框架身份和当前文档权限。启动页必须匹配精确的文件 URL；所连接的应用必须匹配其 HTTP 源及非继承来源的文档 URL。跨源导航、弹出窗口、webview、权限请求和自动下载均被拒绝。

现有[目录选择器能力](2026-07-28-directory-picker-capability-seam.md)将工作区接纳保留在共享客户端。本地 Host 的 Service Provider 请求自有外壳显示对话框，并接收有类型的选择结果或取消结果。渲染进程选择操作不接受路径参数，外部连接不能使用外壳的本地选择器。存续时间超出所属连接的选择结果会被丢弃。

持续保留的托盘或菜单栏图标为隐藏窗口提供可见的返回入口。应用不会注册操作系统登录启动；用户登录后自行启动应用并选择本地 Host。计划任务仅在该 Host 运行期间执行。关闭窗口会隐藏窗口，并让工作继续。注销、重启和显式退出都会停止自有 Host。显式断开连接或退出会观察 Host 活动；工作进行中或观察信息不可用时发出警告并提供重试路径，取消操作保持 Host 连接。确认自有 Host 已停止后，即使退出状态不干净，外壳也可以释放连接。更新仍要求更严格的获确认零状态退出。外部 Host 在外壳退出后继续运行。

渲染进程崩溃时返回连接页，不终止 Host。子进程故障返回不含凭据的恢复消息，并在释放完成前保留进程所有权。串行连接切换防止两个自有子进程重叠运行，应用实例锁将后续启动引导至同一窗口。产品标识为 `dsh-harniverse`，应用 id 为 `com.keeplost.harniverse`。

[桌面 Host](../../../../apps/desktop-host/README.md) 在独立主目录和可释放的 Loader 根目录中组合发行版的认证 Web 组合包。应用内 Service Providers 实现 HTTP 准入和原生目录选择；控制 Consumer 观察现有认证、会话、终端和计划任务服务。可执行依赖归应用闭包所有，用户 Profile 补丁或运行时包安装均不能改变它。桌面不会静默接管 CLI（命令行界面）主目录、凭据或包管理器状态。Electron 内嵌 Node 运行自有 Host 和 W09 [PTC Provider 引导](2026-09-23-ptc-runtime-naming-and-bootstrap.md)。生产组装携带完整的固定 Playwright 1.61.1 Chromium 载荷：Chromium revision 1228／Chrome for Testing 149.0.7827.55。`runtime-input.json` 和 `offline-assets.json` 要求浏览器可执行文件、版本、revision 和 Playwright 版本；打包 Profile 在启动前验证锚定路径，并使用 `sandbox: 'auto'` 将该路径设置给现有 browser-controller Provider。当前源码品牌使用同一个 Harniverse 蓝色 H 图案作为原生窗口、托盘以及生成的 PNG、ICO 和 ICNS 图标，Electron 默认图标已固定到这一资源系列。

外壳、Host 运行时和包管理器构成一个更新单元。原生 **Install update…** 菜单选择本地产物及相邻 `.manifest.json`；明确同意前验证标识、更高版本、操作系统／CPU、文件名和 SHA-256。摘要证明字节完整性，不证明发布者身份。没有配置远程更新源。[更新事务](../../../../apps/desktop/src/update.ts) 先检查自有工作、锁定准入、再次检查，安装前要求工作空闲且关闭获确认并成功退出。活动计划任务必须暂停或完成。外部连接仅断开，绝不停止或更新其 Host。

主进程在副作用前原子持久化日志。当前运行且可写的 AppImage 先保留并验证旧可执行文件，再原子替换并重新启动；恢复只覆盖本次事务拥有的候选文件。其他 Linux 启动方式保留当前安装，单独打开所选 AppImage。Windows NSIS 与 macOS DMG 交给原生安装流程，不支持自动回滚安装器的变更。启动恢复重放经过验证的记录，安装前中断要求重新同意，预期应用版本启动时记录完成。这是版本启动检查，不是完整运行时健康检查。恢复无效时禁用本次启动的更新功能并保留恢复文件。

## Alternatives considered

独立的桌面业务界面会重复插件组合和认证行为。加载共享 Web 入口将这些能力保留在现有所有者之下。

通过地址判断文件系统是否位于本机会误判回环隧道。明确的子进程所有权为本机原生选择器和进程关闭提供所需权限。

无条件关闭即退出会中断后台工作，而不可见的后台运行会移除用户的返回入口。持续保留的托盘和显式感知活动的退出操作兼顾工作连续性与用户控制。

修改共享 CLI Profile 或向桌面安装可执行插件会让多个所有者控制同一应用闭包。独立 Profile 和整单元更新保持运行时可复现。将 manifest（元数据清单）校验和视为发布者认证，或承诺自动回滚原生安装器，都超出了机制的保证；本地选择和明确同意让这些限制可见。

## Consequences

外壳保留较小的本机信任边界，并依赖 Host 的实际退出和认证注册约定。其浏览器设备适配器共享 Web 客户端的持久化格式，因此修改该辅助函数时需要联合验证桌面引导与 Web 认证入口。

聚焦的[生命周期](../../../../apps/desktop/tests/main.spec.ts)、[IPC](../../../../apps/desktop/tests/ipc.spec.ts)和[预加载](../../../../apps/desktop/tests/preload.spec.ts)测试在 Electron 模块边界替换实现，无需模型提供方即可验证所有权、拒绝行为、崩溃恢复和关闭完成。最终品牌化 Linux x64 AppImage 与解包目录产物已经通过真实 Electron Host 认证和 CDP 浏览器验证，资源清单 SHA-256 为 `0acb0a809a1433abc933c47862604401b2c911cb68548654fd4204c86db7518f`：12,079 字节 JPEG 帧、正确标题、一次本地请求、关闭后零页面以及确认退出状态 0。同一资格检查还通过了未认证 401、签名交换、插件引导、UI 渲染、Session 列表、重启后复用设备密钥、Host 存活时关闭／隐藏、重开、两次确认 Host 关闭和空命令路径运行。原生资格检查通过 Electron 43.4.0、内嵌 Node 24.18.1、Koffi、sharp、PTY、PTC、SQLite 和 pnpm 11.7.0，资源清单无错误或警告。Windows 和 macOS 已安装产物、对应 CI 门禁及发行签名仍是独立资格门禁。

最低发行验证矩阵为 Linux x64、Windows x64 和 macOS arm64。其他声明的 CPU 目标在验证前不作支持承诺。品牌化 Linux x64 含浏览器载荷的产物资格已在本地完成；Windows／macOS 产物资格和三操作系统 CI 验证仍在进行。Electron UI 本身不提供 Session 绑定的 Host-CDP 浏览器；打包 Chromium 载荷是单独要求的运行时资源。发行签名／公证（包括公开安装器的 Windows EV 签名）属于公开发行门禁，不阻止源码实现或本地产物验证。
