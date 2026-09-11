/**
 * The schedules management surface's shared viewing state: whether the
 * center view currently occupies the center column. The occupying view
 * writes the fact on mount/unmount (the frame is the authority); the
 * sidebar footer trigger reads it for its pressed affordance. Module level
 * exports the factory only (a module-level handle would pin the store
 * identity across plugin reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Schedules surface viewing state shared by the sidebar trigger and the center view. */
type ScheduleViewState = {
  /** Whether the schedules center view occupies the center column. */
  open: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type ScheduleViewActions = {
  setOpen: (draft: ScheduleViewState, open: boolean) => void
}

/**
 * Create the schedules surface viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createScheduleViewStore(): EngineStoreHandle<ScheduleViewState, ScheduleViewActions> {
  return defineStore({
    init: (): ScheduleViewState => ({ open: false }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
    },
  })
}
