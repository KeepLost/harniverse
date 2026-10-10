/**
 * Wallpaper row: upload, a grid of the recent wallpapers (select, delete), a
 * way back to none, and the blur slider. Rejections come back typed from the
 * Host (or from the local size pre-check) and are shown in product copy.
 */
import clsx from 'clsx'
import { useRef, useState } from 'react'
import { Button, IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkinLibraryLimits } from '@deepseek-ai/dsh-api-remotes/client'
import type { SkinHooks } from './faces.ts'
import { formatBytes } from './format.ts'
import type { NS } from './locales.ts'
import { assertNever } from './never.ts'
import type { OperationOutcome, WallpaperOutcome } from './outcomes.ts'
import { Row } from './Row.tsx'
import { RANGES, type SetSetting } from './settings.ts'
import { useWallpaperUrl } from './useWallpaperUrl.ts'
import { canWrite } from './view.ts'
import css from './WallpaperRow.module.css'

/** Injected business face of the wallpaper row. */
export interface WallpaperRowInjected {
  hooks: SkinHooks
  /** Stage one settings field. */
  setSetting: SetSetting
  /** Upload a picked image and select it. */
  uploadWallpaper: (file: File) => Promise<WallpaperOutcome>
  /** Delete a stored wallpaper. */
  removeWallpaper: (hash: string) => Promise<OperationOutcome>
  /** Take a reference on a wallpaper's object URL. */
  acquireWallpaper: (hash: string) => Promise<string | undefined>
  /** Drop a reference taken by `acquireWallpaper`. */
  releaseWallpaper: (hash: string) => void
}

/** Full component props. */
export type WallpaperRowProps =
  PropsRuntime<'settings.appearance.item'> & PropsLocale<typeof NS> & InjectFace<WallpaperRowInjected>

type Translate = TranslateNS<typeof NS>

/** The user-facing line for a failed or rejected outcome; undefined for success. */
function problemOf(outcome: WallpaperOutcome | OperationOutcome, limits: SkinLibraryLimits, t: Translate): string | undefined {
  switch (outcome.status) {
    case 'ok': return undefined
    case 'failed': return t('error.generic', { message: outcome.message })
    case 'rejected': return t(`wallpaper.reject.${outcome.reason}`, {
      limit: formatBytes(limits.maxWallpaperBytes),
      max: limits.maxWallpapers,
    })
    /* v8 ignore next -- closed outcome union */
    default: return assertNever(outcome)
  }
}

/** One recent wallpaper: a select button over its thumbnail, and a delete button. */
function WallpaperItem(props: {
  hash: string
  index: number
  size: string
  selected: boolean
  writable: boolean
  t: Translate
  acquire: WallpaperRowInjected['acquireWallpaper']
  release: WallpaperRowInjected['releaseWallpaper']
  onSelect: () => void
  onRemove: () => void
}) {
  const { hash, index, size, selected, writable, t, acquire, release, onSelect, onRemove } = props
  const url = useWallpaperUrl(hash, acquire, release)
  return (
    <li className={css.item}>
      <button
        type="button"
        className={clsx(css.thumb, selected && css.selected)}
        aria-label={t('wallpaper.thumb', { index, size })}
        aria-pressed={selected}
        disabled={!writable}
        onClick={onSelect}
      >
        {url === undefined ? <span className={css.placeholder} /> : <img className={css.image} src={url} alt="" />}
      </button>
      <button
        type="button"
        className={css.remove}
        aria-label={t('wallpaper.remove', { index })}
        disabled={!writable}
        onClick={onRemove}
      >
        <IconCloseOutline16 size={12} />
      </button>
    </li>
  )
}

/**
 * Render the wallpaper row.
 * @param props - composed slot props.
 * @returns the row element.
 */
export function WallpaperRow(props: WallpaperRowProps) {
  const { t, useSkin, setSetting, uploadWallpaper, removeWallpaper, acquireWallpaper, releaseWallpaper } = props
  const library = useSkin(view => view.library)
  const settings = useSkin(view => view.settings)
  const access = useSkin(view => view.access)
  const writable = canWrite(access)
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)

  const settle = (outcome: WallpaperOutcome | OperationOutcome): void => {
    setProblem(problemOf(outcome, library.limits, t))
  }

  return (
    <Row
      title={t('wallpaper.title')}
      description={t('wallpaper.desc')}
      notice={writable ? undefined : t('access.readOnly')}
    >
      <div className={css.toolbar}>
        <input
          ref={picker}
          type="file"
          hidden
          accept="image/png,image/jpeg,image/webp"
          disabled={!writable || busy}
          onChange={(event) => {
            const input = event.currentTarget
            const file = input.files?.[0]
            input.value = ''
            if (file === undefined) return
            setBusy(true)
            void uploadWallpaper(file).then(settle).finally(() => { setBusy(false) })
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!writable || busy}
          onClick={() => { (picker.current as HTMLInputElement).click() }}
        >
          {busy ? t('wallpaper.uploading') : t('wallpaper.upload')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!writable || settings.wallpaper === ''}
          onClick={() => { setSetting('wallpaper', '') }}
        >
          {t('wallpaper.none')}
        </Button>
      </div>
      <p className={css.hint}>
        {t('wallpaper.hint', { limit: formatBytes(library.limits.maxWallpaperBytes), max: library.limits.maxWallpapers })}
      </p>
      {problem === undefined ? null : <p className={css.problem} role="alert">{problem}</p>}
      {library.status === 'error' ? <p className={css.problem} role="status">{t('wallpaper.unavailable')}</p> : null}
      <h4 className={css.subtitle}>{t('wallpaper.recent')}</h4>
      {library.wallpapers.length === 0
        ? <p className={css.hint}>{t('wallpaper.empty')}</p>
        : (
          <ul className={css.grid}>
            {library.wallpapers.map((entry, position) => (
              <WallpaperItem
                key={entry.hash}
                hash={entry.hash}
                index={position + 1}
                size={formatBytes(entry.bytes)}
                selected={entry.hash === settings.wallpaper}
                writable={writable}
                t={t}
                acquire={acquireWallpaper}
                release={releaseWallpaper}
                onSelect={() => { setSetting('wallpaper', entry.hash) }}
                onRemove={() => { void removeWallpaper(entry.hash).then(settle) }}
              />
            ))}
          </ul>
        )}
      <label className={css.slider}>
        <span>{t('wallpaper.blur')}</span>
        <input
          type="range"
          min={RANGES.wallpaperBlur.min}
          max={RANGES.wallpaperBlur.max}
          step={1}
          value={settings.wallpaperBlur}
          disabled={!writable || settings.wallpaper === ''}
          onChange={(event) => { setSetting('wallpaperBlur', Number(event.currentTarget.value)) }}
        />
        <output>{t('wallpaper.blurValue', { value: settings.wallpaperBlur })}</output>
      </label>
    </Row>
  )
}
