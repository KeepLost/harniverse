/**
 * The server editor: one modal form covering both transports and the
 * behavior fields the settings schema owns. Secret values (env/headers) ride
 * write-only: configured keys render as placeholders and lines left empty
 * keep the stored value.
 */

import { useState } from 'react'
import { Button, Input, Modal, Select } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatKeyValueLines, parseKeyValueLines } from './import.ts'
import type { McpSettingsServers } from './section-store.ts'
import type { McpLocaleKey } from './locales.ts'
import css from './McpSection.module.css'

/** The editor's serializable draft (what a settings row carries). */
export interface ServerDraft {
  id: string
  serverName: string
  transport: 'stdio' | 'streamable-http'
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  toolCallTimeoutMs: string
  maxInstructionBytes: string
  failOnStartupError: boolean
}

/** One settings row as the editor reads it (secrets redacted on the wire). */
export type EditableServerRow = NonNullable<McpSettingsServers['servers']>[number]

/** Translate a settings row into the editor draft. */
export function draftOf(row: EditableServerRow | undefined, id: string): ServerDraft {
  return {
    id: row?.id ?? id,
    serverName: row?.serverName ?? id,
    transport: row?.transport ?? 'stdio',
    command: row?.command ?? '',
    args: (row?.args ?? []).join('\n'),
    env: formatKeyValueLines(row?.env ?? {}),
    cwd: row?.cwd ?? '',
    url: row?.url ?? '',
    headers: formatKeyValueLines(row?.headers ?? {}),
    toolCallTimeoutMs: row?.toolCallTimeoutMs === undefined ? '' : String(row.toolCallTimeoutMs),
    maxInstructionBytes: row?.maxInstructionBytes === undefined ? '' : String(row.maxInstructionBytes),
    failOnStartupError: row?.failOnStartupError === true,
  }
}

/** Validation failure keys the editor reports before touching the scope. */
export type DraftError = McpLocaleKey

/**
 * Validate one draft against the settings schema's own rules.
 * @param draft - the editor's current draft.
 * @param others - the other rows (id/serverName uniqueness).
 * @param originalId - the edited row's id, or undefined for a new row.
 * @returns the first failure key, or undefined when the draft is valid.
 */
export function validateDraft(
  draft: ServerDraft,
  others: readonly EditableServerRow[],
  originalId: string | undefined,
): DraftError | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(draft.id)) return 'editor.invalidId'
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(draft.serverName)) return 'editor.invalidServerName'
  if (others.some(row => row.id === draft.id && row.id !== originalId)) return 'editor.duplicateId'
  if (others.some(row => row.serverName === draft.serverName && row.id !== originalId)) return 'editor.duplicateServerName'
  if (draft.transport === 'stdio' && draft.command.trim() === '') return 'editor.commandRequired'
  if (draft.transport === 'streamable-http' && draft.url.trim() === '') return 'editor.urlRequired'
  return undefined
}

/** Stored secret maps an edited row may carry; empty draft values keep these. */
export interface StoredSecrets {
  /** Stdio environment additions as stored. */
  env?: Record<string, string>
  /** Remote request headers as stored. */
  headers?: Record<string, string>
}

/**
 * Resolve a draft's KEY=VALUE map against the stored secrets: a key whose
 * line is absent is removed, a key with an empty value keeps the stored one.
 * @param lines - the draft's text-area lines.
 * @param stored - the stored secret map for this row, when one exists.
 * @returns the resolved map.
 */
function resolveSecrets(lines: string, stored: Record<string, string> | undefined): Record<string, string> {
  const parsed = parseKeyValueLines(lines)
  const resolved: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    resolved[key] = value === '' ? stored?.[key] ?? '' : value
  }
  return resolved
}

/**
 * Materialize a draft into the settings row shape.
 * @param draft - the validated draft.
 * @param stored - the edited row's stored secrets, when one exists.
 * @returns the complete row for the servers array.
 */
export function rowOf(draft: ServerDraft, stored: StoredSecrets = {}): EditableServerRow {
  const timeout = Number(draft.toolCallTimeoutMs)
  const instructionBytes = Number(draft.maxInstructionBytes)
  const common = {
    id: draft.id,
    serverName: draft.serverName,
    enabled: true,
    transport: draft.transport,
    ...draft.toolCallTimeoutMs !== '' && Number.isFinite(timeout) ? { toolCallTimeoutMs: timeout } : {},
    ...draft.maxInstructionBytes !== '' && Number.isFinite(instructionBytes) ? { maxInstructionBytes: instructionBytes } : {},
    failOnStartupError: draft.failOnStartupError,
  }
  if (draft.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: draft.command.trim(),
      args: draft.args.split('\n').map(line => line.trim()).filter(line => line !== ''),
      env: resolveSecrets(draft.env, stored.env),
      cwd: draft.cwd,
    }
  }
  return {
    ...common,
    transport: 'streamable-http',
    url: draft.url.trim(),
    headers: resolveSecrets(draft.headers, stored.headers),
  }
}

/** The editor's props. */
export interface ServerEditorProps {
  /** Whether the modal is open. */
  open: boolean
  /** Whether a new row (true) or an existing one (false) is edited. */
  creating: boolean
  /** The draft state. */
  draft: ServerDraft
  /** Replace the draft. */
  setDraft: (draft: ServerDraft) => void
  /** The other rows for uniqueness checks. */
  others: readonly EditableServerRow[]
  /** Locale translator. */
  t: (key: McpLocaleKey, params?: Record<string, unknown>) => string
  /** Persist the draft. */
  save: () => Promise<void>
  /** Close without saving. */
  cancel: () => void
}

/** The editor modal. */
export function ServerEditor(props: ServerEditorProps) {
  const { open, creating, draft, setDraft, others, t, save, cancel } = props
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<DraftError | undefined>(undefined)
  const editingId = creating ? undefined : draft.id

  const submit = async () => {
    const failure = validateDraft(draft, others, editingId)
    setError(failure)
    if (failure !== undefined) return
    setBusy(true)
    try {
      await save()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={cancel}
      title={creating ? t('editor.addTitle') : t('editor.editTitle')}
      closeLabel={t('editor.cancel')}
      footer={(
        <>
          <Button variant="ghost" onClick={cancel}>{t('editor.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void submit() }}>{t('editor.save')}</Button>
        </>
      )}
    >
      <div className={css.form}>
        <label className={css.formRow}>
          <span className={css.formLabel}>{t('editor.id')}</span>
          <Input value={draft.id} disabled={!creating} onChange={(event) => { setDraft({ ...draft, id: event.target.value }) }} />
        </label>
        <label className={css.formRow}>
          <span className={css.formLabel}>{t('editor.serverName')}</span>
          <Input value={draft.serverName} onChange={(event) => { setDraft({ ...draft, serverName: event.target.value }) }} />
        </label>
        <label className={css.formRow}>
          <span className={css.formLabel}>{t('editor.transport')}</span>
          <Select value={draft.transport} onChange={(event) => { setDraft({ ...draft, transport: event.target.value as 'stdio' | 'streamable-http' }) }}>
            <option value="stdio">{t('editor.transport.stdio')}</option>
            <option value="streamable-http">{t('editor.transport.http')}</option>
          </Select>
        </label>
        {draft.transport === 'stdio' ? (
          <>
            <label className={css.formRow}>
              <span className={css.formLabel}>{t('editor.command')}</span>
              <Input
                value={draft.command}
                onChange={(event) => { setDraft({ ...draft, command: event.target.value }) }}
              />
            </label>
            <label className={css.formRow}>
              <span className={css.formLabel}>{t('editor.args')}</span>
              <textarea
                className={css.formRow}
                rows={3}
                value={draft.args}
                onChange={(event) => { setDraft({ ...draft, args: event.target.value }) }}
              />
            </label>
            <label className={css.formRow}>
              <span className={css.formLabel}>{t('editor.env')}</span>
              <textarea rows={3} value={draft.env} onChange={(event) => { setDraft({ ...draft, env: event.target.value }) }} />
              <span className={css.formHint}>{t('editor.envHint')}</span>
            </label>
            <label className={css.formRow}>
              <span className={css.formLabel}>{t('editor.cwd')}</span>
              <Input value={draft.cwd} onChange={(event) => { setDraft({ ...draft, cwd: event.target.value }) }} />
            </label>
          </>
        ) : (
          <>
            <label className={css.formRow}>
              <span className={css.formLabel}>{t('editor.url')}</span>
              <Input value={draft.url} onChange={(event) => { setDraft({ ...draft, url: event.target.value }) }} />
            </label>
            <label className={css.formRow}>
              <span className={css.formLabel}>{t('editor.headers')}</span>
              <textarea rows={3} value={draft.headers} onChange={(event) => { setDraft({ ...draft, headers: event.target.value }) }} />
              <span className={css.formHint}>{t('editor.envHint')}</span>
            </label>
          </>
        )}
        <label className={css.formRow}>
          <span className={css.formLabel}>{t('editor.timeout')}</span>
          <Input value={draft.toolCallTimeoutMs} inputMode="numeric" onChange={(event) => { setDraft({ ...draft, toolCallTimeoutMs: event.target.value }) }} />
        </label>
        <label className={css.formRow}>
          <span className={css.formLabel}>{t('editor.instructionBytes')}</span>
          <Input value={draft.maxInstructionBytes} inputMode="numeric" onChange={(event) => { setDraft({ ...draft, maxInstructionBytes: event.target.value }) }} />
        </label>
        <label className={css.checkRow}>
          <input type="checkbox" checked={draft.failOnStartupError} onChange={(event) => { setDraft({ ...draft, failOnStartupError: event.target.checked }) }} />
          <span className={css.formLabel}>{t('editor.failOnStartupError')}</span>
        </label>
        {error !== undefined && <span className={css.formError}>{t(error)}</span>}
      </div>
    </Modal>
  )
}
