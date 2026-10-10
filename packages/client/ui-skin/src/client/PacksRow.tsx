/**
 * Skin packs row: import a `harniverse.skin` file (the Host's typed rejection
 * issues are listed verbatim), manage the imported packs, list pack files on
 * disk that failed validation, and export the active skin as a template.
 */
import { useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SkinLibraryLimits } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import clsx from 'clsx'
import { skinDisplayName } from './catalog.ts'
import type { SkinHooks } from './faces.ts'
import { formatBytes } from './format.ts'
import type { NS } from './locales.ts'
import { assertNever } from './never.ts'
import type { OperationOutcome, PackOutcome } from './outcomes.ts'
import { Row } from './Row.tsx'
import { activeSkinOf, canWrite } from './view.ts'
import css from './PacksRow.module.css'

/** Injected business face of the packs row. */
export interface PacksRowInjected {
  hooks: SkinHooks
  /** Import a picked pack file. */
  importPack: (file: File) => Promise<PackOutcome>
  /** Delete an imported pack. */
  removePack: (id: string) => Promise<OperationOutcome>
  /** Download the active skin as a pack file; false when the active theme is not a catalog skin. */
  exportActive: () => boolean
}

/** Full component props. */
export type PacksRowProps =
  PropsRuntime<'settings.appearance.item'> & PropsLocale<typeof NS> & InjectFace<PacksRowInjected>

type Translate = TranslateNS<typeof NS>

/** What the row says after an operation. */
interface Feedback {
  problem: boolean
  text: string
  issues: readonly string[]
}

/** The feedback of an outcome; undefined when there is nothing to say. */
function feedbackOf(
  outcome: PackOutcome | OperationOutcome,
  context: { limits: SkinLibraryLimits; locale: string; t: Translate },
): Feedback | undefined {
  const { limits, locale, t } = context
  switch (outcome.status) {
    case 'ok': return undefined
    case 'imported': return { problem: false, text: t('packs.imported', { name: skinDisplayName(outcome.skin, locale) }), issues: [] }
    case 'replaced': return { problem: false, text: t('packs.replaced', { name: skinDisplayName(outcome.skin, locale) }), issues: [] }
    case 'rejected': return { problem: true, text: t('packs.rejected'), issues: outcome.issues }
    case 'too-large': return { problem: true, text: t('packs.tooLarge', { limit: formatBytes(limits.maxPackBytes) }), issues: [] }
    case 'failed': return { problem: true, text: t('error.generic', { message: outcome.message }), issues: [] }
    /* v8 ignore next -- closed outcome union */
    default: return assertNever(outcome)
  }
}

/**
 * Render the packs row.
 * @param props - composed slot props.
 * @returns the row element.
 */
export function PacksRow({ t, useSkin, importPack, removePack, exportActive }: PacksRowProps) {
  const library = useSkin(view => view.library)
  const theme = useSkin(view => view.theme)
  const locale = useSkin(view => view.locale)
  const access = useSkin(view => view.access)
  const writable = canWrite(access)
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | undefined>(undefined)

  const packs = library.skins.filter(skin => skin.source === 'pack')
  const active = activeSkinOf(library, theme.activeId)
  const settle = (outcome: PackOutcome | OperationOutcome): void => {
    setFeedback(feedbackOf(outcome, { limits: library.limits, locale, t }))
  }

  return (
    <Row
      title={t('packs.title')}
      description={t('packs.desc')}
      notice={writable ? undefined : t('access.readOnly')}
    >
      <div className={css.toolbar}>
        <input
          ref={picker}
          type="file"
          hidden
          accept=".json,application/json"
          disabled={!writable || busy}
          onChange={(event) => {
            const input = event.currentTarget
            const file = input.files?.[0]
            input.value = ''
            if (file === undefined) return
            setBusy(true)
            void importPack(file).then(settle).finally(() => { setBusy(false) })
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!writable || busy}
          onClick={() => { (picker.current as HTMLInputElement).click() }}
        >
          {busy ? t('packs.importing') : t('packs.import')}
        </Button>
      </div>
      <p className={css.hint}>{t('packs.hint', { limit: formatBytes(library.limits.maxPackBytes) })}</p>
      {feedback === undefined
        ? null
        : (
          <div className={clsx(css.feedback, feedback.problem && css.problem)} role={feedback.problem ? 'alert' : 'status'}>
            <p className={css.line}>{feedback.text}</p>
            {feedback.issues.length === 0
              ? null
              : <ul className={css.issues}>{feedback.issues.map((issue, index) => <li key={`${String(index)}:${issue}`}>{issue}</li>)}</ul>}
          </div>
        )}
      {packs.length === 0
        ? <p className={css.hint}>{t('packs.empty')}</p>
        : (
          <ul className={css.list} aria-label={t('packs.list')}>
            {packs.map(pack => (
              <li key={pack.id} className={css.pack}>
                <span className={css.packMain}>
                  <span className={css.packName}>{skinDisplayName(pack, locale)}</span>
                  <span className={css.hint}>
                    {pack.author === undefined
                      ? t(`gallery.scheme.${pack.colorScheme}`)
                      : `${t(`gallery.scheme.${pack.colorScheme}`)} · ${t('packs.author', { author: pack.author })}`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!writable}
                  onClick={() => { void removePack(pack.id).then(settle) }}
                >
                  {t('packs.remove', { name: skinDisplayName(pack, locale) })}
                </Button>
              </li>
            ))}
          </ul>
        )}
      {library.rejected.length === 0
        ? null
        : (
          <details className={css.broken}>
            <summary>{t('packs.broken')}</summary>
            <ul className={css.issues}>
              {library.rejected.map(entry => <li key={entry.file}>{`${entry.file}: ${entry.message}`}</li>)}
            </ul>
          </details>
        )}
      <div className={css.toolbar}>
        <Button size="sm" variant="outline" disabled={active === undefined} onClick={() => { exportActive() }}>
          {t('packs.export')}
        </Button>
        <span className={css.hint}>{active === undefined ? t('packs.exportNone') : t('packs.exportHint')}</span>
      </div>
    </Row>
  )
}
