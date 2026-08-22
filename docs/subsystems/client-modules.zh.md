# Client 模块

[English](client-modules.md) | 中文

Web 插件表：[dsh-client-modules](../../packages/client/modules) 中 client 模块系统的 Node 半，以 `ctx.clientModules`（`ClientModuleRegistry`）形式提供。它扫描宿主 Loader 的 entry，找出声明了 `dsh.client` 的包，组合出 `window.__DSH_BOOT__` entry 图，在 `/plugins` 下提供聚合及逐插件资源，并经 index 转换（index tap）注入启动 manifest（元数据清单）——这是同一个服务的四个面。它是 Web GUI 栈的一项可选能力，不属于 agent loop（智能体循环）主干，并且是 [dsh-host-webserver](../../packages/host/webserver) 的消费方：[web-server.md](web-server.md) 所述的载体提供本服务注册的前缀路由与 index 转换。同一个包的浏览器半（`ctx.modules`，即拉取并物化这些 bundle 的 lazy CJS 模块表）属于内核机件，记录在[包 README](../../packages/client/modules/README.md)中，不在本页。

源码：[`packages/client/modules/src/client/manifest.ts`](../../packages/client/modules/src/client/manifest.ts)

## wire

图是 Node 半与浏览器半之间协议层的唯一真源：宿主从扫描到的包组合出 `WebBootEntry` 行，把图作为 `<head>` 中的第一个脚本注入（`window.__DSH_BOOT__`，其中 `<` 已转义，插件可控的字符串因此无法逃出 script 元素），壳则在启动任何东西之前先解析它。没有有效 manifest 的页面无法启动——浏览器侧的解析器在图缺失或畸形时大声抛错。

```ts type-equiv
/**
 * One composed client entry pushed by the host (a graph row). Wire
 * single source: the host node half (package root) produces this same shape.
 * `immediately` marks the per-bundle fallback prefetch tier; `inject` is informational graph
 * metadata (the authoritative edges live in each package's `dsh.client`
 * declaration and reach fibers through entry creation).
 */
interface WebBootEntry {
  /** Entry name == package name. */
  id: string
  /** Bundle endpoint, '/plugins/<id>/client.js?rev=<rev>'. */
  url: string
  /** Bundle content hash (cache-busting consistency anchor). */
  rev: string
  /** Package-name dependency edges, informational (preflight display / HMR diffing). */
  inject?: string[]
  /** Per-bundle fallback prefetch mark when graph bootstrap registration fails. */
  immediately?: boolean
  /** Whether this entry must be active before the first interactive UI. */
  startup?: 'critical' | 'deferred'
}
```

```ts type-equiv
/** The composed client entry graph the host injects as `window.__DSH_BOOT__`. */
interface WebBootGraph {
  /** Consistency anchor over the whole graph (content + bundle hashes). */
  rev: string
  /** One revision-addressed script that registers every graph factory for initial boot. */
  bootstrapUrl: string
  /** Bootstrap script for entries that are safe to activate after first paint. */
  deferredBootstrapUrl: string
  /** Composed entries; order carries no semantics (activation order is fiber inject waiting). */
  entries: WebBootEntry[]
}
```

每一行的 `rev` 是该 bundle 的内容哈希，并作为使缓存失效的查询参数附在 URL 上；图的 `rev` 对组合后的各行做哈希，因此任何一行变化都会同时改变它和 `bootstrapUrl`。bootstrap 脚本会登记每一行的 factory，但不物化任何插件。聚合失败或漏登 factory 时，`immediately` 标记逐 bundle 回退屏障；entry import 保留独立路由，并负责大声报告到达失败。

## 扫描

包加入这张表的方式，是在自己的 package.json 中声明 `dsh.client`（`platform: 'web'`、可选的 `inject` 边、可选的 `immediately`），并在 `exports["./client"]` 导出构建好的 bundle。包解析锚定在配置树的 `ctx.baseUrl`——即 cordis.yml 所在目录，该目录的包把每个被组合的插件声明为依赖——这一锚点未设置时，构造即抛错。

扫描是单包增量的；不存在全量重扫代码路径。fiber 构造或 dispose（资源释放）时的每次 cordis `internal/plugin` 发射都把该 fiber 的 entry 名标脏，一次微任务 flush 把每个脏名与实时 loader entry 对账。激活趟以全部当前 entry 灌入同一个脏集合并同步 flush，因此初扫与稳态共享一条实现——但失败姿态相反。激活时，已加载 entry 中的畸形声明或缺失 bundle 会聚合为一个大声的 `AggregateError`，列出每个损坏的包：该 fiber 进入 FAILED，由启动的大声失败 sweep 上报。稳态下，损坏的包只记录一条警告，且不得殃及其他包。

包元数据——包括「非 client 包」这一否定结论——按名缓存且永不过期：插件集合的变更在重启后生效。fiber 重启原样复用其行与 rev；bundle 内容变更只经 `rebuilt()` 到达图。

## bundle 路由与 index 转换

`GET`/`HEAD /plugins/bootstrap.js?rev=<graph-rev>` 提供由该图 revision 所有 factory 登记组成的一份缓存聚合。聚合会移除逐 bundle 的 `sourceMappingURL` 注释，支持 gzip，并采用按 revision 定址的 immutable 缓存；注册表保留最近两个 revision，使 index 响应跨越一次并发图变化后仍可加载。`GET`/`HEAD /plugins/<id>/client.js` 以 `no-cache` 从磁盘提供一个已注册的 bundle，`/plugins/<id>/client.js.map` 则为直接加载和 HMR 保留其 sourcemap。其他方法返回 405。未知 id、已淘汰的聚合 revision 或不可读的已注册 bundle 会回应一个大声的 404，而不是让载体的 SPA 回退把 HTML 当作 JavaScript 发出。index 转换在每次 index 渲染时注入当前图，因此刷新页面总是针对实时组合启动。

## 服务

`ClientModuleRegistry`（`ctx.clientModules`，定义于 [`packages/client/modules/src/index.ts`](../../packages/client/modules/src/index.ts)）暴露读取面与重建面；签名见生成的[服务目录](#ctxclientmodules--clientmoduleregistry)。`graph()` 返回当前组合出的图（两次变更之间是同一个稳定对象），`clientPath(id)` 返回该 bundle 的绝对路径。`rebuilt(id)` 是 bundle 内容到达图的唯一入口：它对文件重新哈希，只有 rev 真正变化才会重新组合图并发出通知。`onRebuilt` 按发生变化的 bundle 逐个触发并携带新 rev；`onGraphChanged` 在任何一次重新组合了图的 flush 之后触发（行的增删，或 rebuilt 带来的 rev 变化），并采用拉取模型——监听器自行重读 `graph()`。两条通知路径都会兜住监听器异常，因此一个抛错的订阅者既不能让后续订阅者被跳过，也不能杀死触发这次 flush 的一方。

开发环境下，[dsh-client-hmr](../../packages/client/hmr/README.md) 是注册表的监视驱动：它的 Node 半从同步取得的基线出发，对图中每一行的 bundle 做 stat 轮询，变化时调用 `rebuilt(id)`，经 `onGraphChanged` 重新同步监视集合，并通过 SSE（Server-Sent Events）把 rev 变化广播给浏览器半。生产环境的图完全不含 HMR（热模块替换）行；模块宿主自身从不监视文件。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxclientmodules--clientmoduleregistry"></a>

### `ctx.clientModules` — `ClientModuleRegistry`

The web plugin table service: incremental `dsh.client` scan + wire composition + plugin resource route + index tap. Construction runs the activation scan synchronously — a malformed declaration or missing bundle among the already-loaded entries aggregates into one loud throw (FAILED fiber; the boot activation audit reports it).

```ts cordis-catalog
/**
 * Current composed entry graph (stable object between changes).
 * @returns the graph served as `window.__DSH_BOOT__`.
 */
graph(): WebBootGraph

/**
 * Absolute path of an entry's client bundle.
 * @param id - entry id (package name).
 * @returns the path, or undefined for an unknown id.
 */
clientPath(id: string): string | undefined

/**
 * Re-hash one bundle (the HMR watch's registration hook — the only entry
 * point through which bundle content changes reach the graph).
 * @param id - entry id (package name).
 * @returns the new rev, or undefined for an unknown id.
 */
rebuilt(id: string): string | undefined

/**
 * Subscribe to bundle rebuilds; fires only when the re-hash changed the rev.
 * @param listener - receives the entry id and its new bundle rev.
 * @returns the unsubscriber.
 */
onRebuilt(listener: (id: string, rev: string) => void): () => void

/**
 * Fires after any flush that recomposed the graph (row added/removed, or a
 * rebuilt rev change). Pull model: listeners re-read {@link graph}.
 * @param listener - notified with no payload.
 * @returns the unsubscriber.
 */
onGraphChanged(listener: () => void): () => void
```

Source: [`packages/client/modules/src/index.ts:211`](../../packages/client/modules/src/index.ts)
<!-- END GENERATED cordis-surface -->
