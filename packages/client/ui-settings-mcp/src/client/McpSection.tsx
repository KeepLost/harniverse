/**
 * The MCP management settings section: a fixed header (intro plus add /
 * import / refresh actions) over the scrolling server-card list. Server
 * writes ride the `mcp` settings scope; connection status and restart ride
 * the mcpManagement Remote; preset references come from the capability
 * composition of each preset.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Button, IconDownloadOutline16, IconPlusOutline16, IconRefreshOutline16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ServerRow } from './ServerRow.tsx'
import { ServerEditor, draftOf, rowOf } from './ServerEditor.tsx'
import type { ServerDraft } from './ServerEditor.tsx'
import { ImportDialog } from './ImportDialog.tsx'
import type { McpSectionState, McpSettingsServers } from './section-store.ts'

/** One settings row, non-optional alias for editor/import plumbing. */
type ServerSettingsRow = NonNullable<McpSettingsServers['servers']>[number]
import css from './McpSection.module.css'

/** Registration-side business face of the MCP section. */
export interface McpSectionInjected {
  hooks: {
    /** Section snapshot bound by the renderer as useMcpSection. */
    mcpSection: SnapshotStore<McpSectionState>
  }
  /** The bound `mcp` settings scope, for reads and writes. */
  scope: McpSectionInjectedScope
  /** One joined refresh (settings + status + presets). */
  refresh: () => Promise<void>
  /** Write the complete server array. */
  writeServers: (servers: ReadonlyArray<ServerSettingsRow>) => Promise<void>
  /** Restart one enabled server's shared connection. */
  restart: (id: string) => Promise<string | undefined>
}

/** The settings-scope face the section reads rows from. */
export interface McpSectionInjectedScope {
  /** Current sync snapshot of the `mcp` settings section. */
  getSnapshot: () => { status: 'loading' | 'ready' | 'unavailable'; value: McpSettingsServers | undefined; writable: boolean }
}

/** Full component props. */
export type McpSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.mcp'>
  & InjectFace<McpSectionInjected>

/** The settings page. */
export function McpSection(props: McpSectionProps) {
  const { t, scope, refresh, writeServers, restart } = props
  const state = props.useMcpSection(snapshot => snapshot)
  const settings = scope.getSnapshot()
  const rows = state.rows ?? []
  const writable = settings.writable
  const [editorOpen, setEditorOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [draft, setDraft] = useState<ServerDraft>(() => draftOf(undefined, 'server-1'))
  const [importOpen, setImportOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [writeError, setWriteError] = useState<string | undefined>(undefined)

  useEffect(() => { void refresh() }, [refresh])

  const settingsRows = useMemo(() => settings.value?.servers ?? [], [settings.value])

  /** Persist the editor's draft as the new servers array. */
  const saveDraft = async () => {
    const next = creating
      ? [...settingsRows, rowOf(draft)]
      : settingsRows.map(row => row.id === draft.id ? { ...row, ...rowOf(draft, row) } : row)
    try {
      await writeServers(next)
      setEditorOpen(false)
      setWriteError(undefined)
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error))
    }
  }

  const setEnabled = async (id: string, enabled: boolean) => {
    try {
      await writeServers(settingsRows.map(row => row.id === id ? { ...row, enabled } : row))
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error))
    }
  }

  const removeRow = async (id: string) => {
    try {
      await writeServers(settingsRows.filter(row => row.id !== id))
      setDeleteId(null)
      setWriteError(undefined)
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error))
    }
  }

  const importServers = async (servers: readonly ServerSettingsRow[]) => {
    try {
      await writeServers([...settingsRows, ...servers.map(server => ({ ...server, enabled: true }))])
      setImportOpen(false)
      setWriteError(undefined)
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : String(error))
    }
  }

  const deleting = rows.find(row => row.id === deleteId)

  return (
    <div className={css.section}>
      <header className={css.header}>
        <h2 className={css.title}>{t('title')}</h2>
        <p className={css.intro}>{t('intro')}</p>
        {!writable && <span className={css.formHint}>{t('readonly')}</span>}
        <div className={css.actions}>
          <Button variant="primary" icon={<IconPlusOutline16 size={16} />} disabled={!writable} onClick={() => {
            setCreating(true)
            setDraft(draftOf(undefined, 'server-1'))
            setEditorOpen(true)
          }}>{t('add')}</Button>
          <Button variant="outline" icon={<IconDownloadOutline16 size={16} />} disabled={!writable} onClick={() => { setImportOpen(true) }}>
            {t('import')}
          </Button>
          <Button variant="ghost" icon={<IconRefreshOutline16 size={16} />} onClick={() => { void refresh() }}>{t('refresh')}</Button>
        </div>
        {writeError !== undefined && <span className={css.formError}>{t('writeFailed', { message: writeError })}</span>}
      </header>
      <div className={css.list}>
        {state.status === 'loading' && rows.length === 0 && <p className={css.notice}>{t('loading')}</p>}
        {state.status === 'error' && <p className={css.notice}>{t('error')}</p>}
        {state.status === 'ready' && rows.length === 0 && <p className={css.notice}>{t('empty')}</p>}
        {rows.map(row => (
          <ServerRow
            key={row.id}
            row={row}
            writable={writable}
            t={t}
            actions={{
              setEnabled,
              edit: (id) => {
                const target = settingsRows.find(entry => entry.id === id)
                if (target === undefined) return
                setCreating(false)
                setDraft(draftOf(target, id))
                setEditorOpen(true)
              },
              requestDelete: (id) => { setDeleteId(id) },
              restart,
            }}
          />
        ))}
      </div>
      <ServerEditor
        open={editorOpen}
        creating={creating}
        draft={draft}
        setDraft={setDraft}
        others={settingsRows.filter(row => row.id !== (creating ? '' : draft.id))}
        t={t}
        save={saveDraft}
        cancel={() => { setEditorOpen(false) }}
      />
      <ImportDialog
        open={importOpen}
        t={t}
        existingIds={settingsRows.map(row => row.id)}
        import={importServers}
        cancel={() => { setImportOpen(false) }}
      />
      <Modal
        open={deleteId !== null}
        onClose={() => { setDeleteId(null) }}
        title={t('row.confirmDelete', { name: deleting?.serverName ?? deleteId ?? '' })}
        closeLabel={t('editor.cancel')}
        footer={(
          <>
            <Button variant="ghost" onClick={() => { setDeleteId(null) }}>{t('editor.cancel')}</Button>
            <Button variant="primary" onClick={() => { /* v8 ignore next -- rendered only while deleteId is non-null (modal open) */ if (deleteId !== null) void removeRow(deleteId) }}>{t('row.delete')}</Button>
          </>
        )}
      >
        <p className={css.intro}>{settingsRows.find(row => row.id === deleteId)?.transport === 'stdio'
          ? settingsRows.find(row => row.id === deleteId)?.command
          : settingsRows.find(row => row.id === deleteId)?.url}</p>
      </Modal>
    </div>
  )
}
