# `@deepseek-ai/dsh-host-frontend-static`

[English](README.md) | 中文

Web 壳的 SPA dist 服务器：一个函数插件（配置为 `{distIndex, indexPaths?}`），占据 [webserver](../webserver/README.md) 的唯一回退席位，并通过显式页面入口服务已构建的前端目录。Dist 根路径、已配置 index 文件和精确的 `indexPaths` 会以 HTTP 200 渲染 `index.html`；缺失文件或未声明 pathname 返回空 404，越出 dist 根目录的遍历返回 403，未知扩展名按 `application/octet-stream` 提供，GET／HEAD 之外的方法在没有匹配的具名路由时返回 405。每个 index 响应都会经过 webserver 已注册的 index 转换器（`applyIndexTaps`），启动 manifest（元数据清单）就是经这条路径送达页面的。`distIndex` 与 `indexPaths` 都是组装事实：[dsh-web-app](../../bundle/web-app/README.md) 解析前端包的 index 并声明 `/auth/manage`；部署不会根据任意未命中项推断页面路由。

回退席位只有单一所有者（第二次占据会抛错），并受 effect 作用域约束：dispose（资源释放）插件的 fiber 会释放席位，此后无人占据的 webserver 回答 404。

## 模型体验

无。该包只服务浏览器资产；其中没有任何内容会进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与延期工作

- **初始 MIME 表很精简**：它覆盖 Vite 输出的资产集合及实际交付的 PWA manifest；其他扩展名在相应资产类别实际发布前都会回退到 `application/octet-stream`。
- **Pathname 路由必须显式声明**：新的 History API pathname 会返回 404，直到组合应用增加精确的 `indexPaths` 配置项和真实组合覆盖。
