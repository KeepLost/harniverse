import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  Button, IconArchiveOutline20, MarkdownText, MessageText, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ConversationNode, ConversationSnapshot, RpcResult, SessionId, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceBrowserProps } from './contract/slots.ts'
import css from './ArchivePanel.module.css'

type Translate = WorkspaceBrowserProps['t']

interface ArchivePanelProps {
  items: readonly SessionSummary[]
  currentId: SessionId | undefined
  openArchive: WorkspaceBrowserProps['openArchive']
  loadArchiveOlder: WorkspaceBrowserProps['loadArchiveOlder']
  unarchiveSession: WorkspaceBrowserProps['unarchiveSession']
  deleteSession: WorkspaceBrowserProps['deleteSession']
  t: Translate
}

interface ArchiveMessage {
  key: string
  role: 'user' | 'assistant' | 'tool' | 'notice'
  time: number
  text: string
}

function jsonText(value: unknown): string {
  try {
    const result = JSON.stringify(value, null, 2)
    return result
  } catch {
    return String(value)
  }
}

function contentText(content: readonly unknown[]): string {
  return content.map((block) => {
    if (block !== null && typeof block === 'object' && 'type' in block) {
      const value = block as { type: string; text?: unknown; name?: unknown; arguments?: unknown; content?: unknown }
      if (value.type === 'text' || value.type === 'reasoning') return typeof value.text === 'string' ? value.text : ''
      if (value.type === 'tool-call') return `调用 ${String(value.name)}\n${jsonText(value.arguments ?? '')}`
      if (value.type === 'tool-result') return contentText(Array.isArray(value.content) ? value.content : [value.content])
      if (value.type === 'image') return '[图片]'
    }
    return jsonText(block)
  }).filter(text => text !== '').join('\n\n')
}

function assistantText(node: Extract<ConversationNode, { kind: 'assistant' }>): string {
  return node.blocks.map((block) => {
    if (block.kind === 'text' || block.kind === 'reasoning') return block.text
    if (block.kind === 'tool-call') return `调用 ${block.name}\n${block.argsRaw}`
    return block.kind === 'image' ? '[图片]' : jsonText(block.block)
  }).filter(text => text !== '').join('\n\n')
}

function archiveMessages(snapshot: ConversationSnapshot): ArchiveMessage[] {
  return snapshot.nodes.flatMap((node): ArchiveMessage[] => {
    switch (node.kind) {
      case 'user':
      case 'steering':
        return [{ key: `${node.kind}:${node.seq}`, role: 'user', time: node.time, text: contentText(node.content) }]
      case 'assistant':
        return [{ key: `assistant:${node.seq}`, role: 'assistant', time: node.time, text: assistantText(node) }]
      case 'tool-result':
        return [{ key: `tool:${node.seq}`, role: 'tool', time: node.time, text: contentText(node.content) }]
      case 'turn-error':
      case 'turn-max-tokens':
      case 'model-retry':
      case 'command':
      case 'compaction':
      case 'unknown':
        return [{ key: `${node.kind}:${node.seq}`, role: 'notice', time: node.time, text: jsonText(node) }]
      case 'context':
        return []
    }
  }).filter(message => message.text !== '')
}

function deleteOrder(ids: readonly SessionId[], byId: ReadonlyMap<SessionId, SessionSummary>): SessionId[] {
  const selected = new Set(ids)
  const depth = (id: SessionId, seen = new Set<SessionId>()): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    const parent = byId.get(id)?.parentId
    return parent === undefined || !selected.has(parent) ? 0 : depth(parent, seen) + 1
  }
  return [...ids].sort((left, right) => depth(right) - depth(left))
}

function resultMessage(result: RpcResult<unknown>): string | null {
  return result.ok ? null : result.error.message
}

/** Read-only archive list, message preview, restoration, and bounded batch deletion. */
export function ArchivePanel({
  items, currentId, openArchive, loadArchiveOlder, unarchiveSession, deleteSession, t,
}: ArchivePanelProps) {
  const [selected, setSelected] = useState<SessionId[]>([])
  const [previewId, setPreviewId] = useState<SessionId | null>(null)
  const [preview, setPreview] = useState<ConversationSnapshot | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [previewAction, setPreviewAction] = useState(false)
  const [deleteIds, setDeleteIds] = useState<SessionId[]>([])
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  const byId = useMemo(() => new Map(items.map(item => [item.id, item])), [items])
  const previewItem = previewId === null ? undefined : byId.get(previewId)
  const messages = preview === null ? [] : archiveMessages(preview)
  const allSelected = items.length > 0 && items.every(item => selected.includes(item.id))

  useEffect(() => {
    setSelected(ids => ids.filter(id => byId.has(id)))
    if (previewId !== null && !byId.has(previewId)) {
      setPreviewId(null)
      setPreview(null)
    }
  }, [byId, previewId])

  const toggleSelected = (id: SessionId): void => {
    setSelected(ids => ids.includes(id) ? ids.filter(candidate => candidate !== id) : [...ids, id])
  }

  const showPreview = (id: SessionId): void => {
    setPreviewId(id)
    setPreview(null)
    setPreviewError(null)
    setPreviewLoading(true)
    void openArchive(id).then((result) => {
      if (result.ok) setPreview(result.value.snapshot)
      else setPreviewError(result.error.message)
    }).catch((error: unknown) => {
      setPreviewError(error instanceof Error ? error.message : String(error))
    }).finally(() => { setPreviewLoading(false) })
  }

  const closePreview = (force = false): void => {
    if (previewAction && !force) return
    setPreviewId(null)
    setPreview(null)
    setPreviewError(null)
  }

  const restore = (id: SessionId): void => {
    setPreviewAction(true)
    void unarchiveSession(id).then(() => {
      closePreview(true)
    }).catch((error: unknown) => {
      setPreviewError(error instanceof Error ? error.message : String(error))
    }).finally(() => { setPreviewAction(false) })
  }

  const requestDelete = (ids: readonly SessionId[]): void => {
    setDeleteIds([...ids])
    setDeleteError(null)
  }

  const confirmDelete = (): void => {
    setDeleting(true)
    setDeleteError(null)
    const ordered = deleteOrder(deleteIds, byId)
    void (async () => {
      const failures: string[] = []
      const succeeded: SessionId[] = []
      for (const id of ordered) {
        const result = await deleteSession(id)
        const message = resultMessage(result)
        if (message === null) succeeded.push(id)
        else failures.push(`${byId.get(id)?.displayTitle ?? id}: ${message}`)
      }
      setSelected(ids => ids.filter(id => !succeeded.includes(id)))
      if (previewId !== null && succeeded.includes(previewId)) closePreview(true)
      if (failures.length > 0) setDeleteError(failures.join('\n'))
      else setDeleteIds([])
      setDeleting(false)
    })().catch((error: unknown) => {
      setDeleteError(error instanceof Error ? error.message : String(error))
      setDeleting(false)
    })
  }

  return (
    <>
      <section className={css.root} aria-label={t('archive.title')}>
        <div className={css.toolbar}>
          <label className={css.selectAll}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => { setSelected(allSelected ? [] : items.map(item => item.id)) }}
              aria-label={t('archive.selectAll')}
            />
            <span>{t('archive.selected', { n: selected.length })}</span>
          </label>
          <Button variant="outline" disabled={selected.length === 0} onClick={() => { requestDelete(selected) }}>
            {t('archive.deleteSelected')}
          </Button>
        </div>
        {items.length === 0 && <div className={css.empty}>{t('archive.empty')}</div>}
        <div className={css.list} role="list">
          {items.map(item => (
            <div key={item.id} className={clsx(css.row, item.id === currentId && css.current)} role="listitem">
              <input
                type="checkbox"
                checked={selected.includes(item.id)}
                onChange={() => { toggleSelected(item.id) }}
                aria-label={t('archive.select', { name: item.displayTitle })}
              />
              <button type="button" className={css.rowBody} onClick={() => { showPreview(item.id) }}>
                <span className={css.rowTitle}>{item.displayTitle}</span>
                <span className={css.rowMeta}>{item.cwd ?? item.id}</span>
              </button>
              <button type="button" className={css.restore} onClick={() => {
                setPreviewId(item.id)
                setPreview(null)
                setPreviewError(null)
                setPreviewAction(true)
                void unarchiveSession(item.id).catch((error: unknown) => {
                  setPreviewError(error instanceof Error ? error.message : String(error))
                }).finally(() => { setPreviewAction(false) })
              }}>
                {t('archive.restore')}
              </button>
            </div>
          ))}
        </div>
      </section>

      <Modal
        open={previewId !== null}
        onClose={closePreview}
        title={previewItem?.displayTitle ?? t('archive.previewTitle')}
        closeLabel={t('close')}
        {...css.previewDialog === undefined ? {} : { className: css.previewDialog }}
        {...css.previewContent === undefined ? {} : { contentClassName: css.previewContent }}
        {...previewId === null ? {} : {
          footer: (
            <div className={css.previewFooter}>
              <Button variant="outline" disabled={previewAction} onClick={() => { restore(previewId) }}>{t('archive.restore')}</Button>
              <Button variant="outline" disabled={previewAction} onClick={() => { requestDelete([previewId]) }}>
                {t('archive.delete')}
              </Button>
            </div>
          ),
        }}
      >
        {previewLoading && <div className={css.status}>{t('archive.loading')}</div>}
        {previewError !== null && <div className={css.error} role="alert">{previewError}</div>}
        {!previewLoading && previewError === null && preview !== null && (
          <div className={css.messages}>
            {preview.hasMore && (
              <Button
                variant="outline"
                disabled={previewAction}
                onClick={() => {
                  setPreviewAction(true)
                  void loadArchiveOlder(preview.sessionId).then((result) => {
                    if (result.ok) setPreview(result.value.snapshot)
                    else setPreviewError(result.error.message)
                  }).finally(() => { setPreviewAction(false) })
                }}
              >
                {t('archive.loadOlder')}
              </Button>
            )}
            {messages.length === 0 && <div className={css.status}>{t('archive.noMessages')}</div>}
            {messages.map(message => (
              <article key={message.key} className={clsx(css.message, css[`message_${message.role}`])}>
                <div className={css.messageHeader}>
                  <span>{t(`archive.role.${message.role}` as never)}</span>
                  <time dateTime={new Date(message.time).toISOString()}>{new Date(message.time).toLocaleString()}</time>
                </div>
                {message.role === 'assistant'
                  ? <MarkdownText text={message.text} />
                  : message.role === 'user'
                    ? <MessageText text={message.text} />
                    : <pre className={css.noticeText}>{message.text}</pre>}
              </article>
            ))}
          </div>
        )}
      </Modal>

      <Modal
        open={deleteIds.length > 0}
        onClose={() => { if (!deleting) setDeleteIds([]) }}
        title={t('archive.deleteTitle')}
        description={t('archive.deleteDescription', { n: deleteIds.length })}
        closeLabel={t('close')}
        footer={(
          <>
            <Button variant="outline" disabled={deleting} onClick={() => { setDeleteIds([]) }}>{t('cancel')}</Button>
            <Button variant="primary" disabled={deleting} onClick={confirmDelete}>{deleting ? t('archive.deleting') : t('archive.delete')}</Button>
          </>
        )}
      >
        {deleteError !== null && <div className={css.error} role="alert">{deleteError}</div>}
        <p className={css.warning}>{t('archive.deleteWarning')}</p>
      </Modal>
    </>
  )
}

export function ArchiveIcon() {
  return <IconArchiveOutline20 size={16} />
}
