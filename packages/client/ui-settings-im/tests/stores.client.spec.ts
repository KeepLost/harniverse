import { describe, expect, it } from 'vitest'
import type { ChatBotsSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { createImStore } from '../src/client/stores.ts'

const SNAPSHOT: ChatBotsSnapshot = {
  platforms: [{ platform: 'telegram', label: 'Telegram', fields: [] }],
  bots: [],
  owners: [],
  bridge: 'running',
}

function fresh() {
  const instance = createImStore().create()
  return { actions: instance.actions, state: () => instance.getSnapshot() }
}

describe('createImStore', () => {
  it('starts loading with nothing selected, expanded, pending, or issued', () => {
    const { state } = fresh()
    expect(state()).toEqual({
      snapshot: null,
      phase: 'loading',
      loadError: null,
      selected: null,
      expanded: [],
      form: null,
      busy: [],
      notes: {},
      confirmRemove: null,
      code: null,
      ownerError: null,
      models: { status: 'idle', groups: [] },
      presets: { status: 'idle', options: [] },
    })
  })

  it('publishes a snapshot and clears an earlier read failure', () => {
    const { actions, state } = fresh()
    actions.snapshotFailed({ code: 'unavailable', message: 'offline' })
    actions.snapshotLoaded(SNAPSHOT)
    expect(state().snapshot).toEqual(SNAPSHOT)
    expect(state().phase).toBe('ready')
    expect(state().loadError).toBeNull()
  })

  it('reports a first read failure as the error phase', () => {
    const { actions, state } = fresh()
    actions.snapshotFailed({ code: 'unavailable', message: 'offline' })
    expect(state().phase).toBe('error')
    expect(state().loadError).toEqual({ code: 'unavailable', message: 'offline' })
  })

  it('keeps the last snapshot on screen when a later read fails', () => {
    const { actions, state } = fresh()
    actions.snapshotLoaded(SNAPSHOT)
    actions.snapshotFailed({ code: 'unavailable', message: 'offline' })
    expect(state().phase).toBe('ready')
    expect(state().snapshot).toEqual(SNAPSHOT)
    expect(state().loadError).toEqual({ code: 'unavailable', message: 'offline' })
  })

  it('selects a channel', () => {
    const { actions, state } = fresh()
    actions.select('feishu')
    expect(state().selected).toBe('feishu')
  })

  it('expands and collapses cards without duplicating an id', () => {
    const { actions, state } = fresh()
    actions.setExpanded('a', true)
    actions.setExpanded('a', true)
    actions.setExpanded('b', true)
    expect(state().expanded).toEqual(['a', 'b'])
    actions.setExpanded('a', false)
    actions.setExpanded('missing', false)
    expect(state().expanded).toEqual(['b'])
  })

  describe('connect form', () => {
    it('opens blank for a platform and discards the draft when closed', () => {
      const { actions, state } = fresh()
      actions.openForm('telegram')
      expect(state().form).toEqual({ platform: 'telegram', alias: '', values: {}, pending: false, error: null })
      actions.closeForm()
      expect(state().form).toBeNull()
    })

    it('edits values and alias, and a new edit clears the shown failure', () => {
      const { actions, state } = fresh()
      actions.openForm('telegram')
      actions.formFailed({ code: 'invalid-credentials', message: 'bad token' })
      actions.setFormValue('token', 'abc')
      expect(state().form).toMatchObject({ values: { token: 'abc' }, error: null })
      actions.formFailed({ code: 'unreachable', message: 'down' })
      actions.setFormAlias('Work')
      expect(state().form).toMatchObject({ alias: 'Work', error: null })
    })

    it('marks the connect attempt pending and settles it on failure', () => {
      const { actions, state } = fresh()
      actions.openForm('telegram')
      actions.formPending()
      expect(state().form).toMatchObject({ pending: true, error: null })
      actions.formFailed({ code: 'duplicate-bot', message: 'dup' })
      expect(state().form).toMatchObject({ pending: false, error: { code: 'duplicate-bot' } })
    })

    it('ignores form edits when no form is open', () => {
      const { actions, state } = fresh()
      actions.setFormValue('token', 'x')
      actions.setFormAlias('x')
      actions.formPending()
      actions.formFailed({ code: 'x', message: 'x' })
      expect(state().form).toBeNull()
    })
  })

  it('tracks pending operations as a set', () => {
    const { actions, state } = fresh()
    actions.setBusy('a:check', true)
    actions.setBusy('a:check', true)
    actions.setBusy('b:retry', true)
    expect(state().busy).toEqual(['a:check', 'b:retry'])
    actions.setBusy('a:check', false)
    actions.setBusy('never-started', false)
    expect(state().busy).toEqual(['b:retry'])
  })

  it('keeps one note per bot and clears it on request', () => {
    const { actions, state } = fresh()
    actions.setNote('a', { kind: 'check', ok: true, checkedAt: 1 })
    actions.setNote('a', { kind: 'error', error: { code: 'x', message: 'y' } })
    expect(state().notes).toEqual({ a: { kind: 'error', error: { code: 'x', message: 'y' } } })
    actions.setNote('a', null)
    expect(state().notes).toEqual({})
  })

  it('asks for a removal confirmation and withdraws it', () => {
    const { actions, state } = fresh()
    actions.askRemove('a')
    expect(state().confirmRemove).toBe('a')
    actions.askRemove(null)
    expect(state().confirmRemove).toBeNull()
  })

  it('holds the issued pairing code and the owner-block failure', () => {
    const { actions, state } = fresh()
    actions.ownerFailed({ code: 'bridge-unavailable', message: 'down' })
    actions.codeIssued({ value: 'K7Q2', expiresAt: 99 })
    expect(state().code).toEqual({ value: 'K7Q2', expiresAt: 99 })
    expect(state().ownerError).toBeNull()
    actions.ownerFailed({ code: 'bridge-unavailable', message: 'down' })
    expect(state().ownerError).toEqual({ code: 'bridge-unavailable', message: 'down' })
    actions.clearCode()
    expect(state().code).toBeNull()
  })

  it('records the model and preset catalogs independently', () => {
    const { actions, state } = fresh()
    actions.modelsLoaded([{ id: 'p', name: 'P', models: [] }])
    actions.presetsFailed()
    expect(state().models).toEqual({ status: 'ready', groups: [{ id: 'p', name: 'P', models: [] }] })
    expect(state().presets.status).toBe('error')
    actions.modelsFailed()
    actions.presetsLoaded([{ id: 'standard' }])
    expect(state().models.status).toBe('error')
    expect(state().presets).toEqual({ status: 'ready', options: [{ id: 'standard' }] })
  })
})
