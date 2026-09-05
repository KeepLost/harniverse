// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityCatalogEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { CapabilityCompositionTab, type CapabilityCompositionTabProps } from '../src/client/CapabilityCompositionTab.tsx'
import type { CapabilityCompositionState } from '../src/client/controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const TARGET = { kind: 'global-agent' } as const
const ENTRIES = [{
  id: 'tool:bash',
  kind: 'tool' as const,
  name: 'bash',
  description: 'Run shell commands.',
  provenance: 'upstream' as const,
  assembleable: true,
  available: true,
  defaultLoaded: true,
  manageable: true,
  owner: 'ctx.tools',
  requires: [],
  members: [{ id: 'tool:bash/tool:read', kind: 'tool' as const, name: 'read', description: 'Read files.', defaultVisible: true, available: true, requires: [] }, { id: 'tool:bash/tool:write', kind: 'tool' as const, name: 'write', description: 'Write files.', defaultVisible: true, available: true, requires: [] }],
  memberSelection: 'inherit' as const,
  memberEntries: [{ id: 'tool:bash/tool:read', kind: 'tool' as const, name: 'read', description: 'Read files.', defaultVisible: true, available: true, requires: [], visible: true }, { id: 'tool:bash/tool:write', kind: 'tool' as const, name: 'write', description: 'Write files.', defaultVisible: true, available: true, requires: [], visible: true }],
  customization: {
    fields: [{ id: 'text', kind: 'text' as const, name: 'Persona', description: 'Agent identity.', multiline: true }],
    defaultValues: { text: 'Default persona' },
  },
  configOverrides: {},
  effectiveConfig: { text: 'Default persona' },
  selection: 'inherit' as const,
  effectiveSelection: 'load' as const,
  selected: true,
}, {
  id: 'subagent-provider:spawn',
  kind: 'subagent-provider' as const,
  name: 'spawn',
  description: 'In-process child Agent provider.',
  provenance: 'harniverse-adapted' as const,
  assembleable: false,
  available: true,
  defaultLoaded: true,
  manageable: false,
  owner: 'ctx.subagents',
  requires: [],
  selection: 'inherit' as const,
  effectiveSelection: 'load' as const,
  selected: true,
}]

const READY: CapabilityCompositionState = {
  status: 'ready',
  error: null,
  profiles: [{ id: 'standard', name: 'Standard' }, { id: 'minimal', name: 'Minimal' }],
  target: TARGET,
  catalog: {
    target: TARGET,
    revision: 1,
    topologyRevision: 4,
    complete: true,
    entries: ENTRIES,
  },
  draft: {},
  plan: null,
  planning: false,
  applying: false,
}

function renderTab(patch: Partial<CapabilityCompositionState> = {}) {
  const store = createSnapshotStore<CapabilityCompositionState>({ ...READY, ...patch })
  const actions = {
    load: vi.fn(async () => {}),
    selectTarget: vi.fn(async () => {}),
    setSelection: vi.fn(),
    setMembers: vi.fn(),
    setConfig: vi.fn(),
    discard: vi.fn(),
    preview: vi.fn(async () => {}),
    apply: vi.fn(async () => {}),
  }
  const props = {
    ...actions,
    useCapabilityComposition: bindSnapshotSelector(store),
    t: (key: keyof typeof en) => en[key],
  } as unknown as CapabilityCompositionTabProps
  render(<CapabilityCompositionTab {...props} />)
  return actions
}

function rowFor(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { name })
  const row = heading.closest('li')
  if (row === null) throw new Error(`no capability row for ${name}`)
  return row
}

describe('CapabilityCompositionTab', () => {
  it('loads once and exposes global plus Profile targets', async () => {
    const actions = renderTab()
    await waitFor(() => { expect(actions.load).toHaveBeenCalledOnce() })

    const target = screen.getByRole('combobox', { name: en.target })
    expect(within(target).getByRole('option', { name: en.globalTarget })).toBeTruthy()
    expect(within(target).getByRole('option', { name: 'Standard' })).toBeTruthy()
    fireEvent.change(target, { target: { value: 'profile:minimal' } })
    expect(actions.selectTarget).toHaveBeenCalledWith({ kind: 'agent-profile', agentProfile: 'minimal' })
  })

  it('shows provenance and stages selections only for manageable capabilities', () => {
    const actions = renderTab()
    const bash = rowFor('bash')
    expect(within(bash).getByText(en.provenanceUpstream)).toBeTruthy()
    expect(within(bash).getByText(en.selectedLoad)).toBeTruthy()
    fireEvent.click(within(bash).getByRole('radio', { name: en.unload }))
    expect(actions.setSelection).toHaveBeenCalledWith('tool:bash', 'unload')

    const spawn = rowFor('spawn')
    expect(within(spawn).getByText(en.readOnly)).toBeTruthy()
    expect(within(spawn).queryByRole('radio')).toBeNull()
  })

  it('stages an explicit built-in member allowlist and owner-declared configuration', () => {
    const actions = renderTab()
    const bash = rowFor('bash')
    fireEvent.click(within(bash).getAllByText(new RegExp(en.members))[0]!)
    fireEvent.click(within(bash).getByRole('checkbox', { name: /write/i }))
    expect(actions.setMembers).toHaveBeenCalledWith('tool:bash', ['tool:bash/tool:read'])
    fireEvent.click(within(bash).getAllByText(en.configuration)[0]!)
    fireEvent.change(within(bash).getByRole('textbox', { name: /Persona/ }), {
      target: { value: 'Reviewer persona' },
    })
    expect(actions.setConfig).toHaveBeenCalledWith('tool:bash', { text: 'Reviewer persona' })
  })

  it('keeps unavailable Profile capabilities selectable and explains inherited composition', () => {
    const target = { kind: 'agent-profile', agentProfile: 'minimal' } as const
    const actions = renderTab({
      target,
      catalog: {
        ...READY.catalog!,
        target,
        entries: [{
          ...ENTRIES[0]!,
          defaultLoaded: false,
          effectiveSelection: 'unload',
          selected: false,
        }],
      },
    })
    const bash = rowFor('bash')
    expect(within(bash).getByText(en.inheritedGlobalUnload)).toBeTruthy()
    const load = within(bash).getByRole('radio', { name: en.load }) as HTMLInputElement
    expect(load.disabled).toBe(false)
    fireEvent.click(load)
    expect(actions.setSelection).toHaveBeenCalledWith('tool:bash', 'load')
  })

  it('previews a draft and withholds Apply from a blocked plan', () => {
    const blocked = {
      id: 'plan-1',
      target: TARGET,
      expectedRevision: 1,
      topologyRevision: 4,
      operations: [{ capabilityId: 'tool:bash', before: 'inherit' as const, after: 'unload' as const }],
      blockers: [{
        code: 'required-unloaded' as const,
        capabilityId: 'tool:bash',
        dependencyId: 'tool:read',
        message: 'bash requires read',
      }],
      result: ENTRIES,
    }
    const actions = renderTab({ draft: { 'tool:bash': { selection: 'unload' } }, plan: blocked })

    fireEvent.click(screen.getByRole('button', { name: en.preview }))
    expect(actions.preview).toHaveBeenCalledOnce()
    expect(screen.getByRole('alert').textContent).toContain('bash requires read')
    expect(screen.getByRole('button', { name: en.apply }).hasAttribute('disabled')).toBe(true)
  })

  it('offers Apply for an unblocked preview and keeps generic failures private', () => {
    const clearPlan = {
      id: 'plan-1',
      target: TARGET,
      expectedRevision: 1,
      topologyRevision: 4,
      operations: [{ capabilityId: 'tool:bash', before: 'inherit' as const, after: 'unload' as const }],
      blockers: [],
      result: ENTRIES,
    }
    const actions = renderTab({ draft: { 'tool:bash': { selection: 'unload' } }, plan: clearPlan, error: 'stale revision' })
    expect(screen.getByRole('alert').textContent).toBe(en.error)
    expect(screen.queryByText('stale revision')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.apply }))
    expect(actions.apply).toHaveBeenCalledOnce()
  })
})

type EntryOverrides = { [K in keyof CapabilityCatalogEntry]?: CapabilityCatalogEntry[K] | undefined }

const entryOf = (overrides: EntryOverrides = {}): CapabilityCatalogEntry => {
  const entry = new Map<string, unknown>(Object.entries(ENTRIES[0]!))
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) entry.delete(key)
    else entry.set(key, value)
  }
  return Object.fromEntries(entry) as unknown as CapabilityCatalogEntry
}

function tabWith(entries: CapabilityCatalogEntry[], patch: Partial<CapabilityCompositionState> = {}) {
  const actions = renderTab({
    catalog: { ...READY.catalog!, entries },
    ...patch,
  })
  return actions
}

describe('CapabilityCompositionTab rendering corners', () => {
  it('parses the global value when the target select moves back to it', () => {
    const actions = renderTab({ target: { kind: 'agent-profile', agentProfile: 'minimal' } })
    fireEvent.change(screen.getByRole('combobox', { name: en.target }), { target: { value: 'global' } })
    expect(actions.selectTarget).toHaveBeenCalledWith({ kind: 'global-agent' })
  })

  it('renders a staged member allowlist and stages additions of hidden members', () => {
    const actions = renderTab({
      draft: { 'tool:bash': { members: ['tool:bash/tool:write'] } },
    })
    const bash = rowFor('bash')
    expect(within(bash).getByText(`${en.memberSummary}: 1/2`)).toBeTruthy()
    const write = within(bash).getByRole('checkbox', { name: /write/i }) as HTMLInputElement
    const read = within(bash).getByRole('checkbox', { name: /read/i }) as HTMLInputElement
    expect(write.checked).toBe(true)
    expect(read.checked).toBe(false)

    fireEvent.click(read)
    expect(actions.setMembers).toHaveBeenCalledWith('tool:bash', ['tool:bash/tool:read', 'tool:bash/tool:write'])
  })

  it('restores inherited membership from the members section', () => {
    const actions = renderTab()
    const bash = rowFor('bash')
    fireEvent.click(within(bash).getAllByText(new RegExp(en.members))[0]!)
    fireEvent.click(within(bash).getByRole('button', { name: en.restoreMembers }))
    expect(actions.setMembers).toHaveBeenCalledWith('tool:bash', 'inherit')
  })

  it('edits a staged configuration draft over its own base', () => {
    const actions = renderTab({
      draft: { 'tool:bash': { config: { text: 'Draft persona' } } },
    })
    const bash = rowFor('bash')
    fireEvent.click(within(bash).getAllByText(en.configuration)[0]!)
    const editor = within(bash).getByRole('textbox', { name: /Persona/ }) as HTMLTextAreaElement
    expect(editor.value).toBe('Draft persona')
    fireEvent.change(editor, { target: { value: 'Edited persona' } })
    expect(actions.setConfig).toHaveBeenCalledWith('tool:bash', { text: 'Edited persona' })
  })

  it('prefers the translated description for known plugins', () => {
    tabWith([entryOf({ id: 'plugin:tool-bash' })])
    const bash = rowFor('bash')
    expect(within(bash).getByText(en.descriptionBash)).toBeTruthy()
    expect(within(bash).queryByText('Run shell commands.')).toBeNull()
  })

  it('marks a selected capability whose implementation went unavailable', () => {
    tabWith([entryOf({ available: false })])
    expect(within(rowFor('bash')).getByText(en.implementationUnavailable)).toBeTruthy()
  })

  it('names the inherited global default on a Profile target', () => {
    renderTab({ target: { kind: 'agent-profile', agentProfile: 'minimal' } })
    expect(within(rowFor('bash')).getByText(en.inheritedGlobalLoad)).toBeTruthy()
    expect(screen.getByText(en.profileHint)).toBeTruthy()
  })

  it('omits the owner line without an owner and counts requirements', () => {
    tabWith([entryOf({ owner: undefined, requires: ['tool:read'] })])
    const bash = rowFor('bash')
    expect(within(bash).queryByText(new RegExp(en.owner))).toBeNull()
    expect(within(bash).getByText(`${en.requires}: 1`)).toBeTruthy()
  })

  it('names the persona field with its shipped copy', () => {
    tabWith([entryOf({ id: 'plugin:persona' })])
    const bash = rowFor('bash')
    expect(within(bash).getByText(en.personaText)).toBeTruthy()
    expect(within(bash).getByText(en.personaTextDescription)).toBeTruthy()
  })

  it('edits boolean configuration through a checkbox', () => {
    const actions = tabWith([entryOf({
      customization: {
        fields: [{ id: 'flag', kind: 'boolean', name: 'Flag', description: 'A flag.' }],
        defaultValues: { flag: true },
      },
      effectiveConfig: { flag: true },
    })])
    const bash = rowFor('bash')
    fireEvent.click(within(bash).getAllByText(en.configuration)[0]!)
    const flag = within(bash).getByRole('checkbox', { name: /Flag/ }) as HTMLInputElement
    expect(flag.checked).toBe(true)
    fireEvent.click(flag)
    expect(actions.setConfig).toHaveBeenCalledWith('tool:bash', { flag: false })
  })

  it('edits single-line text and number fields with their own types', () => {
    const actions = tabWith([entryOf({
      customization: {
        fields: [
          { id: 'label', kind: 'text', name: 'Label', description: 'A label.' },
          { id: 'count', kind: 'number', name: 'Count', description: 'A count.' },
        ],
        defaultValues: { label: 'x', count: 3 },
      },
      effectiveConfig: { label: 'Draft label', count: 3 },
    })])
    const bash = rowFor('bash')
    fireEvent.click(within(bash).getAllByText(en.configuration)[0]!)
    const label = within(bash).getByRole('textbox', { name: /Label/ }) as HTMLInputElement
    expect(label.value).toBe('Draft label')
    fireEvent.change(label, { target: { value: 'Edited' } })
    expect(actions.setConfig).toHaveBeenCalledWith('tool:bash', { label: 'Edited' })

    const count = within(bash).getByRole('spinbutton', { name: /Count/ }) as HTMLInputElement
    expect(count.type).toBe('number')
    expect(count.value).toBe('3')
    fireEvent.change(count, { target: { value: '5' } })
    expect(actions.setConfig).toHaveBeenCalledWith('tool:bash', { count: 5 })
  })

  it('falls back to an empty string for absent field values', () => {
    tabWith([entryOf({
      customization: {
        fields: [
          { id: 'text', kind: 'text', name: 'Persona', description: 'Agent identity.', multiline: true },
          { id: 'label', kind: 'text', name: 'Label', description: 'A label.' },
        ],
        defaultValues: {},
      },
      effectiveConfig: {},
    })])
    const bash = rowFor('bash')
    fireEvent.click(within(bash).getAllByText(en.configuration)[0]!)
    const persona = within(bash).getByRole('textbox', { name: /Persona/ }) as HTMLTextAreaElement
    expect(persona.value).toBe('')
    const label = within(bash).getByRole('textbox', { name: /Label/ }) as HTMLInputElement
    expect(label.value).toBe('')
  })

  it('restores inherited configuration from the configuration section', () => {
    const actions = renderTab()
    const bash = rowFor('bash')
    fireEvent.click(within(bash).getAllByText(en.configuration)[0]!)
    fireEvent.click(within(bash).getByRole('button', { name: en.restoreConfiguration }))
    expect(actions.setConfig).toHaveBeenCalledWith('tool:bash', 'inherit')
  })

  it('explains that an unmanageable capability with configuration is required', () => {
    const withCustomization = ENTRIES[0]!.customization === undefined
      ? ENTRIES[1]!
      : { ...ENTRIES[1]!, customization: ENTRIES[0]!.customization }
    tabWith([withCustomization])
    const spawn = rowFor('spawn')
    expect(within(spawn).getByText(en.requiredCapability)).toBeTruthy()
    expect(within(spawn).queryByText(en.readOnly)).toBeNull()
  })

  it('shows the loading surface before the first catalog lands, even when busy afterwards', () => {
    renderTab({ status: 'idle', catalog: null })
    expect(screen.getByText(en.loading)).toBeTruthy()
    cleanup()

    const loading = renderTab({ status: 'loading', catalog: null })
    expect(screen.getByText(en.loading)).toBeTruthy()
    expect(loading.load).toHaveBeenCalledOnce()
    cleanup()

    renderTab({ status: 'loading' })
    expect(screen.queryByText(en.loading)).toBeNull()
    expect(screen.getByRole('combobox', { name: en.target })).toBeTruthy()
  })

  it('offers retry on a whole-tab failure', () => {
    const actions = renderTab({ status: 'error', error: 'down', catalog: null })
    expect(screen.getByRole('alert').textContent).toBe(en.error)
    fireEvent.click(screen.getByRole('button', { name: en.retry }))
    expect(actions.load).toHaveBeenCalledTimes(2)
  })

  it('keeps the roster visible with an inline failure after a failed refresh', () => {
    renderTab({ status: 'error', error: 'refresh failed' })
    expect(screen.getByRole('alert').textContent).toBe(en.error)
    expect(rowFor('bash')).toBeTruthy()
  })

  it('filters by kind and by search over name, id, description, and owner', () => {
    tabWith([entryOf({}), { ...ENTRIES[1]! }])
    const kind = screen.getByRole('combobox', { name: en.kind })
    fireEvent.change(kind, { target: { value: 'skill' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.change(kind, { target: { value: 'all' } })

    const search = screen.getByRole('searchbox', { name: en.search })
    fireEvent.change(search, { target: { value: 'RUN SHELL' } })
    expect(within(rowFor('bash')).getByText(en.provenanceUpstream)).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'spawn' })).toBeNull()

    fireEvent.change(search, { target: { value: 'ctx.tools' } })
    expect(rowFor('bash')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('matches a search against ownerless entries by id', () => {
    tabWith([entryOf({ owner: undefined })])
    fireEvent.change(screen.getByRole('searchbox', { name: en.search }), { target: { value: 'tool:bash' } })
    expect(rowFor('bash')).toBeTruthy()
  })

  it('announces an empty roster', () => {
    renderTab({ catalog: { ...READY.catalog!, entries: [] } })
    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('warns when the catalog is incomplete', () => {
    renderTab({ catalog: { ...READY.catalog!, complete: false } })
    expect(screen.getByRole('status').textContent).toBe(en.incomplete)
  })

  it('labels the preview and apply buttons with their in-flight states', () => {
    renderTab({ draft: { 'tool:bash': { selection: 'unload' } }, planning: true })
    expect(screen.getByRole('button', { name: en.planning })).toBeTruthy()
    cleanup()

    const clearPlan = {
      id: 'plan-1',
      target: TARGET,
      expectedRevision: 1,
      topologyRevision: 4,
      operations: [{ capabilityId: 'tool:bash', before: 'inherit' as const, after: 'unload' as const }],
      blockers: [],
      result: ENTRIES,
    }
    renderTab({ draft: { 'tool:bash': { selection: 'unload' } }, plan: clearPlan, applying: true })
    expect(screen.getByRole('button', { name: en.applying })).toBeTruthy()
  })
})
