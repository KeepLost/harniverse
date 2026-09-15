/** The context compaction card: when automatic history reduction begins. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { ValueField } from './fields.tsx'
import { PluginCard } from './PluginCard.tsx'
import type { CompactionCardFace } from './compaction-card-controller.ts'
import type {} from './slot-contract.ts'

/** Props the renderer binds for the compaction card. */
export type CompactionCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<CompactionCardFace>

/** Render the global compaction threshold card. */
export function CompactionCard(props: CompactionCardProps) {
  const { t } = props
  const state = props.useCompactionCard(snapshot => snapshot)
  return (
    <PluginCard
      t={t}
      titleKey="compactionTitle"
      descriptionKey="compactionDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <ValueField
        id="plugin-config-compaction-threshold"
        label={t('compactionThreshold')}
        hint={t('compactionThresholdHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidPercentage')}
        placeholder="80"
        numeric
        disabled={!state.writable}
        {...state.thresholdPercent}
        onEdit={(text) => { props.edit('thresholdRatio', text) }}
        onReset={() => { props.resetField('thresholdRatio') }}
      />
      <ValueField
        id="plugin-config-nudge-threshold"
        label={t('nudgeThreshold')}
        hint={t('nudgeThresholdHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidTokens')}
        placeholder="120000"
        numeric
        disabled={!state.writable}
        {...state.nudgeThresholdTokens}
        onEdit={(text) => { props.edit('nudgeThresholdTokens', text) }}
        onReset={() => { props.resetField('nudgeThresholdTokens') }}
      />
      <ValueField
        id="plugin-config-nudge-delta"
        label={t('nudgeDelta')}
        hint={t('nudgeDeltaHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidTokens')}
        placeholder="20000"
        numeric
        disabled={!state.writable}
        {...state.nudgeRefireDeltaTokens}
        onEdit={(text) => { props.edit('nudgeRefireDeltaTokens', text) }}
        onReset={() => { props.resetField('nudgeRefireDeltaTokens') }}
      />
    </PluginCard>
  )
}
