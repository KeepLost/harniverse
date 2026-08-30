/** Pure presentation for the Web selectors and selected provider forms. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, SelectField, ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type {
  BraveWebSearchState, DeepSeekWebSearchState, ExaWebSearchState,
  FirecrawlWebSearchState, KagiWebSearchState, PerplexityWebSearchState,
  TavilyWebSearchState, WebSearchCardState,
  WebSearchCardFace,
} from './web-search-card-controller.ts'
import type { CardFieldState } from './card-form.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the Web search card. */
export type WebSearchCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<WebSearchCardFace>

/**
 * Render the selectors and only the selected providers' controls.
 * @param props - locale copy, aggregate snapshot, and staged form actions.
 * @returns the single Web search card.
 */
export function WebSearchCard(props: WebSearchCardProps) {
  const { t } = props
  const state = props.useWebSearchCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="webSearchTitle"
      descriptionKey="webSearchDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <SelectField
        {...fieldFrame(t)}
        id="plugin-config-web-search-provider"
        label={t('webSearchProvider')}
        hint={t('webSearchProviderHint')}
        disabled={!state.selector.writable}
        {...state.selector.searchProvider}
        options={[
          { value: 'deepseek-official', label: t('webSearchProviderDeepSeek') },
          { value: 'exa', label: t('webSearchProviderExa') },
          { value: 'perplexity', label: t('webSearchProviderPerplexity') },
          { value: 'tavily', label: t('webSearchProviderTavily') },
          { value: 'brave', label: t('webSearchProviderBrave') },
          { value: 'kagi', label: t('webSearchProviderKagi') },
          { value: 'firecrawl', label: t('webSearchProviderFirecrawl') },
        ]}
        onEdit={(text) => { props.edit('selector.searchProvider', text) }}
        onReset={() => { props.resetField('selector.searchProvider') }}
      />
      <SelectField
        {...fieldFrame(t)}
        id="plugin-config-web-fetch-provider"
        label={t('webSearchFetchProvider')}
        hint={t('webSearchFetchProviderHint')}
        disabled={!state.selector.writable}
        {...state.selector.fetchProvider}
        options={[
          { value: 'http', label: t('webSearchFetchProviderHttp') },
          { value: 'firecrawl', label: t('webSearchFetchProviderFirecrawl') },
        ]}
        onEdit={(text) => { props.edit('selector.fetchProvider', text) }}
        onReset={() => { props.resetField('selector.fetchProvider') }}
      />
      <SearchProviderFields t={t} state={state} edit={props.edit} reset={props.resetField} />
      {state.selectedFetchProvider === 'firecrawl' && state.selectedProvider !== 'firecrawl'
        ? <FirecrawlFields t={t} state={state.firecrawl} edit={props.edit} reset={props.resetField} />
        : null}
    </PluginCard>
  )
}

type T = (key: PluginsSettingsLocaleKey) => string
type Edit = (address: string, text: string) => void
type Reset = (address: string) => void

function fieldFrame(t: T) {
  return {
    overriddenLabel: t('overridden'),
    resetLabel: t('reset'),
    invalidLabel: t('invalidNumber'),
  }
}

function ProviderValue(props: {
  t: T
  id: string
  label: PluginsSettingsLocaleKey
  hint: PluginsSettingsLocaleKey
  state: CardFieldState
  address: string
  disabled: boolean
  numeric?: boolean
  edit: Edit
  reset: Reset
}) {
  return (
    <ValueField
      {...fieldFrame(props.t)}
      id={props.id}
      label={props.t(props.label)}
      hint={props.t(props.hint)}
      disabled={props.disabled}
      {...props.numeric === true ? { numeric: true } : {}}
      {...props.state}
      onEdit={(text) => { props.edit(props.address, text) }}
      onReset={() => { props.reset(props.address) }}
    />
  )
}

function ProviderBoolean(props: {
  t: T
  id: string
  label: PluginsSettingsLocaleKey
  hint: PluginsSettingsLocaleKey
  state: CardFieldState
  address: string
  disabled: boolean
  edit: Edit
  reset: Reset
}) {
  return (
    <SelectField
      {...fieldFrame(props.t)}
      id={props.id}
      label={props.t(props.label)}
      hint={props.t(props.hint)}
      disabled={props.disabled}
      {...props.state}
      options={[
        { value: 'true', label: props.t('webSearchBooleanTrue') },
        { value: 'false', label: props.t('webSearchBooleanFalse') },
      ]}
      onEdit={(text) => { props.edit(props.address, text) }}
      onReset={() => { props.reset(props.address) }}
    />
  )
}

function ProviderSecret(props: {
  t: T
  id: string
  label: PluginsSettingsLocaleKey
  state: { apiKey: CardFieldState; apiKeyConfigured: boolean; apiKeyWritable: boolean }
  address: string
  edit: Edit
}) {
  return (
    <SecretField
      id={props.id}
      label={props.t(props.label)}
      hint={props.t('webSearchApiKeyHint')}
      disabled={!props.state.apiKeyWritable}
      text={props.state.apiKey.text}
      configured={props.state.apiKeyConfigured}
      stateLabel={props.t(props.state.apiKeyConfigured ? 'webSearchApiKeySet' : 'webSearchApiKeyUnset')}
      onEdit={(text) => { props.edit(props.address, text) }}
    />
  )
}

function ProviderUnavailable({ t }: { t: T }) {
  return <p role="status">{t('webSearchProviderUnavailable')}</p>
}

function SearchProviderFields(props: { t: T; state: WebSearchCardState; edit: Edit; reset: Reset }) {
  if (props.state.selectedProvider === 'deepseek-official') {
    return <DeepSeekFields t={props.t} state={props.state.deepseek} edit={props.edit} reset={props.reset} />
  }
  if (props.state.selectedProvider === 'exa') {
    return <ExaFields t={props.t} state={props.state.exa} edit={props.edit} reset={props.reset} />
  }
  if (props.state.selectedProvider === 'perplexity') {
    return <PerplexityFields t={props.t} state={props.state.perplexity} edit={props.edit} reset={props.reset} />
  }
  if (props.state.selectedProvider === 'tavily') {
    return <TavilyFields t={props.t} state={props.state.tavily} edit={props.edit} reset={props.reset} />
  }
  if (props.state.selectedProvider === 'brave') {
    return <BraveFields t={props.t} state={props.state.brave} edit={props.edit} reset={props.reset} />
  }
  if (props.state.selectedProvider === 'kagi') {
    return <KagiFields t={props.t} state={props.state.kagi} edit={props.edit} reset={props.reset} />
  }
  return <FirecrawlFields t={props.t} state={props.state.firecrawl} edit={props.edit} reset={props.reset} />
}

function DeepSeekFields(props: { t: T; state: DeepSeekWebSearchState; edit: Edit; reset: Reset }) {
  if (!props.state.available) return <ProviderUnavailable t={props.t} />
  const common = { t: props.t, disabled: !props.state.writable, edit: props.edit, reset: props.reset }
  return (
    <>
      <ProviderSecret
        t={props.t} id="plugin-config-web-search-deepseek-key"
        label="webSearchDeepSeekApiKey" state={props.state}
        address="deepseek.apiKey" edit={props.edit}
      />
      <ProviderValue {...common} id="plugin-config-web-search-deepseek-base-url" label="webSearchBaseUrl" hint="webSearchBaseUrlHint" state={props.state.baseURL} address="deepseek.baseURL" />
      <ProviderValue {...common} id="plugin-config-web-search-deepseek-model" label="webSearchDeepSeekModel" hint="webSearchDeepSeekModelHint" state={props.state.model} address="deepseek.model" />
      <ProviderValue {...common} id="plugin-config-web-search-deepseek-api-version" label="webSearchDeepSeekApiVersion" hint="webSearchDeepSeekApiVersionHint" state={props.state.apiVersion} address="deepseek.apiVersion" />
      <ProviderValue {...common} numeric id="plugin-config-web-search-deepseek-max-tokens" label="webSearchDeepSeekMaxTokens" hint="webSearchDeepSeekMaxTokensHint" state={props.state.maxTokens} address="deepseek.maxTokens" />
      <ProviderValue {...common} numeric id="plugin-config-web-search-deepseek-max-uses" label="webSearchDeepSeekMaxUses" hint="webSearchDeepSeekMaxUsesHint" state={props.state.maxUses} address="deepseek.maxUses" />
    </>
  )
}

function ExaFields(props: { t: T; state: ExaWebSearchState; edit: Edit; reset: Reset }) {
  if (!props.state.available) return <ProviderUnavailable t={props.t} />
  const common = { t: props.t, disabled: !props.state.writable, edit: props.edit, reset: props.reset }
  return (
    <>
      <ProviderSecret
        t={props.t} id="plugin-config-web-search-exa-key"
        label="webSearchExaApiKey" state={props.state}
        address="exa.apiKey" edit={props.edit}
      />
      <ProviderValue {...common} id="plugin-config-web-search-exa-base-url" label="webSearchBaseUrl" hint="webSearchBaseUrlHint" state={props.state.baseURL} address="exa.baseURL" />
      <SelectField
        {...fieldFrame(props.t)}
        id="plugin-config-web-search-exa-search-type"
        label={props.t('webSearchExaSearchType')}
        hint={props.t('webSearchExaSearchTypeHint')}
        disabled={!props.state.writable}
        {...props.state.searchType}
        options={[
          { value: 'auto', label: props.t('webSearchExaSearchTypeAuto') },
          { value: 'keyword', label: props.t('webSearchExaSearchTypeKeyword') },
          { value: 'neural', label: props.t('webSearchExaSearchTypeNeural') },
        ]}
        onEdit={(text) => { props.edit('exa.searchType', text) }}
        onReset={() => { props.reset('exa.searchType') }}
      />
      <ProviderValue {...common} numeric id="plugin-config-web-search-exa-num-results" label="webSearchExaNumResults" hint="webSearchExaNumResultsHint" state={props.state.numResults} address="exa.numResults" />
      <ProviderValue {...common} numeric id="plugin-config-web-search-exa-highlights" label="webSearchExaHighlightsPerResult" hint="webSearchExaHighlightsPerResultHint" state={props.state.highlightsPerResult} address="exa.highlightsPerResult" />
    </>
  )
}

function PerplexityFields(props: { t: T; state: PerplexityWebSearchState; edit: Edit; reset: Reset }) {
  if (!props.state.available) return <ProviderUnavailable t={props.t} />
  const common = { t: props.t, disabled: !props.state.writable, edit: props.edit, reset: props.reset }
  return (
    <>
      <ProviderSecret
        t={props.t} id="plugin-config-web-search-perplexity-key"
        label="webSearchPerplexityApiKey" state={props.state}
        address="perplexity.apiKey" edit={props.edit}
      />
      <ProviderValue {...common} id="plugin-config-web-search-perplexity-base-url" label="webSearchBaseUrl" hint="webSearchBaseUrlHint" state={props.state.baseURL} address="perplexity.baseURL" />
      <ProviderValue {...common} id="plugin-config-web-search-perplexity-model" label="webSearchPerplexityModel" hint="webSearchPerplexityModelHint" state={props.state.model} address="perplexity.model" />
      <ProviderValue {...common} numeric id="plugin-config-web-search-perplexity-max-tokens" label="webSearchPerplexityMaxTokens" hint="webSearchPerplexityMaxTokensHint" state={props.state.maxTokens} address="perplexity.maxTokens" />
      <SelectField
        {...fieldFrame(props.t)}
        id="plugin-config-web-search-perplexity-recency"
        label={props.t('webSearchPerplexitySearchRecency')}
        hint={props.t('webSearchPerplexitySearchRecencyHint')}
        disabled={!props.state.writable}
        {...props.state.searchRecency}
        options={[
          { value: '', label: props.t('webSearchPerplexitySearchRecencyAny') },
          { value: 'day', label: props.t('webSearchPerplexitySearchRecencyDay') },
          { value: 'week', label: props.t('webSearchPerplexitySearchRecencyWeek') },
          { value: 'month', label: props.t('webSearchPerplexitySearchRecencyMonth') },
          { value: 'year', label: props.t('webSearchPerplexitySearchRecencyYear') },
        ]}
        onEdit={(text) => { props.edit('perplexity.searchRecency', text) }}
        onReset={() => { props.reset('perplexity.searchRecency') }}
      />
    </>
  )
}

function TavilyFields(props: { t: T; state: TavilyWebSearchState; edit: Edit; reset: Reset }) {
  if (!props.state.available) return <ProviderUnavailable t={props.t} />
  const common = { t: props.t, disabled: !props.state.writable, edit: props.edit, reset: props.reset }
  return (
    <>
      <ProviderSecret
        t={props.t} id="plugin-config-web-search-tavily-key"
        label="webSearchTavilyApiKey" state={props.state}
        address="tavily.apiKey" edit={props.edit}
      />
      <ProviderValue {...common} id="plugin-config-web-search-tavily-base-url" label="webSearchBaseUrl" hint="webSearchBaseUrlHint" state={props.state.baseURL} address="tavily.baseURL" />
      <ProviderBoolean {...common} id="plugin-config-web-search-tavily-raw-content" label="webSearchTavilyIncludeRawContent" hint="webSearchTavilyIncludeRawContentHint" state={props.state.includeRawContent} address="tavily.includeRawContent" />
      <ProviderValue {...common} numeric id="plugin-config-web-search-tavily-max-results" label="webSearchTavilyMaxResults" hint="webSearchTavilyMaxResultsHint" state={props.state.maxResults} address="tavily.maxResults" />
    </>
  )
}

function BraveFields(props: { t: T; state: BraveWebSearchState; edit: Edit; reset: Reset }) {
  if (!props.state.available) return <ProviderUnavailable t={props.t} />
  const common = { t: props.t, disabled: !props.state.writable, edit: props.edit, reset: props.reset }
  return (
    <>
      <ProviderSecret
        t={props.t} id="plugin-config-web-search-brave-key"
        label="webSearchBraveApiKey" state={props.state}
        address="brave.apiKey" edit={props.edit}
      />
      <ProviderValue {...common} id="plugin-config-web-search-brave-base-url" label="webSearchBaseUrl" hint="webSearchBaseUrlHint" state={props.state.baseURL} address="brave.baseURL" />
      <ProviderValue {...common} numeric id="plugin-config-web-search-brave-max-results" label="webSearchBraveMaxResults" hint="webSearchBraveMaxResultsHint" state={props.state.maxResults} address="brave.maxResults" />
    </>
  )
}

function KagiFields(props: { t: T; state: KagiWebSearchState; edit: Edit; reset: Reset }) {
  if (!props.state.available) return <ProviderUnavailable t={props.t} />
  return (
    <>
      <ProviderSecret
        t={props.t} id="plugin-config-web-search-kagi-key"
        label="webSearchKagiApiKey" state={props.state}
        address="kagi.apiKey" edit={props.edit}
      />
      <ProviderValue
        t={props.t} disabled={!props.state.writable} edit={props.edit} reset={props.reset}
        id="plugin-config-web-search-kagi-base-url" label="webSearchBaseUrl" hint="webSearchBaseUrlHint"
        state={props.state.baseURL} address="kagi.baseURL"
      />
    </>
  )
}

function FirecrawlFields(props: { t: T; state: FirecrawlWebSearchState; edit: Edit; reset: Reset }) {
  if (!props.state.available) return <ProviderUnavailable t={props.t} />
  const common = { t: props.t, disabled: !props.state.writable, edit: props.edit, reset: props.reset }
  return (
    <>
      <ProviderSecret
        t={props.t} id="plugin-config-web-firecrawl-key"
        label="webSearchFirecrawlApiKey" state={props.state}
        address="firecrawl.apiKey" edit={props.edit}
      />
      <ProviderValue {...common} id="plugin-config-web-firecrawl-base-url" label="webSearchBaseUrl" hint="webSearchBaseUrlHint" state={props.state.baseURL} address="firecrawl.baseURL" />
      <ProviderBoolean {...common} id="plugin-config-web-firecrawl-search-content" label="webSearchFirecrawlIncludeSearchContent" hint="webSearchFirecrawlIncludeSearchContentHint" state={props.state.includeSearchContent} address="firecrawl.includeSearchContent" />
      <ProviderValue {...common} numeric id="plugin-config-web-firecrawl-search-content-max-chars" label="webSearchFirecrawlSearchContentMaxChars" hint="webSearchFirecrawlSearchContentMaxCharsHint" state={props.state.searchContentMaxChars} address="firecrawl.searchContentMaxChars" />
      <ProviderValue {...common} numeric id="plugin-config-web-firecrawl-max-chars" label="webSearchFirecrawlMaxChars" hint="webSearchFirecrawlMaxCharsHint" state={props.state.maxChars} address="firecrawl.maxChars" />
    </>
  )
}
