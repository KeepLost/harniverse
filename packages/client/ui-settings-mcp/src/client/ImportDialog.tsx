/**
 * The paste-import dialog: parse OpenCode `mcp` or standard `mcpServers`
 * JSON, preview the recognized servers, and import the non-conflicting rows.
 */

import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseMcpImport } from './import.ts'
import type { ParsedMcpServer } from './import.ts'
import type { McpLocaleKey } from './locales.ts'
import css from './McpSection.module.css'

/** The import dialog's props. */
export interface ImportDialogProps {
  /** Whether the modal is open. */
  open: boolean
  /** Locale translator. */
  t: (key: McpLocaleKey, params?: Record<string, unknown>) => string
  /** Ids already configured; conflicting parses are skipped. */
  existingIds: readonly string[]
  /** Import the parsed, non-conflicting servers. */
  import: (servers: readonly ParsedMcpServer[]) => Promise<void>
  /** Close the dialog. */
  cancel: () => void
}

/** The paste-import modal. */
export function ImportDialog(props: ImportDialogProps) {
  const { open, t, existingIds, import: importServers, cancel } = props
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<readonly ParsedMcpServer[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const accepted = (parsed ?? []).filter(server => !existingIds.includes(server.id))
  const conflicts = (parsed ?? []).filter(server => existingIds.includes(server.id))

  const submit = async () => {
    /* v8 ignore next -- the import button carries the same emptiness in its
       disabled state; this guard only defends a future caller that bypasses it. */
    if (accepted.length === 0) return
    setBusy(true)
    try {
      await importServers(accepted)
      setText('')
      setParsed(undefined)
      setError(undefined)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={cancel}
      title={t('import.title')}
      closeLabel={t('import.cancel')}
      footer={(
        <>
          <Button variant="ghost" onClick={cancel}>{t('import.cancel')}</Button>
          <Button variant="primary" disabled={busy || accepted.length === 0} onClick={() => { void submit() }}>
            {t('import.import')}
          </Button>
        </>
      )}
    >
      <div className={css.form}>
        <span className={css.formHint}>{t('import.hint')}</span>
        <label className={css.formRow}>
          <span className={css.formLabel}>{t('import.paste')}</span>
          <textarea rows={8} value={text} onChange={(event) => { setText(event.target.value) }} />
        </label>
        <Button variant="outline" onClick={() => {
          try {
            setParsed(parseMcpImport(text))
            setError(undefined)
          } catch (parseError) {
            setParsed(undefined)
            /* v8 ignore next 3 -- parseMcpImport wraps every failure in McpImportError */
            setError(parseError instanceof Error
              ? parseError.message
              : String(parseError))
          }
        }}>{t('import.parse')}</Button>
        {error !== undefined && <span className={css.formError}>{t('import.failed', { message: error })}</span>}
        {parsed !== undefined && (
          <>
            <span className={css.formHint}>{t('import.parsed', { count: String(parsed.length) })}</span>
            <div className={css.parsedList}>
              {parsed.map(server => (
                <div key={server.id} className={css.parsedRow}>
                  <span className={css.parsedName}>{server.serverName}</span>
                  <span className={css.parsedTransport}>{server.transport}</span>
                  <span className={css.parsedTarget}>{server.transport === 'stdio' ? [server.command, ...server.args].join(' ') : server.url}</span>
                </div>
              ))}
            </div>
            {conflicts.map(server => (
              <span key={server.id} className={css.formHint}>{t('import.conflict', { name: server.id })}</span>
            ))}
          </>
        )}
      </div>
    </Modal>
  )
}
