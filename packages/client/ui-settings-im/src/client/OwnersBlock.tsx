/**
 * The "已绑定的账号" block of one channel: the paired accounts with their
 * unpair action, and the one-time pairing code (code, expiry countdown, copy
 * button, and the instruction for the private chat with the bot).
 */
import { useEffect, useId, useState } from 'react'
import { Button, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatOwnerView } from '@deepseek-ai/dsh-api-remotes/client'
import { errorText, formatRemaining, formatStamp, type ImTranslate, type OpError } from './format.ts'
import type { ImState } from './stores.ts'
import controls from './controls.module.css'
import css from './OwnersBlock.module.css'

/** How long the copy button reads "已复制" after a successful write, in ms. */
const COPIED_MS = 1500

/** Props of the owners block. */
export interface OwnersBlockProps {
  /** Paired accounts of the channel. */
  owners: readonly ChatOwnerView[]
  /** The issued pairing code, when one exists. */
  code: ImState['code']
  /** Failure of the last code request or unpair. */
  error: OpError | null
  /** Pending operations (`code`, `owner:<key>`). */
  busy: readonly string[]
  /** Mint a pairing code. */
  issueCode: () => Promise<void>
  /** Revoke one paired account. */
  unpair: (key: string) => Promise<void>
  /** Bound translator. */
  t: ImTranslate
}

/**
 * Milliseconds left until an expiry, re-read every second until it passes.
 * @param expiresAt - epoch milliseconds the code stops working.
 * @returns the remaining milliseconds; zero or negative once expired.
 */
function useRemaining(expiresAt: number): number {
  const [now, setNow] = useState(() => Date.now())
  const live = expiresAt - now > 0
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => { setNow(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [live])
  return expiresAt - now
}

/** The code, its copy button, the instruction, and the countdown (or the expiry notice). */
function PairingCode({ code, t }: { code: { value: string; expiresAt: number }; t: ImTranslate }) {
  const remaining = useRemaining(code.expiresAt)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => { setCopied(false) }, COPIED_MS)
    return () => { clearTimeout(timer) }
  }, [copied])
  if (remaining <= 0) return <p className={css.expired}>{t('pair.expired')}</p>
  return (
    <div className={css.pairing}>
      <div className={css.codeRow}>
        <code className={css.code} aria-label={t('pair.codeLabel')}>{code.value}</code>
        <Button
          size="sm"
          variant="outline"
          aria-label={t('pair.copyAria')}
          onClick={() => { void writeClipboard(code.value).then((ok) => { if (ok) setCopied(true) }) }}
        >
          {copied ? t('pair.copied') : t('pair.copy')}
        </Button>
        <span className={css.countdown}>{t('pair.expires', { remaining: formatRemaining(remaining) })}</span>
      </div>
      <p className={css.instruction}>
        {t('pair.instruction')}
        {' '}
        <code className={css.command}>{`/pair ${code.value}`}</code>
      </p>
    </div>
  )
}

/**
 * Render the paired accounts and the pairing-code request.
 * @param props - owners, code, failure, pending operations, verbs, and translator.
 * @returns the block element.
 */
export function OwnersBlock({ owners, code, error, busy, issueCode, unpair, t }: OwnersBlockProps) {
  const headingId = useId()
  const issuing = busy.includes('code')
  return (
    <section className={css.block} aria-labelledby={headingId}>
      <div className={css.head}>
        <h4 id={headingId} className={css.heading}>{t('owners.heading')}</h4>
        <Button size="sm" variant="outline" disabled={issuing} onClick={() => { void issueCode() }}>
          {issuing ? t('pair.generating') : t(code === null ? 'pair.generate' : 'pair.regenerate')}
        </Button>
      </div>
      <span className={controls.srOnly} role="status">{code === null ? '' : t('pair.announce')}</span>
      {code === null ? null : <PairingCode key={code.value} code={code} t={t} />}
      {error === null ? null : <p className={controls.error} role="alert">{errorText(t, error)}</p>}
      {owners.length === 0
        ? <p className={css.empty}>{t('owners.empty')}</p>
        : (
          <ul className={css.owners}>
            {owners.map((owner) => {
              const name = owner.displayName ?? owner.userId
              return (
                <li key={owner.key} className={css.owner}>
                  <div className={css.ownerText}>
                    <span className={css.ownerName}>{name}</span>
                    <span className={css.ownerMeta}>
                      <span className={css.ownerId}>{t('owners.userId', { id: owner.userId })}</span>
                      {' · '}
                      {t('owners.pairedAt', { time: formatStamp(owner.pairedAt) })}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy.includes(`owner:${owner.key}`)}
                    aria-label={t('owners.unpairAria', { name })}
                    onClick={() => { void unpair(owner.key) }}
                  >
                    {t('owners.unpair')}
                  </Button>
                </li>
              )
            })}
          </ul>
        )}
    </section>
  )
}
