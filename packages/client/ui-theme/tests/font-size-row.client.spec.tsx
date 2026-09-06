// @vitest-environment jsdom
/** FontSizeRow behavior: three tier cubes, selection follows the persisted
 * content font size, clicks drive setContentFontSize. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createSnapshotStore, type SessionListState, type WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { FontSizeRow } from '../src/client/FontSizeRow.tsx'
import type { FontSizeRowComponentProps } from '../src/client/FontSizeRow.tsx'
import { createFontSizeRowStore } from '../src/client/settings-store.ts'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'fontSize.title': '字号',
  'fontSize.small': '小',
  'fontSize.medium': '中',
  'fontSize.large': '大',
}

/** Empty global standard-kit hooks (the row reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function mount(fontSize: number = 16) {
  // Real store instance — the sanctioned zero-machinery path for tests.
  const store = createFontSizeRowStore().create()
  store.actions.sync(fontSize, 0)
  const setContentFontSize = vi.fn()
  const props: FontSizeRowComponentProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useStore: bindSnapshotSelector(store),
    actions: store.actions,
    t: (key: string) => COPY[key] ?? key,
    setContentFontSize,
  }
  render(<FontSizeRow {...props} />)
  return { store, setContentFontSize }
}

const pressed = (name: RegExp): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-pressed')

describe('FontSizeRow', () => {
  it('renders the title and three tiers with the persisted tier selected', () => {
    mount(14)
    expect(screen.getByText('字号')).toBeDefined()
    expect(pressed(/小/)).toBe('true')
    expect(pressed(/中/)).toBe('false')
    expect(pressed(/大/)).toBe('false')
  })

  it('click drives setContentFontSize; selection follows the store mirror, not the click echo', () => {
    const b = mount(16)
    expect(pressed(/中/)).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: /大/ }))
    expect(b.setContentFontSize).toHaveBeenCalledWith(18)
    // No store write yet: selection is unchanged.
    expect(pressed(/中/)).toBe('true')
    act(() => { b.store.actions.sync(18, 1) })
    expect(pressed(/大/)).toBe('true')
    expect(pressed(/中/)).toBe('false')
  })
})
