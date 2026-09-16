/** The compaction card's staged form over the `compaction` settings namespace. */

import type { SettingsScope, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import {
  CardForm,
  type CardActions,
  type CardFieldSpec,
  type CardFieldState,
  type CardShell,
} from './card-form.ts'

/** Host-owned compaction settings namespace, mirrored without a Host value import. */
export const COMPACTION_NS = 'compaction'

/** The global compaction fields this card edits. */
export interface CompactionSettings {
  /** Automatic pressure threshold as a context-window ratio. */
  thresholdRatio?: number
  /** First context-nudge notice threshold, in estimated framed tokens. */
  nudgeThresholdTokens?: number
  /** Growth between context-nudge notices, in estimated framed tokens. */
  nudgeRefireDeltaTokens?: number
}

/** What the compaction card renders. */
export interface CompactionCardState extends CardShell {
  /** Pressure threshold rendered as an integer percentage. */
  thresholdPercent: CardFieldState
  /** First context-nudge notice threshold, in tokens. */
  nudgeThresholdTokens: CardFieldState
  /** Growth between context-nudge notices, in tokens. */
  nudgeRefireDeltaTokens: CardFieldState
}

/** The registration-side face the compaction card's slot entry injects. */
export interface CompactionCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useCompactionCard. */
    compactionCard: SnapshotStore<CompactionCardState>
  }
}

/** Convert the stored ratio to and from the integer percentage shown by the card. */
const thresholdField: CardFieldSpec = {
  field: 'thresholdRatio',
  format: value => typeof value === 'number' ? String(Math.round(value * 100)) : '',
  parse: (text) => {
    const trimmed = text.trim()
    if (trimmed === '') return { kind: 'clear' }
    const percent = Number(trimmed)
    return Number.isSafeInteger(percent) && percent >= 17 && percent <= 100
      ? { kind: 'set', value: percent / 100 }
      : undefined
  },
}

/** Convert a positive whole-token override to and from the shown integer. */
function tokenField(field: 'nudgeThresholdTokens' | 'nudgeRefireDeltaTokens'): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const tokens = Number(trimmed)
      return Number.isSafeInteger(tokens) && tokens >= 1
        ? { kind: 'set', value: tokens }
        : undefined
    },
  }
}

/** Bridges the `compaction` scope onto the card's staged percentage form. */
export class CompactionCardController {
  private readonly form: CardForm<CompactionSettings>
  private readonly store: SnapshotStore<CompactionCardState>

  /** @param scope - the bound settings scope for the `compaction` namespace. */
  constructor(scope: SettingsScope<CompactionSettings>) {
    this.form = new CardForm(scope, [thresholdField, tokenField('nudgeThresholdTokens'), tokenField('nudgeRefireDeltaTokens')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): CompactionCardState {
    return {
      ...this.form.shell(),
      thresholdPercent: this.form.field('thresholdRatio'),
      nudgeThresholdTokens: this.form.field('nudgeThresholdTokens'),
      nudgeRefireDeltaTokens: this.form.field('nudgeRefireDeltaTokens'),
    }
  }

  /**
   * Build the card snapshot and staged form actions.
   * @returns the injected card store and mutation actions.
   */
  inject(): CompactionCardFace {
    return { hooks: { compactionCard: this.store }, ...this.form.actions() }
  }
}
