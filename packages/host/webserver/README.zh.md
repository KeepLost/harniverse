# @deepseek-ai/dsh-host-webserver

[English](README.md) | 中文

Web HTTP/HTTPS 与 upgrade route 注册插件（默认导出 `WebServer`，配置为 `{host, port, compression?, compressionLevel?, compressionThresholdBytes?, tlsCertPath?, tlsKeyPath?}`）：一个在激活时开始监听并提供 `ctx.webServer` 的 Node 服务器。`register(route)` 添加具名 `exact`／`prefix` 请求 route；`registerUpgrade(route)` 添加精确 pathname 的 upgrade route；同一张表内的重复路径会抛错，因为 route 模式是组合层约定，冲突即配置错误；两者返回的 disposer 都会移除注册。`registerFallback(handler)` 注册处理所有未被具名 route 命中请求的唯一 handler；第二次注册会抛错。随附的 SPA dist 服务器 [`dsh-host-frontend-static`](../frontend-static/README.md) 是该 handler 的所有者，没有注册 handler 时服务器返回 404。`tapIndex(transform)` 添加 index.html 转换，`applyIndexTaps(html)` 按注册顺序运行转换。`port` 读取监听端口，`host` 读取绑定宿主，`protocol` 报告 `http:` 或 `https:`。HTTP 匹配顺序固定为精确 route、最长前缀、fallback handler；upgrade 只做精确匹配，未命中连接直接关闭。

`compression: 'gzip'` 只包装有 socket 支撑的 HTTP 与 HTTPS 响应，不改变任何 route API：认证、路由与 handler 的响应所有权均不受影响，变化的只有出口编码。客户端必须偏好 gzip 且媒体类型可压缩；已知长度低于 `compressionThresholdBytes` 的响应保持 identity，未知长度的流则立即可压缩。`compressionLevel` 控制 DEFLATE 级别。已有 content encoding 的响应（包括预压缩的静态资源与 `/api` 桥接协商后的回复）、带 `Cache-Control: no-transform`、range 响应与 SSE 均保持原样。发布的 Web bundle 启用级别 1 与 1024 字节阈值；其他组合默认 `compression: 'none'`。没有 socket 支撑的响应按 identity 字节发送。

该包不了解任何 harness 概念，也不提供任何文件服务：`/api` 桥接与下行 WebSocket 是 connection 插件的 route，插件 bundle 与 HMR（热模块替换）事件流是 modules／hmr 插件的 route，dist 服务则属于 fallback 持有者。upgrade handler 拥有协议握手与连接内容；webserver 只交付原始 socket 与 request。`host` 只接受 `127.0.0.1` 与 `0.0.0.0`；全接口监听必须同时配置两个 TLS 路径，回环监听可以继续使用 HTTP。两个路径必须成对出现，并在 listen 前读取。该服务器只服务浏览器；Electron 通过 `file://` 加载 dist，并经 IPC 桥接承载 fetch。该包从不打印内容；URL 行属于 shell。

监听失败（EADDRINUSE……）会从激活过程抛出，并以绑定诊断信息拒绝 Loader 组合；失败的候选 fiber 会被 dispose（资源释放）。处理 HTTP 请求时抛错会使服务器响应 400；若响应头已经发出，则销毁 socket，并记录 warning，但绝不会退出进程。客户端在发送请求体时主动中断连接，会安静结束，因为已不存在可接收错误响应的连接。upgrade handler 抛错或升级 socket 出现传输错误时，会记录 warning 并销毁对应 socket。资源释放会启动 `close()` 与 `closeAllConnections()`，销毁所有受跟踪的升级 socket，并仅在 HTTP server 与这些 socket 均已关闭后返回。

## 模型体验

无。该包只是浏览器与其他插件所注册 HTTP／upgrade route 之间的 Web 载体，其中没有任何内容会进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **TLS 策略基于证书文件**：服务器不负责自动签发证书、客户端证书认证或可信代理协议；部署可以在此处配置证书文件终止 TLS，也可以只监听回环并由外部代理终止 TLS。
- **Socket 选项固定不变**：配置只选择绑定宿主与端口；在具体部署产生需求前，backlog 和其他 socket 设置仍保持内部实现。
