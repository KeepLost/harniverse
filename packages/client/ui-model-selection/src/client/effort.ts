/**
 * Effort derivation for the model seat's drilled effort pane: the trigger
 * label and the pane's rows come from one pure derivation over the
 * per-session directory.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from './directory.ts'


/** One dynamic effort row; undefined means preserve the provider default. */
export interface EffortChoice {
  key: string
  effort: string | undefined
  label: string
  description?: string
}

/** The reasoning metadata a directory model row may carry. */
export type ModelReasoning = NonNullable<ModelDirectoryState['groups'][number]['models'][number]['reasoning']>

/**
 * The effort the next assembled step carries: the session's explicit pick,
 * else the model's declared default, else the provider's own default.
 * @param current - the host-reported selection, or null before the first load.
 * @param reasoning - the current model's reasoning metadata, if any.
 * @returns the effective effort id, or undefined to send no effort.
 */
export function effectiveEffortOf(
  current: ModelSelection | null,
  reasoning: ModelReasoning | undefined,
): string | undefined {
  return current?.reasoningEffort ?? reasoning?.defaultEffort
}

/**
 * Spell an effort id as the user-facing label.
 * @param effective - the effective effort id.
 * @param reasoning - the current model's reasoning metadata, if any.
 * @param t - the model-namespace translate.
 * @returns undefined only while the model declares no reasoning at all.
 */
export function effortLabelOf(
  effective: string | undefined,
  reasoning: ModelReasoning | undefined,
  t: TranslateNS<'model'>,
): string | undefined {
  return reasoning === undefined
    ? undefined
    : effective === undefined
      ? t('effort.providerDefault')
      : reasoning.efforts.find(level => level.id === effective)?.name ?? effective
}

/**
 * Build the selectable effort rows: the provider-default row only when the
 * model does not pin its own default, then one row per declared level.
 * @param reasoning - the current model's reasoning metadata, if any.
 * @param t - the model-namespace translate.
 * @returns the rows, empty while the model declares no reasoning.
 */
export function effortChoicesOf(
  reasoning: ModelReasoning | undefined,
  t: TranslateNS<'model'>,
): readonly EffortChoice[] {
  return reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [],
      ...reasoning.efforts.map(effort => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
        ...effort.description === undefined ? {} : { description: effort.description },
      })),
    ]
}
