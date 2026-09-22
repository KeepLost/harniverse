# Browser Controller

English | [中文](browser-controller.zh.md)

The [browser-controller package](../../packages/api/browser-controller/README.md) serves real host browser pages to the browser panel: one `ctx.browserController` Remote owns a Chromium process per Session over the subprocess spawn seam, drives it through the Chrome DevTools Protocol, and reports each page as screencast images plus page metadata so a reconnecting client recovers the current picture. Page traffic leaves the HOST's network position, which is the entire point of the surface — a workspace dev server on the host's own loopback is reachable, the target sees the host's address, and a page that refuses embedding renders normally because nothing is embedded. The panel is a carrier for a human: the controller registers no tools and emits no session events, and the model's own fetching stays in the [web subsystem](web.md) with its separate pinned-lookup policy. This page owns the browser-panel wire shapes from [`packages/api/browser-controller/src/types.ts`](../../packages/api/browser-controller/src/types.ts); the host `apiproxy` carries the stream face (`events.browser` SSE) beside the unary `browser/*` gateway endpoints.

## Page identity and frames

A page is scoped to one Session and one Host lifetime; closing an identity retires it rather than recycling it. A new page has no destination, because navigation belongs to the controlling attachment, which only exists once a client follows the page. Every attachment begins with a snapshot carrying the current metadata and the most recent image the host holds, then receives images and metadata as they change. Unlike a terminal's ordered byte stream each image is complete, so a follower keeps only the newest image and the newest metadata: a slow consumer loses intermediate frames and never fails its stream.

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

## Attachment control

One attachment at a time holds control of a page. A later attachment takes control and demotes the earlier one to watching, so navigation, input and resize from a stale attachment fail `browser-control-unavailable` instead of fighting for the page; the demoted client sees the change in the next state frame and can ask for control back. Detaching releases control without closing the page, and the next attachment resumes from the snapshot.

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

## Navigation policy

The host reviews a destination before the browser is asked to move, so a refusal is a typed `browser-navigation-refused` error rather than a blank page. Only `http` and `https` are accepted; a bare host is completed to `https`; embedded `user:pass@` credentials are rejected; and loopback, link-local and private ranges are rejected unless the operator sets `allowPrivateAddresses` — the switch that makes a workspace dev server on the host's own localhost visible, and which by the same reachability covers the host's internal network. A non-empty `allowedHosts` narrows the surface further, matching a host exactly or as a subdomain.

The review binds the destination the user typed. Chromium resolves DNS and fetches subresources itself, so a name that resolves to a private address after the review passes is not re-checked, and no per-request address pinning is possible from outside the browser — unlike the model's fetch seam, which owns its own resolver. The operator allowlist is therefore the load-bearing control for a locked-down deployment.

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

## Input and history

Input arrives as a small vocabulary the host maps onto CDP `Input` commands: mouse press, release and move, wheel deltas, key down and up, and composed text for paste and IME commits. Coordinates are page-space CSS pixels, so the client scales them from its rendered frame and the host never sees the client's element geometry. History moves are navigation-history entries rather than a back/forward command, because that is what the protocol exposes: the host reads the entry list and navigates to a neighbour, and a move with no neighbour is refused.

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

## Process lifetime

One Session launches at most one browser: the launch is memoized, the first page starts it, and releasing the last page shuts it down, so a panel left closed costs nothing. The process spawns with `ambientEnv: 'scrubbed'` — unlike the user's terminals it never inherits harness credentials — under a throwaway profile directory that is removed when the browser goes away. A profile whose browser cannot be observed exiting is remembered and removed on the next attempt, so an unresponsive process tree cannot leak bytes silently. Chromium's own sandbox stays on unless the operator waives it, which is required when the harness runs as root.

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

Source: [`packages/api/browser-controller/src/index.ts:114`](../../packages/api/browser-controller/src/index.ts)
<!-- END GENERATED cordis-surface -->
