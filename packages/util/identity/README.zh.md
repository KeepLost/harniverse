# dsh-identity

[English](README.md) | 中文

出站请求携带的**产品身份的唯一真相源**。它拥有 `harniverse` 的 `User-Agent` 产品标识、产品版本，以及 MCP 的 `clientInfo` 投影——仅此而已。所有 LLM 适配器、web 工具、通知发送器、聊天适配器和 MCP 客户端都从这里渲染自己的身份，任何出口都不会再漂移成手写常量或过时版本号。

版本号读取自本包 manifest，并由发布流程（`pnpm run release:dsh`）统一授予整个工作区家族，因此身份永远不会标出一个仓库里不存在的版本。范围与有意不做的事（会话 id、SDK 指纹头、服务商准入头保持在各自的所有者决策里）见 [Agent Note](../../../.agents/notes/implemented/architecture/2026-10-31-harniverse-product-identity.md)。

它是一个**库，不是服务或插件**：没有 `ctx`，不注册任何东西，不持有状态。每个字段都是静态公开的产品事实——不含秘密、本地路径、会话 id、提示词或按用户标识。白标部署传入自己的 `AppIdentity`；缺省回退到 harniverse 默认值，且任何调用都无法完全关闭署名。

## API

```ts
import { APP_IDENTITY, attributionHeaders, clientIdentity, userAgent } from '@deepseek-ai/dsh-identity'
```

| 导出 | 职责 |
|---|---|
| `APP_IDENTITY` | 产品身份：`harniverse` 加 manifest 版本号，不带 url 注释（产品没有公开的仓库主页）。 |
| `userAgent(identity?)` | 渲染 `User-Agent` 值：`product/version`；身份带主页时追加 ` (+url)`。 |
| `attributionHeaders(identity?)` | 出站请求必须携带的头——目前是 `{ 'user-agent': … }`，仅此一项。 |
| `clientIdentity(identity?)` | 把身份投影为协议客户端自述，例如 MCP `initialize` 的 `clientInfo`（`{ name, version }`）。 |

## 模型影响

无。身份绝不进入提示词、请求体、token 计量或会话日志；LLM 服务商请求只把它作为 HTTP 元数据携带。

## 已知限制与暂缓事项

- 宿主进程与子进程流量（pnpm、git、Electron/无头 Chrome 外壳）保留各自的客户端指纹；本次集中只覆盖第一方出站 HTTP 与协议自述。
- 白标部署需要在各消费方以编程方式覆盖身份；目前没有 deployment 级的单一配置开关可以整体替换产品标识。
