/**
 * The browser carrier panel (浏览器) center view: an app-owned navigation
 * surface over a sandboxed iframe. The URL bar is the single navigation
 * entry point and every submission passes the pure policy module first — a
 * rejected URL renders an inline notice and never reaches the frame. The
 * frame is deliberately sandboxed without `allow-same-origin`, so the
 * embedded page gets an opaque origin and can never touch harness cookies,
 * storage, or DOM. History is app-owned (the declared store), not browser
 * history: back/forward/reload act on the panel's own trail.
 */
import { useEffect, useState } from 'react'
import type { SnapshotStore, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconRefreshOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { createBrowserViewStore } from './history.ts'
import { reviewNavigation, type NavigationPolicyOptions, type NavigationRejectReason } from './policy.ts'
import { NS, type BrowserKey } from './locales.ts'
import css from './BrowserCenterView.module.css'

/** The `browser` settings section value the panel reads its allowlist from. */
export interface BrowserPanelSettings {
  /** Exact hostnames the panel may navigate to; unset means open browsing. */
  allowedHosts?: string[]
}

/** Injected business face of the panel shell. */
export interface BrowserCenterInjected {
  hooks: {
    /** Browser settings scope snapshot bound by the renderer as useConfig. */
    config: SnapshotStore<SettingsScopeSnapshot<BrowserPanelSettings>>
  }
  /** The harness's own origin; policy refuses framing it. */
  selfOrigin: string
  /** Release the center column back to the conversation. */
  closeView: () => void
}

/** Full props composed by the center-view slot. */
export type BrowserCenterViewProps =
  PropsRuntime<'center.view'>
  & PropsStore<ReturnType<typeof createBrowserViewStore>>
  & InjectFace<BrowserCenterInjected>
  & PropsLocale<typeof NS>

/** Locale key of each refusal reason. */
const REJECTION_KEYS: Record<NavigationRejectReason, BrowserKey> = {
  empty: 'reject.empty',
  malformed: 'reject.malformed',
  scheme: 'reject.scheme',
  credentials: 'reject.credentials',
  'self-origin': 'reject.self-origin',
  'host-not-allowed': 'reject.host-not-allowed',
}

/** One refused submission as rendered by the notice. */
interface Rejection {
  raw: string
  reason: NavigationRejectReason
}

/**
 * The panel shell: header with history controls and the URL form, the
 * inline refusal notice, and the sandboxed frame over the current entry.
 * The address draft and any refusal follow the current entry: every trail
 * movement (visit, back, forward) resolves the bar and dismisses the
 * notice.
 * @param props - center slot currency, the shared store, the config hook, the harness origin, the exit verb, and the translator.
 * @returns the panel shell.
 */
export function BrowserCenterView({
  actions, useStore, useConfig, selfOrigin, closeView, t,
}: BrowserCenterViewProps) {
  useEffect(() => { actions.setOpen(true); return () => { actions.setOpen(false) } }, [actions])
  const entries = useStore(state => state.entries)
  const cursor = useStore(state => state.cursor)
  const scope = useConfig(snapshot => snapshot)
  // The settings layer materializes an absent array field as [], so an empty
  // allowlist here means the section never set one: open browsing.
  const listed = scope.status === 'ready' ? scope.value?.allowedHosts : undefined
  const allowedHosts = listed !== undefined && listed.length > 0 ? listed : undefined
  const current = entries[cursor]
  const [draft, setDraft] = useState('')
  const [rejection, setRejection] = useState<Rejection | undefined>(undefined)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    setDraft(current ?? '')
    setRejection(undefined)
  }, [current])

  /** Review one submission and either navigate or surface the refusal. */
  const navigate = (raw: string) => {
    const options: NavigationPolicyOptions = { selfOrigin }
    if (allowedHosts !== undefined) options.allowedHosts = allowedHosts
    const review = reviewNavigation(raw, options)
    if (!review.ok) {
      setRejection({ raw: raw.trim(), reason: review.reason })
      return
    }
    setRejection(undefined)
    actions.visit(review.url)
  }

  return (
    <section className={css.view} aria-label={t('view.title')}>
      <header className={css.header}>
        <h2 className={css.title}>{t('view.title')}</h2>
        <div className={css.headerActions}>
          <button
            type="button"
            className={css.navButton}
            aria-label={t('nav.back')}
            title={t('nav.back')}
            disabled={cursor <= 0}
            onClick={() => { actions.back() }}
          >
            <IconChevronLeftOutline14 />
          </button>
          <button
            type="button"
            className={css.navButton}
            aria-label={t('nav.forward')}
            title={t('nav.forward')}
            disabled={cursor >= entries.length - 1}
            onClick={() => { actions.forward() }}
          >
            <IconChevronRightOutline14 />
          </button>
          <button
            type="button"
            className={css.navButton}
            aria-label={t('nav.reload')}
            title={t('nav.reload')}
            disabled={current === undefined}
            onClick={() => { setNonce(value => value + 1) }}
          >
            <IconRefreshOutline16 />
          </button>
          <button type="button" className={css.button} onClick={closeView}>{t('view.close')}</button>
        </div>
      </header>
      <form
        className={css.addressBar}
        onSubmit={(event) => { event.preventDefault(); navigate(draft) }}
      >
        <label className={css.urlLabel} htmlFor="browser-panel-url">{t('url.label')}</label>
        <input
          id="browser-panel-url"
          className={css.urlInput}
          type="text"
          value={draft}
          placeholder={t('url.placeholder')}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(event) => { setDraft(event.target.value) }}
        />
        <button type="submit" className={css.button}>{t('url.go')}</button>
      </form>
      {rejection !== undefined ? (
        <div className={css.notice} role="alert">
          <strong className={css.noticeTitle}>{t('reject.title')}</strong>
          <p className={css.noticeBody}>
            <span>{t(REJECTION_KEYS[rejection.reason])}</span>
            {rejection.raw !== '' ? <code className={css.noticeRaw}>{rejection.raw}</code> : null}
          </p>
        </div>
      ) : null}
      {current !== undefined ? (
        <iframe
          key={`browser-frame-${String(nonce)}`}
          className={css.frame}
          src={current}
          title={t('frame.title')}
          sandbox="allow-scripts allow-forms allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      ) : (
        <p className={css.empty}>{t('view.empty')}</p>
      )}
    </section>
  )
}
