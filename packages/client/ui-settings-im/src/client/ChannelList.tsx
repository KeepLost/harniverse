/**
 * The channel column: one entry per platform descriptor the host reports, so
 * a platform added on the host appears here with no client change.
 */
import type { ChatBotView, ChatPlatformView } from '@deepseek-ai/dsh-api-remotes/client'
import { botsOf, type ImTranslate } from './format.ts'
import { PlatformBadge } from './PlatformBadge.tsx'
import css from './ChannelList.module.css'

/** Props of the channel list. */
export interface ChannelListProps {
  /** Platforms from the host's descriptors. */
  platforms: readonly ChatPlatformView[]
  /** Every managed bot, for the per-channel counts. */
  bots: readonly ChatBotView[]
  /** Selected platform id. */
  selected: string
  /** Select a channel. */
  onSelect: (platform: string) => void
  /** Bound translator. */
  t: ImTranslate
}

/**
 * Render the channel navigation.
 * @param props - descriptors, bots, selection, and translator.
 * @returns the navigation element.
 */
export function ChannelList({ platforms, bots, selected, onSelect, t }: ChannelListProps) {
  return (
    <nav aria-label={t('channels.aria')}>
      <ul className={css.list}>
        {platforms.map((platform) => {
          const n = botsOf(bots, platform.platform).length
          return (
            <li key={platform.platform}>
              <button
                type="button"
                className={css.channel}
                aria-label={t('channels.entry', { platform: platform.label, n })}
                aria-current={platform.platform === selected ? 'true' : undefined}
                onClick={() => { onSelect(platform.platform) }}
              >
                <PlatformBadge platform={platform.platform} label={platform.label} />
                <span className={css.label}>{platform.label}</span>
                <span className={css.count} aria-hidden="true">{n}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
