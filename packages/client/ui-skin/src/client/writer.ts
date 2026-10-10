/**
 * Coalesced settings writes. A slider drag fires dozens of changes a second;
 * each field's latest value is staged immediately — so the live preview and
 * the control follow the user — and written once the input settles. The staged
 * overlay clears when the write settles, after which the scope's accepted
 * value (the Host's answer) is what the view shows.
 * @module @deepseek-ai/dsh-client-ui-skin/writer
 */
import type { SkinSettings } from './settings.ts'

/** How long an edit rests before it is written. */
export const WRITE_DELAY_MS = 200

/** The part of a settings scope the writer drives. */
export interface WriteTarget {
  set(field: string, value: unknown): Promise<void>
}

/** Debounced, ordered writer over one settings scope. */
export class SettingsWriter {
  private readonly staged = new Map<keyof SkinSettings, SkinSettings[keyof SkinSettings]>()
  private readonly unsent = new Set<keyof SkinSettings>()
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param target - the scope receiving writes.
   * @param changed - called whenever the staged overlay changes (so the view republishes).
   */
  constructor(private readonly target: WriteTarget, private readonly changed: () => void) {}

  /**
   * Read the staged edits.
   * @returns the unsaved edits, applied over the accepted settings by the view.
   */
  overlay(): Partial<SkinSettings> {
    return Object.fromEntries(this.staged)
  }

  /**
   * Stage one field's next value and arm the write.
   * @param field - settings field.
   * @param value - its next value.
   */
  stage<F extends keyof SkinSettings>(field: F, value: SkinSettings[F]): void {
    this.staged.set(field, value)
    this.unsent.add(field)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { void this.flush() }, WRITE_DELAY_MS)
    this.changed()
  }

  /**
   * Write every unsent field now, in staging order.
   * @returns settlement of all writes; a field re-staged meanwhile keeps its newer value.
   */
  async flush(): Promise<void> {
    clearTimeout(this.timer)
    this.timer = undefined
    const fields = [...this.unsent]
    this.unsent.clear()
    await Promise.all(fields.map(async (field) => {
      const value = this.staged.get(field)
      await this.target.set(field, value)
      if (this.staged.get(field) === value && !this.unsent.has(field)) this.staged.delete(field)
    }))
    this.changed()
  }

  /** Cancel the pending write and forget staged edits. */
  dispose(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.unsent.clear()
    this.staged.clear()
  }
}
