/**
 * The governor board's shared viewing state: whether the center view
 * currently occupies the center column. The occupying view writes the fact
 * on mount/unmount (the frame is the authority); the sidebar footer trigger
 * reads it for its pressed affordance. Module level exports the factory only
 * (a module-level handle would pin the store identity across plugin
 * reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Governor surface viewing state shared by the sidebar trigger and the board. */
type GovernorViewState = {
  /** Whether the governor board occupies the center column. */
  open: boolean
  /** Active in-page tab id (a `governor.center.tab` entry id, resources first). */
  tab: string
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type GovernorViewActions = {
  setOpen: (draft: GovernorViewState, open: boolean) => void
  setTab: (draft: GovernorViewState, tab: string) => void
}

/**
 * Create the governor surface viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createGovernorViewStore(): EngineStoreHandle<GovernorViewState, GovernorViewActions> {
  return defineStore({
    init: (): GovernorViewState => ({ open: false, tab: 'resources' }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
      setTab: (d, tab: string) => { d.tab = tab },
    },
  })
}
