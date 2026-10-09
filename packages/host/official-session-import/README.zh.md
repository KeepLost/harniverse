# @deepseek-ai/dsh-host-official-session-import

[English](README.md) | 中文

在服务端机器上远程发现并归档导入官方 DeepSeek Harness 会话。`OfficialSessionImport` 注册 `officialSessionImport` 服务，发布三个生成的直连 Remote，都由 `harniverse.operate` 保护：`scan`、`importSources` 与 `importUpload`。每次调用都在客户端当前指向的机器上执行，因此远程主机经同一个 web-app 行扫描并导入到它自己的 DSH home。

`scan` 遍历每个配置根目录，目录布局与官方构建存放会话的方式一致 —— `<root>/<project>/<session>/session.vN.jsonl[.zstd]` —— 每个会话目录只提供最新世代，忽略原生 `session.jsonl[.zstd]` 日志与已保留的导入源件。每份日志经 [`dsh-session-import`](../../session/session-import/README.md)（`ctx.sessionImport.describe`）描述，并在大小与 mtime 不变时按路径缓存，因此重复扫描只重读变化过的日志。候选项的状态来自已持久化的会话 id：存在内容完全相同的归档时为 `imported`，存在同一官方会话旧版本的归档时为 `updated`，否则为 `new`。超过 `maxArtifactBytes` 的日志、无法描述为官方世代的日志以及无法列出的目录都作为不可读项报告，而不会让扫描失败；候选项按最近更新时间倒序排列。

`importSources(sourceIds, target)` 把每个不透明的来源 id 解析回其根目录下 —— 拒绝任何不是“配置根目录下恰好三个普通路径段的世代日志”的 id —— 并依次导入。`importUpload(fileName, contentBase64, target)` 在解码前后都限制大小，然后以裸文件名导入一份上传的日志。目标是一个已注册的 workspace，或者 `source-cwd`：官方会话自身工作目录处的 workspace，该目录在本机存在时按需注册。结果逐项返回、从不抛出：`imported`（归档 id、所在 workspace、是否加入了 workspace、标题与有损映射计数）、`already-imported`（已有归档），或带 `source-missing`、`too-large`、`invalid`、`workspace-unavailable`、`failed` 之一的 `failed`。

该服务只提供 Remote，不声明同进程的 Cordis `Context` 合并。负载类型位于 `./types`；Typert 生成 `./typert` 与 `./remote` 暴露的 Host 与 Client Remote 工件，客户端经 [`api-remotes`](../../api/remotes/README.md) 消费它们。

## 配置

| 键 | 类型 | 默认值 | 含义 |
|---|---|---|---|
| `roots` | `string[]` | 必填 | 要扫描的绝对会话根目录；web-app 捆绑传入 `dshHomePath('sessions')`，即官方构建默认共用的目录。 |
| `maxArtifactBytes` | `number` | `67108864` | 从磁盘读取或作为上传接受的最大日志字节数。 |

## 模型体验

无，因为导入 Remote 结算的归档从不运行；继续对话归 dsh-session-import 与 API 代理所有。

#### KV Cache 影响

无；本包从不组装或发送 provider 请求。

## 已知限制与暂缓事项

- **只识别官方布局** —— 发现过程只认官方的每会话目录布局与世代文件名；其他位置的日志经 `importUpload` 导入。
- **上传走 JSON RPC 请求体** —— base64 会让上传体积增大三分之一，因此能从浏览器发送多大的文件，除 `maxArtifactBytes` 外还受连接的请求体上限约束。
- **描述缓存只在内存中** —— Host 重启后，第一次扫描会重读所有日志。
