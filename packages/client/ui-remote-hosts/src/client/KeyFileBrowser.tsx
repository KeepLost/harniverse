/**
 * The in-app key-file browser: one host directory level at a time —
 * directories enter, files pick — starting at the operator's `~/.ssh`. Pure
 * presentation over the injected listing call; failures localize through the
 * shared carrier-reason mapping.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { KeyFileListing } from '@deepseek-ai/dsh-remote-hosts/types'
import {
  Button, IconChevronLeftOutline14, IconChevronRightOutline14, IconFolderClose16, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { remoteIssue, type IssueTranslate } from './issues.ts'
import css from './remote-hosts.module.css'

/** Owner-supplied browser props: the listing call, pick semantics, and copy. */
export interface KeyFileBrowserProps {
  /** Dialog visibility; opening restarts at the default directory. */
  open: boolean
  /** List one host directory level (absent path = the default start). */
  list: (path?: string) => Promise<RemoteResult<KeyFileListing>>
  /** The operator picked a key file (absolute host path). */
  onPick: (path: string) => void
  /** Close without picking (mask, Escape, Cancel). */
  onClose: () => void
  /** Localized copy. */
  t: IssueTranslate
}

/** Failure text of a listing rejection: the thrown Error's message, else its string form. */
function failureText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Render the key-file browser dialog.
 * @param props - owner-controlled browser props.
 * @returns the dialog element (nothing while closed, via Modal).
 */
export function KeyFileBrowser({ open, list, onPick, onClose, t }: KeyFileBrowserProps) {
  const [listing, setListing] = useState<KeyFileListing | undefined>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  // Newer intent wins: a settlement from a superseded or closed dialog must
  // not repopulate the view.
  const seq = useRef(0)

  const load = useCallback((path?: string): void => {
    const current = ++seq.current
    setLoading(true)
    setError(undefined)
    list(path).then((result) => {
      if (current !== seq.current) return
      setLoading(false)
      if (result.ok) { setListing(result.value); return }
      setError(remoteIssue(t, result.error))
    }, (cause: unknown) => {
      if (current !== seq.current) return
      setLoading(false)
      setError(failureText(cause))
    })
  }, [list, t])

  // Every open restarts at the default directory; closing invalidates pending
  // settlements; unmount does the same.
  useEffect(() => {
    if (open) { setListing(undefined); load() }
    return () => { seq.current++ }
  }, [open, load])

  const parent = listing?.parent
  const entries = listing?.entries ?? []
  return (
    <Modal open={open} onClose={onClose} title={t('keyBrowserTitle')} closeLabel={t('close')} className={clsx(css.keyBrowserDialog)} footer={
      <Button variant="outline" onClick={onClose}>{t('keyBrowserCancel')}</Button>
    }>
      <div className={css.keyBrowserBody}>
        <div className={css.keyBrowserPath}>{listing?.path ?? ''}</div>
        <ul className={css.keyBrowserList} role="list">
          {parent !== undefined ? (
            <li role="listitem">
              <button type="button" className={css.keyBrowserRow} disabled={loading}
                onClick={() => { load(parent) }}>
                <IconChevronLeftOutline14 size={12} className={css.keyBrowserIcon} />
                <span className={css.keyBrowserName}>{t('keyBrowserUp')}</span>
              </button>
            </li>
          ) : null}
          {entries.map(entry => (
            <li role="listitem" key={entry.path}>
              <button type="button" className={css.keyBrowserRow} disabled={loading}
                onClick={() => { if (entry.kind === 'directory') load(entry.path); else onPick(entry.path) }}>
                {entry.kind === 'directory'
                  ? <IconFolderClose16 size={14} className={css.keyBrowserIcon} />
                  : <span className={css.keyBrowserFileIcon} />}
                <span className={css.keyBrowserName}>{entry.name}</span>
                {entry.kind === 'directory' ? <IconChevronRightOutline14 size={12} className={css.keyBrowserChevron} /> : null}
              </button>
            </li>
          ))}
        </ul>
        {!loading && listing !== undefined && listing.entries.length === 0 && listing.parent === undefined
          ? <p className={css.keyBrowserNote}>{t('keyBrowserEmpty')}</p> : null}
        {loading ? <p className={css.keyBrowserNote} role="status">{t('keyBrowserLoading')}</p> : null}
        {listing?.truncated === true ? <p className={css.keyBrowserNote} role="status">{t('keyBrowserTruncated')}</p> : null}
        {error !== undefined ? <p className={css.keyBrowserNote} role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}
