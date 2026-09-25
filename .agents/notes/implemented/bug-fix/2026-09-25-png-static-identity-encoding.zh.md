# Agent Note: PNG 资源不进行传输重压缩

Status: implemented

[English](2026-09-25-png-static-identity-encoding.md) | 中文

## Problem

完整的 Harniverse 图稿是一个 777,299 字节的 PNG，在认证启动期间请求。同时同步计算 gzip 与默认质量的 Brotli 会阻塞其他 Host 请求，包括关键启动流量。一次本地测量花费约 2.48 秒生成 763,496 字节的 Brotli 表示，体积仅减少约 1.8%。不带哈希的资源请求会重复这项工作。

## Decision

[静态前端插件](../../../../packages/host/frontend-static/README.md)按文件原始字节提供 `.png`，不受请求提供的传输编码选项影响。它不会为 PNG 计算 gzip 或 Brotli 表示。GET 与 HEAD 保留原始内容长度、`image/png`，以及现有按路径决定的不可变缓存策略。

## Alternatives considered

**增加启动超时：**拒绝，因为这会掩盖可避免的 Host 阻塞，用户仍然需要等待同样的工作。

**缓存或异步重压缩 PNG：**拒绝，因为这会为实测中很小的体积收益保留计算和编码表示的存储开销。直接提供已经压缩的文件即可移除这些工作，也无需更改批准的图稿。

## Consequences

PNG 传输放弃少量额外压缩收益，避免每次未缓存请求中的同步重压缩。其他静态资源类型保留各自的编码策略。[显式页面路由决策](2026-08-20-explicit-web-index-paths.md)与 [API 响应编码决策](../architecture/2026-08-23-api-response-encoding.md)继续独立适用；这条资源类型规则不取代其中任何一个。

## Verification

真实 Loader 的 HTTP 测试覆盖普通路径和带哈希路径下的 PNG GET／HEAD 响应，以及 Brotli、gzip、identity 编码偏好，检查字节、MIME、长度、内容编码缺席和缓存。既有构建后浏览器启动测试在延迟插件内容被拦住时仍保留五秒上限；认证浏览器检查验证原始图稿能够正确加载。
