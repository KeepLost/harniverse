/**
 * The terminal panel's shared viewing state: center-column occupancy. The
 * terminal list, the active tab, and the stream facts live in the panel
 * controller's own snapshot store (surviving view remounts with the plugin
 * fiber); the register-declared store carries the occupancy fact the sidebar
 * trigger mirrors as its pressed affordance and dies with the app session.
 * The module exports the factory only (a module-level handle would pin the
 * store identity across plugin reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Terminal panel viewing state shared by the sidebar trigger and the panel. */
export interface TerminalViewState {
  /** Whether the terminal panel occupies the center column. */
  open: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type TerminalViewActions = {
  setOpen: (draft: TerminalViewState, open: boolean) => void
}

/**
 * Create the terminal panel viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createTerminalViewStore(): EngineStoreHandle<TerminalViewState, TerminalViewActions> {
  return defineStore({
    init: (): TerminalViewState => ({ open: false }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
    },
  })
}
