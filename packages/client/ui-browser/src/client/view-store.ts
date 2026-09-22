/**
 * The browser panel's shared viewing state: center-column occupancy. The page
 * list, the active tab, and the stream facts live in the panel controller's own
 * snapshot store (surviving view remounts with the plugin fiber); the
 * register-declared store carries the occupancy fact the sidebar trigger
 * mirrors as its pressed affordance and dies with the app session. The module
 * exports the factory only (a module-level handle would pin the store identity
 * across plugin reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Browser panel viewing state shared by the sidebar trigger and the panel. */
export interface BrowserViewState {
  /** Whether the browser panel occupies the center column. */
  open: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type BrowserViewActions = {
  setOpen: (draft: BrowserViewState, open: boolean) => void
}

/**
 * Create the browser panel viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createBrowserViewStore(): EngineStoreHandle<BrowserViewState, BrowserViewActions> {
  return defineStore({
    init: (): BrowserViewState => ({ open: false }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
    },
  })
}
