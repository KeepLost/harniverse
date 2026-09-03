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
}

/** What the compaction card renders. */
export interface CompactionCardState extends CardShell {
  /** Pressure threshold rendered as an integer percentage. */
  thresholdPercent: CardFieldState
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

/** Bridges the `compaction` scope onto the card's staged percentage form. */
export class CompactionCardController {
  private readonly form: CardForm<CompactionSettings>
  private readonly store: SnapshotStore<CompactionCardState>

  /** @param scope - the bound settings scope for the `compaction` namespace. */
  constructor(scope: SettingsScope<CompactionSettings>) {
    this.form = new CardForm(scope, [thresholdField])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): CompactionCardState {
    return {
      ...this.form.shell(),
      thresholdPercent: this.form.field('thresholdRatio'),
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
