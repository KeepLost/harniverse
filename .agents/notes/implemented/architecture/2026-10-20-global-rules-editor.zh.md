# Agent Note: 基于 apiproxy wire 的第一方全局规则编辑器

Status: implemented

中文 | [English](2026-10-20-global-rules-editor.md)

## Problem

harness 主目录下的 `AGENTS.md` —— 每个会话都会加载的 `user-global` 指令作用域 —— 此前没有第一方编辑入口：编辑意味着开 shell 和文本编辑器；社区插件 `dsh-global-rules`（上游 DSH、第三方）证明了需求，但它依赖 Harniverse 并未提供的插件兼容 fetch 面，只镜像了主目录解析的 `$DSH_HOME` 一级（与加载器的“配置优先于环境变量”存在漂移风险），并在第一方设置契约之外自带手写 UI。Harniverse 要的是按标准能力缝（Service Definition、Provider、Consumer 三角色）构建的第一方能力。

## Decision

沿三条标准缝落地：

- **Service Definition + Provider** —— `packages/context/global-rules` 默认导出 `GlobalRulesService extends Service`（`ctx.globalRules`）。主目录解析复用 `resolveDshHome(config.dshHome)`（与加载器完全一致的优先级：配置优先于 `$DSH_HOME` 优先于 `~/.dsh`）；写入上限默认等于加载器的单文件源上限（1 MiB），保证编辑器接受的内容恰好是加载器能读取的内容；展示路径经 `dshHomeDisplay` 符号化，绝对路径绝不离开宿主。新鲜度令牌是内容本身的 sha256 前缀 —— 冲突检测比较的是内容同一性而非写入历史，写入成功后也无需回读 stat。
- **Wire** —— 共享 `/api` 载体上的两个 unary 端点：`globalRules.read`（`harniverse.observe`）与 `globalRules.write`（`harniverse.operate`：该文件左右每个会话的模型可见基线），端到端复刻 `speech.*` 先例：`apiproxy/src/api/` 的契约 + zod schema、`rpc-map.ts` 三处登记、`fetch/handler.ts` 分发、`fetch/client.ts` 的 `IApiClient` 与值 schema、`ApiProxy.globalRules` 适配层（把服务结果映射为稳定错误码 `global-rules-unavailable` / `-conflict` / `-too-large` / `-read-failed` / `-write-failed`）、连接 fixture 分支，以及重新生成的 `docs/api-catalog.json`。不新增传输面、不引入插件 fetch 注册表、也不建设置命名空间 —— 文件本身就是持久状态，设置命名空间的镜像只会制造第二事实源。
- **Consumer** —— `packages/client/ui-settings-global-rules` 以标准四份额 props 注册 `settings.section` 条目（id `global-rules`，order 12）及 `settings.nav.icon` 图标。分区按宿主上报的上限做字节计数（TextEncoder 多字节安全）、仅脏草稿可保存并回传已加载令牌、保存后说明加载器的生效语义、冲突时提供显式重新加载。生效传播完全由 `dsh-agent-instructions` 既有的 reconcile 承担 —— 新会话在第一步读取，活跃会话在下一次文件操作后感知 —— 本特性不自行传播。

组合：宿主行与浏览器名册行都放在 `dsh-web-app` 组合包（设置界面只存在于 web 与桌面；headless/TUI 不会挂载它，端点的可选缝在那里应答 `global-rules-unavailable`）。

## Verification

- `packages/context/global-rules` —— 基于真实临时主目录的 10 个测试：缺失、往返与令牌形态、主目录创建、令牌匹配/过期/文件消失、多字节上限拒绝、配置-环境-默认三级解析、非缺失失败传播；单文件覆盖率 100%。
- `packages/host/apiproxy/tests/api-proxy-global-rules-rpc.spec.ts` —— 6 个测试钉住代理层映射：两种视图、缝缺失、带令牌 details 的冲突、带 `maxBytes` details 的超限、读写失败各自的错误码。
- `packages/client/ui-settings-global-rules` —— 26 个测试：注册/HMR 销毁（分区 + 图标 + inject 面）、词典奇偶校验、分区呈现行为（加载态、字节计数单位、脏/保存/放弃、令牌回传契约、冲突与重载、超限守卫、本地化的缝缺失、被拒绝/抛出/非 Error 失败）；单文件覆盖率 100%。
- `docs/api-catalog.json` 经 `gen-api-catalog` 重新生成；`module-graph` 重新生成并镜像；`verify-translation-pairing` 全绿（1240 对）。
- settings Chrome e2e 在真实组合宿主上演练该分区并刷新设置对话框金标。

## Alternatives considered

**直接采用第三方插件。** 零实现成本，但它面向 Harniverse 未提供的上游 `ctx.connection.fetch.register` 面、仅按环境变量解析主目录（加载器的 `dshHome` 配置覆盖会让编辑器与实际加载的文件脱钩）、并在四份额/词典/令牌契约之外手写 bundle。已否决；该插件在原生运行时上仍可作为外部插件安装。

**把编辑器暴露为设置命名空间。** 设置机制已在为浏览器偏好建命名空间，但规则文件是加载器读取的持久事实源；命名空间会把文件字节镜像进设置文档，而每次外部编辑都会让二者漂移。作为第二事实源否决。

**经专用 Connection RPC 通道服务。** 每特性一通道会让信任面成倍增加，而共享 `/api` 载体既有的栅栏 + capability 门已经足够；`speech.*` 的 unary 先例已经回答了这个形态。否决。

## Consequences

- `IApiClient.globalRules` 进入客户端必需面：connection/runtime 的测试替身各补一个成员（两处文件）—— 这是每个新 unary 域都要付的同等成本。
- 冲突检测是尽力而为的乐观锁而非事务：两个并发写者可能同时通过令牌检查；服务 README 已将其列为已知局限，升级路径是基于 rename 的替换。
- 写入上限与加载器的 `maxSourceBytes` 是两个需要联动的配置；目前都默认 1 MiB、组合行注释也写明了，但尚无机制强制耦合。
- 每个 web/desktop 组合现在都会携带 `dsh-global-rules`（无状态文件适配器、无生命周期）；不需要编辑器的组合可以禁用该行，端点退化为 `global-rules-unavailable`。
