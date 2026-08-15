/** Aggregate staged form for the Web search selector and its three providers. */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'
import { createSnapshotStore, type SettingsScope, type SettingsScopeSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm, positiveIntegerField, selectField, textField,
  type CardActions, type CardFieldState, type CardShell,
} from './card-form.ts'

/** Provider-neutral selector namespace. */
export const WEB_NS = 'web'
/** DeepSeek provider settings namespace. */
export const WEB_SEARCH_DEEPSEEK_NS = 'web-search-deepseek'
/** Exa provider settings namespace. */
export const WEB_SEARCH_EXA_NS = 'web-search-exa'
/** Perplexity provider settings namespace. */
export const WEB_SEARCH_PERPLEXITY_NS = 'web-search-perplexity'

/** Provider ids accepted by the Web runtime selector. */
export const WEB_SEARCH_PROVIDER_IDS = ['deepseek-official', 'exa', 'perplexity'] as const
/** A selectable Web search provider id. */
export type WebSearchProviderId = typeof WEB_SEARCH_PROVIDER_IDS[number]

const API_KEY_FIELD = 'apiKey'

/** Live Web selector settings. */
export interface WebSettings { searchProvider?: string }

/** Live DeepSeek Web search settings. */
export interface DeepSeekWebSearchSettings {
  apiKeyEnv?: string
  baseURL?: string
  model?: string
  apiVersion?: string
  maxTokens?: number
  maxUses?: number
}

/** Live Exa Web search settings. */
export interface ExaWebSearchSettings {
  apiKeyEnv?: string
  baseURL?: string
  searchType?: 'auto' | 'keyword' | 'neural'
  numResults?: number
  highlightsPerResult?: number
}

/** Live Perplexity Web search settings. */
export interface PerplexityWebSearchSettings {
  apiKeyEnv?: string
  baseURL?: string
  model?: string
  maxTokens?: number
  searchRecency?: 'day' | 'week' | 'month' | 'year'
}

interface CredentialState {
  ref: string
  configured: boolean
  writable: boolean
  generation: number
}

interface ProviderCredentialState extends CardShell {
  apiKey: CardFieldState
  apiKeyConfigured: boolean
  apiKeyWritable: boolean
}

/** Selector form projected into the aggregate card. */
export interface WebSearchSelectorState extends CardShell { searchProvider: CardFieldState }

/** DeepSeek provider form projected into the aggregate card. */
export interface DeepSeekWebSearchState extends ProviderCredentialState {
  baseURL: CardFieldState
  model: CardFieldState
  apiVersion: CardFieldState
  maxTokens: CardFieldState
  maxUses: CardFieldState
}

/** Exa provider form projected into the aggregate card. */
export interface ExaWebSearchState extends ProviderCredentialState {
  baseURL: CardFieldState
  searchType: CardFieldState
  numResults: CardFieldState
  highlightsPerResult: CardFieldState
}

/** Perplexity provider form projected into the aggregate card. */
export interface PerplexityWebSearchState extends ProviderCredentialState {
  baseURL: CardFieldState
  model: CardFieldState
  maxTokens: CardFieldState
  searchRecency: CardFieldState
}

/** Complete state rendered by the single Web search card. */
export interface WebSearchCardState extends CardShell {
  selectedProvider: WebSearchProviderId
  selector: WebSearchSelectorState
  deepseek: DeepSeekWebSearchState
  exa: ExaWebSearchState
  perplexity: PerplexityWebSearchState
}

/** The registration-side face injected into the Web search card. */
export interface WebSearchCardFace extends CardActions {
  hooks: { webSearchCard: SnapshotStore<WebSearchCardState> }
}

/** Four settings scopes aggregated by the Web search card. */
export interface WebSearchScopes {
  selector: SettingsScope<WebSettings>
  deepseek: SettingsScope<DeepSeekWebSearchSettings>
  exa: SettingsScope<ExaWebSearchSettings>
  perplexity: SettingsScope<PerplexityWebSearchSettings>
}

/** Owns the selector, all provider drafts, and provider credential reads. */
export class WebSearchCardController {
  private readonly selectorForm: CardForm<WebSettings>
  private readonly deepseekForm: CardForm<DeepSeekWebSearchSettings>
  private readonly exaForm: CardForm<ExaWebSearchSettings>
  private readonly perplexityForm: CardForm<PerplexityWebSearchSettings>
  private readonly store: SnapshotStore<WebSearchCardState>
  private readonly credentials: Record<WebSearchProviderId, CredentialState> = {
    'deepseek-official': credential('DEEPSEEK_API_KEY'),
    exa: credential('EXA_API_KEY'),
    perplexity: credential('PERPLEXITY_API_KEY'),
  }
  private saving = false

  /**
   * @param scopes - the selector and three provider settings scopes.
   * @param api - wire face used for write-only provider credentials.
   */
  constructor(
    private readonly scopes: WebSearchScopes,
    private readonly api: Pick<IApiClient, 'credentials'>,
  ) {
    this.selectorForm = new CardForm(scopes.selector, [
      selectField('searchProvider', WEB_SEARCH_PROVIDER_IDS),
    ])
    this.deepseekForm = new CardForm(
      scopes.deepseek,
      [
        textField('baseURL'), textField('model'), textField('apiVersion'),
        positiveIntegerField('maxTokens'), positiveIntegerField('maxUses'),
      ],
      [{ field: API_KEY_FIELD, write: value => this.writeKey('deepseek-official', value) }],
    )
    this.exaForm = new CardForm(
      scopes.exa,
      [
        textField('baseURL'), selectField('searchType', ['auto', 'keyword', 'neural']),
        positiveIntegerField('numResults'), positiveIntegerField('highlightsPerResult'),
      ],
      [{ field: API_KEY_FIELD, write: value => this.writeKey('exa', value) }],
    )
    this.perplexityForm = new CardForm(
      scopes.perplexity,
      [
        textField('baseURL'), textField('model'), positiveIntegerField('maxTokens'),
        selectField('searchRecency', ['day', 'week', 'month', 'year']),
      ],
      [{ field: API_KEY_FIELD, write: value => this.writeKey('perplexity', value) }],
    )

    this.store = createSnapshotStore(this.projection())
    for (const form of this.forms()) form.subscribe(() => { this.publish() })
    for (const provider of WEB_SEARCH_PROVIDER_IDS) {
      this.scope(provider).subscribe(() => { void this.readCredential(provider) })
      void this.readCredential(provider)
    }
  }

  /**
   * Build the face injected into the card slot.
   * @returns the aggregate snapshot and staged actions.
   */
  inject(): WebSearchCardFace {
    return {
      hooks: { webSearchCard: this.store },
      edit: (address, text) => { this.addressActions(address).edit(addressField(address), text) },
      resetField: (address) => { this.addressActions(address).resetField(addressField(address)) },
      save: () => { void this.save() },
      discard: () => {
        for (const form of this.forms()) form.actions().discard()
      },
    }
  }

  /**
   * Save selector and provider forms in fixed order. Writes are non-transactional:
   * successful forms settle while each failed form retains its own drafts.
   * @returns settlement after all four forms have attempted their writes.
   */
  async save(): Promise<void> {
    const shells = this.forms().map(form => form.shell())
    if (this.saving || shells.every(shell => !shell.dirty) || shells.some(shell => shell.invalid)) return
    this.saving = true
    this.publish()
    try {
      for (const form of this.forms()) await form.save()
    } finally {
      this.saving = false
      this.publish()
    }
  }

  /**
   * Refresh providers currently addressing a changed credential reference.
   * @param ref - credential reference reported by the Host.
   */
  refreshCredential(ref: string): void {
    for (const provider of WEB_SEARCH_PROVIDER_IDS) {
      if (this.ref(provider) === ref) void this.readCredential(provider)
    }
  }

  private projection(): WebSearchCardState {
    const selector = this.selectorState()
    const selectedProvider = providerId(selector.searchProvider.text)
    const deepseek = this.deepseekState()
    const exa = this.exaState()
    const perplexity = this.perplexityState()
    const selected = selectedProvider === 'deepseek-official'
      ? deepseek
      : selectedProvider === 'exa' ? exa : perplexity
    const forms = [selector, deepseek, exa, perplexity]
    return {
      available: selector.available,
      writable: selector.writable || (selected.available && (selected.writable || selected.apiKeyWritable)),
      dirty: forms.some(form => form.dirty),
      invalid: forms.some(form => form.invalid),
      saving: this.saving,
      failed: forms.some(form => form.failed),
      selectedProvider,
      selector,
      deepseek,
      exa,
      perplexity,
    }
  }

  private selectorState(): WebSearchSelectorState {
    return { ...this.selectorForm.shell(), searchProvider: this.selectorForm.field('searchProvider') }
  }

  private deepseekState(): DeepSeekWebSearchState {
    return {
      ...this.providerShell('deepseek-official', this.deepseekForm),
      baseURL: this.deepseekForm.field('baseURL'),
      model: this.deepseekForm.field('model'),
      apiVersion: this.deepseekForm.field('apiVersion'),
      maxTokens: this.deepseekForm.field('maxTokens'),
      maxUses: this.deepseekForm.field('maxUses'),
    }
  }

  private exaState(): ExaWebSearchState {
    return {
      ...this.providerShell('exa', this.exaForm),
      baseURL: this.exaForm.field('baseURL'),
      searchType: this.exaForm.field('searchType'),
      numResults: this.exaForm.field('numResults'),
      highlightsPerResult: this.exaForm.field('highlightsPerResult'),
    }
  }

  private perplexityState(): PerplexityWebSearchState {
    return {
      ...this.providerShell('perplexity', this.perplexityForm),
      baseURL: this.perplexityForm.field('baseURL'),
      model: this.perplexityForm.field('model'),
      maxTokens: this.perplexityForm.field('maxTokens'),
      searchRecency: this.perplexityForm.field('searchRecency'),
    }
  }

  private providerShell<T>(provider: WebSearchProviderId, form: CardForm<T>): ProviderCredentialState {
    const state = this.credentials[provider]
    return {
      ...form.shell(),
      apiKey: form.field(API_KEY_FIELD),
      apiKeyConfigured: state.configured,
      apiKeyWritable: state.writable,
    }
  }

  private forms(): readonly [
    CardForm<WebSettings>, CardForm<DeepSeekWebSearchSettings>,
    CardForm<ExaWebSearchSettings>, CardForm<PerplexityWebSearchSettings>,
  ] {
    return [this.selectorForm, this.deepseekForm, this.exaForm, this.perplexityForm]
  }

  private addressActions(address: string): CardActions {
    const prefix = addressPrefix(address)
    if (prefix === 'selector') return this.selectorForm.actions()
    if (prefix === 'deepseek') return this.deepseekForm.actions()
    if (prefix === 'exa') return this.exaForm.actions()
    if (prefix === 'perplexity') return this.perplexityForm.actions()
    throw new Error(`web search card has no form ${prefix}`)
  }

  private scope(provider: WebSearchProviderId): SettingsScope<{ apiKeyEnv?: string }> {
    if (provider === 'deepseek-official') {
      return this.scopes.deepseek
    }
    if (provider === 'exa') return this.scopes.exa
    return this.scopes.perplexity
  }

  private ref(provider: WebSearchProviderId): string {
    return refOf(this.scope(provider).getSnapshot(), defaultRef(provider))
  }

  private async readCredential(provider: WebSearchProviderId): Promise<void> {
    const ref = this.ref(provider)
    const previous = this.credentials[provider]
    const generation = previous.generation + 1
    this.credentials[provider] = {
      ref,
      configured: previous.ref === ref ? previous.configured : false,
      writable: previous.ref === ref ? previous.writable : true,
      generation,
    }
    if (previous.ref !== ref) this.publish()

    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch (_credentialReadFailure) {
      return
    }
    const current = this.credentials[provider]
    if (!response.result.ok || current.generation !== generation || current.ref !== ref || this.ref(provider) !== ref) return
    const view = response.result.value.credentials[ref]
    this.credentials[provider] = {
      ref,
      configured: view?.configured ?? false,
      writable: view?.writable ?? true,
      generation,
    }
    this.publish()
  }

  private async writeKey(provider: WebSearchProviderId, value: string): Promise<boolean> {
    const ref = this.ref(provider)
    let accepted = false
    try {
      const response = await this.api.credentials.set({ ref, value })
      accepted = response.result.ok
    } catch (_credentialWriteFailure) {
      // A refresh still publishes the authoritative status after transport failure.
    }
    await this.readCredential(provider)
    const state = this.credentials[provider]
    return accepted && state.ref === ref && state.configured
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}

function credential(ref: string): CredentialState {
  return { ref, configured: false, writable: true, generation: 0 }
}

function defaultRef(provider: WebSearchProviderId): string {
  if (provider === 'deepseek-official') return 'DEEPSEEK_API_KEY'
  if (provider === 'exa') return 'EXA_API_KEY'
  return 'PERPLEXITY_API_KEY'
}

function refOf(snapshot: SettingsScopeSnapshot<{ apiKeyEnv?: string }>, fallback: string): string {
  const declared = snapshot.value?.apiKeyEnv
  return declared !== undefined && declared.length > 0 ? declared : fallback
}

function providerId(value: string): WebSearchProviderId {
  return WEB_SEARCH_PROVIDER_IDS.find(provider => provider === value) ?? 'deepseek-official'
}

function addressPrefix(address: string): string {
  const separator = address.indexOf('.')
  if (separator <= 0 || separator === address.length - 1) {
    throw new Error(`web search field address is ambiguous: ${address}`)
  }
  return address.slice(0, separator)
}

function addressField(address: string): string {
  addressPrefix(address)
  return address.slice(address.indexOf('.') + 1)
}
