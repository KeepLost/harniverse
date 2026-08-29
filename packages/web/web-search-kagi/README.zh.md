# @deepseek-ai/dsh-web-search-kagi

[English](README.md) | 中文

由 [Kagi](https://kagi.com) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`），注册 id 为 `kagi`。它使用原生 `fetch` 调用 `GET https://kagi.com/api/v1/search?q=...`。

这是一个实现包，也是带有 `inject: ['web']` 的函数／命名空间插件。它向 aggregate web service 注册 provider，不新增工具，也不使用 LLM seam。已挂载的凭据服务具有权威性；只有没有该 seam 时才查询启动环境。每次搜索都会解析 Kagi 凭据引用。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | 未设置 | Kagi API token 字面值。优先使用 `apiKeyEnv`；非空字面值会直接使用。 |
| `apiKeyEnv` | `KAGI_API_KEY` | 每次搜索解析的凭据引用；没有 credentials seam 时回退到启动环境。 |
| `baseURL` | `https://kagi.com/api/v1` | Kagi API 基址；追加 `/search`。 |

```yaml
- id: web-search-kagi
  name: '@deepseek-ai/dsh-web-search-kagi'
  config:
    apiKeyEnv: KAGI_API_KEY
```

`apiKey` 带有 `role('secret')`，不会出现在脱敏的设置描述中。token 以 `Authorization: Bot <token>` 发送。每个带凭据请求都使用 `redirect: 'error'`，会在访问目标前拒绝重定向。

## 映射

Kagi 只接收模型查询作为 `q`；最终的 `maxResults` 限制由 aggregate web seam 负责。适配器接受文档中的直接结果数组，也容忍 `data`、`results` 或 `items` 包装。每项结果将 `url` 映射为 `url`、`title` 映射为 `title`、`snippet` 映射为 `snippet`、`published` 映射为 `publishedAt`。此适配器不返回 Kagi AI answer，因此省略 `content`。

凭据缺失以 `WEB_PROVIDER_CREDENTIAL_MISSING` 返回，provider／网络／HTTP／响应体失败以 `WEB_PROVIDER_ERROR` 返回，调用方取消以 `WEB_ABORTED` 返回。在凭据解析或请求发出前取消不会发送 HTTP 请求。

## 模型体验

### 搜索结果 sources

#### 模型看到什么

模型通过 [`dsh-tool-web`](../tool-web/README.md) 接收规范化且受 `maxResults` 限制的 source URL、标题、snippet 和发布日期。Kagi token、包装元数据及其他 provider 私有字段不会暴露。

#### Token 影响

此 provider 不会发起额外的模型推理请求；只有选定的对话模型会消费规范化的搜索结果上下文。

#### KV Cache effect

不会直接导致失效；请求前缀变化由上述消费方负责。

## 已知限制与暂缓事项

- Kagi 的厂商专属过滤器、结果类型和排序元数据不会公开，因为当前 provider-neutral seam 没有对应字段。
- 适配器会容忍包装结构，但会有意忽略非结果元数据以及缺少可用 URL 的错误条目。
- 动态凭据的可用性在操作内部确认，因为 `available()` 无法同步查询异步凭据存储。
