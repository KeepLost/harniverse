/**
 * Platform logo badge: an inline monogram or glyph on a token-colored tile,
 * keyed by platform id with a first-letter fallback so a platform the client
 * has never heard of still gets a badge.
 */
import css from './PlatformBadge.module.css'

/** Props of the badge. */
export interface PlatformBadgeProps {
  /** Platform id (`telegram`, `feishu`, …). */
  platform: string
  /** Platform display name; its first letter is the fallback monogram. */
  label: string
}

/** Paper-plane glyph for Telegram. */
function PaperPlane() {
  return (
    <svg className={css.glyph} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M14.5 2 1.5 7.2l3.9 1.6 1.4 4.2 2.3-2.5 3.5 2.6z" />
    </svg>
  )
}

/**
 * Render the platform badge. Decorative: the platform name is always in text beside it.
 * @param props - platform id and display name.
 * @returns the badge element.
 */
export function PlatformBadge({ platform, label }: PlatformBadgeProps) {
  const monogram = platform === 'feishu' ? '飞' : (Array.from(label)[0] ?? '?').toUpperCase()
  return (
    <span className={css.badge} data-platform={platform} aria-hidden="true">
      {platform === 'telegram' ? <PaperPlane /> : monogram}
    </span>
  )
}
