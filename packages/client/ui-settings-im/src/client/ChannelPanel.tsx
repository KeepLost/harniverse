/**
 * One channel's panel: the connect action with the online tally, the inline
 * connect form, the bot cards (or the platform's how-to-create-a-bot empty
 * state), and the paired-accounts block.
 */
import { useId } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { AddBotForm } from './AddBotForm.tsx'
import type { WorkspaceChoice } from './BotSettings.tsx'
import { BotCard } from './BotCard.tsx'
import type { ChatBotView, ChatOwnerView, ChatPlatformView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ImBoundActions, ImInjected } from './controller.ts'
import { connectValues, tally, type ImTranslate } from './format.ts'
import type { ImKey } from './locales.ts'
import { OwnersBlock } from './OwnersBlock.tsx'
import { PlatformBadge } from './PlatformBadge.tsx'
import type { ImState } from './stores.ts'
import css from './ChannelPanel.module.css'

/** Props of one channel panel. */
export interface ChannelPanelProps {
  /** The platform descriptor. */
  platform: ChatPlatformView
  /** The platform's bots. */
  bots: readonly ChatBotView[]
  /** The platform's paired accounts. */
  owners: readonly ChatOwnerView[]
  /** The section store state. */
  state: ImState
  /** Registered workspaces offered by the directory chooser. */
  workspaces: readonly WorkspaceChoice[]
  /** The operation verbs. */
  face: ImInjected
  /** The store's bound mutation API. */
  actions: ImBoundActions
  /** Bound translator. */
  t: ImTranslate
}

/** Channel-specific empty-state copy; any other platform reads the generic sentence. */
const EMPTY_COPY: Readonly<Record<string, ImKey>> = {
  telegram: 'empty.telegram',
  feishu: 'empty.feishu',
}

/**
 * Render one channel.
 * @param props - descriptor, bots, owners, store state, verbs, and translator.
 * @returns the panel element.
 */
export function ChannelPanel({ platform, bots, owners, state, workspaces, face, actions, t }: ChannelPanelProps) {
  const titleId = useId()
  const { online, total } = tally(bots, platform.platform)
  const form = state.form !== null && state.form.platform === platform.platform ? state.form : null
  return (
    <section className={css.panel} aria-labelledby={titleId}>
      <div className={css.header}>
        <h3 id={titleId} className={css.title}>
          <PlatformBadge platform={platform.platform} label={platform.label} />
          {platform.label}
        </h3>
        <div className={css.headerActions}>
          <span className={css.pill}>{t('pill', { online, total })}</span>
          <Button
            variant="primary"
            size="sm"
            disabled={form !== null}
            onClick={() => { actions.openForm(platform.platform) }}
          >
            {t('connect.open')}
          </Button>
        </div>
      </div>
      {form === null
        ? null
        : (
          <AddBotForm
            platform={platform}
            form={form}
            setValue={actions.setFormValue}
            setAlias={actions.setFormAlias}
            onSubmit={() => { void face.connect(platform.platform, form.alias, connectValues(platform.fields, form.values)) }}
            onCancel={actions.closeForm}
            t={t}
          />
        )}
      <h4 className={css.listHeading}>{t('list.heading')}</h4>
      {bots.length === 0
        ? <p className={css.empty}>{t(EMPTY_COPY[platform.platform] ?? 'empty.generic')}</p>
        : (
          <ul className={css.cards}>
            {bots.map(bot => (
              <BotCard
                key={bot.id}
                bot={bot}
                platformLabel={platform.label}
                expanded={state.expanded.includes(bot.id)}
                busy={state.busy.filter(op => op.startsWith(`${bot.id}:`)).map(op => op.slice(bot.id.length + 1))}
                note={state.notes[bot.id]}
                confirming={state.confirmRemove === bot.id}
                workspaces={workspaces}
                models={state.models}
                presets={state.presets}
                face={face}
                onToggle={() => { actions.setExpanded(bot.id, !state.expanded.includes(bot.id)) }}
                onAskRemove={(asking) => { actions.askRemove(asking ? bot.id : null) }}
                t={t}
              />
            ))}
          </ul>
        )}
      <OwnersBlock
        owners={owners}
        code={state.code}
        error={state.ownerError}
        busy={state.busy}
        issueCode={face.issueCode}
        unpair={face.unpair}
        t={t}
      />
    </section>
  )
}
