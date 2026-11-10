/** React bindings for the framework-neutral slot and snapshot contracts. */
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

export { bindSnapshotSelector } from './bind.ts'

/**
 * Selector hook over a session's conversation snapshot. Wide (`object`) by
 * default inside this dependency-inverted package; runtime narrows it once at
 * its exports (`UseSession<ConversationSnapshot>`) — the snapshot type
 * never flows back into web-react.
 */
export type UseSession<Snap extends object = object> = SnapshotSelectorHook<Snap>

export type {
  ChainRenderOpts, HostObservable, KeyedStandardSource, RenderOpts, SnapshotSelectorHook,
  ScopedStandardSourceBinding, SlotRenderer, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'
export { SlotOwnershipError, StaleAuthorizationError } from '@deepseek-ai/dsh-client-ui-slots'
export { createSlotRenderer } from './scoped-slots.tsx'

export { SlotAssemblyError } from './errors.ts'

export { useInvoke } from './use-invoke.ts'
