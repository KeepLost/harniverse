// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import {
  createSnapshotStore, type SessionListState, type WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { LinkDestinationRow } from '../src/client/settings/LinkDestinationRow.tsx'
import type { LinkDestinationRowProps } from '../src/client/settings/LinkDestinationRow.tsx'
import { DEFAULT_LINK_DESTINATION, type LinkDestination } from '../src/conversation-settings.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

function emptySessions() {
  return bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined, selectionSeq: 0,
  }))
}

function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  }))
}

function mount() {
  const destination = createSnapshotStore<LinkDestination>(DEFAULT_LINK_DESTINATION)
  const setLinkDestination = vi.fn((next: LinkDestination) => { destination.set(next) })
  const props: LinkDestinationRowProps = {
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useLinkDestination: bindSnapshotSelector(destination),
    setLinkDestination,
    t: makeTranslate(en),
  }
  render(<LinkDestinationRow {...props} />)
  return { destination, setLinkDestination }
}

describe('LinkDestinationRow', () => {
  it('shows the host browser as the shipped destination', () => {
    mount()
    expect(screen.getByText('Where links open')).toBeDefined()
    expect(screen.getByText('The host browser reaches the host\u2019s own network; your browser opens a new tab')).toBeDefined()
    expect(screen.getByRole('button', { name: /Host browser/ }).getAttribute('aria-expanded')).toBe('false')
  })

  it('switches the destination to the reader\u2019s own browser and follows a later change', () => {
    const b = mount()
    fireEvent.click(screen.getByRole('button', { name: /Host browser/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Your browser' }))
    expect(b.setLinkDestination).toHaveBeenCalledWith('device')
    expect(screen.getByRole('button', { name: /Your browser/ })).toBeDefined()

    act(() => { b.destination.set('panel') })
    fireEvent.click(screen.getByRole('button', { name: /Host browser/ }))
    expect(screen.getByRole('menuitem', { name: 'Your browser' })).toBeDefined()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menuitem', { name: 'Your browser' })).toBeNull()
  })
})
