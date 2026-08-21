// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
