# Agent Note: 插件导出

Status: implemented

[English](2026-10-11-plugin-export.md) | 中文

## 问题

Profile 可以安装插件（`dsh plugin --profile <name> add <spec>`，一个薄的 pnpm 转发器），却没有反向操作：只存在于本地检出（`link:`/`file:` spec）或安装副本里的插件，无法交给另一个实例、一台离线主机、或一个跑不了原始 git `prepare`（pnpm ≥10 在加白之前会拦截）的用户。导出能力需要决定打包逻辑放在哪里、由哪个 surface 提供、以及用哪个 capability 授权。

## 决策

**共享核心在 `dsh-app-boot`**（`plugin-export.ts`）：`classifyDependencySpec` 把 profile 依赖的 spec 分为文件系统类（`link:`/`file:`/裸路径）与远程类（registry/git/tarball）；`resolvePluginExportSource` 优先使用 spec 指向的仍然存在的本地源码目录，否则回退到 profile 下的安装副本（`node_modules` 查找以 profile 清单为锚点——绝不用安装锚点，因为被导出的按定义就是 profile 依赖）；`packPluginTarball` 以与 `dsh plugin` 转发器相同的 Windows shell 姿态运行 `pnpm pack --pack-destination`，并从 pnpm 打印的路径解析产物。放在 app-boot 是因为它已经拥有 profile、清单与 bundle 解析，且两个 surface 需要完全一致的来源语义。

**CLI**（`apps/cli/src/plugin.ts`）：`dsh plugin --profile X export <name> [--out <dir>]` 在 pnpm 转发之前被拦截（pnpm 没有打包某个依赖的动词）；它打印 tarball 路径和一行来源说明，并拒绝不存在的 `--out` 目录。`dsh plugin export-manifest [--out <file>]` 打印 profile 的重放清单（bundle 层 + 全部依赖 spec）。重装走既有转发器路径：`dsh plugin --profile Y add <tarball>`。

**宿主下载归入 apiproxy 的 downloads 域**，镜像 `session.export`：`plugin-export.ts` 从 Loader 的 `baseUrl` 锚点推导 profile 目录，在进程临时目录中打包，强制 `pluginExportMaxBytes` 上限（默认 128 MiB，在任何字节送出之前检查），并以 `content-disposition` 流式返回 tarball；临时目录在响应体结束或请求中止时删除。载体以 `pluginExportQuerySchema` 只放行恰好一个 npm 形状的名字，应答 `GET/HEAD /api/plugin.export?package=<name>`。错误响应绝不回显宿主机路径。

**Capability 为 `harniverse.administer`**：导出虽是对宿主内容的读取，但在网络层面是一条外流通道，因此与其它宿主内容搬运（`agentPreset.read`、`skin-library importPack`）同层，而不是挂在 `harniverse.observe` 下。capability 集合是封闭的（`typert-loader` 的 `isSupportedCapability`）；发明 `harniverse.plugin.export` 不在选项之内。

**Web UI**：插件列表 Settings 页的注入面新增 `exportPlugin(moduleName)`；apply 闭包先对下载 URL 做 HEAD 预检，再交给浏览器下载管理器（session-export 控制器的模式），展开的清单行按模块名发布 busy/done/error 进度。

## 备选方案

**typert Remote 在线缆信封里返回 base64。** 需要为新包走完整的 typert 代码生成链，整包 tarball 缓冲在内存，而相比 `session.export` 已确立的无信封下载通道毫无收益。

**新建 `packages/host/plugin-export` 包。** downloads 域就是宿主侧下载的既定接缝；为一个本属载体职责的方法新增包，只会多出一条组合行和一个 wire surface。

**专用 `harniverse.plugin.export` capability。** capability 联合类型按设计是封闭的；administer 层已经覆盖为分发而打包宿主内容的行为。

**导出内置 bundle。** 它们来自安装而非 profile 清单；该 surface 对它们有意回答 404，而不是重新分发产品代码。

## 后果

导出来源是显式的：`link:`/`file:` spec 且源码仍存在时打包检出目录（其 `prepack` 在与 `pnpm add` 相同的信任级别下运行）；其余打包安装副本，并且 CLI 会说明是哪种。tarball 可以安装到转发器已接受的任何地方，包括无网络访问或没有原始 git 构建加白的主机。验证：`packages/boot/app-boot/tests/plugin-export.spec.ts`（分类、解析、伪 spawner 打包路径）、`apps/cli/tests/plugin-export.spec.ts`（参数守卫、真实 pnpm 打包、分发拦截、清单两种形态）、`packages/host/apiproxy/tests/plugin-export.spec.ts`（路由、守卫、上限、失败模式、含中止在内的临时目录清理）、`packages/client/ui-settings-plugin-inventory` 规格（按钮流程、预检 + 浏览器下载）、以及 `rpc-map.spec.ts`（capability 行）。`docs/api-catalog.json` 经 `gen-api-catalog` 新增了载体行。
