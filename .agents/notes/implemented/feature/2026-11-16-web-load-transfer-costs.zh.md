# Agent Note: Web 加载路径传输成本——压缩并按 rev 缓存的插件 bundle 与内容寻址壁纸路由

Status: implemented

[English](2026-11-16-web-load-transfer-costs.md) | 中文

## Problem

登录后打开页面时，壳层很快绘制完成，但插件提供的视觉元素——图标按钮、设置界面、壁纸背景——要晚几秒到几十秒才出现，且随网速伸缩。两项线上成本占主导：

1. `GET /plugins/<id>/client.js` 以**裸字节**提供每个已注册 bundle（`cache-control: no-cache`、无 `content-encoding` 路径、无验证器）。59 个 bundle 共 6.24 MB 在**每次**加载时未压缩地过线——`no-cache` 而无 `ETag` 无法再验证，因此什么都不可复用——而同样字节的 Brotli 实测 1.24 MB（5.0×）。Bootstrap 聚合与壳层 chunk 早已压缩并 immutable，这正解释了为什么登录门本身很快、只有插件层迟滞。
2. 壁纸字节（每张至多 8 MiB）以 base64 走 `skinLibrary/readWallpaper` RPC——没有 HTTP 缓存，即使每张壁纸都有钉死确切字节的内容地址，每次刷新仍全量重取。

## Decision

- **压缩并按 rev 缓存插件 bundle**（`@deepseek-ai/dsh-client-modules`）。该路由现在解析表记录，把 bundle 一次读入 `EncodedArtifact`（`plain` + 异步填充的 `br`/`gzip`，即 Bootstrap 聚合所用的同一主线程外 `fillEncoding`），并以 Brotli 优先应答、带 `vary: accept-encoding`。`?rev=` 与组合行匹配的请求按定义即内容寻址（rev 就是 bundle 的 sha1 内容哈希），因此应答 `private, max-age=31536000, immutable`；rev 缺失或过期——手工抓取、HMR 重建进行中——保持 `no-cache`，不会钉住过期内容。工件按 `id\0rev` 保存在 FIFO 有界映射（96 项）中，HMR 世代更替而无无界增长。Source map 保持其 `no-cache` JSON 路径。
- **壁纸下载迁移到 `GET /skins/wallpapers/<sha256>`**（`@deepseek-ai/dsh-host-skin-library`），位于与插件 bundle 路由相同的 Connection 信任栅栏与 `harniverse.observe` 准入之后。store 增加 `readWallpaperBytes`（同样的哈希与签名校验）；路由以 `private, max-age=31536000, immutable` 提供校验后的字节——替换壁纸得到新哈希即新 URL。`readWallpaper` Remote 与 `WallpaperContent` 类型删除：该路由是唯一下载面，`ui-skin` 直接抓取 `Blob`（其 `WallpaperUrlCache` 失去了 base64 解码步骤）。壁纸哈希设置保存在页面权威的设置存储中，因此从页面权威提供字节也让被选中的远程机器不再抹掉本地选择的背景。

## Alternatives considered

- **只用压缩中间件**（webserver 上的 `compression`）：保留 `no-cache` 重取——回访仍要传 6.24 MB——且不覆盖 `/plugins` 路由的握手。作为半个修复被否决。
- **用 `ETag` 再验证替代 immutable 缓存**：把回访变成 304 往返（59 个请求）而非零请求。URL 中已有的 rev 使 immutable 是严格更优的契约。
- **浏览器侧 Cache API 存壁纸**：`caches` 要求安全上下文；harniverse 常在局域网纯 HTTP 地址上服务，该功能会静默消失。服务端路由在页面能加载的地方都可用。
- **保留 `readWallpaper` 作为回退 Remote**：已无消费者，而一条能传数兆 base64 负载的死 RPC 正是包规则要退休的未用公共面。

## Consequences

- 回访页面插件层线上流量约 0 字节（immutable 缓存命中）；首次加载约 1.24 MB 而非 6.24 MB。壁纸重载为缓存命中；首次绘制只抓一次原始图像。
- HMR 照常工作：重建改变 rev，图行 URL 随之改变，旧 rev 请求退化为 `no-cache` 而非钉住过期字节。
- 暴露 webserver 而无 Connection 服务的组合（今日没有出货的）会注册 index-tap 引导但不注册壁纸路由；`ui-skin` 抓取届时看到 404 并不渲染壁纸，与此前缺库时的退化一致。
- skin-library Remote 面缩减为五个方法；typert 契约、`api-remotes` 类型再导出与两份包 README 随之移动。

## Testing

- `packages/client/modules/tests/node-half.client.spec.ts`：bundle 的 brotli/gzip/identity 分支、rev 匹配 immutable 与过期/缺失 `no-cache`、无主体的 HEAD、压缩失败明文回退、未知资源 404。
- `packages/host/skin-library/tests/loader-composition.spec.ts` 引导真实组合（webserver + connection 替身）并经 HTTP 断言路由：字节、mime、immutable 头、HEAD、格式错误/缺失/尾部地址的 404、405、Connection 拒绝的 403，以及删除后的 404。
- `packages/client/ui-skin` 各 spec 以桩 `fetch`（blob、404、被拒传输）驱动控制器，引用计数 URL 生命周期不变。
- 真实浏览器覆盖：既有 `skin.e2e.ts` 壁纸场景（上传 → 绘制 → 重载 → 绘制）端到端走新路由。
