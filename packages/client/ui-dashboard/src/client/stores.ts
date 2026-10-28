/**
 * The dashboard's shared viewing state: whether the center view currently
 * occupies the center column, and which in-page tab is active. The occupying
 * view writes the occupancy fact on mount/unmount (the frame is the
 * authority); the sidebar footer trigger reads it for its pressed
 * affordance. Module level exports the factory only (a module-level handle
 * would pin the store identity across plugin reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Dashboard viewing state shared by the sidebar trigger and the center view. */
type DashboardViewState = {
  /** Whether the dashboard occupies the center column. */
  open: boolean
  /** Active in-page tab id (a `dashboard.center.tab` entry id; empty selects the first). */
  tab: string
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type DashboardViewActions = {
  setOpen: (draft: DashboardViewState, open: boolean) => void
  setTab: (draft: DashboardViewState, tab: string) => void
}

/**
 * Create the dashboard viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createDashboardViewStore(): EngineStoreHandle<DashboardViewState, DashboardViewActions> {
  return defineStore({
    init: (): DashboardViewState => ({ open: false, tab: '' }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
      setTab: (d, tab: string) => { d.tab = tab },
    },
  })
}
