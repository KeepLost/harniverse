/** Host browser page identities, metadata, input vocabulary, and stream frames. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** A host browser page scoped to one Session and one Host lifetime. */
export type HostBrowserPageId = Branded<'HostBrowserPageId'>
/** An attachment allowed to navigate and drive input on one page. */
export type BrowserAttachmentId = Branded<'BrowserAttachmentId'>

/** Viewport bounds and policy facts shared by new and restored pages. */
export interface HostBrowserEnvironment {
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

/**
 * Host-owned page state. `url` and `title` track the page's own navigations,
 * including the ones a script initiates, because the host observes the real
 * browser rather than a URL the client asked for.
 */
export interface HostBrowserPageInfo {
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

/**
 * Create is idempotent for an open identity; closed identities cannot be
 * recreated. A new page has no destination: navigation belongs to the
 * controlling attachment, which only exists once the client follows the page.
 */
export interface BrowserCreateRequest {
  readonly id: HostBrowserPageId
  readonly width: number
  readonly height: number
}

/** History and reload verbs CDP exposes as navigation-history moves. */
export type BrowserNavigationAction = 'back' | 'forward' | 'reload' | 'stop'

/**
 * One input event forwarded to the page. Coordinates are page-space CSS
 * pixels, so the client scales them from its rendered frame before sending;
 * the host never sees the client's own element geometry.
 */
export type BrowserInputEvent =
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

/** One encoded screencast image; `data` is base64 with no data-URL prefix. */
export interface BrowserImageFrame {
  readonly data: string
  readonly width: number
  readonly height: number
}

/**
 * Every attachment begins with the page's metadata plus the most recent image
 * the host holds, then receives images and metadata as they change. Unlike a
 * terminal's ordered byte stream each image is complete, so a slow consumer
 * loses intermediate frames instead of failing the stream.
 */
export type BrowserFrame =
  | { readonly type: 'snapshot'; readonly info: HostBrowserPageInfo; readonly image?: BrowserImageFrame }
  | { readonly type: 'image'; readonly image: BrowserImageFrame }
  | { readonly type: 'state'; readonly info: HostBrowserPageInfo }
