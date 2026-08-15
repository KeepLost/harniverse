/**
 * The staged card form: what a draft shows before it is written, which wire
 * call a save reaches, and what happens to drafts the Host did not accept.
 */

import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope, type StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { CardForm, numberField, selectField, textField } from '../src/client/card-form.ts'
import { AgentLoopCardController, type AgentLoopSettings } from '../src/client/agent-loop-card-controller.ts'
import { BashCardController, type BashSettings } from '../src/client/bash-card-controller.ts'
import {
  WebSearchCardController,
  type DeepSeekWebSearchSettings,
  type ExaWebSearchSettings,
  type PerplexityWebSearchSettings,
  type WebSettings,
} from '../src/client/web-search-card-controller.ts'

/** Make the stub behave like a Host that accepts every write. */
function acceptWrites<T>(host: StubSettingsScope<T>): void {
  const section = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().value as object })
  const layer = (): Record<string, unknown> => ({ ...host.scope.getSnapshot().user as object })
  host.set.mockImplementation((field: string, value: unknown) => {
    host.publish({ value: { ...section(), [field]: value } as T, user: { ...layer(), [field]: value } })
  })
  host.unset.mockImplementation((field: string) => {
    const user = Object.fromEntries(Object.entries(layer()).filter(([key]) => key !== field))
    const base = host.scope.getSnapshot().base as Record<string, unknown> | undefined
    host.publish({ value: { ...section(), [field]: base?.[field] } as T, user })
  })
}

function credentialsApi(configured: Record<string, boolean> = {}) {
  const describe = vi.fn((_request: { refs: string[] }) => Promise.resolve({
    rpcId: 'c-1' as never,
    result: {
      ok: true as const,
      value: {
        credentials: Object.fromEntries(
          Object.entries(configured).map(([ref, value]) => [ref, { configured: value, writable: true }]),
        ),
      },
    },
  }))
  const set = vi.fn(() => Promise.resolve({ rpcId: 'c-2' as never, result: { ok: true as const, value: {} } }))
  return { api: { credentials: { describe, set } } as never, describe, set }
}

function webSearchController(credentials = credentialsApi({
  DEEPSEEK_API_KEY: true,
  EXA_API_KEY: false,
  PERPLEXITY_API_KEY: true,
})) {
  const selector = stubSettingsScope<WebSettings>()
  const deepseek = stubSettingsScope<DeepSeekWebSearchSettings>()
  const exa = stubSettingsScope<ExaWebSearchSettings>()
  const perplexity = stubSettingsScope<PerplexityWebSearchSettings>()
  const controller = new WebSearchCardController(
    { selector: selector.scope, deepseek: deepseek.scope, exa: exa.scope, perplexity: perplexity.scope },
    credentials.api,
  )
  selector.publish({
    status: 'ready', writable: true,
    value: { searchProvider: 'deepseek-official' },
    base: { searchProvider: 'deepseek-official' }, user: {},
  })
  deepseek.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
  exa.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
  perplexity.publish({ status: 'ready', writable: true, value: {}, base: {}, user: {} })
  return { selector, deepseek, exa, perplexity, credentials, controller, face: controller.inject() }
}

describe('CardForm', () => {
  function form() {
    const host = stubSettingsScope<Record<string, unknown>>()
    const subject = new CardForm(host.scope, [numberField('timeoutMs'), textField('baseURL')])
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 60_000, baseURL: 'https://search.test/v1' },
      base: { timeoutMs: 60_000, baseURL: 'https://search.test/v1' },
      user: {},
    })
    return { host, subject }
  }

  it('shows the effective value and stays clean until something is staged', () => {
    const { subject } = form()

    expect(subject.field('timeoutMs')).toEqual({ text: '60000', overridden: false, invalid: false })
    expect(subject.shell()).toMatchObject({ available: true, writable: true, dirty: false, invalid: false })
  })

  it('marks a field the user layer carries as overridden', () => {
    const { host, subject } = form()

    host.publish({ value: { timeoutMs: 60_000 }, user: { timeoutMs: 60_000 } })

    // An override equal to the composition default is still an override.
    expect(subject.field('timeoutMs').overridden).toBe(true)
  })

  it('writes nothing until the form is saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('timeoutMs', '9000')

    expect(subject.field('timeoutMs')).toEqual({ text: '9000', overridden: true, invalid: false })
    expect(subject.shell().dirty).toBe(true)
    expect(host.set).not.toHaveBeenCalled()

    await subject.save()

    expect(host.set.mock.calls).toEqual([['timeoutMs', 9_000]])
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false, saving: false })
  })

  it('drops a draft that settles back on the value already shown', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    subject.actions().edit('timeoutMs', '60000')

    expect(subject.shell().dirty).toBe(false)
    await subject.save()

    expect(host.set).not.toHaveBeenCalled()
  })

  it('refuses to save while a draft is not a value the field accepts', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', 'soon')

    expect(subject.field('timeoutMs')).toEqual({ text: 'soon', overridden: false, invalid: true })
    expect(subject.shell()).toMatchObject({ dirty: true, invalid: true })

    await subject.save()

    expect(host.set).not.toHaveBeenCalled()
    expect(subject.field('timeoutMs').text).toBe('soon')
  })

  it('stages a reset that clears the field only once saved', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ value: { timeoutMs: 9_000 }, user: { timeoutMs: 9_000 } })

    subject.actions().resetField('timeoutMs')

    // The badge previews the save: the field will no longer be overridden.
    expect(subject.field('timeoutMs')).toEqual({ text: '60000', overridden: false, invalid: false })
    expect(host.unset).not.toHaveBeenCalled()

    await subject.save()

    expect(host.unset.mock.calls).toEqual([['timeoutMs']])
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false })
  })

  it('treats resetting an inherited field as no change at all', async () => {
    const { host, subject } = form()

    subject.actions().resetField('timeoutMs')

    expect(subject.shell().dirty).toBe(false)
    await subject.save()

    expect(host.unset).not.toHaveBeenCalled()
  })

  it('clears a number field by emptying it', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ user: { timeoutMs: 9_000 } })

    subject.actions().edit('timeoutMs', '')

    expect(subject.field('timeoutMs')).toEqual({ text: '', overridden: false, invalid: false })
    await subject.save()

    expect(host.unset.mock.calls).toEqual([['timeoutMs']])
  })

  it('clears a text field by emptying it', async () => {
    const { host, subject } = form()
    acceptWrites(host)
    host.publish({ user: { baseURL: 'https://search.test/v1' } })

    subject.actions().edit('baseURL', '   ')
    await subject.save()

    expect(host.unset.mock.calls).toEqual([['baseURL']])
  })

  it('writes the trimmed text of a text field', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('baseURL', '  https://other.test  ')
    await subject.save()

    expect(host.set.mock.calls).toEqual([['baseURL', 'https://other.test']])
  })

  it('keeps the drafts a save did not land, and reports the failure', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    await subject.save()

    // The stub Host accepted the call without storing it, exactly as a
    // validator that refuses the value does.
    expect(host.set).toHaveBeenCalledWith('timeoutMs', 9_000)
    expect(subject.shell()).toMatchObject({ dirty: true, failed: true, saving: false })
    expect(subject.field('timeoutMs').text).toBe('9000')
  })

  it('reports a reset the Host did not apply as a failure', async () => {
    const { host, subject } = form()
    host.publish({ user: { timeoutMs: 9_000 } })

    subject.actions().resetField('timeoutMs')
    await subject.save()

    expect(host.unset).toHaveBeenCalledWith('timeoutMs')
    expect(subject.shell().failed).toBe(true)
  })

  it('clears the failure as soon as the user edits again', async () => {
    const { subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    await subject.save()
    expect(subject.shell().failed).toBe(true)

    subject.actions().edit('timeoutMs', '9001')

    expect(subject.shell().failed).toBe(false)
  })

  it('discards every staged edit', async () => {
    const { host, subject } = form()

    subject.actions().edit('timeoutMs', '9000')
    subject.actions().discard()

    expect(subject.field('timeoutMs').text).toBe('60000')
    expect(subject.shell()).toMatchObject({ dirty: false, failed: false })

    // A discard with nothing staged publishes nothing.
    const before = subject.shell()
    subject.actions().discard()
    expect(subject.shell()).toEqual(before)

    await subject.save()
    expect(host.set).not.toHaveBeenCalled()
  })

  it('refuses a second save while one is in flight', async () => {
    const { host, subject } = form()
    acceptWrites(host)

    subject.actions().edit('timeoutMs', '9000')
    const first = subject.save()
    expect(subject.shell().saving).toBe(true)
    const second = subject.save()
    await Promise.all([first, second])

    expect(host.set).toHaveBeenCalledTimes(1)
  })

  it('publishes a projection whenever the scope or a draft changes', () => {
    const { host, subject } = form()
    const store = subject.bind(() => subject.field('timeoutMs').text)
    expect(store.getSnapshot()).toBe('60000')

    host.publish({ value: { timeoutMs: 1_000 } })
    expect(store.getSnapshot()).toBe('1000')

    subject.actions().edit('timeoutMs', '2000')
    expect(store.getSnapshot()).toBe('2000')
  })

  it('refuses to address a field the card never declared', () => {
    const { subject } = form()

    expect(() => subject.field('nope')).toThrow('plugin card has no field nope')
  })

  it('renders an absent section value as an empty draft', () => {
    const host = stubSettingsScope<Record<string, unknown>>()
    const subject = new CardForm(host.scope, [numberField('timeoutMs'), textField('baseURL')])

    host.publish({ status: 'ready', writable: true, value: {}, base: {}, user: undefined })

    expect(subject.field('timeoutMs').text).toBe('')
    expect(subject.field('baseURL').text).toBe('')
    expect(subject.shell().available).toBe(true)
  })

  it('accepts only declared select options', () => {
    const host = stubSettingsScope<Record<string, unknown>>()
    const subject = new CardForm(host.scope, [selectField('provider', ['deepseek-official', 'exa', 'perplexity'])])
    host.publish({ status: 'ready', writable: true, value: { provider: 'exa' }, user: {} })

    subject.actions().edit('provider', 'other')
    expect(subject.field('provider')).toMatchObject({ text: 'other', invalid: true })

    subject.actions().edit('provider', 'perplexity')
    expect(subject.field('provider')).toMatchObject({ text: 'perplexity', invalid: false })

    subject.actions().edit('provider', '')
    expect(subject.field('provider')).toMatchObject({ text: '', overridden: false, invalid: false })
  })

  it('allows aggregate owners to unsubscribe from form publications', () => {
    const { subject } = form()
    const listener = vi.fn()
    const unsubscribe = subject.subscribe(listener)
    subject.actions().edit('timeoutMs', '1000')
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    subject.actions().edit('timeoutMs', '2000')
    expect(listener).toHaveBeenCalledOnce()
  })

  it('stays unavailable while the namespace is not served', () => {
    const host = stubSettingsScope<Record<string, unknown>>()
    const subject = new CardForm(host.scope, [numberField('timeoutMs')])

    host.publish({ status: 'unavailable' })

    expect(subject.shell()).toMatchObject({ available: false, writable: false })
  })
})

describe('BashCardController', () => {
  it('projects both fields and saves them in one write pass', async () => {
    const host = stubSettingsScope<BashSettings>()
    acceptWrites(host)
    const controller = new BashCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000, maxOutputBytes: 64_000 },
      base: { timeoutMs: 60_000, maxOutputBytes: 64_000 },
      user: { timeoutMs: 5_000 },
    })
    const face = controller.inject()

    expect(face.hooks.bashCard.getSnapshot()).toMatchObject({
      available: true,
      writable: true,
      dirty: false,
      timeoutMs: { text: '5000', overridden: true },
      maxOutputBytes: { text: '64000', overridden: false },
    })

    face.edit('timeoutMs', '9000')
    face.edit('maxOutputBytes', '1024')
    expect(face.hooks.bashCard.getSnapshot().dirty).toBe(true)

    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledTimes(2) })

    expect(host.set.mock.calls).toEqual([['timeoutMs', 9_000], ['maxOutputBytes', 1_024]])
    expect(face.hooks.bashCard.getSnapshot().dirty).toBe(false)
  })

  it('stages a reset and applies it on save', async () => {
    const host = stubSettingsScope<BashSettings>()
    acceptWrites(host)
    const controller = new BashCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { timeoutMs: 5_000 },
      base: { timeoutMs: 60_000 },
      user: { timeoutMs: 5_000 },
    })
    const face = controller.inject()

    face.resetField('timeoutMs')
    expect(face.hooks.bashCard.getSnapshot().timeoutMs.text).toBe('60000')

    face.save()
    await vi.waitFor(() => { expect(host.unset).toHaveBeenCalledWith('timeoutMs') })

    expect(face.hooks.bashCard.getSnapshot()).toMatchObject({
      dirty: false,
      timeoutMs: { text: '60000', overridden: false },
    })
  })

  it('discards staged edits without writing', () => {
    const host = stubSettingsScope<BashSettings>()
    const controller = new BashCardController(host.scope)
    host.publish({ status: 'ready', writable: true, value: { timeoutMs: 5_000 }, user: {} })
    const face = controller.inject()

    face.edit('timeoutMs', '9000')
    face.discard()

    expect(face.hooks.bashCard.getSnapshot().timeoutMs.text).toBe('5000')
    expect(host.set).not.toHaveBeenCalled()
  })
})

describe('AgentLoopCardController', () => {
  it('saves the only field it owns', async () => {
    const host = stubSettingsScope<AgentLoopSettings>()
    acceptWrites(host)
    const controller = new AgentLoopCardController(host.scope)
    host.publish({
      status: 'ready',
      writable: true,
      value: { maxParallelToolCalls: 10 },
      base: { maxParallelToolCalls: 10 },
      user: {},
    })
    const face = controller.inject()

    face.edit('maxParallelToolCalls', '4')
    face.save()
    await vi.waitFor(() => { expect(host.set).toHaveBeenCalledWith('maxParallelToolCalls', 4) })

    expect(face.hooks.agentLoopCard.getSnapshot()).toMatchObject({
      dirty: false,
      maxParallelToolCalls: { text: '4', overridden: true },
    })
  })

  it('reports a read-only document so the card can disable its controls', () => {
    const host = stubSettingsScope<AgentLoopSettings>()
    const controller = new AgentLoopCardController(host.scope)

    host.publish({ status: 'ready', writable: false, value: { maxParallelToolCalls: 10 } })

    expect(controller.inject().hooks.agentLoopCard.getSnapshot().writable).toBe(false)
  })
})

describe('WebSearchCardController', () => {
  it('projects all four scopes and stages provider selection', () => {
    const { face, selector } = webSearchController()

    expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      selectedProvider: 'deepseek-official',
      selector: { available: true, searchProvider: { text: 'deepseek-official' } },
      deepseek: { available: true },
      exa: { available: true },
      perplexity: { available: true },
    })

    face.edit('selector.searchProvider', 'exa')

    expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({ selectedProvider: 'exa', dirty: true })
    expect(selector.set).not.toHaveBeenCalled()
  })

  it('routes every provider field with unambiguous addresses', () => {
    const { face } = webSearchController()

    face.edit('deepseek.model', 'deepseek-search')
    face.edit('exa.numResults', '8')
    face.edit('perplexity.searchRecency', 'week')
    face.resetField('deepseek.maxTokens')
    face.resetField('exa.searchType')
    face.resetField('perplexity.model')
    face.resetField('selector.searchProvider')

    const state = face.hooks.webSearchCard.getSnapshot()
    expect(state.deepseek.model.text).toBe('deepseek-search')
    expect(state.exa.numResults.text).toBe('8')
    expect(state.perplexity.searchRecency.text).toBe('week')
  })

  it('rejects ambiguous and unknown field addresses', () => {
    const { face } = webSearchController()

    expect(() => { face.edit('model', 'x') }).toThrow('web search field address is ambiguous')
    expect(() => { face.edit('unknown.model', 'x') }).toThrow('web search card has no form unknown')
  })

  it('keeps hidden provider drafts while switching and saves every form in deterministic order', async () => {
    const fixture = webSearchController()
    acceptWrites(fixture.selector)
    acceptWrites(fixture.deepseek)
    acceptWrites(fixture.exa)
    acceptWrites(fixture.perplexity)

    fixture.face.edit('deepseek.baseURL', 'https://deepseek.test')
    fixture.face.edit('selector.searchProvider', 'exa')
    fixture.face.edit('exa.numResults', '8')
    fixture.face.edit('selector.searchProvider', 'perplexity')
    fixture.face.edit('perplexity.maxTokens', '512')

    expect(fixture.face.hooks.webSearchCard.getSnapshot().deepseek.baseURL.text).toBe('https://deepseek.test')
    await fixture.controller.save()

    expect(fixture.selector.set).toHaveBeenCalledWith('searchProvider', 'perplexity')
    expect(fixture.deepseek.set).toHaveBeenCalledWith('baseURL', 'https://deepseek.test')
    expect(fixture.exa.set).toHaveBeenCalledWith('numResults', 8)
    expect(fixture.perplexity.set).toHaveBeenCalledWith('maxTokens', 512)
    expect(fixture.selector.set.mock.invocationCallOrder[0]).toBeLessThan(fixture.deepseek.set.mock.invocationCallOrder[0]!)
    expect(fixture.deepseek.set.mock.invocationCallOrder[0]).toBeLessThan(fixture.exa.set.mock.invocationCallOrder[0]!)
    expect(fixture.exa.set.mock.invocationCallOrder[0]).toBeLessThan(fixture.perplexity.set.mock.invocationCallOrder[0]!)
  })

  it('continues its explicitly non-transactional save and retains only failed-form drafts', async () => {
    const fixture = webSearchController()
    acceptWrites(fixture.selector)
    acceptWrites(fixture.deepseek)
    acceptWrites(fixture.perplexity)
    fixture.face.edit('deepseek.model', 'accepted-model')
    fixture.face.edit('exa.numResults', '9')
    fixture.face.edit('perplexity.model', 'sonar-pro')

    await fixture.controller.save()

    const state = fixture.face.hooks.webSearchCard.getSnapshot()
    expect(fixture.perplexity.set).toHaveBeenCalledWith('model', 'sonar-pro')
    expect(state).toMatchObject({ dirty: true, failed: true })
    expect(state.deepseek.dirty).toBe(false)
    expect(state.exa).toMatchObject({ dirty: true, failed: true, numResults: { text: '9' } })
    expect(state.perplexity.dirty).toBe(false)
  })

  it('discards drafts from the selector and every provider', () => {
    const { face } = webSearchController()
    face.edit('selector.searchProvider', 'exa')
    face.edit('deepseek.model', 'draft-deepseek')
    face.edit('exa.numResults', '4')
    face.edit('perplexity.model', 'draft-perplexity')

    face.discard()

    expect(face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      dirty: false,
      selectedProvider: 'deepseek-official',
      deepseek: { model: { text: '' } },
      exa: { numResults: { text: '' } },
      perplexity: { model: { text: '' } },
    })
  })

  it('keeps the selector usable when an unselected provider scope is absent', () => {
    const fixture = webSearchController()
    fixture.exa.publish({ status: 'unavailable' })

    expect(fixture.face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      available: true,
      selector: { writable: true },
      selectedProvider: 'deepseek-official',
      exa: { available: false },
    })
  })

  it('reads and writes each provider credential under its own default reference', async () => {
    const fixture = webSearchController()
    await vi.waitFor(() => {
      expect(fixture.credentials.describe).toHaveBeenCalledWith({ refs: ['DEEPSEEK_API_KEY'] })
      expect(fixture.credentials.describe).toHaveBeenCalledWith({ refs: ['EXA_API_KEY'] })
      expect(fixture.credentials.describe).toHaveBeenCalledWith({ refs: ['PERPLEXITY_API_KEY'] })
    })
    fixture.credentials.describe.mockImplementation(({ refs }: { refs: string[] }) => Promise.resolve({
      rpcId: 'c-3' as never,
      result: { ok: true as const, value: { credentials: { [refs[0]!]: { configured: true, writable: true } } } },
    }))
    fixture.face.edit('deepseek.apiKey', ' deepseek-secret ')
    fixture.face.edit('exa.apiKey', ' exa-secret ')
    fixture.face.edit('perplexity.apiKey', ' perplexity-secret ')

    await fixture.controller.save()

    expect(fixture.credentials.set.mock.calls).toEqual([
      [{ ref: 'DEEPSEEK_API_KEY', value: 'deepseek-secret' }],
      [{ ref: 'EXA_API_KEY', value: 'exa-secret' }],
      [{ ref: 'PERPLEXITY_API_KEY', value: 'perplexity-secret' }],
    ])
    expect(fixture.face.hooks.webSearchCard.getSnapshot()).toMatchObject({ dirty: false, failed: false })
  })

  it('leaves stored provider keys untouched for blank drafts', async () => {
    const fixture = webSearchController()
    fixture.face.edit('deepseek.apiKey', '   ')
    fixture.face.edit('exa.apiKey', '')
    fixture.face.edit('perplexity.apiKey', '\t')

    fixture.face.save()
    await Promise.resolve()

    expect(fixture.credentials.set).not.toHaveBeenCalled()
    expect(fixture.face.hooks.webSearchCard.getSnapshot().dirty).toBe(false)
  })

  it('falls back to DeepSeek while an invalid provider draft blocks saving', () => {
    const fixture = webSearchController()
    fixture.face.edit('selector.searchProvider', 'unknown-provider')

    expect(fixture.face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      selectedProvider: 'deepseek-official',
      invalid: true,
    })
  })

  it('rejects non-positive and fractional provider integer drafts', async () => {
    const fixture = webSearchController()
    fixture.face.edit('deepseek.maxTokens', '0')
    fixture.face.edit('deepseek.maxUses', '-1')
    fixture.face.edit('exa.numResults', '1.5')
    fixture.face.edit('exa.highlightsPerResult', '0')
    fixture.face.edit('perplexity.maxTokens', '-2')

    expect(fixture.face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      dirty: true,
      invalid: true,
      deepseek: { maxTokens: { invalid: true }, maxUses: { invalid: true } },
      exa: { numResults: { invalid: true }, highlightsPerResult: { invalid: true } },
      perplexity: { maxTokens: { invalid: true } },
    })

    await fixture.controller.save()
    expect(fixture.deepseek.set).not.toHaveBeenCalled()
    expect(fixture.exa.set).not.toHaveBeenCalled()
    expect(fixture.perplexity.set).not.toHaveBeenCalled()
  })

  it('refreshes only providers whose current credential reference matches', async () => {
    const fixture = webSearchController()
    fixture.exa.publish({ value: { apiKeyEnv: 'SHARED_SEARCH_KEY' } })
    fixture.perplexity.publish({ value: { apiKeyEnv: 'SHARED_SEARCH_KEY' } })
    await vi.waitFor(() => { expect(fixture.credentials.describe).toHaveBeenCalledWith({ refs: ['SHARED_SEARCH_KEY'] }) })
    fixture.credentials.describe.mockClear()

    fixture.controller.refreshCredential('SHARED_SEARCH_KEY')

    await vi.waitFor(() => { expect(fixture.credentials.describe).toHaveBeenCalledTimes(2) })
    expect(fixture.credentials.describe.mock.calls).toEqual([
      [{ refs: ['SHARED_SEARCH_KEY'] }],
      [{ refs: ['SHARED_SEARCH_KEY'] }],
    ])
  })

  it('drops stale credential responses even when they describe the same reference', async () => {
    const fixture = webSearchController()
    await vi.waitFor(() => { expect(fixture.credentials.describe).toHaveBeenCalled() })
    const resolvers: Array<(configured: boolean) => void> = []
    fixture.credentials.describe.mockImplementation(() => new Promise((resolve) => {
      resolvers.push((configured) => {
        resolve({
          rpcId: 'c-stale' as never,
          result: {
            ok: true as const,
            value: { credentials: { DEEPSEEK_API_KEY: { configured, writable: true } } },
          },
        })
      })
    }))

    fixture.controller.refreshCredential('DEEPSEEK_API_KEY')
    fixture.controller.refreshCredential('DEEPSEEK_API_KEY')
    await vi.waitFor(() => { expect(resolvers).toHaveLength(2) })
    resolvers[1]!(true)
    await vi.waitFor(() => {
      expect(fixture.face.hooks.webSearchCard.getSnapshot().deepseek.apiKeyConfigured).toBe(true)
    })
    resolvers[0]!(false)
    await Promise.resolve()

    expect(fixture.face.hooks.webSearchCard.getSnapshot().deepseek.apiKeyConfigured).toBe(true)
  })

  it('drops a credential response after its provider changes references', async () => {
    const fixture = webSearchController()
    await vi.waitFor(() => { expect(fixture.credentials.describe).toHaveBeenCalled() })
    fixture.exa.publish({ value: { apiKeyEnv: '' } })
    fixture.exa.publish({ value: { apiKeyEnv: 'EXA_FIRST_KEY' } })
    await vi.waitFor(() => { expect(fixture.credentials.describe).toHaveBeenCalledWith({ refs: ['EXA_FIRST_KEY'] }) })
    const resolvers: Array<(value: Awaited<ReturnType<typeof fixture.credentials.describe>>) => void> = []
    fixture.credentials.describe.mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve) }))
    fixture.controller.refreshCredential('EXA_FIRST_KEY')
    await vi.waitFor(() => { expect(resolvers).toHaveLength(1) })

    fixture.exa.publish({ value: { apiKeyEnv: 'EXA_SECOND_KEY' } })
    resolvers[0]!({
      rpcId: 'c-old-ref' as never,
      result: { ok: true as const, value: { credentials: { EXA_FIRST_KEY: { configured: true, writable: true } } } },
    })
    await Promise.resolve()

    expect(fixture.face.hooks.webSearchCard.getSnapshot().exa.apiKeyConfigured).toBe(false)
  })

  it('keeps credential controls usable when reads fail or omit a reference', async () => {
    const failed = credentialsApi()
    failed.describe.mockRejectedValue(new Error('offline'))
    const failedFixture = webSearchController(failed)
    await vi.waitFor(() => { expect(failed.describe).toHaveBeenCalled() })
    expect(failedFixture.face.hooks.webSearchCard.getSnapshot().deepseek.apiKeyWritable).toBe(true)

    const omitted = credentialsApi()
    const omittedFixture = webSearchController(omitted)
    await vi.waitFor(() => { expect(omitted.describe).toHaveBeenCalled() })
    expect(omittedFixture.face.hooks.webSearchCard.getSnapshot().exa).toMatchObject({
      apiKeyConfigured: false,
      apiKeyWritable: true,
    })
  })

  it('ignores refused credential reads and retains a key draft after a failed write', async () => {
    const credentials = credentialsApi()
    credentials.describe.mockResolvedValue({
      rpcId: 'c-refused' as never,
      result: { ok: false as const, error: { code: 'credentials-unavailable', message: 'offline' } },
    } as never)
    credentials.set.mockRejectedValue(new Error('offline'))
    const fixture = webSearchController(credentials)
    fixture.face.edit('exa.apiKey', 'exa-secret')

    await fixture.controller.save()

    expect(fixture.face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      dirty: true,
      failed: true,
      exa: { apiKey: { text: 'exa-secret' } },
    })
  })

  it('retains a replacement key draft when the write is refused but the old key remains configured', async () => {
    const credentials = credentialsApi({ EXA_API_KEY: true })
    credentials.set.mockResolvedValue({
      rpcId: 'c-write-refused' as never,
      result: { ok: false as const, error: { code: 'credentials-unavailable', message: 'read only' } },
    } as never)
    const fixture = webSearchController(credentials)
    fixture.face.edit('exa.apiKey', 'replacement-secret')

    await fixture.controller.save()

    expect(fixture.face.hooks.webSearchCard.getSnapshot()).toMatchObject({
      dirty: true,
      failed: true,
      exa: { apiKeyConfigured: true, apiKey: { text: 'replacement-secret' } },
    })
  })

  it('derives aggregate writability from selector, selected scope, and credential independently', async () => {
    const credentials = credentialsApi()
    credentials.describe.mockImplementation(({ refs }: { refs: string[] }) => Promise.resolve({
      rpcId: 'c-read-only' as never,
      result: { ok: true as const, value: { credentials: { [refs[0]!]: { configured: true, writable: false } } } },
    }))
    const fixture = webSearchController(credentials)
    fixture.selector.publish({ writable: false })
    fixture.deepseek.publish({ writable: false })
    await vi.waitFor(() => { expect(fixture.face.hooks.webSearchCard.getSnapshot().deepseek.apiKeyWritable).toBe(false) })
    expect(fixture.face.hooks.webSearchCard.getSnapshot().writable).toBe(false)

    fixture.deepseek.publish({ status: 'unavailable' })
    expect(fixture.face.hooks.webSearchCard.getSnapshot().writable).toBe(false)
  })
})
