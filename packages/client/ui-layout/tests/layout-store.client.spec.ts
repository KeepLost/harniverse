// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and the absence of browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createLayoutStore, PROVISIONAL_RIGHT_ACCOUNT_PREFIX, UNGROUPED_RIGHT_ACCOUNT,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  WORKBENCH_DEFAULT, WORKBENCH_MAX, WORKBENCH_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.right.v1'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      activeRightAccount: UNGROUPED_RIGHT_ACCOUNT,
      rightByAccount: {},
      narrow: false,
      narrowExpanded: false,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('clamps sidebar, details, and workbench widths into their contract ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setRightWidth('details', 1)
    expect(store.getSnapshot().rightByAccount['']?.widths.details).toBe(DETAILS_MIN)
    actions.setRightWidth('details', 9999)
    expect(store.getSnapshot().rightByAccount['']?.widths.details).toBe(DETAILS_MAX)
    actions.setRightWidth('workbench', 1)
    expect(store.getSnapshot().rightByAccount['']?.widths.workbench).toBe(WORKBENCH_MIN)
    actions.setRightWidth('workbench', 9999)
    expect(store.getSnapshot().rightByAccount['']?.widths.workbench).toBe(WORKBENCH_MAX)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toMatchObject({ sidebar: 400, narrow: true, narrowExpanded: true })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('switches right modes while preserving their independent widths across close and reset', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    actions.setRightWidth('details', 500)
    actions.openWorkbench()
    actions.setRightWidth('workbench', 900)
    actions.closeDetails()
    expect(store.getSnapshot().rightByAccount['']).toEqual({
      mode: 'workbench',
      open: false,
      widths: { details: 500, workbench: 900 },
    })
    actions.openDetails()
    expect(store.getSnapshot().rightByAccount['']).toMatchObject({ mode: 'details', open: true })
    actions.resetRightWidth('details')
    actions.resetRightWidth('workbench')
    expect(store.getSnapshot().rightByAccount['']?.widths).toEqual({
      details: DETAILS_DEFAULT,
      workbench: WORKBENCH_DEFAULT,
    })
  })

  it('persists only per-Workspace right preferences and retains transient sidebar defaults', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.setActiveRightAccount('workspace-a')
    first.actions.openDetails()
    first.actions.setRightWidth('details', 500)
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({
      'workspace-a': {
        mode: 'details', open: true, widths: { details: 500, workbench: WORKBENCH_DEFAULT },
      },
    })

    const second = createLayoutStore().create()
    expect(second.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
    expect(second.store.getSnapshot().activeRightAccount).toBe(UNGROUPED_RIGHT_ACCOUNT)
    expect(second.store.getSnapshot().rightByAccount['workspace-a']).toEqual({
      mode: 'details', open: true, widths: { details: 500, workbench: WORKBENCH_DEFAULT },
    })
  })

  it('does not persist provisional accounts and migrates their explicit choices when baselines resolve', () => {
    const { store, actions } = createLayoutStore().create()
    const provisional = `${PROVISIONAL_RIGHT_ACCOUNT_PREFIX}s-a`
    actions.setActiveRightAccount(provisional)
    actions.openWorkbench()
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({})

    actions.setActiveRightAccount('workspace-a')
    expect(store.getSnapshot().rightByAccount).toEqual({
      'workspace-a': { mode: 'workbench', open: true, widths: { details: DETAILS_DEFAULT, workbench: WORKBENCH_DEFAULT } },
    })
  })

  it('merges provisional choices over an existing account without resetting untouched widths', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setActiveRightAccount('workspace-a')
    actions.openDetails()
    actions.setRightWidth('details', 500)
    actions.setRightWidth('workbench', 900)

    const provisional = `${PROVISIONAL_RIGHT_ACCOUNT_PREFIX}s-a`
    actions.setActiveRightAccount(provisional)
    actions.openWorkbench()
    actions.setRightWidth('details', 420)
    actions.setActiveRightAccount('workspace-a')

    expect(store.getSnapshot().rightByAccount['workspace-a']).toEqual({
      mode: 'workbench', open: true, widths: { details: 420, workbench: 900 },
    })
    actions.setActiveRightAccount(`${PROVISIONAL_RIGHT_ACCOUNT_PREFIX}s-b`)
    actions.setActiveRightAccount('workspace-b')
    expect(store.getSnapshot().rightByAccount['workspace-b']).toBeUndefined()
  })

  it('isolates and prunes Workspace accounts explicitly', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setActiveRightAccount('a')
    actions.openDetails()
    actions.setActiveRightAccount('b')
    actions.openWorkbench()
    expect(store.getSnapshot().rightByAccount.a?.mode).toBe('details')
    expect(store.getSnapshot().rightByAccount.b?.mode).toBe('workbench')
    actions.retainRightAccounts(['b'])
    expect(store.getSnapshot().rightByAccount).toEqual({
      b: { mode: 'workbench', open: true, widths: { details: DETAILS_DEFAULT, workbench: WORKBENCH_DEFAULT } },
    })
  })

  it('does not publish when every stored Workspace account remains valid', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setActiveRightAccount('a')
    actions.openDetails()
    let publications = 0
    const dispose = store.subscribe(() => { publications++ })

    actions.retainRightAccounts(['', 'a'])

    expect(publications).toBe(0)
    dispose()
  })
})
