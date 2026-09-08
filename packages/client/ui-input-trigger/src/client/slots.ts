/**
 * Overlay-slot contract surface of the slash plugin. The
 * 'conversation.input.overlay' slot is OWNED by the ui-conversation composer
 * entry (declaring is claiming: anchor, children declaration, lifecycle),
 * but the SlotMap type merge lives here: the owner package depends on this
 * one, so the dependency direction admits no reverse type import, and a
 * type-erased registration is ruled out. The owner's
 * program picks this merge up transitively through its ui-input-trigger imports.
 */
// Type-only edge: the SlotMap augmentation below merges into this package's interface.
import type { MouseEvent } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { MenuState } from '../core/contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The InputBar floating overlay anchor: MenuView (this package) and the
     * popupSelect shell (ui-commands) contribute list entries; each reads its
     * own store and renders null while closed. Declared (children table) by
     * ui-conversation's composer entry; the anchor hides with the input
     * under a takeover.
     */
    'conversation.input.overlay': { kind: 'list'; scope: 'session' }
    /**
     * The named commands seat at the head of the composer tool row, left of
     * the file-choose affordance — one occupant: this package's CommandSeat
     * (the plus button). Same SlotMap-here/declaration-there split as the
     * overlay above: the owner package depends on this one, never the
     * reverse. The owner share is the bar's disable state, its focus
     * keeper, and the click-time textarea/machine context a synthetic '/'
     * trigger aims at; the entry owns the button, the launcher's expanded
     * state, and the toggle. Unoccupied, the seat renders nothing at all —
     * the bar paints no placeholder, and the button's appearance rides this
     * plugin's own activation (no composer-side service probing).
     */
    'conversation.input.commands': {
      kind: 'single'
      scope: 'session'
      owner: {
        /** Session-removed lock (the bar's chrome disable state). */
        locked: boolean
        /** Mousedown focus keeper (button presses must not steal textarea focus). */
        keepFocus: (event: MouseEvent<HTMLButtonElement>) => void
        /** Snapshot the bar-side trigger context, or undefined without a textarea. */
        captureContext: () => CommandToggleContext | undefined
      }
    }
  }
}

/** Injected business face of the MenuView overlay entry (copy rides the standard locale seat, not this face). */
export interface MenuViewInjected {
  /** The service's menu state store (read-only here; MenuView subscribes). */
  menu: SnapshotStore<MenuState>
  /**
   * Pointer pick routed back through the service pipeline.
   * @param source - source (group) name.
   * @param index - candidate index within the group.
   */
  onPick: (source: string, index: number) => void
  /** Dismiss the menu (external pointer outside the composer area). */
  onDismiss: () => void
}

/**
 * Bar-side context for one synthetic '/' trigger aimed from the commands
 * seat. The owner package (ui-conversation, which depends on this one)
 * captures it at click time from its textarea and input machine.
 */
export interface CommandToggleContext {
  /** Selection endpoints the synthetic trigger span covers. */
  readonly selection: { readonly start: number; readonly end: number }
  /** True when the draft before the selection start is blank (a leading trigger). */
  readonly leading: boolean
  /** Current draft revision, stamped into the span for pick-time CAS. */
  readonly draftRev: number
  /** Dismiss the open autocomplete popup before the menu opens. */
  readonly dismissPopup: () => void
}

/** Injected business face of the commands seat entry (copy rides the standard locale seat, not this face). */
export interface CommandSeatInjected {
  /**
   * Toggle the shared menu over exactly the command source, aiming a
   * synthetic '/' hit from the captured bar context.
   * @param context - the bar-side trigger context captured at click time.
   */
  toggle: (context: CommandToggleContext) => void
  /** Registrant hooks compartment: the launcher state (open source name or null). */
  hooks: {
    launcher: SnapshotStore<string | null>
  }
}
