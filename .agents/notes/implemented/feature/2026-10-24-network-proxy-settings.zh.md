# Agent Note:运行时网络代理设置(`network-proxy` namespace)

Status: implemented

[English](2026-10-24-network-proxy-settings.md) | 中文

## Problem

Harniverse 原生携带 `dsh-http-proxy`,但它只是启动时的环境缝:启动器在任何插件挂载前一次性解析 `HTTP(S)_PROXY`/`no_proxy`,改代理就要改环境并重启。需要"部分目标走代理、其余直连"的用户(常见的 `127.0.0.1:7890` 分流场景)完全没有产品入口。社区插件 `@copylee/dsh-proxy`(`dsh-proxy` v0.4.5)在官方 dsh 上补的正是这个空缺,它的行为集——全局路由 off / system / manual、保存即生效、其上再叠按 provider 路由——就是本特性吸收的参考。

## Decision

- **一个实时生效的设置 namespace `network-proxy`**(`packages/host/network-proxy`):`mode: 'off' | 'system' | 'manual'`、`url`、`noProxy: string[]`。每次提交都走 `resolveProxyDecision` 与 `setProxyOverride`,无需重启;`off` 精确恢复启动策略。
- **传输缝仍是路由的唯一汇聚点。** `dsh-http-proxy` 新增 `setProxyOverride(policy | null)` 与 `policyFromManual(url, noProxy)`;启动安装仍拥有插件前状态,`null` override 原样重挂启动时装的 dispatcher,被替换的运行时 dispatcher 只在无路由可达时关闭。`ProxyPolicy.source` 增加 `'runtime'`,与 `'env'` 可区分。三个既有消费者(llm-pi-ai、subprocess、web-fetch-http)与所有裸 `fetch()` 调用零改动跟随。
- **`system` 探测复用参考插件的行为边界而非代码**:先启动快照的 HTTP(S) 变量(`HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`,快照防止本插件安装的代理回馈进探测),再看平台设置——win32 的当前用户 Internet Settings 键、macOS 的 `scutil --proxy`、Linux 仅环境——激活期间每 30 秒重探。SOCKS、PAC、WPAD 视为无代理。探测是注入 `platform`/`env`/`run` 的纯模块(`detect.ts`),每个分支无需 Windows/macOS 主机即可单测。
- **失败带警告回退,绝不静默**:传输无法路由的手动 URL(SOCKS、无法解析)或 `system` 无结果,保持启动策略并记录 `dsh-http-proxy` 既有的面向操作者的诊断(结构上不含凭证)。
- **有意不做按 provider 路由。** 参考插件的招牌特性在这里价值最低:需要独立路由的 provider 已经有——它的 base URL。带上按 provider 分发就得引入 AsyncLocalStorage 的 `fetch` 包装(插件的 `fetch-router`),其唯一目的是全局缝不需要的按请求 dispatcher 选择。
- Web 设置页经网关 `WEB_SETTINGS_NAMESPACES` 白名单访问该 namespace(现含 `'network-proxy'`),与 `shell-backend` 同路;dsh-base 以默认 `off` 组合本插件,恢复的启动策略逐字节一致,未动过的安装行为与之前完全相同。
- **用户可见的设置页是 `packages/client/ui-settings-network-proxy`**(`settings.section` id `network-proxy`,order 13,位于全局规则与插件之间):关闭 / 系统代理 / 手动 单选表单,手动模式独享地址输入对。它经 `ctx.settingsScope.bind` 绑定命名空间,只按顺序写入变化字段(mode、url、noProxy;清空的可选字段清除其覆盖);非 http(s) 的地址在客户端即禁用保存,宿主仍是最终执法者。

## Verification

- `@deepseek-ai/dsh-http-proxy` —— `override.spec.ts`:针对有/无启动策略的 override/restore 往返、空 URL 直连、环回合并、socks/不可解析拒绝诊断;既有 102 测试保持绿。
- `@deepseek-ai/dsh-network-proxy` —— `detect.spec.ts`:env 优先级与非 HTTP(S) 跳过、Windows 单服务器与按协议注册表形状及禁用/失败查询、macOS scutil 的 https 优先、Linux 永不执行命令;`network-proxy.spec.ts`:决策表(off/manual/system × 可用/不可用/未检出)与 `MemorySettings` 文档上的应用行为——namespace 默认、实时 manual 路由、off 恢复启动策略、system 从快照解析、带警告回退。
- `@deepseek-ai/dsh-client-ui-settings-network-proxy`——30 个 client 测试:注册/生命周期(HMR 安全卸载)、namespace 解码器的收窄表、设置页的表现矩阵(加载/不可用/只读态、手动独享输入、URL 校验、按序字段写入与覆盖清除、忙碌/失败提示、干净草稿对外部修订的采纳);逐文件覆盖率 100%。
- 无密钥 web e2e(`apps/web/tests/settings-chrome.e2e.ts`)覆盖真实组合的端到端:nav 名册与对话框 golden 增加网络代理分节,场景切换手动、保存 `http://127.0.0.1:7890` 与例外列表进 `settings.yaml`、重载后作为活动草稿读回、并恢复 `off`。
- 集成邻域保持绿:apiproxy、bundle base(REAL 组合)、shell-backend-settings——五个受影响包共 891 测试。

## Alternatives considered

**原样 vendoring 或推荐 `@copylee/dsh-proxy`。** 否:控制进程全部出站路由的第三方包是 harniverse 不应固定发布的供应链面,且该插件的 cordis.patch 分层(`dsh-proxy` 设置条目、volatile config)与原生设置缝已有的能力重复。吸收的是行为参考;想用的用户仍可自行安装该插件。

**按 provider 路由。** 所有者裁定否决:base URL 已表达按 provider 的路由,而它要求的 `fetch-router` AsyncLocalStorage 机制会成为本特性中最复杂、服务最不重要行为的代码。

**从实时 `process.env` 探测。** 否:启动快照是 harness 自身解析策略的唯一环境;读实时状态会让本插件安装的代理回馈进自己的探测(参考插件的启动快照规则)。

## Consequences

- harniverse 拥有的代理模式在上游不存在:官方 dsh 保持仅环境缝,因此本包是一项长期分歧,本 note 即其记录(absorption review 将其视为下游扩展,同类如 2026-10-24 的重定向跟随预算)。
- 设置页展示字段但不展示实时探测结论;状态行待设置视图能承载只读诊断后再做。
- 30 秒轮询仅在 `system` 模式激活时存在;Linux 上永不执行命令(仅环境探测)。
