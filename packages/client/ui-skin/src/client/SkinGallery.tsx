/**
 * Skin gallery row: a radio group of cards, one per catalog skin (built-ins in
 * catalog order, then imported packs), each with a mini preview drawn from its
 * own tokens. The color mode (System / Light / Dark) is the theme owner's own
 * row and is not repeated here. The group is one tab stop with a roving
 * tabindex; arrow keys move and select, Home and End jump to the ends. A card
 * is checked only while the persisted preference is that skin's theme.
 */
import clsx from 'clsx'
import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react'
import type { SkinDefinition } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { skinDisplayName, skinThemeId } from './catalog.ts'
import type { SkinHooks } from './faces.ts'
import type { NS } from './locales.ts'
import { previewStyle } from './preview.ts'
import { Row } from './Row.tsx'
import { SkinPreview } from './SkinPreview.tsx'
import { canWrite } from './view.ts'
import css from './SkinGallery.module.css'

/** Injected business face of the gallery. */
export interface SkinGalleryInjected {
  hooks: SkinHooks
  /** Select a skin theme (`skin:<id>`). */
  setTheme: (id: string) => void
  /** Re-read the catalog, so packs and wallpapers added on disk since the last read show up. */
  refresh: () => Promise<void>
}

/** Full component props. */
export type SkinGalleryProps =
  PropsRuntime<'settings.appearance.item'> & PropsLocale<typeof NS> & InjectFace<SkinGalleryInjected>

/** One selectable card. */
interface Card {
  /** The skin's theme id (`skin:<id>`). */
  id: string
  label: string
  detail: string
  skin: SkinDefinition
}

/**
 * Render the gallery row.
 * @param props - composed slot props.
 * @returns the row element.
 */
export function SkinGallery({ t, useSkin, setTheme, refresh }: SkinGalleryProps) {
  const library = useSkin(view => view.library)
  const theme = useSkin(view => view.theme)
  const locale = useSkin(view => view.locale)
  const access = useSkin(view => view.access)
  const refs = useRef<Array<HTMLButtonElement | null>>([])

  // Opening the Appearance section re-reads the catalog: a pack file dropped into the library directory by hand shows up here.
  useEffect(() => { void refresh() }, [refresh])

  const cards = useMemo<Card[]>(() => library.skins.map((skin): Card => {
    const scheme = t(`gallery.scheme.${skin.colorScheme}`)
    return {
      id: skinThemeId(skin.id),
      label: skinDisplayName(skin, locale),
      detail: skin.source === 'pack' ? `${scheme} · ${t('gallery.imported')}` : scheme,
      skin,
    }
  }), [library.skins, locale, t])

  // A card is checked only for a skin preference; with none checked (a color mode, or a skin id not in the catalog),
  // the first card is the tab stop.
  const tabStop = Math.max(0, cards.findIndex(card => card.id === theme.preference))

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const last = cards.length - 1
    const next = index === last ? 0 : index + 1
    const previous = index === 0 ? last : index - 1
    const targets: Record<string, number> = {
      ArrowRight: next, ArrowDown: next, ArrowLeft: previous, ArrowUp: previous, Home: 0, End: last,
    }
    const target = targets[event.key]
    if (target === undefined) return
    event.preventDefault()
    refs.current[target]?.focus()
    setTheme((cards[target] as Card).id)
  }

  return (
    <Row
      title={t('gallery.title')}
      description={t('gallery.desc')}
      notice={canWrite(access) ? undefined : t('gallery.localOnly')}
    >
      {library.status === 'error' ? <p className={css.unavailable} role="status">{t('gallery.unavailable')}</p> : null}
      {cards.length === 0 ? null : (
        <div role="radiogroup" aria-label={t('gallery.label')} className={css.grid}>
          {cards.map((card, index) => (
            <button
              key={card.id}
              ref={(element) => { refs.current[index] = element }}
              type="button"
              role="radio"
              aria-checked={card.id === theme.preference}
              tabIndex={index === tabStop ? 0 : -1}
              className={clsx(css.card, card.id === theme.preference && css.selected)}
              onClick={() => { setTheme(card.id) }}
              onKeyDown={(event) => { move(event, index) }}
            >
              <SkinPreview style={previewStyle(card.skin)} />
              <span className={css.label}>{card.label}</span>
              <span className={css.detail}>{card.detail}</span>
            </button>
          ))}
        </div>
      )}
    </Row>
  )
}
