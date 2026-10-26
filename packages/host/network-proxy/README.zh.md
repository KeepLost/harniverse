# @deepseek-ai/dsh-network-proxy

[English](README.md) | 中文

DeepSeek Harness 的运行时网络代理设置:`$DSH_HOME/settings.yaml` 的 `network-proxy` 小节选择一条全局路由——关闭、跟随系统、或手动 URL——并通过 [dsh-http-proxy](../../util/http-proxy) 传输缝即时生效,无需重启;提交后的下一个请求起,模型调用、web 搜索与抓取、HTTP MCP、以及裸 `fetch()` 调用全部跟随。

## 字段

| 字段 | Schema | 默认 |
| --- | --- | --- |
| `mode` | `'off' \| 'system' \| 'manual'` | `'off'` |
| `url` | `string`(manual 模式的代理 URL;空串表示刻意直连) | `''` |
| `noProxy` | `string[]`(绕过条目;子域同样匹配,环回地址永远直连) | `[]` |

该 namespace 实时生效:每次提交都会执行 `resolveProxyDecision` 与 `setProxyOverride` 更新传输缝,且串行化,轮询与提交不会交错安装。`off` 精确恢复启动环境的策略——即 `dsh-app-boot` 在任何插件挂载前从启动器快照解析出的那条。`manual` 让 `http:` 与 `https:` 源都走该 URL,绕过列表与环回下限合并;传输无法路由的 URL(SOCKS、无法解析)会被拒绝并告警,同时保持启动策略。`system` 先解析启动快照的 HTTP(S) 变量(`HTTPS_PROXY` → `HTTP_PROXY` → `ALL_PROXY`,因此本插件安装的代理不会回馈进探测),再看平台设置——win32 上是当前用户的 Internet Settings 注册表键,macOS 上是 `scutil --proxy`,Linux 只看环境——激活期间每 30 秒重新探测;找不到可用值则告警并回退启动策略。

按 provider 的路由被有意省去:需要独立路由的 provider 直接在自己的 base URL 里解决。

Web 客户端通过 `settings.describe` / `settings.update` 访问该 namespace(网关的 `WEB_SETTINGS_NAMESPACES` 白名单含 `'network-proxy'`),设置页编辑的就是同一份文档。

## 模型体验

无,因为这些设置只改变出站请求的网络路径;提示词、工具、schema 均不受影响。

#### KV Cache 影响

这里没有任何内容进入模型请求,provider 缓存复用不受影响。

## 已知限制与遗留工作

- 探测只读启动快照,从不读实时 `process.env`,且只支持 HTTP(S) 代理——SOCKS、PAC、WPAD 一律视为无代理(与参考社区插件 `@copylee/dsh-proxy` 确立的边界一致)。
- 设置页展示字段但不展示实时探测结论;system 模式未命中时以日志中的回退告警可观察,状态行的展示推迟到设置 schema 能承载只读诊断时再做。
