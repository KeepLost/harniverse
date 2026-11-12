/**
 * The shell registry section: the registry-default radio fieldset plus the
 * custom-entry list over the host `shell-registry` settings namespace.
 * Writes go through the bound settings scope (`default` and `entries`
 * fields); the namespace declares `applies: 'restart'`, so the composed
 * shell rows follow on the next start — the form itself holds only drafts.
 */

import { useEffect, useState } from 'react'
import type { SettingsScopeSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShellBackendSectionValue, ShellRegistryEntryValue } from './decode.ts'
import css from './ShellBackendSection.module.css'

/** Boot-stable probe badge for one registered entry, from the host description. */
export interface ShellEntryProbe {
  /** Registry entry id the badge addresses. */
  id: string
  /** Whether the boot probe resolved the entry's executable. */
  available: boolean
}

/** Registration-side business face for the section. */
export interface ShellBackendSectionInjected {
  hooks: {
    /** Settings scope snapshot bound by the renderer as useScope. */
    scope: SnapshotStore<SettingsScopeSnapshot<ShellBackendSectionValue>>
  }
  /** Queue one field write through the bound settings scope. */
  set: (field: string, value: unknown) => Promise<void>
  /** Boot snapshot of the host's entry probes; undefined when not exposed. */
  probe: readonly ShellEntryProbe[] | undefined
}

/** Props the renderer binds for the section. */
export type ShellBackendSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.shell-backend'>
  & InjectFace<ShellBackendSectionInjected>

/** One notice the actions row reports to assistive technology. */
type Notice = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; message: string }

/** Draft state of the add-entry form. */
type AddDraft = { id: string; path: string }

const EMPTY_ADD: AddDraft = { id: '', path: '' }

/** Render the Shell registry settings page. */
export function ShellBackendSection({ t, useScope, set, probe }: ShellBackendSectionProps) {
  const scope = useScope(snapshot => snapshot)
  const [draft, setDraft] = useState<string | null>(null)
  const [draftEntries, setDraftEntries] = useState<readonly ShellRegistryEntryValue[] | null>(null)
  const [addDraft, setAddDraft] = useState<AddDraft>(EMPTY_ADD)
  const [dirty, setDirty] = useState(false)
  const [syncedRevision, setSyncedRevision] = useState<number | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>({ kind: 'idle' })

  const current = scope.value
  // Adopt every clean revision: the first resolved section and each external
  // or settled write. A dirty draft (the user edited since the last sync) is
  // the user's until saved or reverted.
  useEffect(() => {
    if (current === undefined || dirty) return
    if (draft !== null && scope.revision === syncedRevision) return
    setDraft(current.default)
    setDraftEntries(current.entries)
    setSyncedRevision(scope.revision)
  }, [current, dirty, draft, scope.revision, syncedRevision])

  if (scope.status !== 'ready' || current === undefined) {
    return (
      <section className={css.page} aria-label={t('title')}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.note}>{scope.status === 'unavailable' ? t('unavailable') : t('loading')}</p>
      </section>
    )
  }

  // The early return above guarantees `current` is present; before the first
  // adoption the drafts fall back to the resolved section, and the disabled
  // props below are the single invocation gate (no in-handler re-guard).
  const view: string = draft ?? current.default
  const entryView: readonly ShellRegistryEntryValue[] = draftEntries ?? current.entries
  const entriesChanged = !entriesEqual(entryView, current.entries)
  const disabled = busy || !scope.writable

  const save = async (): Promise<void> => {
    setBusy(true)
    setNotice({ kind: 'idle' })
    try {
      // The namespace validation rejects the whole write loudly (slug ids,
      // dialect classes, default-addresses-entry), so the form sends drafts
      // as-is and surfaces the rejection text verbatim.
      if (view !== current.default) await set('default', view)
      if (entriesChanged) {
        await set('entries', entryView.map(entry => ({ id: entry.id, path: entry.path, label: entry.label ?? '' })))
      }
      setNotice({ kind: 'saved' })
      setDirty(false)
    } catch (error: unknown) {
      setNotice({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(false)
    }
  }

  const options: readonly { value: string; label: string; desc: string }[] = [
    { value: 'platform-default', label: t('default.platform-default'), desc: t('default.platform-defaultDesc') },
    { value: 'posix', label: t('default.posix'), desc: t('default.posixDesc') },
    { value: 'pwsh', label: t('default.pwsh'), desc: t('default.pwshDesc') },
    ...entryView.map(entry => ({
      value: entry.id,
      label: entry.label ?? entry.id,
      desc: entry.path,
    })),
  ]

  const addEntry = (): void => {
    const id = addDraft.id.trim()
    const path = addDraft.path.trim()
    // Empty ids/paths never leave the form; deeper rules (slug shape,
    // dialect class, reserved or duplicate ids) belong to the namespace
    // validation and come back as its rejection text.
    if (id === '' || path === '') return
    setDraftEntries([...entryView, { id, path }])
    setAddDraft(EMPTY_ADD)
    setDirty(true)
    setNotice({ kind: 'idle' })
  }

  const removeEntry = (id: string): void => {
    setDraftEntries(entryView.filter(entry => entry.id !== id))
    setDirty(true)
    setNotice({ kind: 'idle' })
  }

  const badge = (id: string): string | undefined => {
    const status = probe?.find(entry => entry.id === id)
    return status === undefined ? undefined : (status.available ? t('entries.probeOk') : t('entries.probeFail'))
  }

  return (
    <section className={css.page} aria-label={t('title')}>
      <h2 className={css.title}>{t('title')}</h2>
      <p className={css.note}>{t('intro')}</p>
      <fieldset className={css.fieldset}>
        {options.map(entry => (
          <div key={entry.value} className={css.optionRow}>
            <label className={css.radioLabel}>
              <input
                type="radio"
                name="shell-registry-default"
                checked={view === entry.value}
                onChange={() => {
                  setDraft(entry.value)
                  setDirty(true)
                  setNotice({ kind: 'idle' })
                }}
                disabled={disabled}
              />
              <span>{entry.label}</span>
            </label>
            <span className={css.hint}>{entry.desc}</span>
          </div>
        ))}
        <div className={css.actions}>
          <Button variant="primary" disabled={disabled || !dirty} onClick={() => { void save() }}>
            {busy ? t('saving') : t('save')}
          </Button>
          <Button variant="ghost" disabled={disabled || !dirty} onClick={() => {
            setDraft(current.default)
            setDraftEntries(current.entries)
            setAddDraft(EMPTY_ADD)
            setDirty(false)
            setNotice({ kind: 'idle' })
          }}>
            {t('revert')}
          </Button>
          <span className={css.notice} aria-live="polite">
            {notice.kind === 'saved' && t('saved')}
            {notice.kind === 'error' && t('saveFailed', { message: notice.message === '' ? t('unknownError') : notice.message })}
          </span>
        </div>
        {!scope.writable ? <p className={css.note}>{t('readonly')}</p> : null}
      </fieldset>
      <fieldset className={css.fieldset}>
        <legend className={css.legend}>{t('entries.title')}</legend>
        <p className={css.note}>{t('entries.intro')}</p>
        {entryView.length === 0 && <p className={css.note}>{t('entries.empty')}</p>}
        {entryView.map(entry => (
          <div key={entry.id} className={css.entryRow}>
            <span className={css.radioLabel}>
              <span>{entry.label ?? entry.id}</span>
              {badge(entry.id) !== undefined && <span className={css.hint} data-probe={entry.id}>{badge(entry.id)}</span>}
            </span>
            <span className={css.hint}>{entry.path}</span>
            <Button variant="ghost" disabled={disabled} onClick={() => { removeEntry(entry.id) }}>
              {t('entries.remove')}
            </Button>
          </div>
        ))}
        <div className={css.addRow}>
          <label className={css.addField}>
            <span>{t('entries.id')}</span>
            <input
              value={addDraft.id}
              onChange={(event) => { setAddDraft({ ...addDraft, id: event.target.value }) }}
              disabled={disabled}
              placeholder="my-zsh"
            />
          </label>
          <label className={css.addField}>
            <span>{t('entries.path')}</span>
            <input
              value={addDraft.path}
              onChange={(event) => { setAddDraft({ ...addDraft, path: event.target.value }) }}
              disabled={disabled}
              placeholder="/bin/zsh"
            />
          </label>
          <Button variant="ghost" disabled={disabled} onClick={addEntry}>
            {t('entries.add')}
          </Button>
        </div>
      </fieldset>
    </section>
  )
}

/** Structural equality for the entries draft against the resolved section. */
function entriesEqual(a: readonly ShellRegistryEntryValue[], b: readonly ShellRegistryEntryValue[]): boolean {
  if (a.length !== b.length) return false
  return a.every((entry, i) => {
    const other = b[i]
    return other !== undefined && entry.id === other.id && entry.path === other.path && entry.label === other.label
  })
}
