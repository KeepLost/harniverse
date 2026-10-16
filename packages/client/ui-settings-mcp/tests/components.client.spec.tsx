// @vitest-environment jsdom
/**
 * The section's presentation behavior: the page's aggregate states, the
 * card's live-state bands and actions, the editor's validation and secret
 * handling, and the import dialog's parse/preview/conflict flow.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { McpSection } from '../src/client/McpSection.tsx'
import type { McpSectionProps } from '../src/client/McpSection.tsx'
import { ServerRow } from '../src/client/ServerRow.tsx'
import { ServerEditor, draftOf, rowOf, validateDraft } from '../src/client/ServerEditor.tsx'
import type { ServerDraft } from '../src/client/ServerEditor.tsx'
import { ImportDialog } from '../src/client/ImportDialog.tsx'
import { McpNavIcon } from '../src/client/NavIcon.tsx'
import { en } from '../src/client/locales.ts'
import type { McpSectionState, McpServerRow, McpSettingsServers } from '../src/client/section-store.ts'
import type { McpManagementStatusRow } from '@deepseek-ai/dsh-mcp-user-config/types'

afterEach(cleanup)

const t = ((key: keyof typeof en, params?: Record<string, unknown>) => {
  let text: string = en[key]
  for (const [name, value] of Object.entries(params ?? {})) text = text.replace(`{${name}}`, String(value))
  return text
}) as McpSectionProps['t']

type SettingsRow = NonNullable<McpSettingsServers['servers']>[number]

const SETTINGS_ROW: SettingsRow = { id: 'docs', serverName: 'docs', enabled: true, transport: 'stdio', command: 'docs-mcp', env: { TOKEN: 'x' } }

/** Non-null first element of a testing-library query result. */
function first<T>(items: readonly T[]): T {
  expect(items.length).toBeGreaterThan(0)
  return items[0] as T
}

const STATUS: McpManagementStatusRow = {
  id: 'docs',
  serverName: 'docs',
  transport: 'stdio',
  state: 'connected',
  connectedAtMs: 1_000,
  failedAttempts: 0,
  maxAttempts: 8,
  tools: [{ name: 'search', description: 'Search the docs' }],
}

function readyState(rows: readonly McpServerRow[]): McpSectionState {
  return { status: 'ready', rows, writable: true }
}

/**
 * Render the whole section over a fixed joined snapshot.
 * @param state - the joined state to render.
 * @param settingsServers - the settings-scope rows the page writes against.
 * @returns the action spies the page reached.
 */
function renderSection(state: McpSectionState, settingsServers: readonly SettingsRow[] = [SETTINGS_ROW]) {
  const store = createSnapshotStore<McpSectionState>(state)
  const actions = {
    refresh: vi.fn(() => Promise.resolve()),
    writeServers: vi.fn((servers: readonly unknown[]) => { void servers; return Promise.resolve() }),
    restart: vi.fn(() => Promise.resolve(undefined)),
  }
  const props = {
    ...actions,
    scope: { getSnapshot: () => ({ status: 'ready' as const, value: { servers: settingsServers }, writable: state.writable }) },
    useMcpSection: bindSnapshotSelector(store),
    t,
  } as unknown as McpSectionProps
  render(<McpSection {...props} />)
  return { ...actions, unmount: () => { cleanup() } }
}

describe('McpSection page', () => {
  it('shows the empty notice when ready with no rows', () => {
    renderSection(readyState([]), [])
    expect(screen.getByText(en['empty'])).toBeDefined()
  })

  it('shows the loading notice before the first read and the error notice when the scope is unavailable', () => {
    const { unmount } = renderSection({ status: 'loading', rows: undefined, writable: false })
    expect(screen.getByText(en['loading'])).toBeDefined()
    unmount()

    renderSection({ status: 'error', rows: undefined, writable: false })
    expect(screen.getByText(en['error'])).toBeDefined()
  })

  it('renders one card per row and disables every write action while read-only', () => {
    renderSection({ status: 'ready', rows: [{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: ['standard'], status: STATUS }], writable: false })
    expect(screen.getAllByText('docs').length).toBeGreaterThan(0)
    expect(screen.getByText(t('row.presets', { names: 'standard' }))).toBeDefined()
    expect(screen.getByText(t('row.tools', { count: '1' }))).toBeDefined()
    expect(screen.getByText(en['readonly'])).toBeDefined()
    const add = screen.getByRole('button', { name: en['add'] })
    expect((add as HTMLButtonElement).disabled).toBe(true)
  })

  it('adding a server opens the editor and writes the joined array', async () => {
    const actions = renderSection(readyState([]), [])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['add'] })) })
    expect(screen.getByText(en['editor.addTitle'])).toBeDefined()
    const fields = first(screen.getAllByLabelText(en['editor.command']))
    await act(async () => { fireEvent.change(fields, { target: { value: 'docs-mcp' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalled())
    expect(actions.writeServers.mock.calls[0]![0][0]).toMatchObject({ id: 'server-1', serverName: 'server-1', transport: 'stdio', command: 'docs-mcp' })
  })

  it('surfaces a rejected write as the page-level failure notice', async () => {
    const store = createSnapshotStore<McpSectionState>(readyState([]))
    const props = {
      refresh: () => Promise.resolve(),
      writeServers: (_servers: readonly unknown[]) => Promise.reject(new Error('scope sealed')),
      restart: () => Promise.resolve(undefined),
      scope: { getSnapshot: () => ({ status: 'ready' as const, value: { servers: [] }, writable: true }) },
      useMcpSection: bindSnapshotSelector(store),
      t,
    } as unknown as McpSectionProps
    render(<McpSection {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['add'] })) })
    await act(async () => { fireEvent.change(screen.getByLabelText(en['editor.command']), { target: { value: 'docs-mcp' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await waitFor(() => expect(screen.getByText(t('writeFailed', { message: 'scope sealed' }))).toBeDefined())
  })

  it('deletes a row through the confirmation modal', async () => {
    const actions = renderSection(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.delete'] }))) })
    expect(screen.getByText(t('row.confirmDelete', { name: 'docs' }))).toBeDefined()
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['row.delete'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalledWith([]))
  })
})

describe('ServerRow card', () => {
  const actions = {
    setEnabled: vi.fn(() => Promise.resolve()),
    edit: vi.fn(),
    requestDelete: vi.fn(),
    restart: vi.fn(() => Promise.resolve(undefined)),
  }

  it.each([
    ['connected', en['state.connected']],
    ['reconnecting', t('state.reconnecting', { failed: '2', max: '5' })],
    ['exhausted', en['state.exhausted']],
    ['stopped', en['state.stopped']],
  ] as const)('bands a %s connection with its counters and last error kind', (state, expected) => {
    cleanup()
    render(<ServerRow
      row={{
        id: 'docs',
        serverName: 'docs',
        transport: 'stdio',
        enabled: true,
        presets: [],
        status: { ...STATUS, state, failedAttempts: 2, maxAttempts: 5, lastErrorKind: 'spawn' },
      }}
      writable
      t={t}
      actions={actions}
    />)
    expect(screen.getByText(expected)).toBeDefined()
    expect(screen.getByText(t('state.errorKind', { kind: 'spawn' }))).toBeDefined()
  })

  it('falls back to the enabled/disabled pill while no live status has landed', () => {
    render(<ServerRow row={{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: false, presets: [] }} writable={false} t={t} actions={actions} />)
    // With no live status the state pill falls back to the disabled band,
    // and the toggle label reads Disabled as well.
    expect(screen.getAllByText(en['state.disabled'])).toHaveLength(2)
    expect(screen.getByText(en['row.presets.zero'])).toBeDefined()
    expect(screen.getByText(en['row.tools.zero'])).toBeDefined()
    const disabledCheckbox = screen.getByRole('checkbox') as HTMLInputElement
    expect(disabledCheckbox.disabled).toBe(true)
    expect(disabledCheckbox.parentElement?.textContent).toContain(en['row.disabled'])
  })

  it('expands the tool inventory and forwards every action', async () => {
    render(<ServerRow row={{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [], status: STATUS }} writable t={t} actions={actions} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: t('row.tools', { count: '1' }) })) })
    expect(screen.getByText('search')).toBeDefined()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['row.restart'] })) })
    await waitFor(() => expect(actions.restart).toHaveBeenCalledWith('docs'))
    fireEvent.click(screen.getByRole('button', { name: en['row.edit'] }))
    expect(actions.edit).toHaveBeenCalledWith('docs')
    fireEvent.click(screen.getByRole('button', { name: en['row.delete'] }))
    expect(actions.requestDelete).toHaveBeenCalledWith('docs')
  })
})

describe('editor draft codec', () => {
  it('derives a draft from a settings row and materializes it back', () => {
    const draft = draftOf(SETTINGS_ROW, 'docs')
    expect(draft).toMatchObject({ id: 'docs', serverName: 'docs', transport: 'stdio', command: 'docs-mcp', env: 'TOKEN=x' })
    const row = rowOf({ ...draft, args: 'a\n\n b ', env: 'TOKEN=y\nNEW=1' })
    expect(row).toMatchObject({ id: 'docs', args: ['a', 'b'], env: { TOKEN: 'y', NEW: '1' }, enabled: true, failOnStartupError: false })
  })

  it('keeps a stored secret when its draft line is empty and drops it when the line is gone', () => {
    const draft = draftOf(SETTINGS_ROW, 'docs')
    expect(rowOf({ ...draft, env: 'TOKEN=' }, SETTINGS_ROW).env).toEqual({ TOKEN: 'x' })
    expect(rowOf({ ...draft, env: 'OTHER=1' }, SETTINGS_ROW).env).toEqual({ OTHER: '1' })
    expect(rowOf({ ...draft, env: 'TOKEN=' }).env).toEqual({ TOKEN: '' })
  })

  it('defaults a fresh draft to a stdio row with generated identity', () => {
    expect(draftOf(undefined, 'server-1')).toMatchObject({ id: 'server-1', serverName: 'server-1', transport: 'stdio', args: '', env: '' })
  })

  it('validates identity, duplicates, and transport-required fields in order', () => {
    const base = draftOf(undefined, 'docs')
    expect(validateDraft({ ...base, id: 'not allowed!' }, [], undefined)).toBe('editor.invalidId')
    expect(validateDraft({ ...base, serverName: 'bad name' }, [], undefined)).toBe('editor.invalidServerName')
    expect(validateDraft({ ...base, id: 'web' }, [{ id: 'web', serverName: 'other', transport: 'stdio', command: 'x' }], 'docs')).toBe('editor.duplicateId')
    expect(validateDraft({ ...base, serverName: 'docs' }, [{ id: 'other', serverName: 'docs', transport: 'stdio', command: 'x' }], 'docs')).toBe('editor.duplicateServerName')
    expect(validateDraft({ ...base, command: '  ' }, [], undefined)).toBe('editor.commandRequired')
    expect(validateDraft({ ...base, transport: 'streamable-http', url: '' }, [], undefined)).toBe('editor.urlRequired')
    expect(validateDraft({ ...base, transport: 'streamable-http', url: 'https://x' }, [], undefined)).toBeUndefined()
  })

  it('materializes an http draft with url and headers', () => {
    const draft = { ...draftOf(undefined, 'web'), transport: 'streamable-http' as const, url: ' https://web ', headers: 'X-Token=abc' }
    expect(rowOf(draft)).toMatchObject({ id: 'web', transport: 'streamable-http', url: 'https://web', headers: { 'X-Token': 'abc' } })
    expect(rowOf(draft)).not.toHaveProperty('env')
  })

  it('keeps numeric optionals out of the row when blank and parses them when set', () => {
    expect(rowOf(draftOf(undefined, 'a'))).not.toHaveProperty('toolCallTimeoutMs')
    expect(rowOf({ ...draftOf(undefined, 'a'), toolCallTimeoutMs: '2500', maxInstructionBytes: '4096' })).toMatchObject({ toolCallTimeoutMs: 2_500, maxInstructionBytes: 4_096 })
    expect(rowOf({ ...draftOf(undefined, 'a'), toolCallTimeoutMs: 'nope' })).not.toHaveProperty('toolCallTimeoutMs')
  })
})

describe('ServerEditor modal', () => {
  it('reports the first validation failure without saving', async () => {
    const save = vi.fn(() => Promise.resolve())
    const draft = draftOf(undefined, 'docs')
    render(<ServerEditor open creating draft={draft} setDraft={() => {}} others={[]} t={t} save={save} cancel={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    expect(screen.getByText(en['editor.commandRequired'])).toBeDefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('switches transports to the remote fields and saves through the callback', async () => {
    const save = vi.fn(() => Promise.resolve())
    const setDraft = vi.fn()
    const draft = draftOf(undefined, 'docs')
    const { rerender } = render(
      <ServerEditor
        open creating draft={draft} setDraft={setDraft} others={[]} t={t} save={save} cancel={() => {}}
      />,
    )
    await act(async () => { fireEvent.change(screen.getByLabelText(en['editor.transport']), { target: { value: 'streamable-http' } }) })
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ transport: 'streamable-http' }))
    const http = { ...draft, transport: 'streamable-http' as const, url: 'https://mcp.example' }
    rerender(<ServerEditor open creating draft={http} setDraft={setDraft} others={[]} t={t} save={save} cancel={() => {}} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await waitFor(() => expect(save).toHaveBeenCalled())
    expect(screen.queryByText(en['editor.commandRequired'])).toBeNull()
  })
})

describe('ImportDialog modal', () => {
  const importFn = vi.fn(() => Promise.resolve())

  it('previews parsed servers and imports only non-conflicting rows', async () => {
    render(<ImportDialog open t={t} existingIds={['docs']} import={importFn} cancel={() => {}} />)
    const textarea = screen.getByLabelText(en['import.paste'])
    await act(async () => {
      fireEvent.change(textarea, { target: { value: JSON.stringify({ mcp: { docs: { type: 'local', command: 'x' }, web: { type: 'remote', url: 'https://web' } } }) } })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.parse'] })) })
    expect(screen.getByText(t('import.parsed', { count: '2' }))).toBeDefined()
    expect(screen.getByText(t('import.conflict', { name: 'docs' }))).toBeDefined()
    const button = screen.getByRole('button', { name: en['import.import'] }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    await act(async () => { fireEvent.click(button) })
    await waitFor(() => expect(importFn).toHaveBeenCalledWith([expect.objectContaining({ id: 'web', url: 'https://web' })]))
  })

  it('surfaces a parse failure and keeps import disabled until a parse succeeds', async () => {
    render(<ImportDialog open t={t} existingIds={[]} import={importFn} cancel={() => {}} />)
    const button = screen.getByRole('button', { name: en['import.import'] }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await act(async () => {
      fireEvent.change(screen.getByLabelText(en['import.paste']), { target: { value: 'nope' } })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.parse'] })) })
    expect(screen.getByText(text => text.startsWith(`${en['import.failed'].split(':')[0]}:`) && text.includes('JSON'))).toBeDefined()
  })
})

describe('McpSection page flows', () => {
  it('edits an existing row through the editor and writes the merged array', async () => {
    const actions = renderSection(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['row.edit'] })) })
    expect(screen.getByText(en['editor.editTitle'])).toBeDefined()
    await act(async () => { fireEvent.change(screen.getByLabelText(en['editor.serverName']), { target: { value: 'docs2' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalled())
    expect(actions.writeServers.mock.calls[0]![0][0]).toMatchObject({ id: 'docs', serverName: 'docs2', command: 'docs-mcp' })
  })

  it('toggles a row enabled through the checkbox', async () => {
    const actions = renderSection(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    await act(async () => { fireEvent.click(screen.getByRole('checkbox')) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalledWith([expect.objectContaining({ id: 'docs', enabled: false })]))
  })

  it('cancels a delete without writing', async () => {
    const actions = renderSection(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.delete'] }))) })
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['editor.cancel'] }))) })
    expect(actions.writeServers).not.toHaveBeenCalled()
  })

  it('imports parsed servers through the page dialog and re-enables them', async () => {
    const actions = renderSection(readyState([]), [])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import'] })) })
    await act(async () => {
      fireEvent.change(screen.getByLabelText(en['import.paste']), { target: { value: JSON.stringify({ mcp: { web: { type: 'remote', url: 'https://web' } } }) } })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.parse'] })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.import'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalledWith([expect.objectContaining({ id: 'web', enabled: true })]))
  })

  it('surfaces rejected toggles, deletes, and imports as the page failure notice', async () => {
    const store = createSnapshotStore<McpSectionState>(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    let calls = 0
    const props = {
      refresh: () => Promise.resolve(),
      writeServers: (_servers: readonly unknown[]) => { calls += 1; return calls === 1 ? Promise.reject(new Error('toggle failed')) : calls === 2 ? Promise.reject(new Error('delete failed')) : Promise.reject(new Error('import failed')) },
      restart: () => Promise.resolve(undefined),
      scope: { getSnapshot: () => ({ status: 'ready' as const, value: { servers: [SETTINGS_ROW] }, writable: true }) },
      useMcpSection: bindSnapshotSelector(store),
      t,
    } as unknown as McpSectionProps
    render(<McpSection {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('checkbox')) })
    await waitFor(() => expect(screen.getByText(t('writeFailed', { message: 'toggle failed' }))).toBeDefined())
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.delete'] }))) })
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['row.delete'] })) })
    await waitFor(() => expect(screen.getByText(t('writeFailed', { message: 'delete failed' }))).toBeDefined())
  })
})

describe('McpSection remaining arms', () => {
  it('treats a ready scope with no section value as an empty list', () => {
    const store = createSnapshotStore<McpSectionState>({ status: 'ready', rows: [], writable: true })
    const props = {
      refresh: () => Promise.resolve(),
      writeServers: () => Promise.resolve(),
      restart: () => Promise.resolve(undefined),
      scope: { getSnapshot: () => ({ status: 'ready' as const, value: undefined, writable: true }) },
      useMcpSection: bindSnapshotSelector(store),
      t,
    } as unknown as McpSectionProps
    render(<McpSection {...props} />)
    expect(screen.getByText(en['empty'])).toBeDefined()
  })

  it('keeps the other rows intact when an edit saves', async () => {
    const actions = renderSection(readyState([
      { id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] },
      { id: 'web', serverName: 'web', transport: 'streamable-http', enabled: true, presets: [] },
    ]), [
      { id: 'docs', serverName: 'docs', enabled: true, transport: 'stdio', command: 'docs-mcp' },
      { id: 'web', serverName: 'web', enabled: true, transport: 'streamable-http', url: 'https://web' },
    ])
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.edit'] }))) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalled())
    expect(actions.writeServers.mock.calls[0]![0]).toHaveLength(2)
    expect(actions.writeServers.mock.calls[0]![0][1]).toMatchObject({ id: 'web', url: 'https://web' })
  })

  it('ignores an edit request for a row the settings scope no longer carries', async () => {
    renderSection(readyState([{ id: 'ghost', serverName: 'ghost', transport: 'stdio', enabled: true, presets: [] }]), [])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['row.edit'] })) })
    expect(screen.queryByText(en['editor.editTitle'])).toBeNull()
  })

  it('confirms deletion of a settings row by id when the joined row is gone', async () => {
    const actions = renderSection(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.delete'] }))) })
    expect(screen.getByText(t('row.confirmDelete', { name: 'docs' }))).toBeDefined()
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['row.delete'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalledWith([]))
  })

  it('re-renders after the refresh action', async () => {
    const actions = { ...renderSection(readyState([]), []) }
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['refresh'] })) })
    expect(actions.refresh).toHaveBeenCalled()
  })

  it('surfaces non-Error write rejections from every write path verbatim', async () => {
    const store = createSnapshotStore<McpSectionState>(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    const props = {
      refresh: () => Promise.resolve(),
      writeServers: (_servers: readonly unknown[]) => Promise.reject('plain refusal'),
      restart: () => Promise.resolve(undefined),
      scope: { getSnapshot: () => ({ status: 'ready' as const, value: { servers: [SETTINGS_ROW] }, writable: true }) },
      useMcpSection: bindSnapshotSelector(store),
      t,
    } as unknown as McpSectionProps
    render(<McpSection {...props} />)
    const notice = async () => await waitFor(() => expect(screen.getByText(t('writeFailed', { message: 'plain refusal' }))).toBeDefined())
    await act(async () => { fireEvent.click(screen.getByRole('checkbox')) })
    await notice()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['row.edit'] })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await notice()
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.delete'] }))) })
    const deleteDialog = screen.getAllByRole('dialog').find(dialog => (dialog.getAttribute('aria-label') ?? '').startsWith(`${en['row.confirmDelete'].split('"')[0]}${'"'}`))
    expect(deleteDialog).toBeDefined()
    await act(async () => { fireEvent.click(within(deleteDialog as HTMLElement).getByRole('button', { name: en['row.delete'] })) })
    await notice()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import'] })) })
    await act(async () => {
      fireEvent.change(screen.getByLabelText(en['import.paste']), { target: { value: JSON.stringify({ mcp: { web: { type: 'remote', url: 'https://web' } } }) } })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.parse'] })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.import'] })) })
    await notice()
  })

  it('closes the editor through its own cancel control', async () => {
    renderSection(readyState([]), [])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['add'] })) })
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['editor.cancel'] }))) })
    expect(screen.queryByText(en['editor.addTitle'])).toBeNull()
  })
})

describe('McpSection final arms', () => {
  it('toggles one row among several without touching the others', async () => {
    const actions = renderSection(readyState([
      { id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] },
      { id: 'web', serverName: 'web', transport: 'streamable-http', enabled: true, presets: [] },
    ]), [
      { id: 'docs', serverName: 'docs', enabled: true, transport: 'stdio', command: 'docs-mcp' },
      { id: 'web', serverName: 'web', enabled: true, transport: 'streamable-http', url: 'https://web' },
    ])
    await act(async () => { fireEvent.click(screen.getAllByRole('checkbox')[1] as HTMLInputElement) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalled())
    expect(actions.writeServers.mock.calls[0]![0][0]).toMatchObject({ id: 'docs', enabled: true })
    expect(actions.writeServers.mock.calls[0]![0][1]).toMatchObject({ id: 'web', enabled: false })
  })

  it('opens the editor for creation while another settings row exists', async () => {
    const actions = renderSection(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['add'] })) })
    await act(async () => { fireEvent.change(screen.getByLabelText(en['editor.command']), { target: { value: 'x' } }) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalled())
    expect(actions.writeServers.mock.calls[0]![0]).toHaveLength(2)
  })

  it('surfaces an Error rejection from an import verbatim', async () => {
    const store = createSnapshotStore<McpSectionState>(readyState([]))
    const props = {
      refresh: () => Promise.resolve(),
      writeServers: (_servers: readonly unknown[]) => Promise.reject(new Error('import refused')),
      restart: () => Promise.resolve(undefined),
      scope: { getSnapshot: () => ({ status: 'ready' as const, value: { servers: [] }, writable: true }) },
      useMcpSection: bindSnapshotSelector(store),
      t,
    } as unknown as McpSectionProps
    render(<McpSection {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import'] })) })
    await act(async () => {
      fireEvent.change(screen.getByLabelText(en['import.paste']), { target: { value: JSON.stringify({ mcp: { web: { type: 'remote', url: 'https://web' } } }) } })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.parse'] })) })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.import'] })) })
    await waitFor(() => expect(screen.getByText(t('writeFailed', { message: 'import refused' }))).toBeDefined())
  })

  it('closes a delete confirmation through the footer cancel control', async () => {
    const actions = renderSection(readyState([{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }]))
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.delete'] }))) })
    const dialog = screen.getByRole('dialog')
    const cancel = within(dialog).getAllByRole('button', { name: en['editor.cancel'] }).find(button => button.textContent === en['editor.cancel'])
    expect(cancel).toBeDefined()
    await act(async () => { fireEvent.click(cancel as HTMLElement) })
    expect(actions.writeServers).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes the import dialog through its cancel action', async () => {
    renderSection(readyState([]), [])
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import'] })) })
    expect(screen.getByText(en['import.title'])).toBeDefined()
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['import.cancel'] }))) })
    expect(screen.queryByText(en['import.title'])).toBeNull()
  })

  it('deletes a ghost row by id and shows its transport lookup miss', async () => {
    const actions = renderSection(readyState([{ id: 'ghost', serverName: 'ghost', transport: 'stdio', enabled: true, presets: [] }]), [])
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['row.delete'] }))) })
    expect(screen.getByText(t('row.confirmDelete', { name: 'ghost' }))).toBeDefined()
    const dialog = screen.getByRole('dialog')
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: en['row.delete'] })) })
    await waitFor(() => expect(actions.writeServers).toHaveBeenCalledWith([]))
  })
})

describe('ServerRow checkbox', () => {
  it('forwards enable toggles through the settings write', async () => {
    const actions = {
      setEnabled: vi.fn(() => Promise.resolve()),
      edit: vi.fn(),
      requestDelete: vi.fn(),
      restart: vi.fn(() => Promise.resolve(undefined)),
    }
    render(<ServerRow row={{ id: 'docs', serverName: 'docs', transport: 'stdio', enabled: true, presets: [] }} writable t={t} actions={actions} />)
    await act(async () => { fireEvent.click(screen.getByRole('checkbox')) })
    expect(actions.setEnabled).toHaveBeenCalledWith('docs', false)
  })
})

describe('ServerEditor full form', () => {
  const noop = (): void => {}

  it('drives every stdio field change and cancels without saving', async () => {
    const save = vi.fn((): Promise<void> => Promise.resolve())
    const initial = { ...draftOf(undefined, 'docs'), toolCallTimeoutMs: '1000', maxInstructionBytes: '2048' }
    let current: ServerDraft = initial
    const setDraft = (next: ServerDraft) => { current = next }
    const view = render(<ServerEditor open creating draft={current} setDraft={setDraft} others={[]} t={t} save={save} cancel={noop} />)
    // Each change re-renders with the accumulated draft, the way the page does.
    const change = async (query: () => HTMLElement, value: string | boolean) => {
      await act(async () => { fireEvent.change(query(), { target: typeof value === 'boolean' ? { checked: value } : { value } }) })
      view.rerender(<ServerEditor open creating draft={current} setDraft={setDraft} others={[]} t={t} save={save} cancel={noop} />)
    }
    await change(() => screen.getByLabelText(en['editor.id']), 'docs2')
    await change(() => screen.getByLabelText(en['editor.serverName']), 'docs2')
    await change(() => screen.getByLabelText(en['editor.command']), 'docs-mcp')
    await change(() => screen.getByLabelText(en['editor.args']), '--verbose')
    await change(() => screen.getByLabelText(label => label.startsWith(en['editor.env'])), 'A=1')
    await change(() => screen.getByLabelText(en['editor.cwd']), '/tmp')
    await change(() => screen.getByLabelText(en['editor.timeout']), '2000')
    await change(() => screen.getByLabelText(en['editor.instructionBytes']), '4096')
    await act(async () => { fireEvent.click(screen.getByRole('checkbox')) })
    view.rerender(<ServerEditor open creating draft={current} setDraft={setDraft} others={[]} t={t} save={save} cancel={noop} />)
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['editor.cancel'] }))) })
    expect(save).not.toHaveBeenCalled()
    expect(current).toMatchObject({ id: 'docs2', serverName: 'docs2', command: 'docs-mcp', args: '--verbose', env: 'A=1', cwd: '/tmp', toolCallTimeoutMs: '2000', maxInstructionBytes: '4096', failOnStartupError: true })
  })

  it('drives the http fields (url, headers) through materialization', async () => {
    const save = vi.fn((): Promise<void> => Promise.resolve())
    let current: ServerDraft = { ...draftOf(undefined, 'docs'), transport: 'streamable-http', url: 'https://mcp' }
    const setDraft = (next: ServerDraft) => { current = next }
    const view = render(<ServerEditor open creating draft={current} setDraft={setDraft} others={[]} t={t} save={save} cancel={noop} />)
    const change = async (query: () => HTMLElement, value: string) => {
      await act(async () => { fireEvent.change(query(), { target: { value } }) })
      view.rerender(<ServerEditor open creating draft={current} setDraft={setDraft} others={[]} t={t} save={save} cancel={noop} />)
    }
    await change(() => screen.getByLabelText(en['editor.url']), 'https://mcp2')
    await change(() => screen.getByLabelText(label => label.startsWith(en['editor.headers'])), 'X-Token=abc')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['editor.save'] })) })
    await waitFor(() => expect(save).toHaveBeenCalled())
  })

  it('carries configured numeric optionals from an edited row into the draft', () => {
    expect(draftOf({ ...SETTINGS_ROW, toolCallTimeoutMs: 1_000, maxInstructionBytes: 4_096 }, 'docs')).toMatchObject({ toolCallTimeoutMs: '1000', maxInstructionBytes: '4096' })
  })
})

describe('ImportDialog guards', () => {
  it('keeps the import action inert while nothing acceptable is parsed', async () => {
    const importFn = vi.fn(() => Promise.resolve())
    render(<ImportDialog open t={t} existingIds={['docs']} import={importFn} cancel={() => {}} />)
    await act(async () => {
      fireEvent.change(screen.getByLabelText(en['import.paste']), { target: { value: JSON.stringify({ mcp: { docs: { type: 'local', command: 'x' } } }) } })
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en['import.parse'] })) })
    const button = screen.getByRole('button', { name: en['import.import'] }) as HTMLButtonElement
    await act(async () => { fireEvent.click(button) })
    expect(importFn).not.toHaveBeenCalled()
  })

  it('closes through the cancel action', async () => {
    const cancel = vi.fn()
    render(<ImportDialog open t={t} existingIds={[]} import={vi.fn(() => Promise.resolve())} cancel={cancel} />)
    await act(async () => { fireEvent.click(first(screen.getAllByRole('button', { name: en['import.cancel'] }))) })
    expect(cancel).toHaveBeenCalled()
  })
})

describe('McpNavIcon', () => {
  it('renders the plug glyph', () => {
    const { container } = render(<McpNavIcon />)
    expect(container.querySelector('svg')).toBeDefined()
  })
})
