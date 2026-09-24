# 浏览器控制器

[English](browser-controller.md) | 中文

[browser-controller 包](../../packages/api/browser-controller/README.md)向浏览器面板提供真实的宿主浏览器页面：一个 `ctx.browserController` Remote 通过 subprocess 生成接缝按 Session 拥有一个 Chromium 进程，用 Chrome DevTools Protocol 驱动它，并将每个页面报告为录屏图像加页面元数据，使重连的客户端恢复当前画面。页面流量从宿主的网络位置发出，这正是该界面的全部意义——宿主自身回环上的工作区开发服务器可达，目标看到的是宿主地址，拒绝被嵌入的页面也能正常渲染，因为这里没有嵌入。该面板是给人使用的载体：控制器不注册任何工具，也不产生任何会话事件，模型自身的抓取仍留在 [web 子系统](web.md)及其独立的锁定解析策略中。本页面拥有来自 [`packages/api/browser-controller/src/types.ts`](../../packages/api/browser-controller/src/types.ts) 的浏览器面板线上形状；host `apiproxy` 在单参 `browser/*` gateway 端点之外承载流 surface（`events.browser` SSE）。

## 页面身份与帧

一个页面作用于一个 Session 与一个 Host 生命周期；关闭一个标识是让它退役，而不是回收复用。新页面没有目标地址，因为导航属于持有控制权的附着，而后者只在客户端跟随该页面之后才存在。每个附着以携带当前元数据与宿主持有的最新图像的快照开始，随后在变化时接收图像与元数据。与终端的有序字节流不同，每张图像都是完整的，因此跟随者只保留最新图像与最新元数据：慢速消费者丢失中间帧，永不使自己的流失败。

```ts type-equiv
/**
 * Host-owned page state. `url` and `title` track the page's own navigations,
 * including the ones a script initiates, because the host observes the real
 * browser rather than a URL the client asked for.
 */
interface HostBrowserPageInfo {
  readonly id: HostBrowserPageId
  /** Current committed URL; the empty string before the first navigation. */
  readonly url: string
  readonly title: string
  readonly width: number
  readonly height: number
  /** Whether a navigation is in flight. */
  readonly loading: boolean
  readonly state: 'ready' | 'failed' | 'closed'
  /** Last navigation or browser failure surfaced to the panel. */
  readonly error?: string
  readonly controllerId?: BrowserAttachmentId
  readonly canGoBack: boolean
  readonly canGoForward: boolean
}
```

```ts type-equiv
/**
 * Every attachment begins with the page's metadata plus the most recent image
 * the host holds, then receives images and metadata as they change. Unlike a
 * terminal's ordered byte stream each image is complete, so a slow consumer
 * loses intermediate frames instead of failing the stream.
 */
type BrowserFrame =
  | { readonly type: 'snapshot'; readonly info: HostBrowserPageInfo; readonly image?: BrowserImageFrame }
  | { readonly type: 'image'; readonly image: BrowserImageFrame }
  | { readonly type: 'state'; readonly info: HostBrowserPageInfo }
```

```ts type-equiv
/** One encoded screencast image; `data` is base64 with no data-URL prefix. */
interface BrowserImageFrame {
  readonly data: string
  readonly width: number
  readonly height: number
}
```

## 附着控制

同一时刻只有一个附着持有页面的控制权。后来的附着会接过控制权并把先前的附着降级为观看，因此过期附着的导航、输入与调整尺寸会以 `browser-control-unavailable` 失败，而不是争夺页面；被降级的客户端会在下一个状态帧中看到这一变化，并可以重新索取控制权。分离会释放控制权但不关闭页面，下一个附着从快照续接。

```ts type-equiv
/**
 * Create is idempotent for an open identity; closed identities cannot be
 * recreated. A new page has no destination: navigation belongs to the
 * controlling attachment, which only exists once the client follows the page.
 */
interface BrowserCreateRequest {
  readonly id: HostBrowserPageId
  readonly width: number
  readonly height: number
}
```

## 导航策略

宿主在要求浏览器移动之前先审查目标，因此拒绝是一个带类型的 `browser-navigation-refused` 错误，而不是一张空白页面。只接受 `http` 与 `https`；裸主机名会补全为 `https`；内嵌的 `user:pass@` 凭据会被拒绝；除非运维设置 `allowPrivateAddresses`，回环、链路本地与私有网段都会被拒绝——正是这个开关让宿主自身 localhost 上的工作区开发服务器变得可见，而同样的可达性也覆盖了宿主的内部网络。非空的 `allowedHosts` 会进一步收窄范围，按精确主机或子域匹配。

审查约束的是用户输入的目标。Chromium 自行解析 DNS 并抓取子资源，因此审查通过之后才解析到私有地址的域名不会被重新检查，而且在浏览器之外无法按请求锁定地址——这与拥有自己解析器的模型抓取接缝不同。因此对于需要锁死的部署，运维允许清单才是承重的控制手段。

```ts type-equiv
/** Viewport bounds and policy facts shared by new and restored pages. */
interface HostBrowserEnvironment {
  /** Whether a usable browser executable was found on the host. */
  readonly available: boolean
  /** Why the surface is unusable, when `available` is false. */
  readonly unavailableReason?: string
  readonly maxPages: number
  readonly maxWidth: number
  readonly maxHeight: number
  /** Operator host allowlist; empty means every public host is reachable. */
  readonly allowedHosts: readonly string[]
  /** Whether loopback and private-range destinations are permitted. */
  readonly allowPrivateAddresses: boolean
}
```

## 输入与历史

输入以一小套词汇到达，宿主将其映射到 CDP 的 `Input` 命令：鼠标按下、释放与移动，滚轮增量，按键按下与抬起，以及用于粘贴和输入法提交的合成文本。坐标是页面空间的 CSS 像素，因此客户端从自己渲染的帧换算，宿主永不看到客户端的元素几何。历史移动是导航历史条目而非 back/forward 命令，因为协议暴露的就是条目：宿主读取条目列表并导航到相邻条目，没有相邻条目的移动会被拒绝。

```ts type-equiv
/** History and reload verbs CDP exposes as navigation-history moves. */
type BrowserNavigationAction = 'back' | 'forward' | 'reload' | 'stop'
```

```ts type-equiv
/**
 * One input event forwarded to the page. Coordinates are page-space CSS
 * pixels, so the client scales them from its rendered frame before sending;
 * the host never sees the client's own element geometry.
 */
type BrowserInputEvent =
  | {
    readonly kind: 'mouse'
    readonly type: 'mousePressed' | 'mouseReleased' | 'mouseMoved'
    readonly x: number
    readonly y: number
    readonly button: 'none' | 'left' | 'middle' | 'right'
    readonly clickCount?: number
    readonly modifiers?: number
  }
  | {
    readonly kind: 'wheel'
    readonly x: number
    readonly y: number
    readonly deltaX: number
    readonly deltaY: number
    readonly modifiers?: number
  }
  | {
    readonly kind: 'key'
    readonly type: 'keyDown' | 'keyUp'
    /** DOM `KeyboardEvent.key`. */
    readonly key: string
    /** DOM `KeyboardEvent.code`. */
    readonly code: string
    readonly modifiers?: number
    /** Windows virtual key code, when the client knows one. */
    readonly windowsVirtualKeyCode?: number
    /** Text the key produces; drives the page's `keypress`/input handling. */
    readonly text?: string
  }
  | {
    readonly kind: 'text'
    /** Composed text inserted verbatim (paste and IME commits). */
    readonly text: string
  }
```

## 进程生命周期

在任何启动之前，浏览器程序先在该 Session 自己的执行环境中解析：运维设置了 `executablePath` 就用它，否则按顺序探测 `browserCandidates`——Chrome、Chromium 与 Edge 的 Linux 名称，加上它们在 macOS 与 Windows 上的安装路径。三者皆无的宿主机是受支持的部署，而非失败：`environment` 报告 `available: false`，并给出一条准确指明探测目标的原因，`create` 也带着同样的文本以 `browser-unavailable` 失败，因此面板可以指出补救办法，而不是显示一个不透明的失败。在该状态下，客户端会改为把对话链接交给读者自己的浏览器。

一个 Session 最多启动一个浏览器：启动过程被记忆化，第一个页面将其拉起，释放最后一个页面时将其关停，因此一直关闭的面板不产生任何成本。该进程以 `ambientEnv: 'scrubbed'` 生成——与用户终端不同，它永不继承 harness 凭据——并使用一次性 profile 目录，在浏览器消失时删除。无法观察到退出的浏览器，其 profile 会被记住并在下一次尝试时删除，因此无响应的进程树不会静默泄漏字节。只要沙箱能够启动，Chromium 自身的沙箱就保持开启：其 zygote 拒绝以 root 运行，因此默认值 `sandbox: 'auto'` 仅在该处放弃沙箱。运维可以固定该选择——`'chromium'` 即使浏览器因此无法启动也强制要求沙箱，`'none'` 则始终放弃。始终未报告 DevTools 端点的启动会带着浏览器打印在 stderr 上的内容失败，因此拒绝浏览器的环境会直说原因，而不是抛出不透明的内部错误。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxbrowsercontroller--browsercontroller"></a>

### `ctx.browserController` — `BrowserController`

Typed Remote control of Session-owned host browser pages.

```ts cordis-catalog
/**
 * Report the panel's bounds and the operator's navigation policy, and whether
 * a browser executable exists at all (`harniverse.observe`).
 * @param agent - Session owner supplied by the Gateway.
 * @param signal - request cancellation.
 * @returns the viewport bounds, page limit, and navigation policy.
 */
@Remote({ exportName: 'environment', requiredCapability: 'harniverse.observe' }) async environment(agent: Agent, signal: AbortSignal): Promise<HostBrowserEnvironment>

/**
 * List retained pages without resolving or activating an Agent (`harniverse.observe`).
 * @param sessionId - displayed Session identity, including offline history.
 * @returns pages retained for this Host lifetime.
 */
@Remote({ exportName: 'list', requiredCapability: 'harniverse.observe' }) list(sessionId: SessionId): HostBrowserPageInfo[]

/**
 * Open a page once for a caller-generated identity, launching the Session's
 * browser process on first use (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param request - initial viewport and idempotency identity.
 * @param signal - allocation cancellation; committed pages survive disconnection.
 * @returns the existing or newly committed page.
 */
@Remote({ exportName: 'create', requiredCapability: 'harniverse.operate' }) async create(agent: Agent, request: BrowserCreateRequest, signal: AbortSignal): Promise<HostBrowserPageInfo>

/**
 * Attach to a page without binding its lifetime to the transport.
 * Not a Remote invocation: harniverse's Gateway surface is request/response, so
 * the screencast transport broadcasts the follower frames the EventsApi browser stream drives.
 * @param agent - Session owner supplied by the Gateway.
 * @param id - page identity.
 * @param attachmentId - new exclusive control attachment.
 * @param signal - attachment stream cancellation.
 * @returns the current page image and metadata, then later frames.
 */
follow( agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, signal: AbortSignal, ): AsyncIterable<BrowserFrame>

/**
 * Navigate one page to a host-reviewed destination (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - page identity.
 * @param attachmentId - current controlling attachment.
 * @param url - requested destination as the panel supplied it.
 * @returns the page metadata after the navigation is dispatched.
 */
@Remote({ exportName: 'navigate', requiredCapability: 'harniverse.operate' }) async navigate( agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, url: string, ): Promise<HostBrowserPageInfo>

/**
 * Move one page through history, reload it, or stop loading (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - page identity.
 * @param attachmentId - current controlling attachment.
 * @param action - requested navigation move.
 * @returns the page metadata after the move is dispatched.
 */
@Remote({ exportName: 'act', requiredCapability: 'harniverse.operate' }) async act( agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, action: BrowserNavigationAction, ): Promise<HostBrowserPageInfo>

/**
 * Forward one input event to a page (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - page identity.
 * @param attachmentId - current controlling attachment.
 * @param event - page-space input event.
 * @returns after the browser accepts the event.
 */
@Remote({ exportName: 'input', requiredCapability: 'harniverse.operate' }) async input( agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, event: BrowserInputEvent, ): Promise<void>

/**
 * Resize one page's emulated viewport (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - page identity.
 * @param attachmentId - current controlling attachment.
 * @param width - CSS-pixel width.
 * @param height - CSS-pixel height.
 * @returns the page metadata with the new viewport.
 */
@Remote({ exportName: 'resize', requiredCapability: 'harniverse.operate' }) async resize( agent: Agent, id: HostBrowserPageId, attachmentId: BrowserAttachmentId, width: number, height: number, ): Promise<HostBrowserPageInfo>

/**
 * Close an identity to future creation and close its page; repeated closes succeed (`harniverse.operate`).
 * @param agent - Session owner supplied by the Gateway.
 * @param id - page identity.
 * @returns after the page is gone. A failure retains the page for retry.
 */
@Remote({ exportName: 'close', requiredCapability: 'harniverse.operate' }) async close(agent: Agent, id: HostBrowserPageId): Promise<void>
```

Types: [Agent](core.md) · [SessionId](core.md)

Source: [`packages/api/browser-controller/src/index.ts:123`](../../packages/api/browser-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
