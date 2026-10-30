/** Tool UI slot declarations and their composed component props. */
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * Keyed atomic Tool call view, dispatched by the wire Tool name. Register
     * with `key: '<tool name>'` to own how one tool's calls render inside a
     * turn — the key domain is open (any wire tool name, including a tool your
     * own package registered), so there is no compile-time key set to pick
     * from and a typo simply never renders.
     *
     * A key the shipped composition already covers is replaced, not shared;
     * an unclaimed key falls back to the generic tool row, so registering is
     * additive for your own tool and a takeover for a shipped one. The owner
     * passes the call's identity, its frozen running-or-settled node, the
     * preparation locale seat, and the expansion state (see
     * ToolCallOwnerProps), so the view stays a pure function of what the turn
     * already knows. A `preparing` phase block has no dispatched arguments;
     * `useToolCallArgumentsPartial` optionally subscribes to its raw prefix.
     */
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: ToolCallOwnerProps }
    /**
     * The result-image gallery position inside the Tool details panel —
     * declared by this package's details entry. The shipped occupant renders
     * the shared `ui-attachment` gallery over the model-side view at priority
     * 100; register at a lower priority to replace, dispose to restore. The
     * chat-row gallery inside tool rows is not this seat — it renders within
     * the keyed toolview entries' own layout and keeps the direct gallery.
     */
    'conversation.details.tool.images': { kind: 'single'; scope: 'session'; owner: ToolImagesOwnerProps }
  }
}

/** Owner currency of the details result-image seat: the refs and the model-side loader. */
export interface ToolImagesOwnerProps {
  /** Settled result image references in presentation order. */
  readonly images: readonly ImageAttachmentRef[]
  /** Resolve each image the way the model route received it. */
  load: (attachment: ImageAttachmentRef) => Promise<string>
}

/** Standard owner currency supplied to every atomic Tool view. */
export interface ToolCallOwnerProps {
  /** Tool call identity, stable across running and settled forms. */
  callId: string
  /** Wire Tool name and keyed dispatch value. */
  toolName: string
  /** Frozen running call or settled result node. */
  block: ToolCallBlock
  /** Session workspace root for relative summaries. */
  cwd?: string | undefined
  /** Open a Tool argument path through the Host. */
  openFile: (path: string) => void
  /** Inspect this call in the trajectory view when available. */
  inspect?: (() => void) | undefined
  /**
   * Resolve a result image the way the model route received it (projected
   * request-image bytes; the stored original when unresolvable) for inline
   * display.
   */
  loadModelImage: (attachment: ImageAttachmentRef) => Promise<string>
  /**
   * Tool-namespace translate for preparation copy (`row.preparing`,
   * `tool.preparing.content`); the conversation locale seat cannot carry the
   * Tool layer's own keys.
   */
  tTool: TranslateNS<'tool'>
}

/** Inject face of the Tool call-tree registration: the bound tool dictionary. */
export interface ToolTreeInjected {
  /** Stable Tool-namespace translate (see `locales.ts`). */
  tTool: TranslateNS<'tool'>
}

/** Full props of a registered atomic Tool view. */
export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>

/** Full props of the Tool call-tree renderer registered as a `tool-call` Chat Node. */
export type ToolTreeProps = PropsRuntime<'conversation.chat.node', 'tool-call'>
  & PropsRenderSlots<'tool.call.toolview'>
  & PropsLocale<'conversation'>
  & InjectFace<ToolTreeInjected>

/** Full props of the selected Tool output renderer in the details panel. */
export type ToolDetailsProps = PropsRuntime<'conversation.details.tool'>
  & PropsRenderSlots<'conversation.details.tool.images'>
  & PropsLocale<'conversation'>
