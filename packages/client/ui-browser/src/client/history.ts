/**
 * The browser panel's shared viewing state: center-column occupancy plus the
 * app-owned navigation history. History lives in the register-declared store
 * (not component state) so it survives view remounts — a session switch
 * clears the center view and the panel remounts with its trail intact — and
 * dies with the app session. The module exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads).
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Bounded history length: past the cap the oldest entry drops. */
const HISTORY_CAP = 50

/** Browser panel viewing state shared by the sidebar trigger and the panel. */
export interface BrowserViewState {
  /** Whether the browser panel occupies the center column. */
  open: boolean
  /** Visited hrefs, oldest first; consecutive duplicates collapse. */
  entries: string[]
  /** Index of the current entry within `entries`, or -1 before the first. */
  cursor: number
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type BrowserViewActions = {
  setOpen: (draft: BrowserViewState, open: boolean) => void
  visit: (draft: BrowserViewState, url: string) => void
  back: (draft: BrowserViewState) => void
  forward: (draft: BrowserViewState) => void
}

/**
 * Create the browser panel viewing store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createBrowserViewStore(): EngineStoreHandle<BrowserViewState, BrowserViewActions> {
  return defineStore({
    init: (): BrowserViewState => ({ open: false, entries: [], cursor: -1 }),
    actions: {
      setOpen: (d, open: boolean) => { d.open = open },
      visit: (d, url: string) => {
        if (d.entries[d.cursor] === url) return
        d.entries.length = d.cursor + 1
        d.entries.push(url)
        if (d.entries.length > HISTORY_CAP) d.entries.splice(0, d.entries.length - HISTORY_CAP)
        d.cursor = d.entries.length - 1
      },
      back: (d) => { if (d.cursor > 0) d.cursor -= 1 },
      forward: (d) => { if (d.cursor < d.entries.length - 1) d.cursor += 1 },
    },
  })
}
