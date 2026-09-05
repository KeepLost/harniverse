/** Agent Profile composition editor with server-side dependency planning. */

import { useDeferredValue, useEffect, useState, type ReactNode } from 'react'
import type { CapabilityCatalogEntry, CapabilityCompositionChange, CapabilityConfigValue, CapabilityTarget } from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CapabilityCompositionLocaleKey } from './locales.ts'
import type { CapabilityCompositionState } from './controller.ts'
import css from './CapabilityCompositionTab.module.css'

export interface CapabilityCompositionTabInjected {
  hooks: { capabilityComposition: SnapshotStore<CapabilityCompositionState> }
  load(): Promise<void>
  selectTarget(target: CapabilityTarget): Promise<void>
  setSelection(capabilityId: string, selection: 'inherit' | 'load' | 'unload'): void
  setMembers(capabilityId: string, members: 'inherit' | readonly string[]): void
  setConfig(capabilityId: string, config: 'inherit' | Readonly<Record<string, CapabilityConfigValue>>): void
  discard(): void
  preview(): Promise<void>
  apply(): Promise<void>
}

export type CapabilityCompositionTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.capabilityComposition'>
  & InjectFace<CapabilityCompositionTabInjected>

const KIND_KEYS = {
  tool: 'kindTool',
  skill: 'kindSkill',
  'mcp-server': 'kindMcpServer',
  'subagent-provider': 'kindSubagentProvider',
} as const satisfies Record<CapabilityCatalogEntry['kind'], CapabilityCompositionLocaleKey>

const PROVENANCE_KEYS = {
  upstream: 'provenanceUpstream',
  'harniverse-added': 'provenanceHarniverseAdded',
  'harniverse-adapted': 'provenanceHarniverseAdapted',
  external: 'provenanceExternal',
  unknown: 'provenanceUnknown',
} as const satisfies Record<CapabilityCatalogEntry['provenance'], CapabilityCompositionLocaleKey>

const DESCRIPTION_KEYS: Readonly<Record<string, CapabilityCompositionLocaleKey>> = {
  'plugin:persona': 'descriptionPersona',
  'plugin:agent-instructions': 'descriptionAgentInstructions',
  'plugin:tool-bash': 'descriptionBash',
  'plugin:tool-pwsh': 'descriptionPwsh',
  'plugin:tool-fs': 'descriptionFs',
  'plugin:tool-fs-search': 'descriptionFsSearch',
  'plugin:tool-jobs': 'descriptionJobs',
  'plugin:skill-filesystem': 'descriptionSkillFilesystem',
  'plugin:tool-skill': 'descriptionSkill',
  'plugin:tool-goal': 'descriptionGoal',
  'plugin:planning': 'descriptionPlanning',
  'plugin:tool-result-artifacts': 'descriptionArtifacts',
  'plugin:compaction': 'descriptionCompaction',
  'plugin:delegation': 'descriptionDelegation',
  'plugin:tool-ask-user': 'descriptionAskUser',
  'plugin:tool-todo': 'descriptionTodo',
  'plugin:tool-session-query': 'descriptionSessionQuery',
  'plugin:tool-session-delivery': 'descriptionSessionDelivery',
  'plugin:tool-web': 'descriptionWeb',
  'plugin:persistent-shell': 'descriptionPersistentShell',
  'plugin:filesystem': 'descriptionFilesystem',
  'plugin:tool-presentation': 'descriptionPresentation',
  'plugin:tool-cordis': 'descriptionCordis',
}

function targetValue(target: CapabilityTarget): string {
  return target.kind === 'global-agent' ? 'global' : `profile:${target.agentProfile}`
}

function parseTarget(value: string): CapabilityTarget {
  return value === 'global'
    ? { kind: 'global-agent' }
    : { kind: 'agent-profile', agentProfile: value.slice('profile:'.length) }
}

function CapabilityRow({
  entry,
  selection,
  profileTarget,
  busy,
  t,
  setSelection,
  setMembers,
  setConfig,
}: {
  entry: CapabilityCatalogEntry
  selection: Omit<CapabilityCompositionChange, 'capabilityId'>
  profileTarget: boolean
  busy: boolean
  t: (key: CapabilityCompositionLocaleKey) => string
  setSelection: CapabilityCompositionTabInjected['setSelection']
  setMembers: CapabilityCompositionTabInjected['setMembers']
  setConfig: CapabilityCompositionTabInjected['setConfig']
}): ReactNode {
  const selectionValue = selection.selection ?? entry.selection
  const memberDraft = selection.members
  const visibleMembers = new Set(memberDraft === 'inherit' || memberDraft === undefined
    ? entry.memberEntries?.filter(member => member.visible).map(member => member.id) ?? []
    : memberDraft)
  const configDraft = selection.config
  const configOverrides = configDraft === 'inherit' || configDraft === undefined
    ? entry.configOverrides ?? {}
    : configDraft
  const configValues = configDraft === 'inherit' || configDraft === undefined
    ? entry.effectiveConfig ?? {}
    : { ...entry.effectiveConfig, ...configDraft }
  const descriptionKey = DESCRIPTION_KEYS[entry.id]
  return (
    <li className={css.card} data-enabled={entry.selected ? 'true' : 'false'}>
      <div className={css.cardMain}>
        <div className={css.cardHeading}>
          <h3>{entry.name}</h3>
          <span className={css.kind}>{t(KIND_KEYS[entry.kind])}</span>
          <span className={css.provenance} data-provenance={entry.provenance}>
            {t(PROVENANCE_KEYS[entry.provenance])}
          </span>
        </div>
        <p className={css.description}>{descriptionKey === undefined ? entry.description : t(descriptionKey)}</p>
        <div className={css.meta}>
          <span data-effective={entry.selected ? 'load' : 'unload'}>
            {t(entry.assembleable ? entry.selected ? 'selectedLoad' : 'selectedUnload' : 'notAssembleable')}
          </span>
          {!entry.available && entry.selected ? <span>{t('implementationUnavailable')}</span> : null}
          {profileTarget && selectionValue === 'inherit' && entry.selection === 'inherit' ? (
            <span className={css.inherited}>
              {t(entry.effectiveSelection === 'load' ? 'inheritedGlobalLoad' : 'inheritedGlobalUnload')}
            </span>
          ) : null}
          {entry.owner === undefined ? null : <span>{t('owner')}: <code>{entry.owner}</code></span>}
          {entry.requires.length === 0 ? null : <span>{t('requires')}: {entry.requires.length}</span>}
          {entry.memberEntries === undefined ? null : (
            <span>{t('memberSummary')}: {visibleMembers.size}/{entry.memberEntries.length}</span>
          )}
        </div>
        {entry.memberEntries !== undefined && entry.memberEntries.length > 1 ? (
          <details className={css.details}>
            <summary>{t('members')} · {visibleMembers.size}/{entry.memberEntries.length}</summary>
            <fieldset className={css.members} disabled={busy || !entry.selected}>
              <legend className={css.visuallyHidden}>{t('members')}</legend>
              {entry.memberEntries.map(member => (
                <label key={member.id}>
                  <input
                    type="checkbox"
                    checked={visibleMembers.has(member.id)}
                    onChange={() => {
                      const next = new Set(visibleMembers)
                      if (next.has(member.id)) next.delete(member.id)
                      else next.add(member.id)
                      setMembers(entry.id, [...next].sort())
                    }}
                  />
                  <span><strong>{member.name}</strong><small>{member.description}</small></span>
                </label>
              ))}
              <button type="button" onClick={() => { setMembers(entry.id, 'inherit') }}>{t('restoreMembers')}</button>
            </fieldset>
          </details>
        ) : null}
        {entry.customization === undefined ? null : (
          <details className={css.details}>
            <summary>{t('configuration')}</summary>
            <fieldset className={css.configuration} disabled={busy}>
              <legend className={css.visuallyHidden}>{t('configuration')}</legend>
              {entry.customization.fields.map((field) => {
                const value = configValues[field.id]
                const fieldName = entry.id === 'plugin:persona' && field.id === 'text'
                  ? t('personaText')
                  : field.name
                const fieldDescription = entry.id === 'plugin:persona' && field.id === 'text'
                  ? t('personaTextDescription')
                  : field.description
                if (field.kind === 'boolean') {
                  return (
                    <label key={field.id} className={css.booleanField}>
                      <input
                        type="checkbox"
                        checked={value === true}
                        onChange={(event) => { setConfig(entry.id, { ...configOverrides, [field.id]: event.currentTarget.checked }) }}
                      />
                      <span><strong>{fieldName}</strong><small>{fieldDescription}</small></span>
                    </label>
                  )
                }
                return (
                  <label key={field.id} className={css.configField}>
                    <span>{fieldName}</span>
                    {field.multiline ? (
                      <textarea
                        value={typeof value === 'string' ? value : ''}
                        onChange={(event) => { setConfig(entry.id, { ...configOverrides, [field.id]: event.currentTarget.value }) }}
                      />
                    ) : (
                      <input
                        type={field.kind === 'number' ? 'number' : 'text'}
                        value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                        onChange={(event) => {
                          const next = field.kind === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value
                          setConfig(entry.id, { ...configOverrides, [field.id]: next })
                        }}
                      />
                    )}
                    <small>{fieldDescription}</small>
                  </label>
                )
              })}
              <button type="button" onClick={() => { setConfig(entry.id, 'inherit') }}>{t('restoreConfiguration')}</button>
            </fieldset>
          </details>
        )}
      </div>
      {entry.manageable && entry.selectionManageable !== false ? (
        <fieldset className={css.selection} disabled={busy}>
          <legend className={css.visuallyHidden}>{entry.name}</legend>
          {(['inherit', 'load', 'unload'] as const).map(value => (
            <label key={value} data-checked={selectionValue === value ? 'true' : undefined}>
              <input
                type="radio"
                name={`capability-${entry.id}`}
                value={value}
                checked={selectionValue === value}
                onChange={() => { setSelection(entry.id, value) }}
              />
              <span>{t(value)}</span>
            </label>
          ))}
        </fieldset>
      ) : <span className={css.readOnly}>{t(entry.customization === undefined ? 'readOnly' : 'requiredCapability')}</span>}
    </li>
  )
}

export function CapabilityCompositionTab(props: CapabilityCompositionTabProps): ReactNode {
  const state = props.useCapabilityComposition(value => value)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'all' | CapabilityCatalogEntry['kind']>('all')
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase())

  useEffect(() => { void props.load() }, [props.load])

  if (state.status === 'idle' || state.status === 'loading' && state.catalog === null) {
    return <p className={css.status}>{props.t('loading')}</p>
  }
  const catalog = state.catalog
  if (catalog === null) {
    return (
      <div className={css.failure}>
        <p role="alert">{props.t('error')}</p>
        <button type="button" onClick={() => { void props.load() }}>{props.t('retry')}</button>
      </div>
    )
  }
  const busy = state.planning || state.applying || state.status === 'loading'
  const entries = catalog.entries.filter((entry) => {
    if (kind !== 'all' && entry.kind !== kind) return false
    if (deferredQuery === '') return true
    return [entry.name, entry.id, entry.description, entry.owner ?? '']
      .some(value => value.toLocaleLowerCase().includes(deferredQuery))
  })
  const draftCount = Object.keys(state.draft).length
  const plan = state.plan

  return (
    <div className={css.section} aria-busy={busy}>
      <div className={css.intro}>
        <p>{props.t('intro')}</p>
        <label>
          <span>{props.t('target')}</span>
          <select
            value={targetValue(state.target)}
            disabled={busy}
            aria-label={props.t('target')}
            onChange={(event) => { void props.selectTarget(parseTarget(event.currentTarget.value)) }}
          >
            <option value="global">{props.t('globalTarget')}</option>
            {state.profiles.map(profile => (
              <option key={profile.id} value={`profile:${profile.id}`}>{profile.name}</option>
            ))}
          </select>
        </label>
        <small>{props.t(state.target.kind === 'global-agent' ? 'globalHint' : 'profileHint')}</small>
      </div>

      {state.error === null ? null : <p className={css.inlineError} role="alert">{props.t('error')}</p>}
      {catalog.complete ? null : <p className={css.warning} role="status">{props.t('incomplete')}</p>}

      <div className={css.filters}>
        <label>
          <span className={css.visuallyHidden}>{props.t('search')}</span>
          <input
            type="search"
            value={query}
            placeholder={props.t('search')}
            aria-label={props.t('search')}
            onChange={(event) => { setQuery(event.currentTarget.value) }}
          />
        </label>
        <label>
          <span className={css.visuallyHidden}>{props.t('kind')}</span>
          <select
            value={kind}
            aria-label={props.t('kind')}
            onChange={(event) => { setKind(event.currentTarget.value as typeof kind) }}
          >
            <option value="all">{props.t('kindAll')}</option>
            {Object.entries(KIND_KEYS).map(([value, key]) => (
              <option key={value} value={value}>{props.t(key)}</option>
            ))}
          </select>
        </label>
        <span className={css.count}>{entries.length} {props.t('count')}</span>
      </div>

      {catalog.entries.length === 0 ? <p className={css.status}>{props.t('empty')}</p> : null}
      {catalog.entries.length > 0 && entries.length === 0
        ? <p className={css.status}>{props.t('emptySearch')}</p>
        : null}
      {entries.length > 0 ? (
        <ul className={css.cards}>
          {entries.map(entry => (
            <CapabilityRow
              key={entry.id}
              entry={entry}
              selection={state.draft[entry.id] ?? {}}
              profileTarget={state.target.kind === 'agent-profile'}
              busy={busy}
              t={props.t}
              setSelection={props.setSelection}
              setMembers={props.setMembers}
              setConfig={props.setConfig}
            />
          ))}
        </ul>
      ) : null}

      {draftCount > 0 ? (
        <div className={css.actions}>
          <span><strong>{draftCount}</strong> {props.t('draftCount')}</span>
          <button type="button" disabled={busy} onClick={props.discard}>{props.t('discard')}</button>
          <button type="button" className={css.primary} disabled={busy} onClick={() => { void props.preview() }}>
            {props.t(state.planning ? 'planning' : 'preview')}
          </button>
        </div>
      ) : null}

      {plan === null ? null : (
        <section className={css.plan} aria-labelledby="capability-plan-title">
          <div className={css.planHeading}>
            <div>
              <h3 id="capability-plan-title">{props.t('planTitle')}</h3>
              <p>{props.t(plan.blockers.length === 0 ? 'planClean' : 'planBlocked')}</p>
            </div>
            <div className={css.planCounts}>
              <span>{props.t('operationCount')}: <strong>{plan.operations.length}</strong></span>
              <span>{props.t('blockerCount')}: <strong>{plan.blockers.length}</strong></span>
            </div>
          </div>
          {plan.blockers.length === 0 ? null : (
            <ul className={css.blockers} role="alert">
              {plan.blockers.map((blocker, index) => (
                <li key={`${blocker.code}:${blocker.capabilityId}:${index}`}>{blocker.message}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className={css.primary}
            disabled={busy || plan.blockers.length > 0}
            onClick={() => { void props.apply() }}
          >
            {props.t(state.applying ? 'applying' : 'apply')}
          </button>
        </section>
      )}
    </div>
  )
}
