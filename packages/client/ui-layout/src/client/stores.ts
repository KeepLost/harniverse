/**
 * The root entry's layout store: transient sidebar geometry plus persisted
 * per-Workspace right-region preferences. Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  WORKBENCH_DEFAULT, WORKBENCH_MAX, WORKBENCH_MIN,
} from './columns.ts'

/** The two plugin-owned surfaces sharing the shell's physical right region. */
export type RightPanelMode = 'details' | 'workbench'

/** Persisted right-region preferences for one Workspace account. */
export interface RightPanelPreference {
  mode: RightPanelMode
  open: boolean
  widths: { details: number; workbench: number }
}

/** Empty string is the browser-local account for Sessions outside a Workspace. */
export const UNGROUPED_RIGHT_ACCOUNT = ''
/** Non-persisted account prefix used while Workspace baselines are unresolved. */
export const PROVISIONAL_RIGHT_ACCOUNT_PREFIX = '\0provisional:'

const RIGHT_PERSIST_KEY = 'dsh.layout.right.v1'

function defaultRightPreference(): RightPanelPreference {
  return {
    mode: 'details',
    open: false,
    widths: { details: DETAILS_DEFAULT, workbench: WORKBENCH_DEFAULT },
  }
}

function rightPreference(value: unknown): RightPanelPreference | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { mode?: unknown; open?: unknown; widths?: unknown }
  if (candidate.mode !== 'details' && candidate.mode !== 'workbench') return undefined
  if (typeof candidate.open !== 'boolean' || typeof candidate.widths !== 'object' || candidate.widths === null) return undefined
  const widths = candidate.widths as Partial<RightPanelPreference['widths']>
  if (typeof widths.details !== 'number' || !Number.isFinite(widths.details)
    || typeof widths.workbench !== 'number' || !Number.isFinite(widths.workbench)) return undefined
  return {
    mode: candidate.mode,
    open: candidate.open,
    widths: {
      details: clampWidth(widths.details, DETAILS_MIN, DETAILS_MAX),
      workbench: clampWidth(widths.workbench, WORKBENCH_MIN, WORKBENCH_MAX),
    },
  }
}

function restoreRightPreferences(value: unknown): Record<string, RightPanelPreference> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const restored: Record<string, RightPanelPreference> = {}
  for (const [key, entry] of Object.entries(value)) {
    const preference = rightPreference(entry)
    if (preference !== undefined) restored[key] = preference
  }
  return restored
}

function ensureRight(draft: LayoutState): RightPanelPreference {
  return draft.rightByAccount[draft.activeRightAccount] ??= defaultRightPreference()
}

/**
 * Layout store state: transient sidebar and active-account state, persisted
 * right-region preferences, plus the narrow-viewport pair. `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that re-expands the auto-collapsed
 * sidebar over the squeezed center without rewriting the width preference.
 */
export type LayoutState = {
  sidebar: number
  activeRightAccount: string
  rightByAccount: Record<string, RightPanelPreference>
  narrow: boolean
  narrowExpanded: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setActiveRightAccount: (draft: LayoutState, account: string) => void
  setRightWidth: (draft: LayoutState, mode: RightPanelMode, px: number) => void
  resetRightWidth: (draft: LayoutState, mode: RightPanelMode) => void
  retainRightAccounts: (draft: LayoutState, accounts: readonly string[]) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openWorkbench: (draft: LayoutState) => void
  closeWorkbench: (draft: LayoutState) => void
}

/**
 * Create the layout panel store handle. Closing preserves the independent
 * details and workbench widths; reopening restores the active mode's prior
 * preference, while double-click reset writes that mode's default. Actions
 * are the complete write set and drag writes stay within the mode's range.
 * Below the auto-collapse breakpoint (AppFrame feeds setNarrow), the sidebar
 * toggle flips the narrowExpanded override instead of the preference.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT,
      activeRightAccount: UNGROUPED_RIGHT_ACCOUNT,
      rightByAccount: {},
      narrow: false,
      narrowExpanded: false,
    }),
    persist: {
      name: RIGHT_PERSIST_KEY,
      select: (state: LayoutState): unknown => Object.fromEntries(
        Object.entries(state.rightByAccount).filter(([account]) => !account.startsWith(PROVISIONAL_RIGHT_ACCOUNT_PREFIX)),
      ),
      restore: (stored: unknown, initial: LayoutState): LayoutState => ({
        ...initial,
        rightByAccount: restoreRightPreferences(stored),
      }),
    },
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setActiveRightAccount: (d, account: string) => {
        const previous = d.activeRightAccount
        if (previous.startsWith(PROVISIONAL_RIGHT_ACCOUNT_PREFIX) && !account.startsWith(PROVISIONAL_RIGHT_ACCOUNT_PREFIX)) {
          const provisional = d.rightByAccount[previous]
          if (provisional !== undefined) {
            const existing = d.rightByAccount[account]
            if (existing === undefined) {
              d.rightByAccount[account] = provisional
            } else {
              const defaults = defaultRightPreference()
              d.rightByAccount[account] = {
                mode: provisional.mode,
                open: provisional.open,
                widths: {
                  details: provisional.widths.details === defaults.widths.details ? existing.widths.details : provisional.widths.details,
                  workbench: provisional.widths.workbench === defaults.widths.workbench
                    ? existing.widths.workbench
                    : provisional.widths.workbench,
                },
              }
            }
            d.rightByAccount = Object.fromEntries(
              Object.entries(d.rightByAccount).filter(([key]) => key !== previous),
            )
          }
        }
        d.activeRightAccount = account
      },
      setRightWidth: (d, mode: RightPanelMode, px: number) => {
        ensureRight(d).widths[mode] = mode === 'details'
          ? clampWidth(px, DETAILS_MIN, DETAILS_MAX)
          : clampWidth(px, WORKBENCH_MIN, WORKBENCH_MAX)
      },
      resetRightWidth: (d, mode: RightPanelMode) => {
        ensureRight(d).widths[mode] = mode === 'details' ? DETAILS_DEFAULT : WORKBENCH_DEFAULT
      },
      retainRightAccounts: (d, accounts: readonly string[]) => {
        const retained = new Set(accounts)
        if (Object.keys(d.rightByAccount).every(key => retained.has(key))) return
        d.rightByAccount = Object.fromEntries(
          Object.entries(d.rightByAccount).filter(([key]) => retained.has(key)),
        )
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      openDetails: (d) => { const right = ensureRight(d); right.mode = 'details'; right.open = true },
      closeDetails: (d) => { ensureRight(d).open = false },
      openWorkbench: (d) => { const right = ensureRight(d); right.mode = 'workbench'; right.open = true },
      closeWorkbench: (d) => { ensureRight(d).open = false },
    },
  })
  return handle
}

/**
 * Resolve the active account without allocating a persisted default on reads.
 * @param state - current layout state.
 * @returns the active account's preference or a fresh default.
 */
export function activeRightPreference(state: LayoutState): RightPanelPreference {
  return state.rightByAccount[state.activeRightAccount] ?? defaultRightPreference()
}

/**
 * Resolve one Workspace account without mutating the persisted preference map.
 * @param state - current layout state.
 * @param account - Workspace id or the ungrouped browser-local account.
 * @returns the account's preference or a fresh default.
 */
export function rightPreferenceFor(state: LayoutState, account: string): RightPanelPreference {
  return state.rightByAccount[account] ?? defaultRightPreference()
}
